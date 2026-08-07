/**
 * model-transport.ts — DeepSeek Transport（桥接 llm-client 与 NativeModelAdapter）。
 *
 * ModelAdapter 不直接依赖 llm-client（依赖注入）；本模块把 llm-client 的
 * LLMRequest/LLMResponse/LLMStreamChunk 形态转换为 NativeModelAdapter 需要的
 * ModelTransport（ChatResponse / ChatChunk）。
 *
 * 流式：通过 stream_options.include_usage 拿到末尾 usage chunk，
 * 组装成 done chunk（Usage 契约必需）。
 *
 * 双协议路由（原生 web_search）：
 * - 工具列表含 web_search 且当前模型为 deepseek-v4-flash → 走 Responses API
 *   （/responses，服务端执行搜索）
 * - 其余（无 web_search / pro 模型暂不支持 Responses API）→ 走 /chat/completions，
 *   pro 时把 web_search 从工具列表中滤除（兜底，不报错）
 */
import type { ModelTransport, ChatResponse, ChatChunk } from './agent-runtime/model-adapter';
import { chatCompletion, chatCompletionStream, responsesCompletion, responsesStream } from './llm-client';
import type { LLMRequest, LLMMessage, LLMStreamChunk, WebSearchCallItem } from '../shared/llm-types';
import { getSettings } from './settings-store';

/** 把 model-types 的消息形态转为 LLM API 形态（tool_calls 序列化为字符串）。 */
function toLLMMessages(messages: unknown[]): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (const raw of messages as Array<Record<string, unknown>>) {
    if (raw.role === 'tool') {
      out.push({ role: 'tool', content: raw.content as string, tool_call_id: raw.tool_call_id as string });
      continue;
    }
    const msg: LLMMessage = {
      role: (raw.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user',
      content: (raw.content as string) ?? null,
    };
    // 思维链回传（DeepSeek V4：带 tools 的请求必须完整回传，否则 400）
    const reasoning = raw.reasoning_content as string | undefined;
    if (reasoning) {
      (msg as LLMMessage & { reasoning_content?: string }).reasoning_content = reasoning;
    }
    const toolCalls = raw.tool_calls as Array<{ id: string; name: string; arguments: Record<string, unknown> }> | undefined;
    if (toolCalls && toolCalls.length > 0) {
      // OpenAI/DeepSeek 规范：带 tool_calls 的 assistant 消息 content 为 null
      msg.content = null;
      msg.tool_calls = toolCalls.map((tc) => {
        if (tc.name === 'web_search') {
          // 服务端联网搜索调用：原样回传（Responses API web_search_call）
          return { id: tc.id, type: 'web_search' as const };
        }
        return {
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        };
      });
    }
    out.push(msg);
  }
  return out;
}

/** 工具列表是否含原生 web_search。 */
function hasWebSearchTool(tools?: unknown[]): boolean {
  return (tools ?? []).some((t) => (t as { type?: string })?.type === 'web_search');
}

/** 过滤掉 web_search 后的 function 工具列表（pro 兜底）。 */
function filterWebSearchTools(tools?: unknown[]): unknown[] | undefined {
  if (!tools) return undefined;
  return tools.filter((t) => (t as { type?: string })?.type !== 'web_search');
}

function toUsage(res: { usage: { promptTokens: number; completionTokens: number } }): ChatResponse['usage'] {
  return {
    inputTokens: res.usage.promptTokens,
    outputTokens: res.usage.completionTokens,
  };
}

/** 虚拟化的 web_search 伪 tool_call（ChatResponse 内统一 function 形态，run-loop 无感）。 */
function toVirtualWebSearchCalls(calls: WebSearchCallItem[]): NonNullable<ChatResponse['choices'][0]['message']['tool_calls']> {
  return calls.map((w) => ({
    id: w.id,
    type: 'function',
    function: { name: 'web_search', arguments: '{}' },
  }));
}

export class DeepSeekTransport implements ModelTransport {
  /** 本轮/本会话的 web_search_call 原始 item（回传时原样注入，服务端恢复搜索结果） */
  private webSearchItems = new Map<string, WebSearchCallItem>();

  private isFlashModel(): boolean {
    return getSettings().model === 'deepseek-v4-flash';
  }

  /** 是否走 Responses API 通道（含 web_search 且模型支持）。 */
  private useResponses(tools?: unknown[]): boolean {
    return hasWebSearchTool(tools) && this.isFlashModel();
  }

  async chat(messages: unknown[], tools?: unknown[], options?: unknown): Promise<ChatResponse> {
    if (this.useResponses(tools)) {
      return this.chatResponses(messages, tools, options);
    }
    return this.chatCompletions(messages, filterWebSearchTools(tools), options);
  }

  async *chatStream(messages: unknown[], tools?: unknown[], options?: unknown): AsyncIterable<ChatChunk> {
    if (this.useResponses(tools)) {
      yield* this.chatStreamResponses(messages, tools, options);
      return;
    }
    yield* this.chatStreamCompletions(messages, filterWebSearchTools(tools), options);
  }

  // -------------------------------------------------------------------------
  // /chat/completions 通道（原逻辑）
  // -------------------------------------------------------------------------

  private async chatCompletions(messages: unknown[], tools?: unknown[], options?: unknown): Promise<ChatResponse> {
    const opts = options as { maxTokens?: number; temperature?: number; signal?: AbortSignal } | undefined;
    const req: LLMRequest = {
      messages: toLLMMessages(messages),
      stream: false,
      temperature: opts?.temperature,
      maxTokens: opts?.maxTokens,
      tools: tools as LLMRequest['tools'],
    };
    const res = await chatCompletion(req);
    return {
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: res.content || null,
            reasoning_content: res.reasoningContent ?? null,
            tool_calls: res.toolCalls?.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
          },
          finish_reason: res.finishReason,
        },
      ],
      usage: {
        inputTokens: res.usage.promptTokens,
        outputTokens: res.usage.completionTokens,
      },
    };
  }

  private async *chatStreamCompletions(messages: unknown[], tools?: unknown[], options?: unknown): AsyncIterable<ChatChunk> {
    const opts = options as { maxTokens?: number; temperature?: number; signal?: AbortSignal } | undefined;
    const req: LLMRequest = {
      messages: toLLMMessages(messages),
      stream: true,
      temperature: opts?.temperature,
      maxTokens: opts?.maxTokens,
      tools: tools as LLMRequest['tools'],
    };

    const queue: ChatChunk[] = [];
    const waiters: Array<() => void> = [];
    let ended = false;
    let streamError: Error | null = null;
    let finalUsage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 };

    const push = (chunk: ChatChunk): void => {
      queue.push(chunk);
      waiters.shift()?.();
    };

    const onChunk = (chunk: LLMStreamChunk): void => {
      if (chunk.usage) {
        finalUsage = {
          inputTokens: chunk.usage.promptTokens,
          outputTokens: chunk.usage.completionTokens,
        };
        return;
      }
      if (chunk.reasoningContent) {
        push({ type: 'reasoning_delta', content: chunk.reasoningContent });
        return;
      }
      if (chunk.toolCalls && chunk.toolCalls.length > 0) {
        for (const tc of chunk.toolCalls) {
          push({
            type: 'tool_call_delta',
            index: tc.index,
            ...(tc.id !== undefined ? { id: tc.id } : {}),
            ...(tc.function?.name !== undefined ? { name: tc.function.name } : {}),
            ...(tc.function?.arguments !== undefined ? { arguments: tc.function.arguments } : {}),
          });
        }
        return;
      }
      if (chunk.content) {
        push({ type: 'text_delta', content: chunk.content });
      }
    };

    void chatCompletionStream(req, onChunk, opts?.signal, true)
      .then(() => {
        ended = true;
        waiters.shift()?.();
      })
      .catch((err: Error) => {
        // API 失败必须传导给调用方（§8.1）：绝不把失败伪装成空回答
        streamError = err;
        ended = true;
        waiters.shift()?.();
      });

    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (ended) break;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    if (streamError) throw streamError;
    yield { type: 'done', finishReason: 'stop', usage: finalUsage };
  }

  // -------------------------------------------------------------------------
  // /responses 通道（原生 web_search）
  // -------------------------------------------------------------------------

  private async chatResponses(messages: unknown[], tools?: unknown[], options?: unknown): Promise<ChatResponse> {
    const opts = options as { maxTokens?: number; temperature?: number; signal?: AbortSignal } | undefined;
    const req: LLMRequest = {
      messages: toLLMMessages(messages),
      stream: false,
      temperature: opts?.temperature,
      maxTokens: opts?.maxTokens,
      tools: tools as LLMRequest['tools'],
    };
    const res = await responsesCompletion(req, this.webSearchItems, opts?.signal);

    // 搜索轮（web_search_call 且无函数调用）：
    // - 无文本 → 虚拟化为伪 tool_call，run-loop 走「占位执行 + 原样回传」闭环
    // - 有文本 → 服务端已自动完成搜索+回答，直接作为 final
    const hasFunctionCalls = res.toolCalls !== undefined && res.toolCalls.length > 0;
    if (!hasFunctionCalls && res.webSearchCalls && res.webSearchCalls.length > 0 && !res.content) {
      return {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: toVirtualWebSearchCalls(res.webSearchCalls),
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: toUsage(res),
      };
    }

    return {
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: res.content || null,
            reasoning_content: res.reasoningContent ?? null,
            tool_calls: res.toolCalls?.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
          },
          finish_reason: res.finishReason,
        },
      ],
      usage: toUsage(res),
    };
  }

  private async *chatStreamResponses(messages: unknown[], tools?: unknown[], options?: unknown): AsyncIterable<ChatChunk> {
    const opts = options as { maxTokens?: number; temperature?: number; signal?: AbortSignal } | undefined;
    const req: LLMRequest = {
      messages: toLLMMessages(messages),
      stream: true,
      temperature: opts?.temperature,
      maxTokens: opts?.maxTokens,
      tools: tools as LLMRequest['tools'],
    };

    const queue: ChatChunk[] = [];
    const waiters: Array<() => void> = [];
    let ended = false;
    let streamError: Error | null = null;
    let finalUsage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 };
    let doneReason: 'stop' | 'tool_calls' = 'stop';
    let sawFunctionToolCall = false;

    const push = (chunk: ChatChunk): void => {
      queue.push(chunk);
      waiters.shift()?.();
    };

    const onChunk = (chunk: LLMStreamChunk): void => {
      if (chunk.usage) {
        finalUsage = {
          inputTokens: chunk.usage.promptTokens,
          outputTokens: chunk.usage.completionTokens,
        };
        if (chunk.finishReason === 'tool_calls' || chunk.finishReason === 'stop' || chunk.finishReason === 'length' || chunk.finishReason === 'content_filter') {
          doneReason = chunk.finishReason as 'stop' | 'tool_calls';
        }
        // 服务端搜索轮（finishReason=tool_calls 且无函数调用）：把 web_search_call
        // 虚拟化为伪 tool_call，让 run-loop 走「占位执行 + 原样回传」闭环。
        // 搜索自动完成（finishReason=stop，message 已在文本增量输出）不虚拟化。
        if (chunk.finishReason === 'tool_calls' && !sawFunctionToolCall && chunk.webSearchCalls && chunk.webSearchCalls.length > 0) {
          chunk.webSearchCalls.forEach((w, i) => {
            push({ type: 'tool_call_delta', index: i, id: w.id, name: 'web_search', arguments: '{}' });
          });
        }
        return;
      }
      if (chunk.reasoningContent) {
        push({ type: 'reasoning_delta', content: chunk.reasoningContent });
        return;
      }
      if (chunk.searchStatus) {
        push({ type: 'search_status', status: chunk.searchStatus });
        return;
      }
      if (chunk.toolCalls && chunk.toolCalls.length > 0) {
        for (const tc of chunk.toolCalls) {
          if (tc.id !== undefined) sawFunctionToolCall = true;
          push({
            type: 'tool_call_delta',
            index: tc.index,
            ...(tc.id !== undefined ? { id: tc.id } : {}),
            ...(tc.function?.name !== undefined ? { name: tc.function.name } : {}),
            ...(tc.function?.arguments !== undefined ? { arguments: tc.function.arguments } : {}),
          });
        }
        return;
      }
      if (chunk.content) {
        push({ type: 'text_delta', content: chunk.content });
      }
    };

    void responsesStream(req, this.webSearchItems, onChunk, opts?.signal)
      .then(() => {
        ended = true;
        waiters.shift()?.();
      })
      .catch((err: Error) => {
        // API 失败必须传导给调用方（§8.1）：绝不把失败伪装成空回答
        streamError = err;
        ended = true;
        waiters.shift()?.();
      });

    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (ended) break;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    if (streamError) throw streamError;
    yield { type: 'done', finishReason: doneReason, usage: finalUsage };
  }
}

/** 真实模型适配器（无 API key 时创建会报错，由调用方兜底提示）。 */
export function createRealModelAdapter(): import('./agent-runtime/model-adapter').NativeModelAdapter {
  const { NativeModelAdapter } = require('./agent-runtime/model-adapter') as typeof import('./agent-runtime/model-adapter');
  return new NativeModelAdapter(new DeepSeekTransport());
}
