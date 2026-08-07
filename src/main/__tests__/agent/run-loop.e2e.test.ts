import { describe, it, expect, afterAll } from 'vitest';
import { createAgentRuntime, type AgentRuntime } from '../../agent-runtime/agent-factory';
import { ScriptedModelAdapter, type ScriptedTurn } from '../../agent-runtime/scripted-model-adapter';
import { ProjectWorkspace } from '../../storage/workspace';
import { acceptRun, rollbackRun, readRunSummary } from '../../agent-runtime/run-recorder';
import { makeProject, removeDir } from '../helpers/temp-project';
import type { ModelAdapter, ModelTurnInput, ModelTurn } from '../../agent-runtime/model-types';
import type { ChatMessage, ToolCallTrace } from '../../../shared/types';

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(removeDir));

function usage(i: number, o: number) {
  return { inputTokens: i, outputTokens: o };
}

function toolCall(id: string, name: string, arguments_: Record<string, unknown>) {
  return { id, name, arguments: arguments_ };
}

function setup(script: ScriptedTurn[], projectName = '测试项目') {
  const { projectDir } = makeProject(projectName);
  tempDirs.push(projectDir);
  const workspace = ProjectWorkspace.open(projectDir)!;
  const runtime = createAgentRuntime(workspace, new ScriptedModelAdapter(script));
  return { projectDir, workspace, runtime };
}

/** 记录每次模型输入的适配器（用于断言知识边界——模型看到什么工具）。 */
class RecordingAdapter implements ModelAdapter {
  readonly provider = 'recording';
  readonly inputs: ModelTurnInput[] = [];
  constructor(private readonly inner: ModelAdapter) {}
  async runTurn(input: ModelTurnInput, options?: unknown): Promise<ModelTurn> {
    this.inputs.push(input);
    return this.inner.runTurn(input, options as never);
  }
}

function userMessage(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, timestamp: `2026-08-05T00:00:00.${id}Z` };
}

describe('E2E — chat（讨论，只读）', () => {
  it('搜索 → 最终回答；无快照、无写入，日志含工具追踪', async () => {
    const { workspace, runtime } = setup([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'search_nodes', { query: '林默' })], usage: usage(10, 2) },
      { type: 'final', answer: '找到 1 个节点。', usage: usage(20, 5) },
    ]);
    workspace.outline.createNode('overview', { id: 'v1', type: 'volume', title: '林默的线索', children: [] });
    workspace.conversation.appendMessage(userMessage('m1', '查一下林默相关的内容'));

    const traces: ToolCallTrace[] = [];
    const result = await runtime.coordinator.run({
      taskKind: 'chat',
      messages: [userMessage('m1', '查一下林默相关的内容')],
      onToolTrace: (t) => traces.push(t),
    });

    expect(result.error).toBeUndefined();
    expect(result.finalAnswer).toBe('找到 1 个节点。');
    expect(result.turns).toBe(2);
    expect(result.toolCallCount).toBe(1);
    expect(result.snapshotId).toBeUndefined();
    expect(result.changes).toEqual([]);

    // 日志：用户消息 + 运行开始/结束 system + AI 回答
    const messages = workspace.conversation.readMessages();
    expect(messages.map((m) => m.role)).toEqual(['user', 'system', 'ai', 'system']);
    const aiMsg = messages.find((m) => m.role === 'ai')!;
    expect(aiMsg.runId).toBe(result.runId);
    expect(aiMsg.toolTrace?.map((t) => t.toolName)).toEqual(['search_nodes']);
    expect(aiMsg.toolTrace![0].status).toBe('completed');

    // 无任何写入
    expect(workspace.snapshots.listSnapshots()).toEqual([]);
    // 每条工具调用推送两次追踪快照：started + completed
    expect(traces.map((t) => t.status)).toEqual(['started', 'completed']);
  });

  it('流式输出：onChunk 收到 final 回合的文本增量', async () => {
    class StreamingAdapter implements ModelAdapter {
      readonly provider = 'streaming';
      async runTurn(_input: ModelTurnInput, options?: { onChunk?: (c: string) => void }): Promise<ModelTurn> {
        for (const c of ['你好', '，作者', '！']) options?.onChunk?.(c);
        return { type: 'final', answer: '你好，作者！', usage: usage(1, 3) };
      }
    }
    const { workspace } = setup([]);
    const runtime = createAgentRuntime(workspace, new StreamingAdapter());
    const chunks: string[] = [];
    const result = await runtime.coordinator.run({
      taskKind: 'chat',
      messages: [userMessage('m1', 'hi')],
      onChunk: (c) => chunks.push(c),
    });
    expect(chunks).toEqual(['你好', '，作者', '！']);
    expect(result.finalAnswer).toBe('你好，作者！');
  });

  it('工具失败：记录 failed 追踪并把错误作为观察返回，运行继续', async () => {
    const { runtime } = setup([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'read_node', { nodeId: 'ghost' })], usage: usage(5, 1) },
      { type: 'final', answer: '节点不存在。', usage: usage(10, 2) },
    ]);
    const result = await runtime.coordinator.run({ taskKind: 'chat', messages: [userMessage('m1', '读一个节点')] });
    expect(result.error).toBeUndefined();
    expect(result.finalAnswer).toBe('节点不存在。');
    const aiMsg = runtime.workspace.conversation.readMessages().find((m) => m.role === 'ai')!;
    expect(aiMsg.toolTrace![0].status).toBe('failed');
    expect(aiMsg.toolTrace![0].error).toContain('节点不存在');
  });

  it('工具调用协议：assistant(tool_calls) 与其 tool 结果成对（DeepSeek 400 校验）', async () => {
    const { workspace } = setup([]);
    const script: ScriptedTurn[] = [
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'search_nodes', { query: 'x' })], usage: usage(5, 2) },
      { type: 'tool_calls', toolCalls: [toolCall('c2', 'read_node', { nodeId: 'v1' })], usage: usage(8, 2) },
      { type: 'final', answer: '完成', usage: usage(10, 2) },
    ];
    const recording = new RecordingAdapter(new ScriptedModelAdapter(script));
    const runtime = createAgentRuntime(workspace, recording);
    await runtime.coordinator.run({ taskKind: 'chat', messages: [userMessage('m1', '查一下')] });

    const inputs = recording.inputs;
    expect(inputs).toHaveLength(3);
    // 第二轮：历史 user + assistant(tool_calls) + tool 结果
    const second = inputs[1].messages;
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect((second[1] as { tool_calls?: Array<{ name: string }> }).tool_calls?.[0].name).toBe('search_nodes');
    expect((second[2] as { tool_call_id: string }).tool_call_id).toBe('c1');
    // 第三轮：user + 第一对 + 第二对（每对 = assistant(tool_calls) + tool）
    const third = inputs[2].messages;
    expect(third.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool']);
    expect((third[3] as { tool_calls?: Array<{ name: string }> }).tool_calls?.[0].name).toBe('read_node');
    expect((third[4] as { tool_call_id: string }).tool_call_id).toBe('c2');
    // tool_calls 的 arguments 以对象形式传给模型输入（transport 会序列化）
    expect((third[1] as { tool_calls?: Array<{ arguments: unknown }> }).tool_calls![0].arguments).toEqual({ query: 'x' });
  });

  it('UI 推送回调抛错不中断 run（webContents 已销毁场景，§8.1）', async () => {
    class StreamingAdapter implements ModelAdapter {
      readonly provider = 'streaming';
      async runTurn(_input: ModelTurnInput, options?: { onChunk?: (c: string) => void }): Promise<ModelTurn> {
        for (const c of ['你', '好']) options?.onChunk?.(c);
        return { type: 'final', answer: '你好', usage: usage(1, 3) };
      }
    }
    const { workspace } = setup([]);
    const runtime = createAgentRuntime(workspace, new StreamingAdapter());
    const result = await runtime.coordinator.run({
      taskKind: 'chat',
      messages: [userMessage('m1', 'hi')],
      onChunk: () => { throw new Error('Object has been destroyed'); },
      onToolTrace: () => { throw new Error('Object has been destroyed'); },
    });
    // 回调异常被隔离：run 正常完成、回答落盘
    expect(result.error).toBeUndefined();
    expect(result.finalAnswer).toBe('你好');
    const aiMsg = workspace.conversation.readMessages().find((m) => m.role === 'ai')!;
    expect(aiMsg.content).toBe('你好');
  });

  it('工具追踪回调抛错不中断工具执行', async () => {
    const { workspace, runtime } = setup([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'search_nodes', { query: 'x' })], usage: usage(5, 2) },
      { type: 'final', answer: '完成', usage: usage(8, 2) },
    ]);
    const result = await runtime.coordinator.run({
      taskKind: 'chat',
      messages: [userMessage('m1', '查')],
      onToolTrace: () => { throw new Error('push failed'); },
    });
    expect(result.error).toBeUndefined();
    expect(result.toolCallCount).toBe(1);
  });

  it('chat 任务的模型输入不包含任何写入工具（物理隔离）；包含服务端联网搜索', async () => {
    const { runtime } = setup([{ type: 'final', answer: '好', usage: usage(1, 1) }]);
    const recording = new RecordingAdapter(new ScriptedModelAdapter());
    const chatRuntime = createAgentRuntime(runtime.workspace, recording);
    await chatRuntime.coordinator.run({ taskKind: 'chat', messages: [userMessage('m1', 'hi')] });
    const toolNames = recording.inputs[0].tools?.map((t) => t.name) ?? [];
    expect(toolNames).toEqual([
      'search_nodes', 'search_conversation', 'read_node', 'read_draft', 'list_nodes',
      'read_asset', 'list_assets', 'list_attachments', 'read_attachment', 'list_all_attachments', 'read_any_attachment', 'read_visible_view',
      'web_search',
    ]);
  });

  it('附件范围（Part 2）：上下文消息引用的附件可读；未引用的越界拒绝', async () => {
    const { projectDir } = makeProject('测试项目');
    tempDirs.push(projectDir);
    const workspace = ProjectWorkspace.open(projectDir)!;
    const inScope = workspace.attachments.createAttachment('本会话附件', 'A', 'pasted');
    const outOfScope = workspace.attachments.createAttachment('别的会话附件', 'B', 'pasted');
    const runtime = createAgentRuntime(workspace, new ScriptedModelAdapter([
      {
        type: 'tool_calls',
        toolCalls: [
          toolCall('c1', 'read_attachment', { attachmentId: inScope.id }),
          toolCall('c2', 'read_attachment', { attachmentId: outOfScope.id }),
        ],
        usage: usage(10, 2),
      },
      { type: 'final', answer: '完成', usage: usage(20, 5) },
    ]));
    const refMessage: ChatMessage = {
      id: 'm1',
      role: 'user',
      content: `（附件：${inScope.name}）`,
      timestamp: 't',
      refs: { attachmentIds: [inScope.id] },
    };

    const traceStatus: Record<string, string> = {};
    const result = await runtime.coordinator.run({
      taskKind: 'chat',
      messages: [refMessage],
      onToolTrace: (t) => { traceStatus[t.args.attachmentId as string] = t.status; },
    });

    expect(result.error).toBeUndefined();
    expect(traceStatus[inScope.id]).toBe('completed');
    expect(traceStatus[outOfScope.id]).toBe('failed');
    // 越界读取失败的原因：范围外拒绝（模型看到失败结果，附提示信息）
    const aiMsg = workspace.conversation.readMessages().find((m) => m.role === 'ai')!;
    const failedTrace = aiMsg.toolTrace!.find((t) => t.args.attachmentId === outOfScope.id)!;
    expect(failedTrace.error).toContain('不在当前会话范围内');
    // 删除会话后（日志不再引用）→ 同样越界：证明附件不随会话可见
    const deletedAtt = workspace.attachments.createAttachment('已删会话附件', 'C', 'pasted');
    const blocked = await runtime.registry.get('read_attachment')!.execute(
      { projectDir: workspace.dir, runId: 'r', recordChange: () => {}, attachmentScope: new Set([inScope.id]) },
      { attachmentId: deletedAtt.id },
    );
    expect(blocked.ok).toBe(false);
  });

  it('parentMessageId：运行事件与 AI 回答挂入消息树；结束事件挂在回答下（§3.2 活动路径）', async () => {
    const { workspace, runtime } = setup([
      { type: 'final', answer: '回复。', usage: usage(1, 1) },
    ]);
    workspace.conversation.appendMessage(userMessage('m1', '问题'));
    const result = await runtime.coordinator.run({
      taskKind: 'chat',
      messages: [userMessage('m1', '问题')],
      parentMessageId: 'm1',
    });
    expect(result.error).toBeUndefined();
    const messages = workspace.conversation.readMessagesWithTree();
    const m1 = messages.find((m) => m.id === 'm1')!;
    // m1 的孩子 = 运行开始 + AI 回答（运行结束挂 AI 回答下 → 活动路径含回答+结束）
    expect(m1.childrenIds).toHaveLength(2);
    const aiMsg = messages.find((m) => m.role === 'ai')!;
    expect(aiMsg.parentId).toBe('m1');
    expect(aiMsg.childrenIds).toHaveLength(1);
    expect(aiMsg.childrenIds![0]).toBe(messages.at(-1)!.id);
    expect(messages.at(-1)!.role).toBe('system');
    expect(messages.at(-1)!.parentId).toBe(aiMsg.id);
    // 活动路径：m1 → AI 回答 → 运行结束（回答不丢）
    expect(workspace.conversation.getActiveMessageId()).toBe(messages.at(-1)!.id);
    expect(workspace.conversation.readActivePath().map((m) => m.id)).toEqual(['m1', aiMsg.id, messages.at(-1)!.id]);
  });
});

describe('E2E — organize（写入 + 变更摘要 + 回滚/接受）', () => {
  it('创建节点→写草稿→写设定→final；快照、变更摘要、光标推进；回滚后全部恢复', async () => {
    const { workspace, runtime } = setup([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'create_node', { type: 'volume', title: '第一卷', nodeId: 'v1' })], usage: usage(10, 3) },
      { type: 'tool_calls', toolCalls: [toolCall('c2', 'write_draft', { nodeId: 'v1', content: '主角是侦探。' })], usage: usage(20, 3) },
      { type: 'tool_calls', toolCalls: [toolCall('c3', 'write_asset', { type: 'character', title: '主角', content: '侦探' })], usage: usage(30, 3) },
      { type: 'final', answer: '已整理：1 节点、1 设定。', usage: usage(40, 8) },
    ]);
    workspace.conversation.appendMessage(userMessage('m1', '主角是侦探'));
    workspace.conversation.appendMessage(userMessage('m2', '他住在青石镇'));
    workspace.conversation.appendMessage(userMessage('m3', '第一幕在码头'));
    workspace.conversation.setOrganizeCursor('m1');

    const result = await runtime.coordinator.run({
      taskKind: 'organize',
      scope: '第 m2–m3 轮未整理对话',
      messages: [
        userMessage('m2', '他住在青石镇'),
        userMessage('m3', '第一幕在码头'),
      ],
    });

    expect(result.error).toBeUndefined();
    expect(result.snapshotId).toBe(result.runId);
    expect(result.writeToolCalls).toBe(3);
    expect(result.changes).toEqual([
      { action: 'node_created', nodeId: 'v1', parentId: 'overview', title: '第一卷' },
      expect.objectContaining({ action: 'draft_updated', nodeId: 'v1' }),
      expect.objectContaining({ action: 'asset_created', type: 'character', title: '主角' }),
    ]);

    // 写入真实落盘
    expect(workspace.outline.findNode('v1')?.aiCreated).toBe(true);
    expect(workspace.outline.readDraft('v1')).toBe('主角是侦探。');
    expect(workspace.assets.listAssets()[0].content).toBe('侦探');

    // Part 4：光标推进已上移到 app-service（run-loop 不再触碰光标；沙箱化后日志零新增）
    expect(workspace.conversation.getOrganizeCursor()).toBe('m1');
    expect(workspace.conversation.readMessages()).toHaveLength(3);

    // 快照 + 变更摘要落盘
    expect(workspace.snapshots.hasSnapshot(result.runId)).toBe(true);
    const summary = readRunSummary(workspace, result.runId)!;
    expect(summary.scope).toBe('第 m2–m3 轮未整理对话');
    expect(summary.changes).toHaveLength(3);
    expect(summary.snapshotId).toBe(result.runId);

    // ---- 回滚：全部恢复 ----
    const restored = rollbackRun(workspace, result.runId);
    expect(restored.length).toBeGreaterThan(0);
    expect(workspace.outline.findNode('v1')).toBeNull();
    expect(workspace.outline.readDraft('v1')).toBe('');
    expect(workspace.assets.listAssets()).toEqual([]);
    // 日志零新增（organize 沙箱化：不写运行事件、不写 AI 回答，Part 4）
    expect(workspace.conversation.readMessages().length).toBe(3);
  });

  it('接受：保留草稿与设定，清除 aiCreated 标记', async () => {
    const { workspace, runtime } = setup([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'create_node', { type: 'volume', title: '第一卷', nodeId: 'v1' })], usage: usage(5, 2) },
      { type: 'final', answer: '完成', usage: usage(10, 2) },
    ]);
    const result = await runtime.coordinator.run({ taskKind: 'organize', messages: [userMessage('m1', '建个卷')] });
    expect(workspace.outline.findNode('v1')?.aiCreated).toBe(true);

    acceptRun(workspace, result.runId);
    expect(workspace.outline.findNode('v1')?.aiCreated).toBeUndefined();
    expect(workspace.outline.findNode('v1')).not.toBeNull();
  });

  it('任务失败（模型轮次耗尽）不推进光标，回滚可用', async () => {
    const { workspace, runtime } = setup([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'create_node', { type: 'volume', title: 'V', nodeId: 'v1' })], usage: usage(1, 1) },
    ]);
    workspace.conversation.appendMessage(userMessage('m1', '整理'));
    const result = await runtime.coordinator.run({
      taskKind: 'organize',
      messages: [userMessage('m1', '整理')],
      maxTurns: 1,
    });
    expect(result.error).toBe('RUN_TURNS_EXCEEDED');
    expect(workspace.conversation.getOrganizeCursor()).toBeUndefined();
    expect(workspace.snapshots.hasSnapshot(result.runId)).toBe(true);
    rollbackRun(workspace, result.runId);
    expect(workspace.outline.findNode('v1')).toBeNull();
  });

  it('整理硬门禁（Part 4）：未调用任何写入工具 → ORGANIZE_NO_WRITE_TOOL，光标不动', async () => {
    const { workspace, runtime } = setup([
      // 只读工具 + 大段分析式回答 = 把整理当讨论
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'read_node', { nodeId: 'overview' })], usage: usage(10, 2) },
      { type: 'final', answer: '这份设定我逐条看了……请选一个方向往下钻。', usage: usage(20, 5) },
    ]);
    workspace.conversation.appendMessage(userMessage('m1', '整理这些讨论'));
    const result = await runtime.coordinator.run({
      taskKind: 'organize',
      messages: [userMessage('m1', '整理这些讨论')],
    });
    expect(result.error).toContain('ORGANIZE_NO_WRITE_TOOL');
    expect(result.writeToolCalls).toBe(0);
    // 不推进光标（内容保持未整理）；快照仍建（可回滚）
    expect(workspace.conversation.getOrganizeCursor()).toBeUndefined();
    expect(workspace.snapshots.hasSnapshot(result.runId)).toBe(true);
    // 沙箱化：日志零新增
    expect(workspace.conversation.readMessages()).toHaveLength(1);
  });
});

describe('E2E — detail_fill（正文生成，§6.5 全管道）', () => {
  function setupSceneWithView(projectName = '测试项目') {
    const { projectDir, workspace, runtime } = setup([], projectName);
    workspace.outline.createNode('overview', { id: 's1', type: 'scene', title: '天桥决斗', children: [] });
    workspace.outline.writeDraft('s1', '陈默（{{暂不明示：陈默是凶手}}）约林静见面。');
    workspace.visibleViews.write({
      sceneId: 's1',
      content: '陈默（）约林静见面。',
      sourceHash: require('crypto').createHash('sha256').update('陈默（{{暂不明示：陈默是凶手}}）约林静见面。').digest('hex'),
      userEdited: false,
      needsRegeneration: false,
      generatedAt: new Date().toISOString(),
    });
    return { projectDir, workspace, runtime };
  }

  it('可见视图（无标记）→ 模板 → write_output 落盘；快照含 outputs；回滚恢复', async () => {
    const { workspace, runtime } = setupSceneWithView();
    const script: ScriptedTurn[] = [
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'read_visible_view', { sceneId: 's1' })], usage: usage(10, 3) },
      { type: 'tool_calls', toolCalls: [toolCall('c2', 'read_format_template', { format: 'novel' })], usage: usage(20, 3) },
      { type: 'tool_calls', toolCalls: [toolCall('c3', 'write_output', { sceneId: 's1', format: 'novel', content: '正文正文' })], usage: usage(30, 6) },
      { type: 'final', answer: '完成。', usage: usage(40, 4) },
    ];
    const runtime2 = createAgentRuntime(workspace, new ScriptedModelAdapter(script));
    const result = await runtime2.coordinator.run({
      taskKind: 'detail_fill',
      messages: [userMessage('m1', '为场景 s1 生成 novel 正文')],
      scope: '生成正文：s1 · novel',
    });
    expect(result.error).toBeUndefined();
    expect(workspace.outputs.exists('s1', 'novel')).toBe(true);
    expect(workspace.outputs.read('s1', 'novel')).toBe('正文正文');
    // 快照（detail_fill 是可写任务）
    expect(workspace.snapshots.hasSnapshot(result.runId)).toBe(true);
    // 沙箱隔离（ux-review §5.2 修订）：写作任务在对话日志中零痕迹
    expect(workspace.conversation.readMessages()).toEqual([]);
    // 正文生成器物理上只能看到可见视图内容，看不到标记（§6.5 知识边界）
    expect(workspace.visibleViews.read('s1')!.content).not.toContain('暂不明示');

    // 回滚 → 输出恢复为运行前状态（无输出）
    const restored = rollbackRun(workspace, result.runId);
    expect(restored.length).toBeGreaterThan(0);
    expect(workspace.outputs.exists('s1', 'novel')).toBe(false);
  });
});

describe('E2E — 知识边界（§8.2 硬隔离）', () => {
  it('detail_fill 模型输入里看不到任何节点/设定/材料工具', async () => {
    const { runtime } = setup([{ type: 'final', answer: 'ok', usage: usage(1, 1) }]);
    const recording = new RecordingAdapter(new ScriptedModelAdapter());
    const detailRuntime = createAgentRuntime(runtime.workspace, recording);
    await detailRuntime.coordinator.run({ taskKind: 'detail_fill', messages: [userMessage('m1', '写正文')] });
    const toolNames = recording.inputs[0].tools?.map((t) => t.name) ?? [];
    expect(toolNames).toEqual(['read_visible_view', 'read_format_template', 'write_output']);
  });

  it('detail_fill 尝试调用 list_nodes：白名单硬拒绝，运行以错误终止', async () => {
    const { workspace, runtime } = setup([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'list_nodes', {})], usage: usage(5, 2) },
    ]);
    const traces: ToolCallTrace[] = [];
    const result = await runtime.coordinator.run({
      taskKind: 'detail_fill',
      messages: [userMessage('m1', '生成正文')],
      onToolTrace: (t) => traces.push(t),
    });
    expect(result.error).toContain('TOOL_NOT_IN_WHITELIST');
    // 最后一次推送是 failed 快照
    expect(traces.at(-1)!.status).toBe('failed');
    expect(traces.at(-1)!.error).toContain('TOOL_NOT_IN_WHITELIST');
    // 失败运行不写 AI 消息
    expect(workspace.conversation.readMessages().filter((m) => m.role === 'ai')).toHaveLength(0);
    // 无任何写入
    expect(workspace.outputs.listFormatsForScene('s1')).toEqual([]);
  });

  it('chat 尝试调用 write_draft：同样被硬拒绝', async () => {
    const { runtime } = setup([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'write_draft', { nodeId: 'v1', content: 'x' })], usage: usage(5, 2) },
    ]);
    const result = await runtime.coordinator.run({ taskKind: 'chat', messages: [userMessage('m1', '帮我写草稿')] });
    expect(result.error).toContain('TOOL_NOT_IN_WHITELIST');
  });
});

describe('E2E — 模型错误传导（不静默）', () => {
  it('模型调用抛错 → result.error 可见，结束事件记录错误，不产生空 AI 消息', async () => {
    class ThrowingAdapter implements ModelAdapter {
      readonly provider = 'throwing';
      async runTurn(): Promise<ModelTurn> {
        throw Object.assign(new Error('DeepSeek API error (401): invalid key'), { code: 'auth_error' });
      }
    }
    const { workspace } = setup([]);
    const runtime = createAgentRuntime(workspace, new ThrowingAdapter());
    const result = await runtime.coordinator.run({ taskKind: 'chat', messages: [userMessage('m1', '你好')] });
    expect(result.error).toContain('MODEL_ERROR');
    expect(result.error).toContain('401');
    expect(result.finalAnswer).toBe('');
    // 无 AI 消息（不把失败伪装成回答）
    expect(workspace.conversation.readMessages().filter((m) => m.role === 'ai')).toHaveLength(0);
    // 结束 system 事件里记录错误（对话内可见）
    const sysEnd = workspace.conversation.readMessages().filter((m) => m.role === 'system').at(-1)!;
    expect(sysEnd.content).toContain('错误：MODEL_ERROR');
  });
});

describe('E2E — 取消与上限', () => {
  it('AbortSignal 取消：运行标记 cancelled，无写入推进', async () => {
    const { workspace } = setup([]);
    class HangingAdapter implements ModelAdapter {
      readonly provider = 'hanging';
      async runTurn(_input: ModelTurnInput, options?: { signal?: AbortSignal }): Promise<ModelTurn> {
        return new Promise((resolve) => {
          options?.signal?.addEventListener('abort', () =>
            resolve({ type: 'final', answer: '', usage: usage(0, 0) }),
          );
        });
      }
    }
    const runtime = createAgentRuntime(workspace, new HangingAdapter());
    const controller = new AbortController();
    const promise = runtime.coordinator.run({
      taskKind: 'chat',
      messages: [userMessage('m1', '慢慢想')],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    const result = await promise;
    expect(result.cancelled).toBe(true);
    expect(result.error).toBeUndefined();
    expect(workspace.conversation.getOrganizeCursor()).toBeUndefined();
  });

  it('超过 maxTurns 报 RUN_TURNS_EXCEEDED', async () => {
    const { runtime } = setup([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'search_nodes', { query: 'x' })], usage: usage(1, 1) },
    ]);
    const result = await runtime.coordinator.run({ taskKind: 'chat', messages: [userMessage('m1', 'hi')], maxTurns: 1 });
    expect(result.error).toBe('RUN_TURNS_EXCEEDED');
  });
});
