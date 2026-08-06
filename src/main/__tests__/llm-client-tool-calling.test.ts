/**
 * llm-client-tool-calling.test.ts — Tests for tool calling support in LLM client
 *
 * Task: I8_POLISH_04
 *
 * Verifies:
 * - buildRequestBody correctly passes tools and tool_choice
 * - buildRequestBody maps LLMMessage with tool_calls/tool_call_id
 * - Stream parser accumulates tool_calls by index correctly
 * - ChatCompletion response maps tool_calls
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LLMMessage, LLMRequest, LLMStreamChunk } from '../../shared/llm-types';

// Mock loadApiKey to avoid real key decryption during tests
vi.mock('../api-key-store', () => ({
  loadApiKey: vi.fn(() => 'sk-test-mock-key'),
}));

// ===========================================================================
// Section 1: buildRequestBody structural tests
// ===========================================================================

describe('buildRequestBody', () => {
  let buildRequestBody: (req: LLMRequest) => Record<string, unknown>;

  beforeEach(async () => {
    const mod = await import('../llm-client');
    buildRequestBody = mod.buildRequestBody;
  });

  it('passes tools through to the request body', () => {
    const tools: LLMRequest['tools'] = [
      {
        type: 'function',
        function: {
          name: 'test_tool',
          description: 'A test tool',
          parameters: { type: 'object', properties: { arg1: { type: 'string' } } },
        },
      },
    ];
    const body = buildRequestBody({
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
      tools,
    });
    expect(body.tools).toEqual(tools);
  });

  it('passes tool_choice through to the request body', () => {
    const body = buildRequestBody({
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
      tool_choice: 'auto',
    });
    expect(body.tool_choice).toBe('auto');
  });

  it('passes tool_choice as specific function', () => {
    const toolChoice = { type: 'function' as const, function: { name: 'test_tool' } };
    const body = buildRequestBody({
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
      tool_choice: toolChoice,
    });
    expect(body.tool_choice).toEqual(toolChoice);
  });

  it('maps LLMMessage with tool_calls and tool_call_id', () => {
    const toolCallMsg: LLMMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_123',
          type: 'function',
          function: { name: 'test_tool', arguments: '{"arg1":"val1"}' },
        },
      ],
    };
    const toolResultMsg: LLMMessage = {
      role: 'user',
      content: 'Tool result here',
      tool_call_id: 'call_123',
    };
    const body = buildRequestBody({
      messages: [toolCallMsg, toolResultMsg],
      stream: false,
    });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_123', type: 'function', function: { name: 'test_tool', arguments: '{"arg1":"val1"}' } },
      ],
    });
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: 'Tool result here',
      tool_call_id: 'call_123',
    });
  });

  it('still works for plain messages without tool fields', () => {
    const body = buildRequestBody({
      messages: [
        { role: 'system', content: 'You are a helper.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
      ],
      stream: false,
      temperature: 0.7,
      maxTokens: 1000,
    });
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a helper.' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Hi' });
    expect(body.messages[2]).toEqual({ role: 'assistant', content: 'Hello!' });
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(1000);
    expect(body.stream).toBe(false);
  });

  it('omits tools and tool_choice when not provided', () => {
    const body = buildRequestBody({
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });
});

// ===========================================================================
// Section 2: chatCompletion tool_calls mapping
// ===========================================================================

describe('chatCompletion tool_calls mapping', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'cmpl-test',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"query":"test"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts tool_calls from chatCompletion response', async () => {
    const { chatCompletion } = await import('../llm-client');
    const response = await chatCompletion({
      messages: [{ role: 'user', content: 'Search something' }],
      stream: false,
    });
    expect(response.toolCalls).toBeDefined();
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0].id).toBe('call_1');
    expect(response.toolCalls![0].function.name).toBe('search');
    expect(response.toolCalls![0].function.arguments).toBe('{"query":"test"}');
    expect(response.finishReason).toBe('tool_calls');
    expect(response.content).toBe('');
  });

  it('returns empty toolCalls when no tool_calls in response', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'cmpl-test-2',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Final answer.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    const { chatCompletion } = await import('../llm-client');
    const response = await chatCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    });
    expect(response.toolCalls).toBeUndefined();
    expect(response.content).toBe('Final answer.');
    expect(response.finishReason).toBe('stop');
  });

  it('passes tools in the fetch request body', async () => {
    let capturedBody: string | null = null;
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string ?? null;
        return new Response(JSON.stringify({
          id: 'cmpl-test-3',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    );
    const { chatCompletion } = await import('../llm-client');
    const tools = [{ type: 'function' as const, function: { name: 't', description: 'd', parameters: {} } }];
    await chatCompletion({
      messages: [{ role: 'user', content: 'Hi' }],
      stream: false,
      tools,
      tool_choice: 'auto',
    });
    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.tools).toEqual(tools);
    expect(parsed.tool_choice).toBe('auto');
  });
});

// ===========================================================================
// Section 3: chatCompletionStream tool_calls accumulation
// ===========================================================================

describe('chatCompletionStream tool_calls accumulation', () => {
  function createStreamResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createStreamResponse([]) // default empty, override per test
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits raw tool_calls delta per chunk (not accumulated)', async () => {
    const { chatCompletionStream } = await import('../llm-client');

    // Build chunk payloads using JSON.stringify to avoid escaping issues
    function ssePayload(data: unknown): string {
      return 'data: ' + JSON.stringify(data) + '\n\n';
    }

    const chunk1Payload = {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0, id: 'call_1', type: 'function',
            function: { name: 'search', arguments: '' },
          }],
        },
        finish_reason: null,
      }],
    };
    const chunk2Payload = {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: JSON.stringify({ query: 'test' }) },
          }],
        },
        finish_reason: null,
      }],
    };
    const chunk3Payload = {
      choices: [{
        delta: {
          tool_calls: [{
            index: 1, id: 'call_2', type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ path: '/tmp' }) },
          }],
          content: '',
        },
        finish_reason: null,
      }],
    };

    const chunks = [
      ssePayload(chunk1Payload),
      ssePayload(chunk2Payload),
      ssePayload(chunk3Payload),
      'data: [DONE]\n\n',
    ];
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(createStreamResponse(chunks));

    const receivedChunks: LLMStreamChunk[] = [];
    await chatCompletionStream(
      { messages: [{ role: 'user', content: 'Search and read' }], stream: true },
      (chunk) => { receivedChunks.push(chunk); },
    );

    expect(receivedChunks.length).toBeGreaterThanOrEqual(2);

    // First chunk: tool_call_0 with partial args
    expect(receivedChunks[0].toolCalls).toBeDefined();
    expect(receivedChunks[0].toolCalls).toHaveLength(1);
    expect(receivedChunks[0].toolCalls![0].index).toBe(0);
    expect(receivedChunks[0].toolCalls![0].id).toBe('call_1');
    expect(receivedChunks[0].toolCalls![0].function?.name).toBe('search');
    expect(receivedChunks[0].toolCalls![0].function?.arguments).toBe('');

    // Second chunk: raw delta for tool_call_0 (only index and this chunk's delta — no id/name carried over)
    expect(receivedChunks[1].toolCalls).toBeDefined();
    expect(receivedChunks[1].toolCalls![0].index).toBe(0);
    // id and type are not in this chunk's raw delta (they were in chunk1)
    expect(receivedChunks[1].toolCalls![0].id).toBeUndefined();
    expect(receivedChunks[1].toolCalls![0].type).toBeUndefined();
    expect(receivedChunks[1].toolCalls![0].function?.name).toBeUndefined();
    const expectedArgs = JSON.stringify({ query: 'test' });
    expect(receivedChunks[1].toolCalls![0].function?.arguments).toBe(expectedArgs);

    // Check that we also got tool_call_1 (index 1) when it appeared
    const hasToolCall1 = receivedChunks.some(
      (c) => c.toolCalls?.some((tc) => tc.index === 1)
    );
    expect(hasToolCall1).toBe(true);
  });

  it('handles content alongside tool_calls', async () => {
    const { chatCompletionStream } = await import('../llm-client');
    const chunks: string[] = [
      'data: {"choices":[{"delta":{"content":"Thinking"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ];
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(createStreamResponse(chunks));

    const receivedChunks: LLMStreamChunk[] = [];
    await chatCompletionStream(
      { messages: [{ role: 'user', content: 'Hi' }], stream: true },
      (chunk) => { receivedChunks.push(chunk); },
    );

    // First chunk: content only, no tool_calls
    expect(receivedChunks[0].content).toBe('Thinking');
    expect(receivedChunks[0].toolCalls).toBeUndefined();

    // Second chunk: tool_calls present
    expect(receivedChunks[1].toolCalls).toBeDefined();
    expect(receivedChunks[1].toolCalls![0].function?.name).toBe('search');
  });

  it('still works without any tool_calls in stream', async () => {
    const { chatCompletionStream } = await import('../llm-client');
    const chunks: string[] = [
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(createStreamResponse(chunks));

    const receivedChunks: LLMStreamChunk[] = [];
    await chatCompletionStream(
      { messages: [{ role: 'user', content: 'Hi' }], stream: true },
      (chunk) => { receivedChunks.push(chunk); },
    );

    expect(receivedChunks.length).toBeGreaterThanOrEqual(2);
    expect(receivedChunks[0].content).toBe('Hello');
    expect(receivedChunks[0].toolCalls).toBeUndefined();
    expect(receivedChunks[1].content).toBe(' world');
    expect(receivedChunks[1].toolCalls).toBeUndefined();
  });
});
