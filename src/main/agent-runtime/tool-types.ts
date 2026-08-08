/**
 * tool-types.ts — 工具契约（design doc §8.2）。
 *
 * 工具白名单只用于知识边界，不做行为限制（无审批、无风险分级、无策略引擎）。
 * 每个工具调用产生 ToolResult（含证据引用）。
 *
 * EvidenceRef 从 src/shared/types.ts 导入（单一来源）。
 */

import type { EvidenceRef } from '../../shared/types';

/** JSON Schema 定义（用于工具入参/出参） */
export type JsonSchema<T> = Record<string, unknown> & { _brand?: T };

// Re-export EvidenceRef from shared/types.ts (single source of truth)
export type { EvidenceRef };

/** 工具执行结果 */
export interface ToolResult<T = unknown> {
  /** 是否成功 */
  ok: boolean;
  /** 结果数据（仅 ok 时存在） */
  data?: T;
  /** 错误详情（仅失败时存在） */
  error?: { code: string; message: string; retryable: boolean };
  /** 支撑本结果引用的来源证据 */
  evidence: EvidenceRef[];
  /** 结果是否被截断（例如大内容） */
  truncated?: boolean;
}

/** 工具执行上下文 */
export interface ToolContext {
  /** 工具操作的项目目录 */
  projectDir: string;
  /** 当前 run id */
  runId: string;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 记录一条变更项（仅写工具使用；由 RunCoordinator 注入） */
  recordChange: (change: import('../../shared/types').ChangeItem) => void;
  /**
   * 当前 run 可见的附件范围（本会话上下文消息引用的附件 id，由 RunCoordinator 注入）。
   * 缺省（undefined）= 不限制（工具直接执行，如单元测试）。
   * 附件读取工具据此硬性过滤：范围外的附件默认不可见；跨会话读取须作者显式要求。
   */
  attachmentScope?: ReadonlySet<string>;
  /**
   * 资源能力边界（P1 修复）：当前 run 被允许访问的场景与格式
   * （detail_fill / revise 由 app-service 注入；chat / organize 缺省不限制）。
   * 正文相关工具（read_visible_view / read_format_template / write_output /
   * read_output）执行器层强制比对模型传入值，越界直接拒绝。
   */
  allowedSceneId?: string;
  allowedFormat?: string;
}

/** 工具规格 */
export interface ToolSpec<TArgs = unknown, TResult = unknown> {
  /** 唯一工具名 */
  name: string;
  /** 给模型的描述 */
  description: string;
  /** 入参 JSON Schema */
  inputSchema: JsonSchema<TArgs>;
  /** 出参 JSON Schema */
  outputSchema: JsonSchema<TResult>;
  /** 执行工具 */
  execute(ctx: ToolContext, args: TArgs): Promise<ToolResult<TResult>>;
}
