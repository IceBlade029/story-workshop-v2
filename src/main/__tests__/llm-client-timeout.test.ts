/**
 * llm-client-timeout.test.ts — 请求/流空闲超时（网络挂起绝不无限等待）。
 *
 * 覆盖：fetch 挂起 → 请求超时；SSE 流中途无数据 → 空闲超时；
 * 两者都带 network_error 码，供上层「思考中…」兜底为明确报错。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { chatCompletion, chatCompletionStream } from '../llm-client';

vi.mock('../api-key-store', () => ({
  loadApiKey: vi.fn(() => 'sk-test-mock-key'),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const REQ = { messages: [{ role: 'user' as const, content: 'hi' }], stream: false };

describe('llm-client — 超时兜底（不无限等待）', () => {
  it('fetch 挂起 → 请求超时并带 network_error', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise<Response>(() => { /* 永不 resolve：模拟网络挂起 */ }),
    );
    await expect(chatCompletion(REQ, undefined, 50)).rejects.toMatchObject({
      code: 'network_error',
      message: expect.stringContaining('超时'),
    });
  });

  it('fetch 直接拒绝 → 网络错误带 network_error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await expect(chatCompletion(REQ, undefined, 50)).rejects.toMatchObject({
      code: 'network_error',
      message: expect.stringContaining('fetch failed'),
    });
  });

  it('SSE 流中途无数据 → 空闲超时（已收到的增量不丢失，流报错）', async () => {
    const encoder = new TextEncoder();
    let firstRead = true;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (firstRead) {
          firstRead = false;
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"半个回答"}}]}\n\n'));
          return;
        }
        // 第二次 read 永不返回数据（模拟流卡死）
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, { status: 200 }));

    const chunks: string[] = [];
    await expect(
      chatCompletionStream(
        { ...REQ, stream: true },
        (c) => { if (c.content) chunks.push(c.content); },
        undefined,
        false,
        5000,
        40,
      ),
    ).rejects.toMatchObject({ code: 'network_error', message: expect.stringContaining('空闲超时') });
    expect(chunks).toEqual(['半个回答']); // 增量已发出
  });

  it('流正常结束不受超时影响', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"完整回答"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, { status: 200 }));

    const chunks: string[] = [];
    await chatCompletionStream(
      { ...REQ, stream: true },
      (c) => { if (c.content) chunks.push(c.content); },
      undefined,
      false,
      5000,
      500,
    );
    expect(chunks).toEqual(['完整回答']);
  });
});
