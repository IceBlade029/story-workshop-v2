/**
 * model-transport.ts — DeepSeek Transport（桥接 llm-client 与 NativeModelAdapter）。
 *
 * ModelAdapter 不直接依赖 llm-client（依赖注入）；本模块把 llm-client 的
 * LLMRequest/LLMResponse/LLMStreamChunk 形态转换为 NativeModelAdapter 需要的
 * ModelTransport（ChatResponse / ChatChunk）。
 *
 * 流式：通过 stream_options.include_usage 拿到末尾 usage chunk，
 * 组装成 done chunk（Usage 契约必需）。
 */
import type { ModelTransport, ChatResponse, ChatChunk } from './agent-runtime/model-adapter';
import { chatCompletion, chatCompletionStream } from './llm-client';
import type { LLMRequest, LLMMessage, LLMStreamChunk } from '../shared/llm-types';

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
      msg.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
      }));
    }
    out.push(msg);
  }
  return out;
}

export class DeepSeekTransport implements ModelTransport {
  async chat(messages: unknown[], tools?: unknown[], options?: unknown): Promise<ChatResponse> {
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

  async *chatStream(messages: unknown[], tools?: unknown[], options?: unknown): AsyncIterable<ChatChunk> {
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
}

/** 真实模型适配器（无 API key 时创建会报错，由调用方兜底提示）。 */
export function createRealModelAdapter(): import('./agent-runtime/model-adapter').NativeModelAdapter {
  const { NativeModelAdapter } = require('./agent-runtime/model-adapter') as typeof import('./agent-runtime/model-adapter');
  return new NativeModelAdapter(new DeepSeekTransport());
}