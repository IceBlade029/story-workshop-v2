import type { LLMMessage, LLMRequest, LLMResponse, LLMStreamChunk, WebSearchCallItem } from '../shared/llm-types';
import { DEEPSEEK_BASE_URL, DEEPSEEK_DEFAULT_MODEL } from '../shared/llm-types';
import type { LLMProvider } from '../shared/llm-types';
import { loadApiKey } from './api-key-store';
import { getSettings } from './settings-store';

interface DeepSeekMessage {
  role: string;
  content: string | null;
  /** 思维链（DeepSeek V4 思考模式；带 tools 的请求必须回传） */
  reasoning_content?: string;
  tool_calls?: LLMMessage['tool_calls'];
  tool_call_id?: string;
}

interface DeepSeekRequestBody {
  model: string;
  messages: DeepSeekMessage[];
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: LLMRequest['tools'];
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
  if (req.tool_choice && (typeof req.tool_choice === 'string' || req.tool_choice.type === 'function')) {
    body.tool_choice = req.tool_choice as typeof body.tool_choice;
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

// ===========================================================================
// Responses API（POST /responses）——原生 web_search 联网搜索通道
//
// DeepSeek 官方仅在 Responses API 支持内置 web_search 工具（服务端执行搜索）。
// 与 /chat/completions 的区别：
// - 请求为无状态 input items（message / function_call / function_call_output /
//   reasoning / web_search_call），多轮历史须全量回传
// - 流式是语义化 SSE 事件（event: / data: 行，无 [DONE]），以
//   response.completed / response.incomplete / response.failed 收尾
// - web_search_call 输出 item 原样回传即可，服务端自动恢复搜索结果
// ===========================================================================

/** Responses API 输入 item。 */
export type ResponsesInputItem =
  | { type: 'message'; role: 'user' | 'assistant' | 'system'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: 'reasoning'; content: Array<{ type: 'reasoning_text'; text: string }> }
  | { type: 'web_search_call'; id: string; status?: string; action: { type: string; queries?: string[] } };

interface ResponsesRequestBody {
  model: string;
  input: ResponsesInputItem[];
  stream: boolean;
  temperature?: number;
  max_output_tokens?: number;
  tools?: Array<
    | {
        type: 'function';
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      }
    | { type: 'web_search' }
  >;
  tool_choice?: 'auto' | 'none' | { type: 'function'; name: string } | { type: 'web_search' };
  reasoning?: { effort: 'none' | 'low' | 'high' | 'max' };
}

interface ResponsesOutputItem {
  type?: string;
  id?: string;
  status?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  action?: { type: string; queries?: string[] };
  content?: Array<{ type?: string; text?: string }>;
}

interface ResponsesResponse {
  id: string;
  status: string;
  output?: ResponsesOutputItem[];
  error?: { code?: string; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

/** 解析 Responses 输出 items → OpenAI 兼容形态。 */
function parseResponsesOutput(output: ResponsesOutputItem[] | undefined): {
  content: string;
  reasoning: string;
  toolCalls: NonNullable<LLMResponse['toolCalls']>;
  webSearchCalls: WebSearchCallItem[];
  hasMessage: boolean;
} {
  const content: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: NonNullable<LLMResponse['toolCalls']> = [];
  const webSearchCalls: WebSearchCallItem[] = [];
  let hasMessage = false;
  for (const item of output ?? []) {
    if (item.type === 'message') {
      hasMessage = true;
      for (const block of item.content ?? []) {
        if (block.type === 'output_text' && block.text) content.push(block.text);
      }
    } else if (item.type === 'reasoning') {
      for (const block of item.content ?? []) {
        if (block.type === 'reasoning_text' && block.text) reasoning.push(block.text);
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.id ?? '',
        type: 'function',
        function: { name: item.name ?? '', arguments: item.arguments ?? '{}' },
      });
    } else if (item.type === 'web_search_call') {
      webSearchCalls.push({ id: item.id ?? '', status: item.status, action: item.action ?? { type: 'search' } });
    }
  }
  return { content: content.join(''), reasoning: reasoning.join(''), toolCalls, webSearchCalls, hasMessage };
}

/**
 * finishReason 判定：
 * - 有 function_call → 'tool_calls'（本地工具轮）
 * - 只有 web_search_call（无 message）→ 'tool_calls'（服务端搜索轮，回传后下轮出答案）
 * - 有 web_search_call 且带 message → 'stop'（服务端已自动完成搜索+回答）
 * - 其余 → 'stop'
 */
function responsesFinishReason(parsed: {
  toolCalls: unknown[];
  webSearchCalls: unknown[];
  hasMessage: boolean;
}): 'stop' | 'tool_calls' {
  if (parsed.toolCalls.length > 0) return 'tool_calls';
  if (parsed.webSearchCalls.length > 0 && !parsed.hasMessage) return 'tool_calls';
  return 'stop';
}

/**
 * OpenAI 消息列表 → Responses input items。
 *
 * - assistant(tool_calls) 拆成 function_call / web_search_call item
 * - tool 消息转 function_call_output；对应 web_search_call 的结果丢弃
 *   （服务端自动恢复搜索结果，无需回传结果）
 * - 思维链（reasoning_content）转 reasoning item（明文回传）
 * - web_search_call 从调用方缓存取原始 item 原样回传
 */
export function messagesToResponsesInput(
  messages: LLMMessage[],
  webSearchItems: Map<string, WebSearchCallItem>,
): ResponsesInputItem[] {
  const webSearchIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.type === 'web_search') webSearchIds.add(tc.id);
      }
    }
  }
  const items: ResponsesInputItem[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      // web_search_call 无对应工具结果：服务端自动恢复搜索结果，丢弃
      if (webSearchIds.has(m.tool_call_id ?? '')) continue;
      items.push({ type: 'function_call_output', call_id: m.tool_call_id ?? '', output: m.content ?? '' });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      // 思维链必须随工具轮回传（DeepSeek V4 thinking：缺失 reasoning_text 直接 400），
      // 且 reasoning item 要先于 function_call / web_search_call（与响应输出顺序一致）
      if (m.reasoning_content) {
        items.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text: m.reasoning_content }] });
      }
      for (const tc of m.tool_calls) {
        if (tc.type === 'web_search') {
          const cached = webSearchItems.get(tc.id);
          items.push(
            cached
              ? { type: 'web_search_call', id: cached.id, status: cached.status, action: cached.action }
              : { type: 'web_search_call', id: tc.id, action: { type: 'search' } },
          );
        } else {
          items.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
        }
      }
      continue;
    }
    const role = m.role === 'system' ? 'system' : m.role === 'assistant' ? 'assistant' : 'user';
    if (m.role === 'assistant' && m.reasoning_content) {
      items.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text: m.reasoning_content }] });
    }
    items.push({ type: 'message', role, content: m.content ?? '' });
  }
  return items;
}

/** 构造 /responses 请求体（thinking/reasoning_effort 映射为 reasoning.effort）。 */
export function buildResponsesRequestBody(
  req: LLMRequest,
  webSearchItems: Map<string, WebSearchCallItem>,
): ResponsesRequestBody {
  const extras = currentRequestExtras();
  const body: ResponsesRequestBody = {
    model: req.model ?? extras.model,
    input: messagesToResponsesInput(req.messages, webSearchItems),
    stream: req.stream,
    temperature: req.temperature,
  };
  if (req.maxTokens) body.max_output_tokens = req.maxTokens;
  const thinking = req.thinking ?? extras.thinking ?? { type: 'enabled' as const };
  const effort = req.reasoningEffort ?? extras.reasoningEffort;
  if (thinking.type === 'disabled') {
    body.reasoning = { effort: 'none' };
  } else {
    body.reasoning = { effort: effort === 'max' ? 'max' : effort === 'low' ? 'low' : 'high' };
  }
  if (req.tools) {
    // Responses API 的 function 工具是扁平结构（type/name/description/parameters 同级），
    // 与 chat/completions 的嵌套 function 格式不同，需转换；web_search 无参数。
    body.tools = (req.tools as Array<
      | { type: 'web_search' }
      | { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
    >).map((t) =>
      t.type === 'web_search'
        ? { type: 'web_search' }
        : { type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters },
    );
  }
  if (req.tool_choice) {
    if (typeof req.tool_choice === 'string') {
      body.tool_choice = req.tool_choice;
    } else if (req.tool_choice.type === 'web_search') {
      body.tool_choice = { type: 'web_search' };
    } else {
      body.tool_choice = { type: 'function', name: req.tool_choice.function.name };
    }
  }
  return body;
}

async function postResponses(
  body: ResponsesRequestBody,
  apiKey: string,
  signal: AbortSignal | undefined,
  timeout: ReturnType<typeof withTimeout>,
): Promise<Response> {
  return Promise.race([
    fetch(`${DEEPSEEK_BASE_URL}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: timeout.signal,
    }),
    timeout.promise,
  ]);
}

/**
 * 非流式 /responses 调用。返回 OpenAI 兼容 LLMResponse；
 * web_search_call 原样放入 webSearchCalls（供回传缓存）。
 */
export async function responsesCompletion(
  req: LLMRequest,
  webSearchItems: Map<string, WebSearchCallItem>,
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<LLMResponse> {
  const apiKey = getApiKey('deepseek');
  const body = buildResponsesRequestBody({ ...req, stream: false }, webSearchItems);
  const timeout = withTimeout(signal, timeoutMs);

  let response: Response;
  try {
    response = await postResponses(body, apiKey, signal, timeout);
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
      new Error(`DeepSeek Responses API error (${response.status}): ${errorText}`),
      { code, statusCode: response.status }
    );
  }

  const data: ResponsesResponse = await response.json();
  if (data.status === 'failed' || data.error) {
    throw Object.assign(new Error(`DeepSeek Responses API error: ${data.error?.message ?? 'failed'}`), { code: 'server_error' });
  }

  const parsed = parseResponsesOutput(data.output);
  return {
    id: data.id,
    content: parsed.content,
    reasoningContent: parsed.reasoning || undefined,
    finishReason: responsesFinishReason(parsed),
    toolCalls: parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
    webSearchCalls: parsed.webSearchCalls.length > 0 ? parsed.webSearchCalls : undefined,
    usage: {
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    },
  };
}

interface ResponsesStreamEvent {
  type: string;
  sequence_number?: number;
  output_index?: number;
  item?: ResponsesOutputItem;
  delta?: string;
  response?: ResponsesResponse & {
    output?: ResponsesOutputItem[];
    usage?: ResponsesResponse['usage'];
    incomplete_details?: { reason?: string } | null;
  };
}

/**
 * 流式 /responses 调用（语义化 SSE 事件）。
 *
 * 事件 → LLMStreamChunk 映射：
 * - response.output_text.delta → content
 * - response.reasoning_text.delta → reasoningContent
 * - response.output_item.added(function_call) + function_call_arguments.delta → toolCalls
 * - response.web_search_call.* → searchStatus
 * - response.completed/incomplete/failed → 末尾 usage chunk（含 finishReason 与 webSearchCalls）
 */
export async function responsesStream(
  req: LLMRequest,
  webSearchItems: Map<string, WebSearchCallItem>,
  onChunk: (chunk: LLMStreamChunk) => void,
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
  idleMs = STREAM_IDLE_TIMEOUT_MS,
): Promise<void> {
  const apiKey = getApiKey('deepseek');
  const body = buildResponsesRequestBody({ ...req, stream: true }, webSearchItems);
  const timeout = withTimeout(signal, timeoutMs);

  let response: Response;
  try {
    response = await postResponses(body, apiKey, signal, timeout);
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
      new Error(`DeepSeek Responses API error (${response.status}): ${errorText}`),
      { code, statusCode: response.status }
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw Object.assign(new Error('Response body is not readable'), { code: 'network_error' });
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  const dataLines: string[] = [];
  /** 本轮是否已通过 reasoning_text.delta 流式发过思维链（completed 兜底时避免重复） */
  let streamedReasoning = false;

  const flushData = (): void => {
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n');
    dataLines.length = 0;
    const eventName = currentEvent;
    currentEvent = '';
    let parsed: ResponsesStreamEvent;
    try {
      parsed = JSON.parse(raw) as ResponsesStreamEvent;
    } catch {
      return;
    }
    const type = eventName || parsed.type;
    const emit = (chunk: LLMStreamChunk): void => { try { onChunk(chunk); } catch { /* 调用方隔离 */ } };

    switch (type) {
      case 'response.output_item.added': {
        const item = parsed.item;
        if (!item) break;
        if (item.type === 'function_call') {
          emit({
            content: '',
            finishReason: null,
            toolCalls: [{ index: parsed.output_index ?? 0, id: item.id, type: 'function', function: { name: item.name, arguments: '' } }],
          });
        } else if (item.type === 'web_search_call') {
          if (item.id) {
            webSearchItems.set(item.id, { id: item.id, status: item.status, action: item.action ?? { type: 'search' } });
          }
          emit({ content: '', finishReason: null, searchStatus: 'searching' });
        }
        break;
      }
      case 'response.output_text.delta':
        emit({ content: parsed.delta ?? '', finishReason: null });
        break;
      case 'response.reasoning_text.delta':
        streamedReasoning = true;
        emit({ content: '', finishReason: null, reasoningContent: parsed.delta ?? '' });
        break;
      case 'response.function_call_arguments.delta':
        emit({
          content: '',
          finishReason: null,
          toolCalls: [{ index: parsed.output_index ?? 0, function: { arguments: parsed.delta ?? '' } }],
        });
        break;
      case 'response.web_search_call.in_progress':
      case 'response.web_search_call.searching':
        emit({ content: '', finishReason: null, searchStatus: 'searching' });
        break;
      case 'response.web_search_call.completed':
        emit({ content: '', finishReason: null, searchStatus: 'completed' });
        break;
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const full = parsed.response;
        if (full?.status === 'failed' || full?.error) {
          throw Object.assign(
            new Error(`DeepSeek Responses API error: ${full?.error?.message ?? 'failed'}`),
            { code: 'server_error' },
          );
        }
        const out = parseResponsesOutput(full?.output);
        const reason =
          full?.incomplete_details?.reason === 'max_output_tokens' ? 'length' :
          full?.incomplete_details?.reason === 'content_filter' ? 'content_filter' :
          responsesFinishReason(out);
        // 思维链兜底：若工具轮（function/web_search）的思维链没有以 delta 事件
        // 流式发出、只出现在 completed 完整 output 里，则补发 reasoning_delta，
        // 否则 run-loop 拿不到 reasoning → 下一轮回传缺失 → DeepSeek 400
        // （The reasoning_text in the thinking mode must be passed back）
        if (out.reasoning && !streamedReasoning) {
          emit({ content: '', finishReason: null, reasoningContent: out.reasoning });
        }
        const webCalls = out.webSearchCalls.length > 0 ? out.webSearchCalls : undefined;
        emit({
          content: '',
          finishReason: reason,
          webSearchCalls: webCalls,
          usage: {
            promptTokens: full?.usage?.input_tokens ?? 0,
            completionTokens: full?.usage?.output_tokens ?? 0,
            totalTokens: full?.usage?.total_tokens ?? 0,
          },
        });
        break;
      }
      default:
        break;
    }
  };

  try {
    while (true) {
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
        if (trimmed.startsWith('event:')) {
          currentEvent = trimmed.slice(6).trim();
        } else if (trimmed.startsWith('data:')) {
          dataLines.push(trimmed.slice(5).trimStart());
        } else if (!trimmed) {
          // SSE 事件以空行分隔
          flushData();
        }
      }
    }
    flushData();
  } finally {
    reader.cancel().catch(() => {});
  }
}
