import type { LLMRequest, LLMResponse, LLMStreamChunk } from '../shared/llm-types';
import { DEEPSEEK_BASE_URL, DEEPSEEK_DEFAULT_MODEL } from '../shared/llm-types';
import type { LLMProvider } from '../shared/llm-types';
import { loadApiKey } from './api-key-store';
import { getSettings } from './settings-store';

interface DeepSeekMessage {
  role: string;
  content: string | null;
  /** 思维链（DeepSeek V4 思考模式；带 tools 的请求必须回传） */
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface DeepSeekRequestBody {
  model: string;
  messages: DeepSeekMessage[];
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  /** 思考模式开关（DeepSeek V4） */
  thinking?: { type: 'enabled' | 'disabled' };
  /** 思考强度（DeepSeek V4） */
  reasoning_effort?: 'low' | 'high' | 'max';
}

interface DeepSeekStreamChunk {
  choices: Array<{
    delta: {
      content?: string | null;
      /** 思维链增量（DeepSeek V4 思考模式） */
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
}

interface DeepSeekResponse {
  id: string;
  choices: Array<{
    message: {
      content: string | null;
      /** 思维链（DeepSeek V4 思考模式） */
      reasoning_content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** 请求整体超时（连接 + 响应完成）：防止网络挂起导致 UI 无限「思考中…」 */
export const REQUEST_TIMEOUT_MS = 90_000;
/** SSE 空闲超时：两个 chunk 之间超过该时长视为流卡死 */
export const STREAM_IDLE_TIMEOUT_MS = 30_000;

/** 组合外部 abort 信号与超时信号（手动实现，兼容性最好）。 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  /** 超时主动 reject（不依赖 fetch 实现是否监听 abort） */
  promise: Promise<never>;
  clear: () => void;
} {
  const controller = new AbortController();
  let timer: NodeJS.Timeout;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`), { code: 'network_error' }));
    }, timeoutMs);
  });
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  return { signal: controller.signal, promise, clear: () => clearTimeout(timer) };
}

/** SSE 读取空闲超时：超时抛 network_error，绝不无限等待。 */
function idleTimeout(ms: number): { promise: Promise<never>; clear: () => void } {
  let timer: NodeJS.Timeout;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`SSE 流空闲超时（${Math.round(ms / 1000)}s 无数据）`), { code: 'network_error' }));
    }, ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

function getApiKey(provider: LLMProvider): string {
  const key = loadApiKey(provider);
  if (!key) {
    throw Object.assign(new Error(`API Key not configured for provider: ${provider}`), {
      code: 'auth_error',
    });
  }
  return key;
}

/** 当前生效的设置（模型 / 思考模式 / 思考强度）。 */
function currentRequestExtras(): { model: string; thinking?: { type: 'enabled' | 'disabled' }; reasoningEffort?: 'low' | 'high' | 'max' } {
  const settings = getSettings();
  return {
    model: settings.model,
    thinking: { type: settings.thinking ? 'enabled' : 'disabled' },
    reasoningEffort: settings.reasoningEffort,
  };
}

function buildRequestBody(req: LLMRequest): DeepSeekRequestBody {
  const extras = currentRequestExtras();
  const body: DeepSeekRequestBody = {
    model: req.model ?? extras.model,
    // Messages are already in LLM API format after transport conversion in index.ts.
    // tool_calls are in OpenAI-compatible format (function.arguments is stringified JSON).
    messages: req.messages.map((m) => {
      const dm: DeepSeekMessage = {
        role: m.role,
        content: m.content,
      };
      // 思维链：带 tools 的请求必须完整回传（DeepSeek V4 思考模式）
      if (m.role === 'assistant' && (m as { reasoning_content?: string }).reasoning_content) {
        dm.reasoning_content = (m as { reasoning_content?: string }).reasoning_content;
      }
      // tool_call_id is present on 'tool' role messages
      if (m.tool_call_id) dm.tool_call_id = m.tool_call_id;
      // tool_calls are already in API format from transport conversion
      if (m.tool_calls) {
        dm.tool_calls = m.tool_calls;
      }
      return dm;
    }),
    stream: req.stream,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
  };
  if (req.thinking) {
    body.thinking = req.thinking;
  } else {
    body.thinking = extras.thinking;
  }
  if (req.reasoningEffort) {
    body.reasoning_effort = req.reasoningEffort;
  } else {
    body.reasoning_effort = extras.reasoningEffort;
  }
  if (req.tools) {
    body.tools = req.tools;
  }
  if (req.tool_choice) {
    body.tool_choice = req.tool_choice;
  }
  return body;
}

function sanitizeForLog(obj: unknown): string {
  return JSON.stringify(obj, (key, value) => {
    if (key === 'content' && typeof value === 'string' && value.length > 200) {
      return value.slice(0, 200) + '...[truncated]';
    }
    return value;
  });
}

export async function chatCompletion(req: LLMRequest, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<LLMResponse> {
  const apiKey = getApiKey('deepseek');
  const body = buildRequestBody({ ...req, stream: false });
  const timeout = withTimeout(signal, timeoutMs);

  let response: Response;
  try {
    response = await Promise.race([
      fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: timeout.signal,
      }),
      timeout.promise,
    ]);
  } catch (err) {
    timeout.clear();
    const e = err as Error & { code?: string };
    if (e.code === 'network_error') throw err;
    if (e.name === 'AbortError') {
      throw Object.assign(new Error(`DeepSeek 请求超时（${Math.round(timeoutMs / 1000)}s）或已取消`), { code: 'network_error' });
    }
    throw Object.assign(new Error(`DeepSeek 网络错误：${e.message}`), { code: 'network_error' });
  }
  timeout.clear();

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    const code =
      response.status === 401 ? 'auth_error' :
      response.status === 429 ? 'rate_limit' :
      response.status >= 500 ? 'server_error' :
      'unknown';
    throw Object.assign(
      new Error(`DeepSeek API error (${response.status}): ${errorText}`),
      { code, statusCode: response.status }
    );
  }

  const data: DeepSeekResponse = await response.json();
  const choice = data.choices?.[0];

  return {
    id: data.id,
    content: choice?.message?.content ?? '',
    reasoningContent: choice?.message?.reasoning_content ?? undefined,
    finishReason: (choice?.finish_reason as LLMResponse['finishReason']) ?? 'stop',
    toolCalls: choice?.message?.tool_calls,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    },
  };
}

export async function chatCompletionStream(
  req: LLMRequest,
  onChunk: (chunk: LLMStreamChunk) => void,
  signal?: AbortSignal,
  includeUsage = false,
  timeoutMs = REQUEST_TIMEOUT_MS,
  idleMs = STREAM_IDLE_TIMEOUT_MS,
): Promise<void> {
  const apiKey = getApiKey('deepseek');
  const body = buildRequestBody({ ...req, stream: true });
  // DeepSeek：stream_options.include_usage 会在流末尾追加含 usage 的 chunk
  if (includeUsage) {
    (body as DeepSeekRequestBody & { stream_options?: { include_usage: boolean } }).stream_options = { include_usage: true };
  }
  const timeout = withTimeout(signal, timeoutMs);

  let response: Response;
  try {
    response = await Promise.race([
      fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: timeout.signal,
      }),
      timeout.promise,
    ]);
  } catch (err) {
    timeout.clear();
    const e = err as Error & { code?: string };
    if (e.code === 'network_error') throw err;
    if (e.name === 'AbortError') {
      throw Object.assign(new Error(`DeepSeek 请求超时（${Math.round(timeoutMs / 1000)}s）或已取消`), { code: 'network_error' });
    }
    throw Object.assign(new Error(`DeepSeek 网络错误：${e.message}`), { code: 'network_error' });
  }
  timeout.clear();

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    const code =
      response.status === 401 ? 'auth_error' :
      response.status === 429 ? 'rate_limit' :
      response.status >= 500 ? 'server_error' :
      'unknown';
    throw Object.assign(
      new Error(`DeepSeek API error (${response.status}): ${errorText}`),
      { code, statusCode: response.status }
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw Object.assign(new Error('Response body is not readable'), { code: 'network_error' });
  }

  const decoder = new TextDecoder();
  let buffer = '';
  const toolCallsAccumulator = new Map<number, {
    id?: string;
    type?: 'function';
    name?: string;
    arguments: string;
  }>();

  try {
    while (true) {
      // 空闲超时：两个 chunk 之间无数据视为流卡死（网络挂起不再无限等待）
      const idle = idleTimeout(idleMs);
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        const result = await Promise.race([reader.read(), idle.promise]);
        done = result.done;
        value = result.value;
      } catch (err) {
        if ((err as { code?: string }).code === 'stream_timeout') {
          throw Object.assign(new Error(`DeepSeek 流空闲超时（${Math.round(idleMs / 1000)}s 无数据）`), { code: 'network_error' });
        }
        throw Object.assign(new Error(`DeepSeek 流读取失败：${(err as Error).message}`), { code: 'network_error' });
      } finally {
        idle.clear();
      }
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          const parsed: DeepSeekStreamChunk & { usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } = JSON.parse(data);

          // 纯 usage 结尾 chunk（choices 为空）
          if (parsed.usage) {
            onChunk({
              content: '',
              finishReason: null,
              usage: {
                promptTokens: parsed.usage.prompt_tokens,
                completionTokens: parsed.usage.completion_tokens,
                totalTokens: parsed.usage.total_tokens,
              },
            });
            continue;
          }

          const choice = parsed.choices?.[0];
          if (choice) {
            // Accumulate tool_calls by index
            if (choice.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                let acc = toolCallsAccumulator.get(tc.index);
                if (!acc) {
                  acc = { arguments: '' };
                  toolCallsAccumulator.set(tc.index, acc);
                }
                if (tc.id !== undefined) acc.id = tc.id;
                if (tc.type !== undefined) acc.type = tc.type;
                if (tc.function?.name !== undefined) acc.name = tc.function.name;
                if (tc.function?.arguments !== undefined) {
                  acc.arguments += tc.function.arguments;
                }
              }
            }

            // Emit RAW delta from this specific chunk (not accumulated)
            // The downstream consumer (NativeModelAdapter) handles accumulation.
            let deltaToolCalls: LLMStreamChunk['toolCalls'] | undefined;
            if (choice.delta?.tool_calls) {
              deltaToolCalls = choice.delta.tool_calls.map(tc => ({
                index: tc.index,
                ...(tc.id !== undefined ? { id: tc.id } : {}),
                ...(tc.type !== undefined ? { type: tc.type } : {}),
                ...(tc.function ? { function: { name: tc.function.name, arguments: tc.function.arguments } } : {}),
              }));
            }

            onChunk({
              content: choice.delta?.content ?? '',
              finishReason: choice.finish_reason,
              toolCalls: deltaToolCalls,
              ...(choice.delta?.reasoning_content ? { reasoningContent: choice.delta.reasoning_content } : {}),
            });
          }
        } catch {
          // skip malformed chunks
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export { sanitizeForLog, buildRequestBody };
