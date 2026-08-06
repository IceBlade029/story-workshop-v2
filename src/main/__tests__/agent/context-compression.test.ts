/**
 * context-compression.test.ts — 两阶段压缩（§7.2、§7.3、§7.4）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { ProjectWorkspace } from '../../storage/workspace';
import { ScriptedModelAdapter, type ScriptedTurn } from '../../agent-runtime/scripted-model-adapter';
import type { ModelAdapter, ModelTurnInput, ModelTurn } from '../../agent-runtime/model-types';
import {
  CONTEXT_BUDGET_TOKENS,
  RECENT_ROUNDS_KEPT,
  estimatePathTokens,
  planCompression,
  safelyTrim,
  formatPrefix,
  compressSystemPrompt,
  runCompressionTask,
  summaryMessage,
  MAX_OUTPUT_TOKENS,
} from '../../agent-runtime/context-compression';
import { makeProject, removeDir } from '../helpers/temp-project';
import type { ChatMessage } from '../../../shared/types';

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(removeDir));

function usage(i: number, o: number) {
  return { inputTokens: i, outputTokens: o };
}

function msg(id: string, role: ChatMessage['role'], content: string, parentId?: string): ChatMessage {
  return { id, role, content, timestamp: `t${id}`, parentId };
}

/** 记录每次模型输入的适配器。 */
class RecordingAdapter implements ModelAdapter {
  readonly provider = 'recording';
  readonly inputs: ModelTurnInput[] = [];
  constructor(private readonly inner: ModelAdapter) {}
  async runTurn(input: ModelTurnInput, options?: unknown): Promise<ModelTurn> {
    this.inputs.push(input);
    return this.inner.runTurn(input, options as never);
  }
}

/** 构造一条足以触发压缩的长对话（每条约 850 字 ≈ 570 token）。 */
function longPath(count = 40): ChatMessage[] {
  const path: ChatMessage[] = [];
  for (let i = 1; i <= count; i++) {
    path.push(msg(`m${i}`, i % 2 === 1 ? 'user' : 'ai', `第 ${i} 轮讨论内容：${'这是一段足够长的讨论文本，'.repeat(60)}`, i > 1 ? `m${i - 1}` : undefined));
  }
  return path;
}

function makeWorkspace(): ProjectWorkspace {
  const { projectDir } = makeProject();
  tempDirs.push(projectDir);
  return ProjectWorkspace.open(projectDir)!;
}

describe('预算估算与触发条件（§7.3）', () => {
  it('短对话不触发压缩；长对话触发', () => {
    const ws = makeWorkspace();
    const short = [msg('a', 'user', '你好'), msg('b', 'ai', '你好，作者。')];
    expect(planCompression(ws, short).needsCompression).toBe(false);
    expect(planCompression(ws, longPath()).needsCompression).toBe(true);
  });

  it('触发阈值 = 预算 - 回答预留 - 15% 预留窗口', () => {
    const ws = makeWorkspace();
    const headroom = CONTEXT_BUDGET_TOKENS - MAX_OUTPUT_TOKENS - Math.floor(CONTEXT_BUDGET_TOKENS * 0.15);
    // 一条大消息 + 7 条后续（可压缩形状：保留最近 6 条，首条进摘要范围）
    const tail = ['后话一', '回答一', '后话二', '回答二', '后话三', '回答三', '收尾']
      .map((c, i) => msg(`m${i + 2}`, i % 2 === 0 ? 'user' : 'ai', c));
    const justOver = [msg('m1', 'user', 'x'.repeat(Math.floor(headroom * 1.5) + 1)), ...tail];
    const justUnder = [msg('m1', 'user', 'x'.repeat(Math.floor(headroom * 1.5) - 10000)), ...tail];
    expect(estimatePathTokens(justOver)).toBeGreaterThan(headroom);
    expect(estimatePathTokens(justUnder)).toBeLessThanOrEqual(headroom);
    expect(planCompression(ws, justOver).needsCompression).toBe(true);
    expect(planCompression(ws, justUnder).needsCompression).toBe(false);
  });

  it('保留最近几轮原文，锚点 = 被压缩前缀最后一条消息', () => {
    const ws = makeWorkspace();
    const path = longPath(40);
    const plan = planCompression(ws, path);
    expect(plan.needsCompression).toBe(true);
    const keptNonSystem = path.slice(plan.keptFrom).filter((m) => m.role !== 'system').length;
    expect(keptNonSystem).toBe(RECENT_ROUNDS_KEPT);
    expect(plan.anchor).toBe(path[plan.keptFrom - 1].id);
  });

  it('压缩阻断（§7.4）：不压缩，按原文继续', () => {
    const ws = makeWorkspace();
    ws.conversation.updateMeta({ compressionBlocked: true });
    const plan = planCompression(ws, longPath());
    expect(plan.needsCompression).toBe(false);
    expect(plan.blocked).toBe(true);
  });
});

describe('阶段 1 — 确定性安全裁剪（§7.3）', () => {
  it('移除可重读的记账 system 事件（运行开始/结束），保留其余一切', () => {
    const path = [
      msg('s1', 'system', '运行开始（chat）'),
      msg('u1', 'user', '用户原话'),
      msg('a1', 'ai', 'AI 回答'),
      msg('s2', 'system', '运行结束（chat）\n本次范围：…'),
      msg('s3', 'system', '（消息已编辑）原内容：…'),
    ];
    const trimmed = safelyTrim(path);
    expect(trimmed.map((m) => m.id)).toEqual(['u1', 'a1', 's3']);
  });

  it('formatPrefix 保留角色标签与用户原话', () => {
    const text = formatPrefix([msg('u', 'user', '我决定主角是侦探'), msg('a', 'ai', '好的。')]);
    expect(text).toContain('【作者】我决定主角是侦探');
    expect(text).toContain('【AI】好的。');
  });
});

describe('阶段 2 — 一次摘要任务（§7.3、§7.4）', () => {
  it('成功：单轮 final 输出即摘要；原日志不动', async () => {
    const ws = makeWorkspace();
    const prefix = longPath(34);
    ws.conversation.appendMessage(prefix[0]);
    const before = ws.conversation.countMessages();
    const outcome = await runCompressionTask(
      ws,
      new ScriptedModelAdapter([{ type: 'final', answer: '## 已确认决策\n…', usage: usage(100, 50) }]),
      prefix,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('## 已确认决策');
    expect(ws.conversation.countMessages()).toBe(before); // 日志不可变
  });

  it('压缩任务不提供任何工具（只读，§7.3）', async () => {
    const recording = new RecordingAdapter(
      new ScriptedModelAdapter([{ type: 'final', answer: 'ok', usage: usage(1, 1) }]),
    );
    const ws = makeWorkspace();
    await runCompressionTask(ws, recording, longPath(20));
    expect(recording.inputs[0].tools).toBeUndefined();
    expect(recording.inputs[0].systemPrompt).toContain('只读，没有任何工具');
  });

  it('重点提示进入系统提示（只影响详略）', () => {
    const prompt = compressSystemPrompt('重点：主角动机');
    expect(prompt).toContain('重点：主角动机');
    expect(prompt).toContain('只影响详略，不改变内容权威');
  });

  it('恢复链：第一次失败（工具调用）→ 第二次成功', async () => {
    const ws = makeWorkspace();
    const script: ScriptedTurn[] = [
      { type: 'tool_calls', toolCalls: [{ id: 't1', name: 'search_nodes', arguments: {} }], usage: usage(10, 2) },
      { type: 'final', answer: '## 已确认决策\n摘要', usage: usage(20, 10) },
    ];
    const outcome = await runCompressionTask(ws, new ScriptedModelAdapter(script), longPath(30));
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('已确认决策');
  });

  it('恢复链耗尽：blocked，绝不把残缺摘要标记为成功（§7.4）', async () => {
    const ws = makeWorkspace();
    const script: ScriptedTurn[] = [
      { type: 'tool_calls', toolCalls: [{ id: 't1', name: 'x', arguments: {} }], usage: usage(1, 1) },
      { type: 'tool_calls', toolCalls: [{ id: 't2', name: 'y', arguments: {} }], usage: usage(1, 1) },
      { type: 'tool_calls', toolCalls: [{ id: 't3', name: 'z', arguments: {} }], usage: usage(1, 1) },
    ];
    const outcome = await runCompressionTask(ws, new ScriptedModelAdapter(script), longPath(30));
    expect(outcome.ok).toBe(false);
    expect(outcome.blocked).toBe(true);
    expect(outcome.summary).toBeUndefined();
  });

  it('摘要消息携带锚点，role=system', () => {
    const m = summaryMessage('m10', '摘要正文');
    expect(m.role).toBe('system');
    expect(m.id).toBe('summary-m10');
    expect(m.content).toContain('#m10');
    expect(m.content).toContain('摘要正文');
  });
});
