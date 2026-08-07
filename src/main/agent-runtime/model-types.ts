/**
 * model-types.ts — Model adapter interface for the agent runtime.
 *
 * Defines the contract between the runtime and LLM backends.
 * The ModelTurn is a discriminated union: either the model calls a tool, or it delivers
 * a final answer. There is no mixture — each turn produces exactly one of these two types.
 */

import type { EvidenceRef, ToolResult, JsonSchema } from './tool-types';

// Note: JsonSchema is imported from tool-types.ts (single source of truth).
// Do NOT redeclare it here — barrel export would produce duplicate identifiers.

/** Token usage for a model turn — required on every ModelTurn variant */
export interface Usage {
  /** Number of input (prompt) tokens consumed */
  inputTokens: number;
  /** Number of output (completion) tokens generated */
  outputTokens: number;
}

/** A tool call request from the model */
export interface ToolCall {
  /** Unique ID for this tool call within the run */
  id: string;
  /** Name matching a registered ToolSpec */
  name: string;
  /** Arguments conforming to the tool's inputSchema */
  arguments: Record<string, unknown>;
}

/**
 * A single model turn — discriminated union.
 *
 * - `tool_calls`: The model requests invocation of one or more tools. The runtime
 *   validates, authorizes, executes, and feeds the results back as observations.
 * - `final`: The model has enough information to answer. The runtime publishes
 *   the answer and terminates the run.
 *
 * Every variant carries a required `usage` field recording token counts for
 * the turn.
 *
 * `reasoning`（DeepSeek V4 思考模式）：模型输出的思维链。带 tools 的请求在
 * 后续轮次必须完整回传（模型输入 assistant 消息的 reasoning_content），
 * 否则 API 返回 400（见 api-docs 思考模式·工具调用）。
 */
export type ModelTurn =
  | { type: 'tool_calls'; toolCalls: ToolCall[]; usage: Usage; reasoning?: string }
  | { type: 'final'; answer: string; citations?: EvidenceRef[]; usage: Usage; reasoning?: string };

/** Input for a single model turn */
export interface ModelTurnInput {
  /** System prompt including role contract and output format */
  systemPrompt: string;
  /**
   * Conversation history supporting four roles:
   * - `system`: system-level instructions
   * - `user`: human input
   * - `assistant`: model responses (may include optional `tool_calls` array
   *   and `reasoning_content` for DeepSeek V4 thinking mode — must be echoed
   *   back on every tool-carrying request)
   * - `tool`: tool result observations (requires `tool_call_id`)
   */
  messages: Array<
    | { role: 'user' | 'system'; content: string }
    | { role: 'assistant'; content: string; tool_calls?: ToolCall[]; reasoning_content?: string }
    | { role: 'tool'; content: string; tool_call_id: string }
  >;
  /** Tools available to the model in this turn */
  tools?: Array<{ name: string; description: string; inputSchema: JsonSchema<unknown> }>;
}

/** Options controlling a model turn */
export interface ModelTurnOptions {
  /** Maximum output tokens */
  maxTokens?: number;
  /** Temperature for sampling */
  temperature?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Streaming callback for partial content (final turns only) */
  onChunk?: (chunk: string) => void;
  /** 思维链增量回调（DeepSeek V4 思考模式；供 UI 展示思考进度） */
  onReasoning?: (text: string) => void;
  /** 服务端联网搜索状态回调（Responses API 原生 web_search；供 UI 展示搜索进度） */
  onSearchStatus?: (status: 'searching' | 'completed') => void;
}

/** Adapter interface for LLM backends */
export interface ModelAdapter {
  /** Provider identifier */
  readonly provider: string;

  /**
   * Execute a single model turn. The model receives the current run state,
   * available tools, and conversation history, and returns either a tool_call
   * or a final answer.
   */
  runTurn(input: ModelTurnInput, options?: ModelTurnOptions): Promise<ModelTurn>;
}
