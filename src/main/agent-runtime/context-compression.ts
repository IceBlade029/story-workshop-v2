/**
 * context-compression.ts — 两阶段压缩与上下文组装（design doc §7.2、§7.3、§7.4）。
 *
 * 触发条件：预计下一轮输入 + 预留回答空间 + 预留工具结果空间 > 模型上下文预算
 * （预留默认 ≈ 15% 窗口，回答按模型输出上限预留）。
 *
 * 阶段 1 — 确定性安全裁剪（safelyTrim）：移除较早消息中可重新读取的记账内容
 * （运行开始/结束 system 事件；可经运行摘要重读）。永不裁剪：用户原话、用户
 * 决定、未完成任务、最近几轮对话（§7.3）。
 *
 * 阶段 2 — 一次摘要：把裁剪后的前缀交给一次只读压缩任务，生成结构化摘要
 * （已确认决策 / 已有事实 / 候选方案 / 待定问题 / 重要用户原话 / 引用清单）。
 * 压缩任务没有写入工具（§7.3）。原日志不动；摘要按分支锚点（被压缩前缀的
 * 最后一条消息 id）落盘 conversation/summaries/<anchor>.md，分支各自维护，
 * 切换后惰性重算（§7.2）。
 *
 * 恢复链（§7.4）：再做一次确定性裁剪 → 缩小摘要范围 → 降低摘要长度 →
 * 置 compressionBlocked 暂停自动压缩，明确提示「原始对话没有丢失」。
 * 禁止把残缺摘要标记为成功。
 */
import type { ChatMessage, RunRecord } from '../../shared/types';
import type { ProjectWorkspace } from '../storage/workspace';
import type { ModelAdapter } from './model-types';
import { persistRunRecord } from './run-recorder';
import { generateId } from '../storage/id';

/** 模型上下文预算（token；DeepSeek V4 系列窗口 1M，留 10% 余量） */
export const CONTEXT_BUDGET_TOKENS = 900_000;
/** 预留窗口比例（§7.3 预留默认 ≈ 15%） */
export const RESERVE_RATIO = 0.15;
/** 回答空间预留（按模型输出上限；V4 最大 384K，这里保守取 8K 平衡成本） */
export const MAX_OUTPUT_TOKENS = 8192;
/** 最近保留原文的轮数（§7.3「最近几轮」） */
export const RECENT_ROUNDS_KEPT = 6;
/** 系统提示 + 工具描述的开销估算（token） */
export const OVERHEAD_TOKENS = 2000;
/** 字符→token 估算：中文约 1 token/字，英文约 4 字符/token，取 1.5 折中 */
export const CHARS_PER_TOKEN = 1.5;

export function estimateTokens(text: string): number {
  return estimateCharCount(text.length);
}

/** 按字符数估算 token（中文约 1 token/字，英文约 4 字符/token，取 1.5 折中）。 */
export function estimateCharCount(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function messageTokens(m: ChatMessage): number {
  let chars = m.content.length;
  if (m.toolTrace) chars += JSON.stringify(m.toolTrace).length;
  if (m.refs) chars += JSON.stringify(m.refs).length;
  return estimateCharCount(chars);
}

/** 估算一条对话路径的总输入（含固定开销）。 */
export function estimatePathTokens(path: ChatMessage[]): number {
  return OVERHEAD_TOKENS + path.reduce((sum, m) => sum + messageTokens(m), 0);
}

export interface CompressionPlan {
  /** 是否需要在本次组装中压缩 */
  needsCompression: boolean;
  /** 保留原文的起始下标（path[keptFrom..] 原样进入上下文；0 = 全部保留） */
  keptFrom: number;
  /** 摘要锚点：被压缩前缀的最后一条消息 id */
  anchor?: string;
  /** 被阻断（§7.4）：不压缩，按原文继续 */
  blocked?: boolean;
}

/**
 * 压缩规划（纯确定性，不调用模型）：判断是否超预算、计算保留边界与锚点。
 * 压缩阻断（compressionBlocked）时返回 needsCompression=false（按原文继续）。
 */
export function planCompression(workspace: ProjectWorkspace, path: ChatMessage[]): CompressionPlan {
  const headroom = CONTEXT_BUDGET_TOKENS - MAX_OUTPUT_TOKENS - Math.floor(CONTEXT_BUDGET_TOKENS * RESERVE_RATIO);
  if (estimatePathTokens(path) <= headroom) return { needsCompression: false, keptFrom: 0 };

  if (workspace.conversation.readMeta().compressionBlocked) {
    return { needsCompression: false, keptFrom: 0, blocked: true };
  }

  // 保留尾部最近 RECENT_ROUNDS_KEPT 条非 system 消息（及附着其间的记账事件）
  let keptFrom = path.length;
  let nonSystemSeen = 0;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].role !== 'system') nonSystemSeen++;
    if (nonSystemSeen >= RECENT_ROUNDS_KEPT) {
      keptFrom = i;
      break;
    }
    keptFrom = i;
  }
  if (keptFrom <= 0) return { needsCompression: false, keptFrom: 0 };
  return { needsCompression: true, keptFrom, anchor: path[keptFrom - 1].id };
}

/** 确定性安全裁剪（阶段 1）：移除可重读的记账 system 事件，保留其余一切。 */
export function safelyTrim(prefix: ChatMessage[]): ChatMessage[] {
  return prefix.filter((m) => {
    if (m.role !== 'system') return true;
    return !m.content.startsWith('运行开始（') && !m.content.startsWith('运行结束（');
  });
}

/** 把前缀折叠为压缩任务输入文本（保留角色标签，用户原话不裁剪）。 */
export function formatPrefix(prefix: ChatMessage[]): string {
  return prefix
    .map((m) => {
      const roleLabel = m.role === 'user' ? '作者' : m.role === 'ai' ? 'AI' : '系统';
      return `【${roleLabel}】${m.content}`;
    })
    .join('\n\n');
}

/** 压缩任务系统提示（只读；重点只影响详略，不改变内容权威，§7.3）。 */
export function compressSystemPrompt(focus?: string): string {
  return [
    '你是「故事工坊」的对话压缩任务（只读，没有任何工具，不得检索或写入）。',
    '把给定的较早讨论前缀压缩为结构化摘要，供后续讨论继续使用。',
    '结构（按此顺序）：',
    '## 已确认决策\n## 已有事实\n## 候选方案\n## 待定问题\n## 重要用户原话\n## 引用清单',
    '规则：',
    '- 事实与决策必须来自给定内容，不得新增、不得虚构；',
    '- 重要用户原话可适度原文引用（决定、约束、偏好、故事关键句）；',
    '- 信息不足的栏目写「（无）」，不得编造；',
    '- 摘要应能替代原文继续讨论，但只是派生的便捷品——原文日志始终保留。',
    focus?.trim() ? `重点提示（只影响详略，不改变内容权威）：${focus.trim()}` : '',
  ].filter((l) => l !== '').join('\n');
}

export interface CompressionOutcome {
  ok: boolean;
  summary?: string;
  /** 恢复链已耗尽（§7.4：暂停自动压缩） */
  blocked?: boolean;
  error?: string;
}

/**
 * 阶段 2 压缩任务（一次只读模型调用）。
 *
 * 恢复链（§7.4）：再次确定性裁剪（safelyTrim 已做）→ 缩小摘要范围（前缀减半）
 * → 降低摘要长度（maxTokens 减半）→ 失败返回 blocked，由调用方暂停自动压缩。
 * 压缩任务也记调用详情（§4.7：全部任务一致透明）。
 */
export async function runCompressionTask(
  workspace: ProjectWorkspace,
  model: ModelAdapter,
  prefix: ChatMessage[],
  focus?: string,
): Promise<CompressionOutcome> {
  const trimmed = safelyTrim(prefix);
  const attempts: Array<{ input: ChatMessage[]; maxTokens: number }> = [
    { input: trimmed, maxTokens: MAX_OUTPUT_TOKENS },
    { input: trimmed.slice(0, Math.ceil(trimmed.length / 2)), maxTokens: MAX_OUTPUT_TOKENS },
    { input: trimmed, maxTokens: Math.floor(MAX_OUTPUT_TOKENS / 2) },
  ];
  const startedAt = Date.now();
  const runId = `compress_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let lastError: string | undefined;
  for (const attempt of attempts) {
    try {
      const turn = await model.runTurn(
        {
          systemPrompt: compressSystemPrompt(focus),
          messages: [{ role: 'user', content: formatPrefix(attempt.input) }],
        },
        { maxTokens: attempt.maxTokens },
      );
      if (turn.type === 'final' && turn.answer.trim() !== '') {
        const record: RunRecord = {
          runId,
          taskKind: 'compress',
          scope: `压缩任务（前缀 ${attempt.input.length} 条消息${focus?.trim() ? `，重点：${focus.trim()}` : ''}）`,
          status: 'done',
          durationMs: Date.now() - startedAt,
          turns: 1,
          usage: { inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens },
          sent: {
            systemPrompt: compressSystemPrompt(focus),
            messages: attempt.input.map((m) => ({ ...(m.id ? { messageId: m.id } : {}), role: m.role, source: 'raw' as const, chars: m.content.length })),
            whitelist: [],
          },
          returned: { toolCalls: [], finalAnswer: `压缩摘要（${turn.answer.length} 字，落盘为派生资产）` },
          createdAt: new Date().toISOString(),
        };
        persistRunRecord(workspace, record);
        return { ok: true, summary: turn.answer.trim() };
      }
    } catch (err) {
      lastError = (err as Error).message;
      /* 尝试下一级恢复 */
    }
  }
  const record: RunRecord = {
    runId,
    taskKind: 'compress',
    scope: `压缩任务（前缀 ${trimmed.length} 条消息${focus?.trim() ? `，重点：${focus.trim()}` : ''}）`,
    status: 'error',
    durationMs: Date.now() - startedAt,
    turns: attempts.length,
    usage: { inputTokens: 0, outputTokens: 0 },
    sent: {
      systemPrompt: compressSystemPrompt(focus),
      messages: trimmed.map((m) => ({ ...(m.id ? { messageId: m.id } : {}), role: m.role, source: 'raw' as const, chars: m.content.length })),
      whitelist: [],
    },
    returned: { toolCalls: [], finalAnswer: '', error: lastError ?? '压缩任务连续失败' },
    createdAt: new Date().toISOString(),
  };
  persistRunRecord(workspace, record);
  return { ok: false, blocked: true, error: '压缩任务连续失败（原始对话没有丢失）' };
}

/**
 * 组装进模型输入的摘要消息（role=system，携带锚点 id 供追溯）。
 * refs 透传被压缩前缀消息引用的附件 id——保证附件范围（默认会话内读取）
 * 在压缩后不丢失：摘要消息的 refs 使被压缩掉的附件仍在本轮可见范围内。
 */
export function summaryMessage(anchor: string, summary: string, refs?: { attachmentIds?: string[] }): ChatMessage {
  return {
    id: `summary-${anchor}`,
    role: 'system',
    content: `【已压缩的较早讨论摘要（锚点 #${anchor}）】\n${summary}`,
    timestamp: new Date().toISOString(),
    ...(refs?.attachmentIds && refs.attachmentIds.length > 0 ? { refs } : {}),
  };
}
