/**
 * llm-client-responses.test.ts — Responses API（原生 web_search）客户端测试。
 *
 * Verifies:
 * - messagesToResponsesInput：OpenAI 消息 → Responses items
 *   （function_call / function_call_output / web_search_call 原样 / reasoning /
 *    丢弃 web_search 对应的 tool 结果消息）
 * - buildResponsesRequestBody：thinking/effort → reasoning.effort 映射、tools 透传
 * - responsesCompletion 非流式：function 轮 / 搜索自动完成 / 纯搜索轮
 * - responsesStream 流式：语义化 SSE 事件解析（searchStatus / usage）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LLMMessage, LLMRequest, LLMStreamChunk, WebSearchCallItem } from '../../shared/llm-types';

// Mock loadApiKey to avoid real key decryption during tests
vi.mock('../api-key-store', () => ({
  loadApiKey: vi.fn(() => 'sk-test-mock-key'),
}));

vi.mock('../settings-store', () => ({
  getSettings: vi.fn(() => ({
    model: 'deepseek-v4-flash',
    thinking: true,
    reasoningEffort: 'high',
    notifications: true,
  })),
}));

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
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function createJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const usagePayload = { input_tokens: 100, output_tokens: 50, total_tokens: 150 };

// ===========================================================================
// messagesToResponsesInput
// ===========================================================================

describe('messagesToResponsesInput', () => {
  let messagesToResponsesInput: (msgs: LLMMessage[], cache: Map<string, WebSearchCallItem>) => unknown[];

  beforeEach(async () => {
    const mod = await import('../llm-client');
    messagesToResponsesInput = mod.messagesToResponsesInput;
  });

  it('system/user/assistant → message items', () => {
    const items = messagesToResponsesInput(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      new Map(),
    );
    expect(items).toEqual([
      { type: 'message', role: 'system', content: 'sys' },
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'assistant', content: 'hello' },
    ]);
  });

  it('assistant tool_calls → function_call item；tool 消息 → function_call_output', () => {
    const items = messagesToResponsesInput(
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'read_node', arguments: '{"nodeId":"n1"}' } }],
        },
        { role: 'tool', content: '{"ok":true}', tool_call_id: 'call_1' },
      ],
      new Map(),
    );
    expect(items).toEqual([
      { type: 'function_call', call_id: 'call_1', name: 'read_node', arguments: '{"nodeId":"n1"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
    ]);
  });

  it('web_search tool_call → web_search_call item（缓存原样回传）', () => {
    const cached = new Map<string, WebSearchCallItem>([
      ['ws_1', { id: 'ws_1', status: 'completed', action: { type: 'search', queries: ['q'] } }],
    ]);
    const items = messagesToResponsesInput(
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'ws_1', type: 'web_search' as const }],
        },
        // 对应 web_search 的 tool 结果必须丢弃（服务端自动恢复搜索结果）
        { role: 'tool', content: '{"ok":true}', tool_call_id: 'ws_1' },
      ],
      cached,
    );
    expect(items).toEqual([
      { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', queries: ['q'] } },
    ]);
  });

  it('web_search tool_call 无缓存时构造最小 item', () => {
    const items = messagesToResponsesInput(
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'ws_x', type: 'web_search' as const }],
        },
      ],
      new Map(),
    );
    expect(items).toEqual([{ type: 'web_search_call', id: 'ws_x', action: { type: 'search' } }]);
  });

  it('assistant reasoning_content → reasoning item（明文）', () => {
    const items = messagesToResponsesInput(
      [{ role: 'assistant', content: '答案', reasoning_content: '思考中…' }],
      new Map(),
    );
    expect(items).toEqual([
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: '思考中…' }] },
      { type: 'message', role: 'assistant', content: '答案' },
    ]);
  });
});

// ===========================================================================
// buildResponsesRequestBody
// ===========================================================================

describe('buildResponsesRequestBody', () => {
  let buildResponsesRequestBody: (req: LLMRequest, cache: Map<string, WebSearchCallItem>) => Record<string, unknown>;

  beforeEach(async () => {
    const mod = await import('../llm-client');
    buildResponsesRequestBody = mod.buildResponsesRequestBody;
  });

  it('thinking enabled + effort high → reasoning.effort=high；tools 透传（含 web_search）', () => {
    const body = buildResponsesRequestBody(
      {
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        thinking: { type: 'enabled' },
        reasoningEffort: 'high',
        tools: [{ type: 'web_search' }],
      },
      new Map(),
    ) as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.tools).toEqual([{ type: 'web_search' }]);
    expect(body.stream).toBe(true);
  });

  it('function 工具转 Responses 扁平结构（type/name/description/parameters 同级）', () => {
    const body = buildResponsesRequestBody(
      {
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        tools: [
          {
            type: 'function',
            function: { name: 'read_node', description: '读节点', parameters: { type: 'object' } },
          },
        ],
      },
      new Map(),
    ) as Record<string, unknown>;
    expect(body.tools).toEqual([
      { type: 'function', name: 'read_node', description: '读节点', parameters: { type: 'object' } },
    ]);
  });

  it('thinking disabled → reasoning.effort=none', () => {
    const body = buildResponsesRequestBody(
      {
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        thinking: { type: 'disabled' },
      },
      new Map(),
    ) as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: 'none' });
  });
});

// ===========================================================================
// responsesCompletion（非流式）
// ===========================================================================

describe('responsesCompletion', () => {
  afterEach(() => vi.restoreAllMocks());

  it('function_call 输出 → toolCalls（finishReason=tool_calls）', async () => {
    const { responsesCompletion } = await import('../llm-client');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createJsonResponse({
        id: 'r1',
        status: 'completed',
        output: [
          { type: 'function_call', id: 'call_1', name: 'read_node', arguments: '{"nodeId":"n1"}' },
        ],
        usage: usagePayload,
      }),
    );
    const res = await responsesCompletion(
      { messages: [{ role: 'user', content: 'hi' }], stream: false },
      new Map(),
    );
    expect(res.finishReason).toBe('tool_calls');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0].function.name).toBe('read_node');
    expect(res.content).toBe('');
    expect(res.webSearchCalls).toBeUndefined();
  });

  it('web_search_call + message（服务端自动完成搜索+回答）→ content + webSearchCalls', async () => {
    const { responsesCompletion } = await import('../llm-client');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createJsonResponse({
        id: 'r2',
        status: 'completed',
        output: [
          { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', queries: ['q'] } },
          { type: 'reasoning', content: [{ type: 'reasoning_text', text: '思考' }] },
          { type: 'message', content: [{ type: 'output_text', text: '答案' }] },
        ],
        usage: usagePayload,
      }),
    );
    const res = await responsesCompletion(
      { messages: [{ role: 'user', content: '搜索下' }], stream: false },
      new Map(),
    );
    expect(res.finishReason).toBe('stop');
    expect(res.content).toBe('答案');
    expect(res.reasoningContent).toBe('思考');
    expect(res.webSearchCalls).toEqual([{ id: 'ws_1', status: 'completed', action: { type: 'search', queries: ['q'] } }]);
    expect(res.toolCalls).toBeUndefined();
  });

  it('纯 web_search_call（无 message）→ finishReason=tool_calls（服务端搜索轮）', async () => {
    const { responsesCompletion } = await import('../llm-client');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createJsonResponse({
        id: 'r3',
        status: 'completed',
        output: [
          { type: 'web_search_call', id: 'ws_1', status: 'in_progress', action: { type: 'search', queries: ['q'] } },
        ],
        usage: usagePayload,
      }),
    );
    const res = await responsesCompletion(
      { messages: [{ role: 'user', content: '搜索下' }], stream: false },
      new Map(),
    );
    expect(res.finishReason).toBe('tool_calls');
    expect(res.webSearchCalls).toHaveLength(1);
    expect(res.content).toBe('');
  });
});

// ===========================================================================
// responsesStream（流式，语义化 SSE 事件）
// ===========================================================================

describe('responsesStream', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(createStreamResponse([]));
  });

  afterEach(() => vi.restoreAllMocks());

  it('解析搜索状态 + 文本增量 + usage 收尾', async () => {
    const { responsesStream } = await import('../llm-client');
    const webSearchItems = new Map<string, WebSearchCallItem>();

    const chunks: string[] = [
      sseEvent('response.created', { type: 'response.created', sequence_number: 0 }),
      sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress', action: { type: 'search', queries: ['2026世界杯'] } },
      }),
      sseEvent('response.web_search_call.searching', { type: 'response.web_search_call.searching' }),
      sseEvent('response.web_search_call.completed', { type: 'response.web_search_call.completed' }),
      sseEvent('response.output_text.delta', { type: 'response.output_text.delta', delta: '决赛在' }),
      sseEvent('response.output_text.delta', { type: 'response.output_text.delta', delta: '美国举行。' }),
      sseEvent('response.completed', {
        type: 'response.completed',
        response: {
          id: 'r1',
          status: 'completed',
          output: [
            { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', queries: ['2026世界杯'] } },
            { type: 'message', content: [{ type: 'output_text', text: '决赛在美国举行。' }] },
          ],
          usage: usagePayload,
        },
      }),
    ];
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(createStreamResponse(chunks));

    const received: LLMStreamChunk[] = [];
    await responsesStream(
      { messages: [{ role: 'user', content: '搜一下' }], stream: true },
      webSearchItems,
      (chunk) => { received.push(chunk); },
    );

    const statuses = received.filter((c) => c.searchStatus).map((c) => c.searchStatus);
    expect(statuses).toContain('searching');
    expect(statuses).toContain('completed');
    expect(received.filter((c) => c.content).map((c) => c.content).join('')).toBe('决赛在美国举行。');
    expect(webSearchItems.get('ws_1')).toEqual({ id: 'ws_1', status: 'in_progress', action: { type: 'search', queries: ['2026世界杯'] } });

    const usageChunk = received.find((c) => c.usage);
    expect(usageChunk).toBeDefined();
    expect(usageChunk!.finishReason).toBe('stop');
    expect(usageChunk!.webSearchCalls).toHaveLength(1);
    expect(usageChunk!.usage).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  });

  it('function_call_arguments 增量 → toolCalls delta', async () => {
    const { responsesStream } = await import('../llm-client');
    const chunks: string[] = [
      sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'call_1', name: 'read_node' },
      }),
      sseEvent('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"nodeId":"n1"}' }),
      sseEvent('response.completed', {
        type: 'response.completed',
        response: {
          id: 'r2',
          status: 'completed',
          output: [{ type: 'function_call', id: 'call_1', name: 'read_node', arguments: '{"nodeId":"n1"}' }],
          usage: usagePayload,
        },
      }),
    ];
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(createStreamResponse(chunks));

    const received: LLMStreamChunk[] = [];
    await responsesStream(
      { messages: [{ role: 'user', content: 'hi' }], stream: true },
      new Map(),
      (chunk) => { received.push(chunk); },
    );

    const toolDeltas = received.filter((c) => c.toolCalls);
    expect(toolDeltas.length).toBeGreaterThanOrEqual(2);
    expect(toolDeltas[0].toolCalls![0].id).toBe('call_1');
    expect(toolDeltas[0].toolCalls![0].function?.name).toBe('read_node');
    const argsDelta = toolDeltas.find((c) => c.toolCalls!.some((tc) => tc.function?.arguments));
    expect(argsDelta?.toolCalls![0].function?.arguments).toBe('{"nodeId":"n1"}');
    const usageChunk = received.find((c) => c.usage);
    expect(usageChunk!.finishReason).toBe('tool_calls');
  });
});
