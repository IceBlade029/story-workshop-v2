import { describe, it, expect, vi, afterEach } from 'vitest';
import { DeepSeekTransport } from '../model-transport';

const chatCompletion = vi.fn();
const chatCompletionStream = vi.fn();

vi.mock('../llm-client', () => ({
  chatCompletion: (...args: unknown[]) => chatCompletion(...args),
  chatCompletionStream: (...args: unknown[]) => chatCompletionStream(...args),
}));

afterEach(() => {
  chatCompletion.mockReset();
  chatCompletionStream.mockReset();
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
