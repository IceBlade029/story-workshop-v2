import { describe, it, expect, vi, afterEach } from 'vitest';
import { DeepSeekTransport } from '../model-transport';

const chatCompletion = vi.fn();
const chatCompletionStream = vi.fn();
const responsesCompletion = vi.fn();
const responsesStream = vi.fn();

vi.mock('../llm-client', () => ({
  chatCompletion: (...args: unknown[]) => chatCompletion(...args),
  chatCompletionStream: (...args: unknown[]) => chatCompletionStream(...args),
  responsesCompletion: (...args: unknown[]) => responsesCompletion(...args),
  responsesStream: (...args: unknown[]) => responsesStream(...args),
}));

let settingsModel: string = 'deepseek-v4-flash';
vi.mock('../settings-store', () => ({
  getSettings: () => ({ model: settingsModel, thinking: true, reasoningEffort: 'high', notifications: true }),
}));

afterEach(() => {
  chatCompletion.mockReset();
  chatCompletionStream.mockReset();
  responsesCompletion.mockReset();
  responsesStream.mockReset();
  settingsModel = 'deepseek-v4-flash';
});

describe('DeepSeekTransport — 非流式', () => {
  it('chat 把 model 消息转成 LLM 请求，并映射回 ChatResponse', async () => {
    chatCompletion.mockResolvedValue({
      content: '你好',
      finishReason: 'stop',
      toolCalls: undefined,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    const transport = new DeepSeekTransport();
    const res = await transport.chat(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [{ id: 't1', name: 'read_node', arguments: { nodeId: 'v1' } }] },
        { role: 'tool', content: '{"ok":true}', tool_call_id: 't1' },
      ],
      [{ name: 'read_node' }],
      { maxTokens: 100 },
    );
    // LLM 请求形态：tool_calls 序列化为字符串
    const req = chatCompletion.mock.calls[0][0];
    expect(req.messages[1].tool_calls[0].function.arguments).toBe('{"nodeId":"v1"}');
    expect(req.messages[2].tool_call_id).toBe('t1');
    expect(req.stream).toBe(false);
    expect(req.maxTokens).toBe(100);
    // 响应映射
    expect(res.choices[0].message.content).toBe('你好');
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});

describe('DeepSeekTransport — 流式', () => {
  it('chatStream 把文本/工具增量/usage 转换为 ChatChunk 序列', async () => {
    chatCompletionStream.mockImplementation(async (_req: unknown, onChunk: (c: unknown) => void) => {
      onChunk({ content: '你', finishReason: null });
      onChunk({ content: '好', finishReason: null });
      onChunk({
        content: '',
        finishReason: null,
        toolCalls: [{ index: 0, id: 't1', function: { name: 'search_nodes', arguments: '{"q":"x"}' } }],
      });
      onChunk({ content: '', finishReason: null, usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 } });
    });

    const transport = new DeepSeekTransport();
    const chunks: string[] = [];
    for await (const chunk of transport.chatStream([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk.type);
      if (chunk.type === 'text_delta') expect(chunk.content).toMatch(/^[你好]$/);
      if (chunk.type === 'tool_call_delta') {
        expect(chunk.id).toBe('t1');
        expect(chunk.name).toBe('search_nodes');
        expect(chunk.arguments).toBe('{"q":"x"}');
      }
      if (chunk.type === 'done') expect(chunk.usage).toEqual({ inputTokens: 9, outputTokens: 3 });
    }
    expect(chunks).toEqual(['text_delta', 'text_delta', 'tool_call_delta', 'done']);
    // includeUsage=true 传入 llm-client
    expect(chatCompletionStream.mock.calls[0][3]).toBe(true);
  });

  it('chatStream 请求携带 include_usage 与 signal；空流以 done 结尾', async () => {
    chatCompletionStream.mockImplementation(async () => { /* noop */ });
    const transport = new DeepSeekTransport();
    const controller = new AbortController();
    const iter = transport.chatStream([{ role: 'user', content: 'x' }], undefined, { signal: controller.signal });
    const first = await iter[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);
    expect(first.value.type).toBe('done');
    expect(first.value.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    const [, , signal, includeUsage] = chatCompletionStream.mock.calls[0];
    expect(signal).toBe(controller.signal);
    expect(includeUsage).toBe(true);
  });

  it('API 失败绝不伪装成空回答：chatStream 向调用方抛出错误', async () => {
    chatCompletionStream.mockRejectedValue(
      Object.assign(new Error('DeepSeek API error (401): invalid key'), { code: 'auth_error' }),
    );
    const transport = new DeepSeekTransport();
    const iter = transport.chatStream([{ role: 'user', content: 'hi' }]);
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow('DeepSeek API error (401)');
  });

  it('流中途失败同样抛出（已吐出的增量不掩盖错误）', async () => {
    chatCompletionStream.mockImplementation(async (_req: unknown, onChunk: (c: unknown) => void) => {
      onChunk({ content: '半个回答', finishReason: null });
      throw new Error('stream broke');
    });
    const transport = new DeepSeekTransport();
    const iter = transport.chatStream([{ role: 'user', content: 'hi' }]);
    const first = await iter[Symbol.asyncIterator]().next();
    expect(first.value.type).toBe('text_delta');
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow('stream broke');
  });
});

// ===========================================================================
// Responses API 路由（原生 web_search）
// ===========================================================================

const wsTools = [{ type: 'web_search' }];

describe('DeepSeekTransport — Responses API 路由', () => {
  it('工具含 web_search 且模型为 flash → 走 responsesCompletion', async () => {
    responsesCompletion.mockResolvedValue({
      content: '',
      finishReason: 'tool_calls',
      webSearchCalls: [{ id: 'ws_1', status: 'in_progress', action: { type: 'search', queries: ['q'] } }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    const transport = new DeepSeekTransport();
    const res = await transport.chat([{ role: 'user', content: '搜一下' }], wsTools);

    expect(responsesCompletion).toHaveBeenCalledTimes(1);
    expect(chatCompletion).not.toHaveBeenCalled();
    // 纯搜索轮 → 虚拟化为伪 tool_call（run-loop 无感闭环）
    expect(res.choices[0].finish_reason).toBe('tool_calls');
    expect(res.choices[0].message.content).toBeNull();
    expect(res.choices[0].message.tool_calls).toEqual([
      { id: 'ws_1', type: 'function', function: { name: 'web_search', arguments: '{}' } },
    ]);
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('搜索自动完成（web_search + message）→ 直接 final 内容', async () => {
    responsesCompletion.mockResolvedValue({
      content: '决赛在美国举行',
      reasoningContent: '思考',
      finishReason: 'stop',
      webSearchCalls: [{ id: 'ws_1', status: 'completed', action: { type: 'search', queries: ['q'] } }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    const transport = new DeepSeekTransport();
    const res = await transport.chat([{ role: 'user', content: '搜一下' }], wsTools);

    expect(res.choices[0].message.content).toBe('决赛在美国举行');
    expect(res.choices[0].message.reasoning_content).toBe('思考');
    expect(res.choices[0].finish_reason).toBe('stop');
  });

  it('pro 模型兜底：web_search 从工具列表滤除，走 chat/completions', async () => {
    settingsModel = 'deepseek-v4-pro';
    chatCompletion.mockResolvedValue({
      content: '好的',
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const transport = new DeepSeekTransport();
    const res = await transport.chat([{ role: 'user', content: 'hi' }], wsTools);

    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(responsesCompletion).not.toHaveBeenCalled();
    const req = chatCompletion.mock.calls[0][0] as { tools?: unknown[] };
    expect(req.tools).toEqual([]);
    expect(res.choices[0].message.content).toBe('好的');
  });

  it('流式：纯搜索轮在 usage 收尾时虚拟化伪 tool_call', async () => {
    responsesStream.mockImplementation(async (_req: unknown, _cache: unknown, onChunk: (c: unknown) => void) => {
      onChunk({ content: '', finishReason: null, searchStatus: 'searching' });
      onChunk({ content: '', finishReason: null, searchStatus: 'completed' });
      onChunk({
        content: '',
        finishReason: 'tool_calls',
        webSearchCalls: [{ id: 'ws_1', status: 'in_progress', action: { type: 'search', queries: ['q'] } }],
        usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 },
      });
    });
    const transport = new DeepSeekTransport();
    const chunks: string[] = [];
    let sawSearching = false;
    for await (const chunk of transport.chatStream([{ role: 'user', content: 'hi' }], wsTools)) {
      chunks.push(chunk.type);
      if (chunk.type === 'search_status' && chunk.status === 'searching') sawSearching = true;
      if (chunk.type === 'tool_call_delta') {
        expect(chunk.name).toBe('web_search');
        expect(chunk.id).toBe('ws_1');
        expect(chunk.arguments).toBe('{}');
      }
    }
    expect(sawSearching).toBe(true);
    expect(chunks).toEqual(['search_status', 'search_status', 'tool_call_delta', 'done']);
  });

  it('流式：搜索自动完成（web_search + message）→ 文本增量 + done', async () => {
    responsesStream.mockImplementation(async (_req: unknown, _cache: unknown, onChunk: (c: unknown) => void) => {
      onChunk({ content: '决赛在', finishReason: null });
      onChunk({ content: '美国', finishReason: null });
      onChunk({ content: '', finishReason: 'stop', usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 } });
    });
    const transport = new DeepSeekTransport();
    const chunks: string[] = [];
    let text = '';
    for await (const chunk of transport.chatStream([{ role: 'user', content: 'hi' }], wsTools)) {
      chunks.push(chunk.type);
      if (chunk.type === 'text_delta') text += chunk.content;
    }
    expect(text).toBe('决赛在美国');
    expect(chunks).toEqual(['text_delta', 'text_delta', 'done']);
  });

  it('web_search tool_call 消息回传时序列化为 web_search 类型（原样回传）', async () => {
    responsesCompletion.mockResolvedValue({
      content: '',
      finishReason: 'tool_calls',
      webSearchCalls: [{ id: 'ws_1', status: 'in_progress', action: { type: 'search', queries: ['q'] } }],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const transport = new DeepSeekTransport();
    // 第二轮：回传上一轮的 assistant(web_search) + tool 结果
    await transport.chat(
      [
        { role: 'user', content: '搜一下' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'ws_1', name: 'web_search', arguments: {} }],
        },
        { role: 'tool', content: '{"ok":true}', tool_call_id: 'ws_1' },
      ],
      wsTools,
    );
    const req = responsesCompletion.mock.calls[0][0] as { messages: Array<Record<string, unknown>> };
    // assistant 消息的 web_search tool_call 保留（transport 层不丢弃，转换在 llm-client 完成）
    expect(req.messages[1].tool_calls).toEqual([{ id: 'ws_1', type: 'web_search' }]);
  });
});
