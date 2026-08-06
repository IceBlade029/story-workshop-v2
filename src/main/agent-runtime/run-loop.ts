/**
 * run-loop.ts — Agent 运行循环（RunCoordinator，design doc §8.1）。
 *
 * 一次 Agent Run = 一次「模型 + 工具」循环：
 * - 流式输出（onChunk）、取消（AbortSignal）、工具调用追踪（onToolTrace）
 * - 可写任务运行前快照受影响文件（§5.4）；运行中记录变更项
 * - 工具白名单强制：白名单外的工具调用硬拒绝（知识边界，§8.2）
 * - 事件全部记录进对话日志（system 事件）与工具追踪面板
 *
 * 普通讨论（chat）没有写入工具；一切写入都由明确按钮启动的任务执行。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ModelAdapter, ModelTurn, ModelTurnInput } from './model-types';
import type { ToolResult, ToolContext } from './tool-types';
import { ToolRegistry } from './tool-registry';
import { TASK_DEFINITIONS } from './task-definitions';
import { RunRecorder, persistRunSummary, persistRunRecord } from './run-recorder';
import { generateId } from '../storage/id';
import type { ProjectWorkspace } from '../storage/workspace';
import type { ChatMessage, ChangeItem, TaskKind, ToolCallTrace } from '../../shared/types';

export const DEFAULT_MAX_TURNS = 25;

export interface RunRequest {
  taskKind: TaskKind;
  /** 已组装好的上下文消息（沿活动路径，含最新用户输入；§7.2 压缩在 M6） */
  messages: ChatMessage[];
  /** 本次范围的人话描述（organize 展示在变更摘要顶部） */
  scope?: string;
  /**
   * 活动路径末端消息 id：本运行追加的 system 事件与 AI 回答
   * 以它为父节点挂入消息树（§3.2）。缺省 = 不挂父节点（根级）。
   */
  parentMessageId?: string;
  /**
   * 本运行的回答取代哪条消息（刷新产生，§3.2）：AI 回答带 supersedesId
   * 指向它，旧消息保留为兄弟分支（读取时派生出 supersededBy）。
   */
  supersedesMessageId?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  /** 流式文本回调（final 回合） */
  onChunk?: (chunk: string) => void;
  /** 思维链增量回调（DeepSeek V4 思考模式；UI 思考进度） */
  onReasoning?: (text: string) => void;
  /** 工具调用追踪回调 */
  onToolTrace?: (trace: ToolCallTrace) => void;
  /** 成功后推进整理光标到该消息 id（§5.3）；'run_end' = 本次运行的最后一条消息 */
  advanceCursorTo?: string | 'run_end';
  /** 压缩决策（ux-review §4.7：随 run 记录进调用详情；来自 prepareChatContext） */
  contextInfo?: { anchor: string; summary: string; keptFrom: number; keptRawCount: number };
}

export interface RunResult {
  runId: string;
  taskKind: TaskKind;
  finalAnswer: string;
  turns: number;
  toolCallCount: number;
  usage: { inputTokens: number; outputTokens: number };
  /** 可写任务的快照目录 id（= runId） */
  snapshotId?: string;
  /** 本次变更项（可写任务） */
  changes: ChangeItem[];
  cancelled: boolean;
  error?: string;
}

/** 可写任务运行前快照的文件（项目文件很小，全量快照最稳，§9.1）。 */
function defaultSnapshotFiles(workspace: ProjectWorkspace): string[] {
  const files: string[] = [path.join(workspace.dir, 'outline.json')];
  for (const dir of ['nodes', 'world', 'visible_views', 'outputs']) {
    const fullDir = path.join(workspace.dir, dir);
    try {
      for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
        if (entry.isFile()) files.push(path.join(fullDir, entry.name));
      }
    } catch {
      /* 目录不存在 */
    }
  }
  return files;
}

function now(): string {
  return new Date().toISOString();
}

function buildSummaryText(scope: string | undefined, changes: ChangeItem[]): string {
  const lines: string[] = [];
  if (scope) lines.push(`本次范围：${scope}`);
  if (changes.length > 0) {
    lines.push(`本次结果：${changes.length} 项变更`);
    for (const c of changes) {
      if (c.action === 'node_created') lines.push(`- 新建大纲节点：${c.title}（${c.nodeId}）`);
      else if (c.action === 'node_deleted') lines.push(`- 删除节点：${c.nodeId}`);
      else if (c.action === 'node_renamed') lines.push(`- 重命名：${c.from} → ${c.to}`);
      else if (c.action === 'draft_updated') lines.push(`- 更新草稿：${c.nodeId}`);
      else if (c.action === 'asset_created') lines.push(`- 新建设定：${c.title}（${c.type}）`);
      else if (c.action === 'asset_updated') lines.push(`- 更新设定：${c.assetId}`);
    }
  } else {
    lines.push('本次结果：无结构变更');
  }
  return lines.join('\n');
}

export class RunCoordinator {
  constructor(private readonly deps: {
    model: ModelAdapter;
    workspace: ProjectWorkspace;
    registry: ToolRegistry;
  }) {}

  /** 可写任务运行前快照；revise 无写入工具（替换由本地在「接受」时执行并快照，§5.3）。 */
  private readonly isWriteTask = (kind: TaskKind): boolean => kind === 'organize' || kind === 'detail_fill';

  async run(request: RunRequest): Promise<RunResult> {
    const { workspace, registry } = this.deps;
    const taskDef = TASK_DEFINITIONS[request.taskKind];
    const runId = workspace.snapshots.newRunId();
    const recorder = new RunRecorder();
    const traces: ToolCallTrace[] = [];
    const maxTurns = request.maxTurns ?? DEFAULT_MAX_TURNS;
    const whitelist = taskDef.whitelist;

    let snapshotId: string | undefined;
    if (this.isWriteTask(request.taskKind)) {
      snapshotId = runId;
      workspace.snapshots.createSnapshot(runId, defaultSnapshotFiles(workspace));
    }

    /**
     * 沙箱隔离（ux-review §4.3/§5.2 修订）：只有对话任务（chat / organize）
     * 把运行事件与 AI 回答写入对话日志；写作任务（detail_fill / revise）在
     * 讨论中零痕迹——运行记录（conversation/runs/<runId>.json）照常完整落盘。
     */
    const isConversationTask = request.taskKind === 'chat' || request.taskKind === 'organize';

    // 运行开始事件（system）——仅对话任务
    if (isConversationTask) {
      workspace.conversation.appendMessage({
        id: generateId('msg'),
        role: 'system',
        content: `运行开始（${request.taskKind}${request.scope ? `；范围：${request.scope}` : ''}）`,
        timestamp: now(),
        runId,
        parentId: request.parentMessageId,
      });
    }

    // 历史消息（持久化日志）→ 模型输入基础段
    const baseMessages: ModelTurnInput['messages'] = request.messages.map((m) => {
      if (m.role === 'ai') return { role: 'assistant', content: m.content };
      if (m.role === 'system') return { role: 'system', content: m.content };
      return { role: 'user', content: m.content };
    });
    /**
     * 运行内上下文（OpenAI/DeepSeek 工具协议必需）：每一轮的
     * assistant(tool_calls) 消息与其后的 tool 结果必须成对出现，
     * tool 消息前必须有带 tool_calls 的 assistant 消息（400 校验）。
     */
    const turnContext: ModelTurnInput['messages'] = [];
    /** 工具追踪推送（UI 回调异常与 run 隔离）。 */
    const emitTrace = (trace: ToolCallTrace): void => {
      try {
        request.onToolTrace?.({ ...trace });
      } catch {
        /* 忽略 UI 侧失败 */
      }
    };
    let finalAnswer = '';
    let cancelled = false;
    let error: string | undefined;
    let turns = 0;
    const usage = { inputTokens: 0, outputTokens: 0 };
    // 工具调用序列（含耗时，进调用详情 §4.7）
    const toolDurations: Array<{ name: string; args: unknown; status: string; error?: string; durationMs: number }> = [];
    // 思维链累积（ux-review §4.1：随 AI 消息持久化，UI 折叠展示）
    const reasoningChunks: string[] = [];
    const runStartedAt = Date.now();
    let reasoningStartedAt: number | null = null;
    let thinkingMs = 0;

    while (turns < maxTurns) {
      if (request.signal?.aborted) {
        cancelled = true;
        break;
      }
      turns++;

      const input = this.buildTurnInput(taskDef, request, whitelist, baseMessages, turnContext);
      let turn: ModelTurn;
      try {
        turn = await this.deps.model.runTurn(input, {
          signal: request.signal,
          // UI 推送回调的异常（如 webContents 已销毁）与 run 隔离：
          // 事件记录、工具写入、回答落盘照常进行（§8.1）
          onChunk: (chunk) => {
            try {
              request.onChunk?.(chunk);
            } catch {
              /* 忽略 UI 侧失败 */
            }
          },
          onReasoning: (text) => {
            try {
              if (reasoningStartedAt === null) reasoningStartedAt = Date.now();
              reasoningChunks.push(text);
              request.onReasoning?.(text);
            } catch {
              /* 忽略 UI 侧失败 */
            }
          },
        });
      } catch (err) {
        if (request.signal?.aborted) {
          cancelled = true;
          break;
        }
        error = `MODEL_ERROR: ${(err as Error).message}`;
        break;
      }
      if (request.signal?.aborted) {
        cancelled = true;
        break;
      }
      usage.inputTokens += turn.usage.inputTokens;
      usage.outputTokens += turn.usage.outputTokens;

      if (turn.type === 'final') {
        finalAnswer = turn.answer;
        break;
      }

      // 工具轮：先把本轮的 assistant(tool_calls) 消息加入运行内上下文，
      // 再逐个执行工具并紧跟 tool 结果（协议配对，400 校验）。
      // 思维链（DeepSeek V4）必须随工具轮完整回传，否则 400。
      turnContext.push({
        role: 'assistant',
        content: '',
        tool_calls: turn.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
        ...(turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
      });

      // 执行工具调用（按序）
      let halted = false;
      for (const call of turn.toolCalls) {
        if (request.signal?.aborted) {
          cancelled = true;
          halted = true;
          break;
        }
        const trace: ToolCallTrace = {
          toolName: call.name,
          args: call.arguments,
          status: 'started',
          timestamp: now(),
        };
        const toolStartedAt = Date.now();
        traces.push(trace);
        emitTrace(trace);

        if (!registry.has(call.name)) {
          trace.status = 'failed';
          trace.error = 'TOOL_NOT_FOUND';
          emitTrace(trace);
          turnContext.push(toolObservation(call.id, { ok: false, code: 'TOOL_NOT_FOUND' }));
          error = `TOOL_NOT_FOUND: ${call.name}`;
          halted = true;
          break;
        }
        if (!whitelist.includes(call.name)) {
          trace.status = 'failed';
          trace.error = `TOOL_NOT_IN_WHITELIST (task=${request.taskKind})`;
          emitTrace(trace);
          turnContext.push(toolObservation(call.id, {
            ok: false,
            code: 'TOOL_NOT_IN_WHITELIST',
            message: `${call.name} 不属于 ${request.taskKind} 任务的白名单`,
          }));
          error = `TOOL_NOT_IN_WHITELIST: ${call.name} (task=${request.taskKind})`;
          halted = true;
          break;
        }

        const spec = registry.get(call.name)!;
        const ctx: ToolContext = {
          projectDir: workspace.dir,
          runId,
          signal: request.signal,
          recordChange: (c) => recorder.record(c),
        };
        let result: ToolResult;
        try {
          result = await spec.execute(ctx, call.arguments);
        } catch (err) {
          result = {
            ok: false,
            error: { code: 'TOOL_EXECUTION_ERROR', message: (err as Error).message, retryable: true },
            evidence: [],
          };
        }

        if (result.ok) {
          trace.status = 'completed';
        } else {
          trace.status = 'failed';
          trace.error = result.error?.message;
        }
        toolDurations.push({ name: call.name, args: call.arguments, status: trace.status, error: trace.error, durationMs: Date.now() - toolStartedAt });
        emitTrace(trace);
        turnContext.push(toolObservation(call.id, result));
      }
      if (halted) break;
    }

    if (!error && !cancelled && turns >= maxTurns) {
      error = 'RUN_TURNS_EXCEEDED';
    }

    // ---- 收尾：落日志（仅对话任务）、摘要、光标 ----
    // 写作任务（detail_fill/revise）沙箱隔离：AI 回答不写对话日志，
    // 最终回答完整保留在调用详情记录（conversation/runs/<runId>.json）。
    let aiMessageId: string | undefined;
    if (finalAnswer && !error && !cancelled && isConversationTask) {
      // AI 回答挂 request.parentMessageId（用户消息）下；运行结束事件挂在
      // AI 回答之下——保证活动路径（activeMessageId 沿父链回溯）同时包含
      // 「AI 回答 + 运行结束」，回答不会在刷新后从消息流消失（§3.2 活动路径）。
      aiMessageId = generateId('msg');
      const reasoningText = reasoningChunks.join('');
      if (reasoningText && reasoningStartedAt !== null) thinkingMs = Date.now() - reasoningStartedAt;
      workspace.conversation.appendMessage({
        id: aiMessageId,
        role: 'ai',
        content: finalAnswer,
        timestamp: now(),
        runId,
        parentId: request.parentMessageId,
        ...(request.supersedesMessageId ? { supersedesId: request.supersedesMessageId } : {}),
        toolTrace: traces.length > 0 ? traces : undefined,
        ...(reasoningText ? { reasoning: reasoningText, thinkingSeconds: Math.round(thinkingMs / 1000) } : {}),
      });
    }

    const changes = recorder.changes;
    if (snapshotId) {
      persistRunSummary(workspace, {
        runId,
        taskKind: request.taskKind,
        snapshotId,
        scope: request.scope ?? '',
        changes,
      });
    }

    // §4.7：调用详情随 run 记录（全部任务一致透明）
    {
      const sentMessages = request.messages.map((m): { messageId?: string; role: 'user' | 'ai' | 'system'; source: 'raw' | 'summary'; chars: number } => ({
        ...(m.id && !m.id.startsWith('summary-') ? { messageId: m.id } : {}),
        role: m.role,
        source: m.id.startsWith('summary-') ? 'summary' : 'raw',
        chars: m.content.length,
      }));
      const systemPrompt = taskDef.systemPrompt + (request.scope ? `\n\n本次范围：${request.scope}` : '');
      persistRunRecord(workspace, {
        runId,
        taskKind: request.taskKind,
        scope: request.scope ?? '',
        status: cancelled ? 'cancelled' : error ? 'error' : 'done',
        durationMs: Date.now() - runStartedAt,
        turns,
        usage,
        sent: {
          systemPrompt,
          messages: sentMessages,
          ...(request.contextInfo ? { compression: request.contextInfo } : {}),
          whitelist: [...taskDef.whitelist],
        },
        returned: {
          toolCalls: toolDurations,
          finalAnswer: aiMessageId
            ? `见本条消息（#${aiMessageId}）`
            : isConversationTask
              ? ''
              : `已写入运行记录（正文模块 ⓘ 调用详情可查，${finalAnswer.length} 字）`,
          error,
        },
        createdAt: new Date().toISOString(),
      });
    }

    // 运行结束事件（仅对话任务；写作任务在讨论中零痕迹）
    let endMessageId: string | undefined;
    if (isConversationTask) {
      endMessageId = generateId('msg');
      workspace.conversation.appendMessage({
        id: endMessageId,
        role: 'system',
        content: [
          `运行结束（${request.taskKind}）`,
          buildSummaryText(request.scope, changes),
          error ? `错误：${error}` : undefined,
          cancelled ? '（已取消）' : undefined,
        ].filter((l): l is string => l !== undefined).join('\n'),
        timestamp: now(),
        runId,
        // 有 AI 回答 → 挂在回答下（活动路径含回答+结束）；无回答（失败/取消）→ 挂父消息
        parentId: aiMessageId ?? request.parentMessageId,
      });
    }

    // §5.3：任务成功结束后推进整理光标（'run_end' = 本次运行的最后一条消息）
    if (!error && !cancelled && request.advanceCursorTo && endMessageId) {
      const target = request.advanceCursorTo === 'run_end' ? endMessageId : request.advanceCursorTo;
      workspace.conversation.setOrganizeCursor(target);
    }

    return {
      runId,
      taskKind: request.taskKind,
      finalAnswer,
      turns,
      toolCallCount: traces.length,
      usage,
      snapshotId,
      changes,
      cancelled,
      error,
    };
  }

  /** 组装单次模型调用输入：系统提示 + 历史 + 运行内上下文（工具配对）+ 白名单工具。 */
  private buildTurnInput(
    taskDef: { systemPrompt: string },
    request: RunRequest,
    whitelist: string[],
    baseMessages: ModelTurnInput['messages'],
    turnContext: ModelTurnInput['messages'],
  ): ModelTurnInput {
    const systemPrompt = taskDef.systemPrompt + (request.scope ? `\n\n本次范围：${request.scope}` : '');
    const messages: ModelTurnInput['messages'] = [...baseMessages, ...turnContext];

    const tools = this.deps.registry
      .getToolsForTask(request.taskKind, whitelist)
      .map((spec) => ({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema as never,
      }));

    return { systemPrompt, messages, tools };
  }
}

function toolObservation(toolCallId: string, result: ToolResult | Record<string, unknown>): Extract<ModelTurnInput['messages'][number], { role: 'tool' }> {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: JSON.stringify(result),
  };
}
