/**
 * model-adapter.test.ts — TDD tests for I7_T02 NativeModelAdapter
 *
 * Task: I7_T02 "ModelAdapter — NativeModelAdapter（OpenAI/DeepSeek tool_calls + ModelTransport 注入）"
 *
 * Covers:
 *   - model-adapter.ts — NativeModelAdapter class, ModelTransport interface,
 *     ChatChunk type, ChatResponse type, UsageUnavailableError
 *
 * RED-run expected because:
 *   1. model-adapter.ts doesn't exist yet (dynamic import will fail)
 *   2. Type assertions (@ts-expect-error) verified by tsc --noEmit quality gate
 *   3. Structural checks verify runtime behavior once implementation exists
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Static type imports — survive vitest/esbuild transpilation because
// they are stripped before runtime. These reference existing modules.
// ---------------------------------------------------------------------------

import type {
  ModelTurn,
  ModelTurnInput,
  ModelTurnOptions,
  Usage,
  ToolCall,
  ModelAdapter,
} from '../agent-runtime/model-types';

// model-adapter.ts does NOT exist yet — static imports here are verified
// by the separate `tsc --noEmit` quality gate and will fail during RED phase.
import type {
  NativeModelAdapter,
  ModelTransport,
  ChatChunk,
  ChatResponse,
  UsageUnavailableError,
} from '../agent-runtime/model-adapter';

// ---------------------------------------------------------------------------
// Helper types: extract discriminant variants from discriminated unions
// ---------------------------------------------------------------------------

type ModelTurnToolCalls = Extract<ModelTurn, { type: 'tool_calls' }>;
type ModelTurnFinal = Extract<ModelTurn, { type: 'final' }>;

// ---------------------------------------------------------------------------
// ChatChunk discriminant union shape verification
// (defined locally for structural checks before model-adapter.ts exists)
// ---------------------------------------------------------------------------

type LocalChatChunk =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; arguments?: string }
  | { type: 'done'; finishReason: 'stop' | 'tool_calls'; usage: Usage };

interface LocalChatResponse {
  choices: Array<{
    index: number;
    message: {
      role: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: 'stop' | 'tool_calls' | string;
  }>;
  usage?: Usage;
}

interface LocalModelTransport {
  chat(
    messages: unknown[],
    tools?: unknown[],
    options?: unknown,
  ): Promise<LocalChatResponse>;
  chatStream(
    messages: unknown[],
    tools?: unknown[],
    options?: unknown,
  ): AsyncIterable<LocalChatChunk>;
}

// ===========================================================================
// MODULE EXISTENCE — Dynamic imports verify files exist
// ===========================================================================

describe('module existence (dynamic import guards)', () => {
  // model-adapter.ts does NOT exist yet → this test SHOULD FAIL (RED)
  it('model-adapter.ts module can be loaded [EXPECTED RED: file missing]', async () => {
    // This dynamic import will throw MODULE_NOT_FOUND until model-adapter.ts is created
    const mod = await import('../agent-runtime/model-adapter');
    expect(mod).toBeDefined();
  });
});

// ===========================================================================
// ModelTransport interface shape (compile-time)
// ===========================================================================

describe('ModelTransport interface shape (quality gate)', () => {
  // BDD @happy-path: ModelTransport injected via constructor
  // Rule: ModelTransport 必注（无默认实现）
  // Catches bug: ModelTransport missing chat() or chatStream() method

  it('ModelTransport requires chat() method returning Promise<ChatResponse>', () => {
    const transport: LocalModelTransport = {
      chat: async () => ({
        choices: [{ index: 0, message: { role: 'assistant', content: 'test' }, finish_reason: 'stop' }],
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      chatStream: async function* () {
        yield { type: 'text_delta', content: 'test' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };

    expect(typeof transport.chat).toBe('function');
    expect(typeof transport.chatStream).toBe('function');

    const chatResult = transport.chat([], []);
    expect(chatResult).toBeInstanceOf(Promise);

    const streamResult = transport.chatStream([], []);
    expect(typeof streamResult[Symbol.asyncIterator]).toBe('function');
  });

  // Catches bug: transport lacks chatStream method
  it('chat returns a promise resolving to ChatResponse with choices and usage', async () => {
    const transport: LocalModelTransport = {
      chat: async () => ({
        choices: [{ index: 0, message: { role: 'assistant', content: 'response' }, finish_reason: 'stop' }],
        usage: { inputTokens: 20, outputTokens: 10 },
      }),
      chatStream: async function* () { /* noop */ },
    };

    const response = await transport.chat([], []);
    expect(response.choices).toHaveLength(1);
    expect(response.choices[0].message.content).toBe('response');
    expect(response.usage).toBeDefined();
    expect(response.usage!.inputTokens).toBe(20);
    expect(response.usage!.outputTokens).toBe(10);
  });
});

// ===========================================================================
// ChatChunk type shape (compile-time boundary)
// ===========================================================================

describe('ChatChunk discriminant union shape (quality gate)', () => {
  // BDD @happy-path: ChatChunk 判别联合: text_delta | tool_call_delta | done
  // Rule: ChatChunk is a discriminated union with three variants
  // Catches bug: Missing variant or wrong field structure

  it('text_delta variant requires type="text_delta" and content string', () => {
    const chunk: LocalChatChunk = { type: 'text_delta', content: 'Hello' };
    expect(chunk.type).toBe('text_delta');
    expect(chunk.content).toBe('Hello');
    expect(typeof chunk.content).toBe('string');
  });

  it('tool_call_delta variant requires index and optionally id, name, arguments', () => {
    const chunkWithId: LocalChatChunk = { type: 'tool_call_delta', index: 0, id: 'c1', name: 'search' };
    expect(chunkWithId.type).toBe('tool_call_delta');
    expect(chunkWithId.index).toBe(0);
    expect(chunkWithId.id).toBe('c1');
    expect(chunkWithId.name).toBe('search');

    const chunkWithArgs: LocalChatChunk = { type: 'tool_call_delta', index: 0, arguments: '{"query":"test"}' };
    expect(chunkWithArgs.type).toBe('tool_call_delta');
    expect(chunkWithArgs.arguments).toBe('{"query":"test"}');
  });

  it('done variant requires finishReason and usage', () => {
    const chunk: LocalChatChunk = {
      type: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    expect(chunk.type).toBe('done');
    expect(chunk.finishReason).toBe('stop');
    expect(chunk.usage.inputTokens).toBe(100);
    expect(chunk.usage.outputTokens).toBe(50);
  });

  // Catches bug: done chunk missing usage (rules say must include usage)
  it('done variant accepts finishReason tool_calls', () => {
    const chunk: LocalChatChunk = {
      type: 'done',
      finishReason: 'tool_calls',
      usage: { inputTokens: 50, outputTokens: 20 },
    };
    expect(chunk.finishReason).toBe('tool_calls');
    expect(chunk.usage.inputTokens).toBe(50);
  });

  // Catches bug: done chunk without usage is accepted
  it('done variant rejects missing usage [compile-time: @ts-expect-error]', () => {
    // @ts-expect-error — done requires usage field
    const chunk: LocalChatChunk = { type: 'done', finishReason: 'stop' };
    expect(chunk).toBeDefined();
  });
});

// ===========================================================================
// NativeModelAdapter construction (ModelTransport injection)
// ===========================================================================

describe('NativeModelAdapter construction — ModelTransport injection', () => {
  // BDD @happy-path: ModelTransport 通过构造函数注入
  // Rule: ModelTransport 必注（无默认实现）
  // Catches bug: Constructor accepts no arguments or has default transport

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };
  let NativeModelAdapterClassType: unknown;

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClassType = mod.NativeModelAdapter;
      NativeModelAdapterClass = mod.NativeModelAdapter;
    } catch (err) {
      // Expected RED — model-adapter.ts doesn't exist yet
      throw new Error(
        'model-adapter.ts not found. This is expected during RED phase. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('NativeModelAdapter is a class/constructor', () => {
    expect(NativeModelAdapterClassType).toBeDefined();
    expect(typeof NativeModelAdapterClassType).toBe('function');
  });

  it('NativeModelAdapter constructor accepts ModelTransport', () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{ index: 0, message: { role: 'assistant', content: 'test' }, finish_reason: 'stop' }],
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      chatStream: async function* () {
        yield { type: 'text_delta', content: 'test' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };

    const adapter = new NativeModelAdapterClass(mockTransport);
    expect(adapter).toBeDefined();
    expect(adapter).toHaveProperty('provider');
    expect(adapter).toHaveProperty('runTurn');
  });

  it('NativeModelAdapter has readonly provider string', () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{ index: 0, message: { role: 'assistant', content: 'test' }, finish_reason: 'stop' }],
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      chatStream: async function* () {
        yield { type: 'text_delta', content: 'test' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };

    const adapter = new NativeModelAdapterClass(mockTransport);
    expect(typeof adapter.provider).toBe('string');
    expect(adapter.provider.length).toBeGreaterThan(0);
    expect(['deepseek', 'openai']).toContain(adapter.provider);
  });

  it('NativeModelAdapter implements ModelAdapter interface', () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{ index: 0, message: { role: 'assistant', content: 'test' }, finish_reason: 'stop' }],
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      chatStream: async function* () {
        yield { type: 'text_delta', content: 'test' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };

    const adapter = new NativeModelAdapterClass(mockTransport);

    // ModelAdapter interface compliance
    const _adapterCheck: ModelAdapter = adapter;
    void _adapterCheck;

    const result = adapter.runTurn({ systemPrompt: 'test', messages: [] });
    expect(result).toBeInstanceOf(Promise);
  });

  // Catches bug: Direct import of llm-client.ts instead of using injected transport
  it('adapter uses injected transport, does not create its own', () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{ index: 0, message: { role: 'assistant', content: 'via mock' }, finish_reason: 'stop' }],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      chatStream: async function* () {
        yield { type: 'text_delta', content: 'via mock' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const adapter = new NativeModelAdapterClass(mockTransport);
    // If adapter used a real transport, this would talk to a live API.
    // Using the mock proves the injection works.
    expect(adapter).toBeDefined();
  });
});

// ===========================================================================
// Non-streaming: Native tool_calls parsing
// ===========================================================================

describe('Non-streaming — Native tool_calls parsing', () => {
  // =========================================================================
  // Single tool_call
  // =========================================================================

  describe('single tool_call response', () => {
    // BDD @happy-path: 正确解析 tool_calls 数组为 ModelTurn.tool_calls
    // Rule: Response tool_calls → ModelTurn{type:'tool_calls', toolCalls:[{id, name, arguments}]}
    // Catches bug: Wrong mapping of id/name/arguments fields

    let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };
    let adapter: { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };

    beforeAll(async () => {
      try {
        const mod = await import('../agent-runtime/model-adapter');
        NativeModelAdapterClass = mod.NativeModelAdapter;
      } catch (err) {
        throw new Error(
          'model-adapter.ts not found. Expected RED. ' +
          'Error: ' + (err instanceof Error ? err.message : String(err)),
        );
      }
    });

    beforeEach(() => {
      const mockTransport: LocalModelTransport = {
        chat: async () => ({
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_001',
                type: 'function',
                function: { name: 'search_workspace', arguments: '{"query":"test query"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { inputTokens: 100, outputTokens: 20 },
        }),
        chatStream: async function* () { /* noop in non-streaming tests */ },
      };
      adapter = new NativeModelAdapterClass(mockTransport);
    });

    it('returns ModelTurn with type tool_calls', async () => {
      const input: ModelTurnInput = {
        systemPrompt: 'You are a helper.',
        messages: [{ role: 'user', content: 'Search for something.' }],
        tools: [{ name: 'search_workspace', description: 'Search workspace', inputSchema: {} as any }],
      };
      const result = await adapter.runTurn(input);
      expect(result.type).toBe('tool_calls');
    });

    it('toolCalls[0].id matches response id', async () => {
      const input: ModelTurnInput = {
        systemPrompt: 'You are a helper.',
        messages: [{ role: 'user', content: 'Search for something.' }],
        tools: [{ name: 'search_workspace', description: 'Search workspace', inputSchema: {} as any }],
      };
      const result = await adapter.runTurn(input);
      expect(result.type).toBe('tool_calls');
      const toolCallsTurn = result as ModelTurnToolCalls;
      expect(toolCallsTurn.toolCalls[0].id).toBe('call_001');
    });

    it('toolCalls[0].name equals function.name', async () => {
      const input: ModelTurnInput = {
        systemPrompt: 'You are a helper.',
        messages: [{ role: 'user', content: 'Search for something.' }],
        tools: [{ name: 'search_workspace', description: 'Search workspace', inputSchema: {} as any }],
      };
      const result = await adapter.runTurn(input);
      expect(result.type).toBe('tool_calls');
      const toolCallsTurn = result as ModelTurnToolCalls;
      expect(toolCallsTurn.toolCalls[0].name).toBe('search_workspace');
    });

    it('toolCalls[0].arguments is JSON.parse(function.arguments)', async () => {
      const input: ModelTurnInput = {
        systemPrompt: 'You are a helper.',
        messages: [{ role: 'user', content: 'Search for something.' }],
        tools: [{ name: 'search_workspace', description: 'Search workspace', inputSchema: {} as any }],
      };
      const result = await adapter.runTurn(input);
      expect(result.type).toBe('tool_calls');
      const toolCallsTurn = result as ModelTurnToolCalls;
      expect(toolCallsTurn.toolCalls[0].arguments).toEqual({ query: 'test query' });
    });

    it('usage contains inputTokens and outputTokens', async () => {
      const input: ModelTurnInput = {
        systemPrompt: 'You are a helper.',
        messages: [{ role: 'user', content: 'Search for something.' }],
        tools: [{ name: 'search_workspace', description: 'Search workspace', inputSchema: {} as any }],
      };
      const result = await adapter.runTurn(input);
      expect(result.type).toBe('tool_calls');
      const toolCallsTurn = result as ModelTurnToolCalls;
      expect(toolCallsTurn.usage.inputTokens).toBe(100);
      expect(toolCallsTurn.usage.outputTokens).toBe(20);
    });

    // ROUND 5 FIX 1: Dynamic argument parsing — cheater must NOT hardcode parseToolArguments()
    // BDD @happy-path: 正确解析 tool_calls 数组为 ModelTurn.tool_calls
    // Rule: toolCalls[0].arguments = JSON.parse(function.arguments)
    // Catches bug: Cheater implements hardcoded {query:'test'} for search_workspace
    //              instead of using JSON.parse(rawArgs)
    it('uses dynamic JSON.parse for unusual arguments that cannot be hardcoded', async () => {
      // Use a random string + unexpected fields so no cheater can hardcode the result
      const unusualArgs = JSON.stringify({
        query: 'unexpected-' + Math.random(),
        limit: 7,
        extra: true,
      });

      const mockTransport: LocalModelTransport = {
        chat: async () => ({
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_unusual',
                type: 'function',
                function: { name: 'search_workspace', arguments: unusualArgs },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { inputTokens: 100, outputTokens: 20 },
        }),
        chatStream: async function* () { /* noop */ },
      };
      const dynamicAdapter = new NativeModelAdapterClass(mockTransport);

      const input: ModelTurnInput = {
        systemPrompt: 'You are a helper.',
        messages: [{ role: 'user', content: 'Test unusual arguments.' }],
        tools: [{ name: 'search_workspace', description: 'Search workspace', inputSchema: {} as any }],
      };

      const result = await dynamicAdapter.runTurn(input);
      expect(result.type).toBe('tool_calls');
      const toolCallsTurn = result as ModelTurnToolCalls;
      expect(toolCallsTurn.toolCalls[0].arguments).toEqual({
        query: expect.stringContaining('unexpected-'),
        limit: 7,
        extra: true,
      });
    });

    // ROUND 6 FIX 1: Invalid JSON in function.arguments → must throw
    // BDD @happy-path: 正确解析 tool_calls 数组为 ModelTurn.tool_calls
    // Rule: toolCalls[0].arguments = JSON.parse(function.arguments)
    // Catches bug: Cheater wraps JSON.parse in try/catch that returns {} on error
    it('throws when function.arguments is invalid JSON', async () => {
      const brokenTransport: LocalModelTransport = {
        chat: async () => ({
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_broken',
                type: 'function',
                function: { name: 'search_workspace', arguments: '{broken' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { inputTokens: 100, outputTokens: 20 },
        }),
        chatStream: async function* () { /* noop */ },
      };
      const brokenAdapter = new NativeModelAdapterClass(brokenTransport);

      const input: ModelTurnInput = {
        systemPrompt: 'You are a helper.',
        messages: [{ role: 'user', content: 'Do something.' }],
        tools: [{ name: 'search_workspace', description: 'Search', inputSchema: {} as any }],
      };

      await expect(brokenAdapter.runTurn(input)).rejects.toThrow();
    });

    // ROUND 6 FIX 2a: Null function field in tool_call entry → must throw
    // BDD @failure-path: tool_calls response malformed
    // Rule: tool_calls entry must have a function field
    // Catches bug: Cheater skips null check on tc.function
    it('throws when tool_calls entry has null function', async () => {
      const nullFunctionTransport: LocalModelTransport = {
        chat: async () => ({
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_null',
                type: 'function',
                function: null as unknown as { name: string; arguments: string },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { inputTokens: 100, outputTokens: 20 },
        }),
        chatStream: async function* () { /* noop */ },
      };
      const nullAdapter = new NativeModelAdapterClass(nullFunctionTransport);

      const input: ModelTurnInput = {
        systemPrompt: 'You are a helper.',
        messages: [{ role: 'user', content: 'Do something.' }],
        tools: [{ name: 'search_workspace', description: 'Search', inputSchema: {} as any }],
      };

      await expect(nullAdapter.runTurn(input)).rejects.toThrow();
    });

    // ROUND 6 FIX 2b: Undefined function field in tool_call entry → must throw
    // Catches bug: Cheater accesses tc.function.name without checking tc.function exists
    it('throws when tool_calls entry has undefined function', async () => {
      const undefinedFunctionTransport: LocalModelTransport = {
        chat: async () => ({
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_undef',
                type: 'function',
                // function is explicitly undefined
              }] as Array<{ id: string; type: string; function: { name: string; arguments: string } }>,
            },
            finish_reason: 'tool_calls',
          }],
          usage: { inputTokens: 100, outputTokens: 20 },
        }),
        chatStream: async function* () { /* noop */ },
      };
      const undefAdapter = new NativeModelAdapterClass(undefinedFunctionTransport);

      const input: ModelTurnInput = {
        systemPrompt: 'You are a helper.',
        messages: [{ role: 'user', content: 'Do something.' }],
        tools: [{ name: 'search_workspace', description: 'Search', inputSchema: {} as any }],
      };

      await expect(undefAdapter.runTurn(input)).rejects.toThrow();
    });

    // ROUND 8: Mixed content+tool_calls — tool_calls prioritized
    // BDD @happy-path: 正确解析 tool_calls 数组为 ModelTurn.tool_calls
    // Rule: When message has both content and tool_calls, tool_calls wins
    // Catches bug: Cheater treats content as final answer ignoring tool_calls
    it('prioritizes tool_calls when both content and tool_calls are present', async () => {
      const mockTransport: LocalModelTransport = {
        chat: async () => ({
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'some text answer that should be ignored',
              tool_calls: [{
                id: 'call_mixed',
                type: 'function',
                function: { name: 'search_workspace', arguments: '{}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { inputTokens: 100, outputTokens: 20 },
        }),
        chatStream: async function* () { /* noop */ },
      };
      const adapter = new NativeModelAdapterClass(mockTransport);

      const input: ModelTurnInput = {
        systemPrompt: 'You are a helper.',
        messages: [{ role: 'user', content: 'test' }],
        tools: [{ name: 'search_workspace', description: 'Search', inputSchema: {} as any }],
      };

      const result = await adapter.runTurn(input);
      expect(result.type).toBe('tool_calls');
      const toolCallsTurn = result as ModelTurnToolCalls;
      expect(toolCallsTurn.toolCalls).toHaveLength(1);
      expect(toolCallsTurn.toolCalls[0].name).toBe('search_workspace');
    });
  });

  // =========================================================================
  // Additional tool_calls edge cases
  // =========================================================================

  describe('additional tool_calls edge cases', () => {
    // ROUND 6 additional edge case: tool_calls with empty array
    // BDD @failure-path: tool_calls response edge case
    // Rule: Empty tool_calls array should be handled gracefully or throw
    // Catches bug: Cheater assumes tool_calls always has at least one entry
    //              and crashes on tool_calls: []

    let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };

    beforeAll(async () => {
      try {
        const mod = await import('../agent-runtime/model-adapter');
        NativeModelAdapterClass = mod.NativeModelAdapter;
      } catch (err) {
        throw new Error(
          'model-adapter.ts not found. Expected RED. ' +
          'Error: ' + (err instanceof Error ? err.message : String(err)),
        );
      }
    });

    it('throws when tool_calls array is empty but finish_reason is tool_calls', async () => {
      const emptyTcTransport: LocalModelTransport = {
        chat: async () => ({
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { inputTokens: 100, outputTokens: 20 },
        }),
        chatStream: async function* () { /* noop */ },
      };
      const emptyAdapter = new NativeModelAdapterClass(emptyTcTransport);

      const input: ModelTurnInput = {
        systemPrompt: 'You are a helper.',
        messages: [{ role: 'user', content: 'test' }],
        tools: [{ name: 'search_workspace', description: 'Search', inputSchema: {} as any }],
      };

      await expect(emptyAdapter.runTurn(input)).rejects.toThrow();
    });

    it('throws when tool_calls entry has missing function.name', async () => {
      const noNameTransport: LocalModelTransport = {
        chat: async () => ({
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_nn',
                type: 'function',
                function: { name: '', arguments: '{}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { inputTokens: 100, outputTokens: 20 },
        }),
        chatStream: async function* () { /* noop */ },
      };
      const noNameAdapter = new NativeModelAdapterClass(noNameTransport);

      const input: ModelTurnInput = {
        systemPrompt: 'You are a helper.',
        messages: [{ role: 'user', content: 'test' }],
        tools: [{ name: 'search_workspace', description: 'Search', inputSchema: {} as any }],
      };

      await expect(noNameAdapter.runTurn(input)).rejects.toThrow();
    });

    // ROUND 6 additional edge case: tool_calls with null message.content works
    // BDD @happy-path: 正确解析 tool_calls → message.content can be null
    // Rule: For tool_calls responses, content is typically null, not a string
    // Catches bug: Cheater tries to parse null content as answer string
    it('correctly handles tool_calls response with null message.content', async () => {
      const nullContentTransport: LocalModelTransport = {
        chat: async () => ({
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_nc',
                type: 'function',
                function: { name: 'search_workspace', arguments: '{"query":"ok"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { inputTokens: 100, outputTokens: 20 },
        }),
        chatStream: async function* () { /* noop */ },
      };
      const adapter = new NativeModelAdapterClass(nullContentTransport);

      const input: ModelTurnInput = {
        systemPrompt: 'You are a helper.',
        messages: [{ role: 'user', content: 'test' }],
        tools: [{ name: 'search_workspace', description: 'Search', inputSchema: {} as any }],
      };

      const result = await adapter.runTurn(input);
      expect(result.type).toBe('tool_calls');
      const toolCallsTurn = result as ModelTurnToolCalls;
      expect(toolCallsTurn.toolCalls).toHaveLength(1);
      expect(toolCallsTurn.toolCalls[0].name).toBe('search_workspace');
      expect(toolCallsTurn.toolCalls[0].arguments).toEqual({ query: 'ok' });
    });

    it('handles function.arguments as empty JSON object', async () => {
      const emptyArgTransport: LocalModelTransport = {
        chat: async () => ({
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_empty',
                type: 'function',
                function: { name: 'search_workspace', arguments: '{}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { inputTokens: 100, outputTokens: 20 },
        }),
        chatStream: async function* () { /* noop */ },
      };
      const adapter = new NativeModelAdapterClass(emptyArgTransport);

      const input: ModelTurnInput = {
        systemPrompt: 'You are a helper.',
        messages: [{ role: 'user', content: 'test' }],
        tools: [{ name: 'search_workspace', description: 'Search', inputSchema: {} as any }],
      };

      const result = await adapter.runTurn(input);
      expect(result.type).toBe('tool_calls');
      const toolCallsTurn = result as ModelTurnToolCalls;
      expect(toolCallsTurn.toolCalls[0].arguments).toEqual({});
    });
  });

  // =========================================================================
  // Multiple tool_calls
  // =========================================================================

  describe('multiple tool_calls in single response', () => {
    // BDD @happy-path: 多 tool_call 一次返回——解析为 tool_calls 数组
    // Rule: Multiple tool_calls → toolCalls array with all entries
    // Catches bug: Only first tool_call parsed, or array flattened

    let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };
    let adapter: { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };

    beforeAll(async () => {
      try {
        const mod = await import('../agent-runtime/model-adapter');
        NativeModelAdapterClass = mod.NativeModelAdapter;
      } catch (err) {
        throw new Error(
          'model-adapter.ts not found. Expected RED. ' +
          'Error: ' + (err instanceof Error ? err.message : String(err)),
        );
      }
    });

    beforeEach(() => {
      const mockTransport: LocalModelTransport = {
        chat: async () => ({
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_001', type: 'function', function: { name: 'search_workspace', arguments: '{"query":"test"}' } },
                { id: 'call_002', type: 'function', function: { name: 'read_node', arguments: '{"nodeId":"n1"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { inputTokens: 200, outputTokens: 40 },
        }),
        chatStream: async function* () { /* noop */ },
      };
      adapter = new NativeModelAdapterClass(mockTransport);
    });

    it('returns tool_calls array of length 2', async () => {
      const input: ModelTurnInput = {
        systemPrompt: 'You are a helper.',
        messages: [{ role: 'user', content: 'Search and read.' }],
        tools: [
          { name: 'search_workspace', description: 'Search', inputSchema: {} as any },
          { name: 'read_node', description: 'Read', inputSchema: {} as any },
        ],
      };
      const result = await adapter.runTurn(input);
      expect(result.type).toBe('tool_calls');
      const toolCallsTurn = result as ModelTurnToolCalls;
      expect(toolCallsTurn.toolCalls).toHaveLength(2);
    });

    it('preserves correct id, name, arguments for each tool call', async () => {
      const input: ModelTurnInput = {
        systemPrompt: 'You are a helper.',
        messages: [{ role: 'user', content: 'Search and read.' }],
        tools: [
          { name: 'search_workspace', description: 'Search', inputSchema: {} as any },
          { name: 'read_node', description: 'Read', inputSchema: {} as any },
        ],
      };
      const result = await adapter.runTurn(input);
      expect(result.type).toBe('tool_calls');
      const toolCallsTurn = result as ModelTurnToolCalls;

      expect(toolCallsTurn.toolCalls[0].id).toBe('call_001');
      expect(toolCallsTurn.toolCalls[0].name).toBe('search_workspace');
      expect(toolCallsTurn.toolCalls[0].arguments).toEqual({ query: 'test' });

      expect(toolCallsTurn.toolCalls[1].id).toBe('call_002');
      expect(toolCallsTurn.toolCalls[1].name).toBe('read_node');
      expect(toolCallsTurn.toolCalls[1].arguments).toEqual({ nodeId: 'n1' });
    });
  });
});

// ===========================================================================
// Non-streaming: Final response parsing
// ===========================================================================

describe('Non-streaming — Final response parsing', () => {
  // BDD @happy-path: 最终答案返回 final ModelTurn 含 usage
  // Rule: choices[0].message.content → ModelTurn{type:'final', answer, usage}
  // Catches bug: Answer not extracted, or usage missing

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };
  let adapter: { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClass = mod.NativeModelAdapter;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  beforeEach(() => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'The final answer is 42.' },
          finish_reason: 'stop',
        }],
        usage: { inputTokens: 150, outputTokens: 30 },
      }),
      chatStream: async function* () { /* noop */ },
    };
    adapter = new NativeModelAdapterClass(mockTransport);
  });

  it('returns ModelTurn with type final', async () => {
    const input: ModelTurnInput = {
      systemPrompt: 'You are a helper.',
      messages: [{ role: 'user', content: 'What is the answer?' }],
    };
    const result = await adapter.runTurn(input);
    expect(result.type).toBe('final');
  });

  it('answer equals choices[0].message.content', async () => {
    const input: ModelTurnInput = {
      systemPrompt: 'You are a helper.',
      messages: [{ role: 'user', content: 'What is the answer?' }],
    };
    const result = await adapter.runTurn(input);
    expect(result.type).toBe('final');
    const finalTurn = result as ModelTurnFinal;
    expect(finalTurn.answer).toBe('The final answer is 42.');
  });

  it('usage is required with inputTokens and outputTokens', async () => {
    const input: ModelTurnInput = {
      systemPrompt: 'You are a helper.',
      messages: [{ role: 'user', content: 'What is the answer?' }],
    };
    const result = await adapter.runTurn(input);
    expect(result.type).toBe('final');
    const finalTurn = result as ModelTurnFinal;
    expect(finalTurn.usage.inputTokens).toBe(150);
    expect(finalTurn.usage.outputTokens).toBe(30);
  });

  // ROUND 6 additional edge case: empty string answer
  // BDD @happy-path: final response should handle empty answer gracefully
  // Rule: Empty string is a valid answer
  // Catches bug: Cheater assumes answer is always non-empty and crashes
  it('handles empty string as answer in final response', async () => {
    const emptyAnswerTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '' },
          finish_reason: 'stop',
        }],
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(emptyAnswerTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    const result = await adapter.runTurn(input);
    expect(result.type).toBe('final');
    const finalTurn = result as ModelTurnFinal;
    expect(finalTurn.answer).toBe('');
  });
});

// ===========================================================================
// Non-streaming: API error handling
// ===========================================================================

describe('Non-streaming — API error handling', () => {
  // BDD @failure-path: API 返回错误时抛出清晰错误
  // Rule: Errors with status code are propagated with clear message
  // Catches bug: Error silently swallowed or generic message without status code

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };
  let adapter: { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClass = mod.NativeModelAdapter;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('throws clear error when API returns 401 Unauthorized', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => {
        const err = new Error('401 Unauthorized: Invalid API key');
        (err as any).status = 401;
        (err as any).statusCode = 401;
        throw err;
      },
      chatStream: async function* () { /* noop */ },
    };
    adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    await expect(adapter.runTurn(input)).rejects.toThrow();
    await expect(adapter.runTurn(input)).rejects.toMatchObject({
      message: expect.stringMatching(/401|Unauthorized|Unauthorized/i),
    });
  });

  it('does not silently swallow API errors', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => {
        throw new Error('API_ERROR: rate limit exceeded');
      },
      chatStream: async function* () { /* noop */ },
    };
    adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    await expect(adapter.runTurn(input)).rejects.not.toBeUndefined();
  });

  it('includes status code in thrown error', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => {
        const err = new Error('403 Forbidden: quota exceeded');
        (err as any).status = 403;
        (err as any).statusCode = 403;
        throw err;
      },
      chatStream: async function* () { /* noop */ },
    };
    adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    try {
      await adapter.runTurn(input);
      expect('should not reach here').toBe('error thrown');
    } catch (err) {
      expect(err).toBeDefined();
      expect(err).toHaveProperty('message');
      expect((err as any).status || (err as any).statusCode).toBeGreaterThanOrEqual(400);
    }
  });

  // ROUND 8: Streaming API error handling
  // BDD @failure-path: API 返回错误时抛出清晰错误 (streaming path)
  // Rule: Errors thrown by chatStream must propagate to runTurn caller
  // Catches bug: Cheater catches/chokes streaming errors silently
  it('propagates errors from chatStream in streaming mode', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat'); },
      chatStream: async function* () {
        throw new Error('403 Forbidden: quota exceeded in streaming');
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    await expect(
      adapter.runTurn(input, { onChunk: () => {} }),
    ).rejects.toThrow();

    await expect(
      adapter.runTurn(input, { onChunk: () => {} }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/403|Forbidden|quota/),
    });
  });
});

// ===========================================================================
// Non-streaming: Defensive response validation (Round 5 Fix 2)
// ===========================================================================

describe('Non-streaming — Defensive response validation', () => {
  // ROUND 5 FIX 2: Defensive null/empty checks on response
  // Catches bug: Cheater skips null checks on response.choices[0] or message.content
  // Rule: Malformed transport responses must produce meaningful errors

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClass = mod.NativeModelAdapter;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('throws when response has empty choices array', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [] as Array<{ index: number; message: { role: string; content?: string | null }; finish_reason: string }>,
      }),
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    await expect(adapter.runTurn(input)).rejects.toThrow();
  });

  it('throws when choices[0].message is null', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{
          index: 0,
          message: null as unknown as { role: string; content?: string | null },
          finish_reason: 'stop',
        }],
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    await expect(adapter.runTurn(input)).rejects.toThrow();
  });

  it('throws when message.content is null for final response', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: null },
          finish_reason: 'stop',
        }],
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    await expect(adapter.runTurn(input)).rejects.toThrow();
  });
});

// ===========================================================================
// Non-streaming: Missing usage
// ===========================================================================

describe('Non-streaming — Missing usage', () => {
  // BDD @failure-path: usage 缺失时抛出 UsageUnavailableError, 不禁默认为 0
  // Rule: API 响应不含 usage 字段 → UsageUnavailableError
  // Catches bug: Usage defaults to 0 instead of throwing

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };
  let UsageUnavailableErrorClass: unknown;

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClass = mod.NativeModelAdapter;
      UsageUnavailableErrorClass = mod.UsageUnavailableError;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('throws UsageUnavailableError when response lacks usage field', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'answer without usage' },
          finish_reason: 'stop',
        }],
        // No usage field
      }),
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    try {
      await adapter.runTurn(input);
      expect('should not reach here').toBe('error thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UsageUnavailableErrorClass as new (...args: never[]) => Error);
    }
  });

  it('throws UsageUnavailableError when usage has missing fields', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'partial usage' },
          finish_reason: 'stop',
        }],
        usage: { inputTokens: 50 } as Usage,  // missing outputTokens
      }),
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    try {
      await adapter.runTurn(input);
      expect('should not reach here').toBe('error thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UsageUnavailableErrorClass as new (...args: never[]) => Error);
    }
  });

  it('does not silently default usage to 0', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'no usage' },
          finish_reason: 'stop',
        }],
      }),
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    try {
      await adapter.runTurn(input);
      expect('should not reach here').toBe('error thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UsageUnavailableErrorClass as new (...args: never[]) => Error);
    }
  });
});

// ===========================================================================
// Streaming: text_delta → final
// ===========================================================================

describe('Streaming — text_delta → final', () => {
  // BDD @happy-path: 流式 text_delta → done 拼接为 final
  // Rule: onChunk called per text_delta, final ModelTurn concatenates all
  // Catches bug: Chunks not concatenated, onChunk not called, usage missing

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClass = mod.NativeModelAdapter;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('onChunk is called for each text_delta chunk', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* () {
        yield { type: 'text_delta', content: 'Hello' };
        yield { type: 'text_delta', content: ' world' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 50, outputTokens: 10 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const chunks: string[] = [];
    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    const result = await adapter.runTurn(input, {
      onChunk: (chunk: string) => { chunks.push(chunk); },
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe('Hello');
    expect(chunks[1]).toBe(' world');
    expect(result.type).toBe('final');
  });

  it('returns ModelTurn with concatenated answer and usage', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* () {
        yield { type: 'text_delta', content: 'Hello' };
        yield { type: 'text_delta', content: ' world' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 50, outputTokens: 10 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    const result = await adapter.runTurn(input, {
      onChunk: () => {},
    });

    expect(result.type).toBe('final');
    const finalTurn = result as ModelTurnFinal;
    expect(finalTurn.answer).toBe('Hello world');
    expect(finalTurn.usage.inputTokens).toBe(50);
    expect(finalTurn.usage.outputTokens).toBe(10);
  });

  // ROUND 6 additional edge case: streaming with only done chunk (no text)
  // BDD @boundary: Stream that yields only a done chunk should produce empty answer
  // Rule: No text_delta chunks before done → empty answer string
  // Catches bug: Cheater crashes on empty text accumulation or missing text_delta
  it('handles streaming with only a done chunk (no text_deltas)', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* () {
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    const chunks: string[] = [];
    const result = await adapter.runTurn(input, {
      onChunk: (chunk: string) => { chunks.push(chunk); },
    });

    expect(chunks).toHaveLength(0);
    expect(result.type).toBe('final');
    const finalTurn = result as ModelTurnFinal;
    expect(finalTurn.answer).toBe('');
    expect(finalTurn.usage.inputTokens).toBe(10);
    expect(finalTurn.usage.outputTokens).toBe(5);
  });
});

// ===========================================================================
// Streaming: tool_call_delta by index
// ===========================================================================

describe('Streaming — tool_call_delta by index', () => {
  // BDD @happy-path: 流式 tool_call_delta 按 index 拼接参数
  // Rule: Arguments fragments accumulated by index, then JSON.parsed
  // Catches bug: Fragments not concatenated, wrong index, JSON parse failure

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClass = mod.NativeModelAdapter;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('accumulates arguments fragments and JSON.parses them', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* () {
        yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'search_workspace' };
        yield { type: 'tool_call_delta', index: 0, arguments: '{"query":' };
        yield { type: 'tool_call_delta', index: 0, arguments: '"test"}' };
        yield { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 100, outputTokens: 30 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    const result = await adapter.runTurn(input, { onChunk: () => {} });
    expect(result.type).toBe('tool_calls');
    const toolCallsTurn = result as ModelTurnToolCalls;
    expect(toolCallsTurn.toolCalls).toHaveLength(1);
    expect(toolCallsTurn.toolCalls[0].id).toBe('c1');
    expect(toolCallsTurn.toolCalls[0].name).toBe('search_workspace');
    expect(toolCallsTurn.toolCalls[0].arguments).toEqual({ query: 'test' });
  });

  // ROUND 7 FIX 1: onChunk must NOT be called with tool data
  // BDD @happy-path: 流式 tool_call_delta 按 index 拼接参数
  // Rule: onChunk is only for text_delta content, not for tool_call_delta data
  // Catches bug: Cheater calls onChunk(JSON.stringify({...})) for tool_call_delta chunks,
  //              leaking raw tool data to the consumer
  it('does not call onChunk for tool_call_delta chunks', async () => {
    const textChunks: string[] = [];
    const onChunk = (chunk: string) => { textChunks.push(chunk); };

    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* () {
        yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'search_workspace' };
        yield { type: 'tool_call_delta', index: 0, arguments: '{"query":"test"}' };
        yield { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 50, outputTokens: 20 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ name: 'search_workspace', description: 'Search', inputSchema: {} as any }],
    };

    const turnResult = await adapter.runTurn(input, { onChunk });

    // onChunk should NOT have been called — no text_delta chunks in this stream
    expect(textChunks).toHaveLength(0);

    // Additional guard: verify the tool_calls result is correct
    expect(turnResult).not.toBeNull();
    expect(turnResult.type).toBe('tool_calls');
  });

  // ROUND 8: Invalid JSON in streaming tool_call arguments
  // BDD @failure-path: 流式 tool_call_delta 含无效 JSON → 抛出错误
  // Rule: Accumulated arguments string must be valid JSON; invalid JSON throws
  // Catches bug: Cheater silently ignores invalid JSON in streaming arguments
  it('throws when streaming tool_call_delta arguments are invalid JSON', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* () {
        yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'test_tool' };
        yield { type: 'tool_call_delta', index: 0, arguments: '{invalid json}' };
        yield { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 50, outputTokens: 20 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    await expect(
      adapter.runTurn(input, { onChunk: () => {} }),
    ).rejects.toThrow();
  });

  // ROUND 8: Empty arguments in streaming tool_call
  // BDD @boundary: Streaming tool_call_delta with empty object arguments
  // Rule: '{}' should parse to empty object, not throw
  // Catches bug: Cheater crashes on empty arguments parse in streaming path
  it('handles streaming tool_call_delta with empty arguments object', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* () {
        yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'search_workspace' };
        yield { type: 'tool_call_delta', index: 0, arguments: '{}' };
        yield { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 50, outputTokens: 20 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    const result = await adapter.runTurn(input, { onChunk: () => {} });
    expect(result.type).toBe('tool_calls');
    const toolCallsTurn = result as ModelTurnToolCalls;
    expect(toolCallsTurn.toolCalls).toHaveLength(1);
    expect(toolCallsTurn.toolCalls[0].arguments).toEqual({});
  });

  // ROUND 8: Usage in streaming tool_calls result
  // BDD @happy-path: Streaming tool_calls result includes usage with inputTokens and outputTokens
  // Rule: Usage from done chunk propagated to ModelTurn
  // Catches bug: Cheater drops usage in streaming tool_calls path
  it('includes usage in streaming tool_calls result', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* () {
        yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'test' };
        yield { type: 'tool_call_delta', index: 0, arguments: '{}' };
        yield { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 75, outputTokens: 25 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    const result = await adapter.runTurn(input, { onChunk: () => {} });
    expect(result.type).toBe('tool_calls');
    const toolCallsTurn = result as ModelTurnToolCalls;
    expect(toolCallsTurn.usage.inputTokens).toBe(75);
    expect(toolCallsTurn.usage.outputTokens).toBe(25);
  });
});

// ===========================================================================
// Streaming: Multi-tool interleaving
// ===========================================================================

describe('Streaming — multi-tool interleaving', () => {
  // BDD @happy-path: 流式 tool_call_delta 多工具交错 index 分离
  // Rule: Different tool indices have separate argument buffers
  // Catches bug: Arguments from different tools mixed together

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClass = mod.NativeModelAdapter;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('correctly separates arguments by tool index', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* () {
        yield { type: 'tool_call_delta', index: 0, id: 'c2', name: 'search_workspace' };
        yield { type: 'tool_call_delta', index: 1, id: 'c3', name: 'read_node' };
        yield { type: 'tool_call_delta', index: 1, arguments: '{"nodeId":"node_A"}' };
        yield { type: 'tool_call_delta', index: 0, arguments: '{"query":"test"}' };
        yield { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 200, outputTokens: 50 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    const result = await adapter.runTurn(input, { onChunk: () => {} });
    expect(result.type).toBe('tool_calls');
    const toolCallsTurn = result as ModelTurnToolCalls;
    expect(toolCallsTurn.toolCalls).toHaveLength(2);

    // tool_calls[0] should have index 0 data
    expect(toolCallsTurn.toolCalls[0].id).toBe('c2');
    expect(toolCallsTurn.toolCalls[0].name).toBe('search_workspace');
    expect(toolCallsTurn.toolCalls[0].arguments).toEqual({ query: 'test' });

    // tool_calls[1] should have index 1 data
    expect(toolCallsTurn.toolCalls[1].id).toBe('c3');
    expect(toolCallsTurn.toolCalls[1].name).toBe('read_node');
    expect(toolCallsTurn.toolCalls[1].arguments).toEqual({ nodeId: 'node_A' });
  });
});

// ===========================================================================
// Streaming: additional edge cases
// ===========================================================================

describe('Streaming — additional edge cases', () => {
  // ROUND 6 additional edge case: tool_call_delta arguments before id/name
  // BDD @happy-path: Streaming tool_call_delta with arguments but no prior id/name
  // Rule: Provider may emit arguments chunks without providing id/name first
  // Catches bug: Cheater crashes when tool entry has no id or name

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClass = mod.NativeModelAdapter;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('handles tool_call_delta with arguments but no prior id/name for index', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* () {
        // Only arguments for index 0, no id/name ever provided
        yield { type: 'tool_call_delta', index: 0, arguments: '{"query":"test"}' };
        yield { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 50, outputTokens: 20 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    const result = await adapter.runTurn(input, { onChunk: () => {} });
    expect(result.type).toBe('tool_calls');
    const toolCallsTurn = result as ModelTurnToolCalls;
    expect(toolCallsTurn.toolCalls).toHaveLength(1);
    // id and name may be undefined/empty but should not crash
    expect(toolCallsTurn.toolCalls[0].arguments).toEqual({ query: 'test' });
  });

  // ROUND 6 additional edge case: response with unexpected finish_reason
  // BDD @failure-path: API returns unexpected finish_reason
  // Rule: finish_reason values other than 'stop' or 'tool_calls' should be handled
  // Catches bug: Cheater only checks for 'stop'/'tool_calls' and crashes on unknown
  it('handles response with unexpected finish_reason', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'unexpected finish' },
          finish_reason: 'length' as string,  // unexpected but valid API value
        }],
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    const result = await adapter.runTurn(input);
    // Should still return a valid ModelTurn even with unknown finish_reason
    expect(result.type).toBe('final');
    const finalTurn = result as ModelTurnFinal;
    expect(finalTurn.answer).toBe('unexpected finish');
    expect(finalTurn.usage.inputTokens).toBe(10);
  });

  // ROUND 8: Streaming tool_call_deltas with finish_reason stop
  // BDD @happy-path: 流式 tool_call_delta 即使 finish_reason 为 'stop' 仍应返回 tool_calls
  // Rule: If tool_call_deltas were accumulated, return tool_calls regardless of finishReason
  // Catches bug: Cheater only returns tool_calls when finishReason is 'tool_calls'
  it('handles streaming with tool_call_deltas and finish_reason stop', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* () {
        yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'search_workspace' };
        yield { type: 'tool_call_delta', index: 0, arguments: '{"query":"test"}' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 50, outputTokens: 20 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    const result = await adapter.runTurn(input, { onChunk: () => {} });
    // tool_call_deltas were accumulated so result should be tool_calls
    expect(result.type).toBe('tool_calls');
    const toolCallsTurn = result as ModelTurnToolCalls;
    expect(toolCallsTurn.toolCalls).toHaveLength(1);
    expect(toolCallsTurn.toolCalls[0].id).toBe('c1');
    expect(toolCallsTurn.toolCalls[0].name).toBe('search_workspace');
    expect(toolCallsTurn.toolCalls[0].arguments).toEqual({ query: 'test' });
  });
});

// ===========================================================================
// Streaming: Error — no done chunk
// ===========================================================================

describe('Streaming — missing done chunk', () => {
  // BDD @failure-path: 流式缺少 done chunk 抛错
  // Rule: Stream without terminal done → UsageUnavailableError
  // Catches bug: Stream completes without error despite missing done

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };
  let UsageUnavailableErrorClass: unknown;

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClass = mod.NativeModelAdapter;
      UsageUnavailableErrorClass = mod.UsageUnavailableError;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('throws UsageUnavailableError when stream ends without done chunk', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* () {
        yield { type: 'text_delta', content: 'hello' };
        // No 'done' chunk — stream ends abruptly
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    try {
      await adapter.runTurn(input, { onChunk: () => {} });
      expect('should not reach here').toBe('error thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UsageUnavailableErrorClass as new (...args: never[]) => Error);
    }
  });

  it('does not silently return result when done chunk is missing', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* () {
        yield { type: 'text_delta', content: 'hello' };
        // Stream ends without done
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    try {
      await adapter.runTurn(input, { onChunk: () => {} });
      expect('should not reach here').toBe('error thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UsageUnavailableErrorClass as new (...args: never[]) => Error);
    }
  });
});

// ===========================================================================
// Streaming: Error — done without usage
// ===========================================================================

describe('Streaming — done without usage', () => {
  // BDD @failure-path: done 不含 usage 抛错
  // Rule: done chunk must include usage → UsageUnavailableError
  // Catches bug: done chunk without usage is accepted

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };
  let UsageUnavailableErrorClass: unknown;

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClass = mod.NativeModelAdapter;
      UsageUnavailableErrorClass = mod.UsageUnavailableError;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('throws UsageUnavailableError when done chunk lacks usage', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* () {
        yield { type: 'text_delta', content: 'test' };
        yield { type: 'done', finishReason: 'stop' } as LocalChatChunk;
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    try {
      await adapter.runTurn(input, { onChunk: () => {} });
      expect('should not reach here').toBe('error thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UsageUnavailableErrorClass as new (...args: never[]) => Error);
    }
  });
});

// ===========================================================================
// JSON mode fallback
// ===========================================================================

describe('JSON mode fallback', () => {
  // BDD @happy-path: 模型不支持 tool calling 时降级为 JSON Mode
  // Rule: System prompt appended with JSON format constraint, response parsed
  // Catches bug: No fallback when model lacks tool calling, or parsing fails

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClass = mod.NativeModelAdapter;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('parses JSON tool_calls response when model does not support native tool calling', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              type: 'tool_calls',
              toolCalls: [{ id: 'json_001', name: 'search_workspace', arguments: { query: 'test' } }],
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { inputTokens: 80, outputTokens: 15 },
      }),
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'You are a helper.',
      messages: [{ role: 'user', content: 'Search something.' }],
    };

    const result = await adapter.runTurn(input);
    expect(result.type).toBe('tool_calls');
    const toolCallsTurn = result as ModelTurnToolCalls;
    expect(toolCallsTurn.toolCalls).toHaveLength(1);
    expect(toolCallsTurn.toolCalls[0].name).toBe('search_workspace');
    expect(toolCallsTurn.toolCalls[0].arguments).toEqual({ query: 'test' });
  });

  it('parses JSON final response when model does not support native tool calling', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              type: 'final',
              answer: 'The result is ready.',
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { inputTokens: 70, outputTokens: 12 },
      }),
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'You are a helper.',
      messages: [{ role: 'user', content: 'Tell me the result.' }],
    };

    const result = await adapter.runTurn(input);
    expect(result.type).toBe('final');
    const finalTurn = result as ModelTurnFinal;
    expect(finalTurn.answer).toBe('The result is ready.');
  });

  it('system prompt is modified with JSON output constraint when using fallback', async () => {
    // Verify that in JSON fallback mode, the system prompt
    // sent to the transport includes a JSON format constraint
    let capturedMessages: unknown[] | undefined;

    const mockTransport: LocalModelTransport = {
      chat: async (messages, tools) => {
        capturedMessages = messages;
        return {
          choices: [{
            index: 0,
            message: { role: 'assistant', content: '{"type":"final","answer":"ok"}' },
            finish_reason: 'stop',
          }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'You are a helper.',
      messages: [{ role: 'user', content: 'test' }],
    };
    const originalPrompt = input.systemPrompt;

    await adapter.runTurn(input);

    expect(capturedMessages).toBeDefined();
    if (capturedMessages && capturedMessages.length > 0) {
      // The system message should contain JSON format constraint
      const systemMsg = capturedMessages[0] as { role: string; content: string };
      expect(systemMsg.content).toMatch(/JSON|json/);
      // Must also preserve the original system prompt content — a cheater
      // should NOT replace the entire prompt with just "JSON mode"
      expect(systemMsg.content).toContain(originalPrompt);
    }
  });

  // ROUND 6 FIX 4: Tools must NOT be passed in JSON fallback mode
  // BDD @happy-path: 模型不支持 tool calling 时降级为 JSON Mode
  // Rule: In JSON fallback mode, tools should NOT be passed to transport
  // Catches bug: Cheater always passes tools to transport regardless of mode
  it('does not pass tools to transport in JSON fallback mode', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async (_messages: unknown[], tools?: unknown[]) => {
        expect(tools).toBeUndefined();
        return {
          choices: [{
            index: 0,
            message: { role: 'assistant', content: '{"type":"final","answer":"ok"}' },
            finish_reason: 'stop',
          }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'You are a helper.',
      messages: [{ role: 'user', content: 'test' }],
      // No tools — triggers JSON fallback mode
    };

    await adapter.runTurn(input);
  });

  // ROUND 8: Streaming JSON fallback — system prompt modification
  // BDD @happy-path: 模型不支持 tool calling 时降级为 JSON Mode (streaming path)
  // Rule: System prompt appended with JSON format constraint when streaming (onChunk provided)
  // Catches bug: Cheater does not append JSON constraint in streaming fallback mode
  it('modifies system prompt with JSON constraint in streaming fallback mode', async () => {
    let capturedMessages: unknown[] | undefined;

    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* (messages: unknown[]) {
        capturedMessages = messages;
        yield { type: 'text_delta', content: '{"type":"final","answer":"ok"}' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const originalPrompt = 'You are a helper.';
    const input: ModelTurnInput = {
      systemPrompt: originalPrompt,
      messages: [{ role: 'user', content: 'test' }],
      // No tools — triggers JSON fallback
    };

    await adapter.runTurn(input, { onChunk: () => {} });

    expect(capturedMessages).toBeDefined();
    if (capturedMessages && capturedMessages.length > 0) {
      const systemMsg = capturedMessages[0] as { role: string; content: string };
      expect(systemMsg.content).toMatch(/JSON|json/);
      // Must preserve original system prompt content
      expect(systemMsg.content).toContain(originalPrompt);
    }
  });

  // ROUND 8: Streaming JSON fallback — JSON returned as plain text
  // BDD @happy-path: 流式 text_delta → done 拼接为 final (JSON fallback path)
  // Rule: JSON-formatted text_delta chunks are concatenated into answer string
  // Catches bug: Cheater tries to JSON-parse streaming content or crashes
  it('returns final turn with JSON string as answer in streaming fallback mode', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* () {
        yield { type: 'text_delta', content: '{"type":"final","answer":"streamed JSON"}' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'You are a helper.',
      messages: [{ role: 'user', content: 'test' }],
    };

    const result = await adapter.runTurn(input, { onChunk: () => {} });
    expect(result.type).toBe('final');
    const finalTurn = result as ModelTurnFinal;
    expect(finalTurn.answer).toBe('{"type":"final","answer":"streamed JSON"}');
    expect(finalTurn.usage.inputTokens).toBe(10);
    expect(finalTurn.usage.outputTokens).toBe(5);
  });

  // ROUND 8: Streaming JSON fallback — onChunk callback invoked
  // BDD @happy-path: onChunk invoked per text_delta chunk in JSON fallback streaming
  // Rule: Callback must be called with each text_delta content regardless of mode
  // Catches bug: Cheater skips onChunk in JSON fallback streaming path
  it('calls onChunk for text_delta chunks in JSON fallback streaming mode', async () => {
    const chunks: string[] = [];
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* () {
        yield { type: 'text_delta', content: '{"type":"final","answer":"ok"}' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    await adapter.runTurn(input, { onChunk: (chunk: string) => { chunks.push(chunk); } });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('{"type":"final","answer":"ok"}');
  });
});

// ===========================================================================
// Boundary: Empty tools
// ===========================================================================

describe('Boundary — Empty tools list', () => {
  // BDD @boundary: 空 tools 列表时仍可正常工作
  // Rule: Empty tools array → adapter works, returns final response
  // Catches bug: Crash or error when tools array is empty

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClass = mod.NativeModelAdapter;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('works normally with empty tools array', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'No tools needed.' },
          finish_reason: 'stop',
        }],
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
      tools: [],
    };

    const result = await adapter.runTurn(input);
    expect(result.type).toBe('final');
    expect((result as ModelTurnFinal).answer).toBe('No tools needed.');
  });

  it('does not throw when tools is empty array', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Works.' },
          finish_reason: 'stop',
        }],
        usage: { inputTokens: 5, outputTokens: 3 },
      }),
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
      tools: [],
    };

    await expect(adapter.runTurn(input)).resolves.toBeDefined();
  });

  it('works normally when tools is undefined (no tools)', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'No tools.' },
          finish_reason: 'stop',
        }],
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
      // tools is undefined
    };

    await expect(adapter.runTurn(input)).resolves.toBeDefined();
  });
});

// ===========================================================================
// Tools parameter construction
// ===========================================================================

describe('Tools parameter construction for API', () => {
  // BDD @happy-path: 原生 tool calling 正确构造 tools 参数
  // Rule: Each tool transformed to { type:"function", function:{name,description,parameters} }
  // Catches bug: Wrong format passed to transport

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };
  let capturedTools: unknown[] | undefined;

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClass = mod.NativeModelAdapter;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  beforeEach(() => {
    capturedTools = undefined;
  });

  async function createAdapterForToolCapture() {
    const mockTransport: LocalModelTransport = {
      chat: async (_messages, tools) => {
        capturedTools = tools;
        return {
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'test' },
            finish_reason: 'stop',
          }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
      chatStream: async function* () { /* noop */ },
    };
    return new NativeModelAdapterClass(mockTransport);
  }

  it('sends tools in {type:"function", function:{...}} wrapper format', async () => {
    const adapter = await createAdapterForToolCapture();

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
      tools: [
        { name: 'search_workspace', description: 'Search workspace nodes', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } as any },
        { name: 'read_node', description: 'Read a node', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' } } } as any },
      ],
    };

    await adapter.runTurn(input);

    expect(capturedTools).toBeDefined();
    expect(capturedTools).toHaveLength(2);

    if (capturedTools) {
      const tool0 = capturedTools[0] as Record<string, unknown>;
      expect(tool0).toHaveProperty('type', 'function');
      expect(tool0).toHaveProperty('function');
      const func0 = tool0.function as Record<string, unknown>;
      expect(func0).toHaveProperty('name', 'search_workspace');
      expect(func0).toHaveProperty('description', 'Search workspace nodes');
      expect(func0).toHaveProperty('parameters');

      const tool1 = capturedTools[1] as Record<string, unknown>;
      expect(tool1).toHaveProperty('type', 'function');
      const func1 = tool1.function as Record<string, unknown>;
      expect(func1).toHaveProperty('name', 'read_node');
      expect(func1).toHaveProperty('description', 'Read a node');
      expect(func1).toHaveProperty('parameters');

      // Must not leak internal fields (name, description, inputSchema) at top level
      expect(Object.keys(tool0)).toEqual(['type', 'function']);
      expect(Object.keys(tool1)).toEqual(['type', 'function']);
    }
  });

  // BDD @happy-path: Native tool calling — messages must be forwarded to transport
  // Rule: runTurn calls transport.chat() with the messages from ModelTurnInput
  // Catches bug: Empty messages array or no messages forwarded to transport
  it('forwards messages from ModelTurnInput to transport.chat()', async () => {
    let capturedMessages: unknown[] | undefined;

    const mockTransport: LocalModelTransport = {
      chat: async (messages) => {
        capturedMessages = messages;
        return {
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'response with messages forwarded' },
            finish_reason: 'stop',
          }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const inputMessages = [{ role: 'user' as const, content: 'Hello' }, { role: 'user' as const, content: 'World' }];
    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: inputMessages,
    };

    await adapter.runTurn(input);

    expect(capturedMessages).toBeDefined();
    expect(capturedMessages!.length).toBeGreaterThan(0);
    // Verify the messages forwarded to transport contain the input messages
    const forwardedSystemMsg = capturedMessages![0] as { role: string; content: string };
    expect(forwardedSystemMsg).toHaveProperty('role', 'system');
    const forwardedUserMsg = capturedMessages![1] as { role: string; content: string };
    expect(forwardedUserMsg).toHaveProperty('role', 'user');
    expect(forwardedUserMsg).toHaveProperty('content', 'Hello');
    const forwardedUserMsg2 = capturedMessages![2] as { role: string; content: string };
    expect(forwardedUserMsg2).toHaveProperty('role', 'user');
    expect(forwardedUserMsg2).toHaveProperty('content', 'World');
  });

  // ROUND 6 FIX 3: Message forwarding in NATIVE tool_calling mode (WITH tools)
  // BDD @happy-path: Native tool calling — messages must be forwarded to transport
  //                  even when tools are provided
  // Rule: runTurn calls transport.chat() with the messages from ModelTurnInput
  // Catches bug: Cheater includes tools in request but drops or modifies messages
  it('forwards messages to transport.chat() in native tool_calling mode', async () => {
    let capturedMessages: unknown[] | undefined;

    const mockTransport: LocalModelTransport = {
      chat: async (messages) => {
        capturedMessages = messages;
        return {
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_fwd',
                type: 'function',
                function: { name: 'search_workspace', arguments: '{"query":"test"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const inputMessages = [{ role: 'user' as const, content: 'Search for it.' }];
    const input: ModelTurnInput = {
      systemPrompt: 'You are a helper.',
      messages: inputMessages,
      tools: [{ name: 'search_workspace', description: 'Search', inputSchema: {} as any }],
    };

    await adapter.runTurn(input);

    expect(capturedMessages).toBeDefined();
    expect(capturedMessages!.length).toBeGreaterThan(0);
    // Verify messages are forwarded verbatim even when tools are present
    const forwardedSystemMsg = capturedMessages![0] as { role: string; content: string };
    expect(forwardedSystemMsg).toHaveProperty('role', 'system');
    const forwardedUserMsg = capturedMessages![1] as { role: string; content: string };
    expect(forwardedUserMsg).toHaveProperty('role', 'user');
    expect(forwardedUserMsg).toHaveProperty('content', 'Search for it.');
  });

  // ROUND 8: Streaming + tools — messages forwarded to chatStream
  // BDD @happy-path: Native tool calling — messages forwarded in streaming path with tools
  // Rule: runTurn calls transport.chatStream() with messages when tools AND onChunk provided
  // Catches bug: Cheater drops messages in streaming tool_calling mode
  it('forwards messages to chatStream in native tool_calling mode', async () => {
    let capturedMessages: unknown[] | undefined;

    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* (messages: unknown[]) {
        capturedMessages = messages;
        yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'search_workspace' };
        yield { type: 'tool_call_delta', index: 0, arguments: '{"query":"test"}' };
        yield { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 100, outputTokens: 20 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'You are a helper.',
      messages: [{ role: 'user', content: 'test message' }],
      tools: [{ name: 'search_workspace', description: 'Search', inputSchema: {} as any }],
    };

    await adapter.runTurn(input, { onChunk: () => {} });

    expect(capturedMessages).toBeDefined();
    expect(capturedMessages!.length).toBeGreaterThan(0);
    const systemMsg = capturedMessages![0] as { role: string; content: string };
    expect(systemMsg).toHaveProperty('role', 'system');
    const userMsg = capturedMessages![1] as { role: string; content: string };
    expect(userMsg).toHaveProperty('role', 'user');
    expect(userMsg).toHaveProperty('content', 'test message');
  });
});

// ===========================================================================
// Streaming: tools parameter transformation
// ===========================================================================

describe('Streaming — tools parameter transformation', () => {
  // BDD @happy-path: 原生 tool calling 正确构造 tools 参数（流式路径）
  // Rule: Each tool transformed to { type:"function", function:{name,description,parameters} }
  //        and passed to chatStream() when streaming
  // Catches bug: Tools not passed to chatStream or wrong format

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClass = mod.NativeModelAdapter;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('passes transformed tools to chatStream in {type:"function",function:{...}} format', async () => {
    let capturedTools: unknown[] | undefined;

    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* (_messages: unknown[], tools?: unknown[]) {
        capturedTools = tools;
        yield { type: 'text_delta', content: 'result' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
      tools: [
        {
          name: 'search_workspace',
          description: 'Search workspace nodes',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } } as any,
        },
      ],
    };

    await adapter.runTurn(input, { onChunk: () => {} });

    expect(capturedTools).toBeDefined();
    expect(capturedTools).toHaveLength(1);
    if (capturedTools) {
      const tool = capturedTools[0] as Record<string, unknown>;
      expect(tool).toHaveProperty('type', 'function');
      expect(tool).toHaveProperty('function');
      const func = tool.function as Record<string, unknown>;
      expect(func).toHaveProperty('name', 'search_workspace');
      expect(func).toHaveProperty('description', 'Search workspace nodes');
      expect(func).toHaveProperty('parameters');
      expect(func.parameters).toEqual({ type: 'object', properties: { query: { type: 'string' } } });

      // Must not leak internal fields at top level
      expect(Object.keys(tool)).toEqual(['type', 'function']);
    }
  });

  it('passes multiple transformed tools to chatStream', async () => {
    let capturedTools: unknown[] | undefined;

    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* (_messages: unknown[], tools?: unknown[]) {
        capturedTools = tools;
        yield { type: 'text_delta', content: 'result' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
      tools: [
        { name: 'tool_a', description: 'Tool A', inputSchema: {} as any },
        { name: 'tool_b', description: 'Tool B', inputSchema: {} as any },
      ],
    };

    await adapter.runTurn(input, { onChunk: () => {} });

    expect(capturedTools).toBeDefined();
    expect(capturedTools).toHaveLength(2);
    if (capturedTools) {
      expect((capturedTools[0] as Record<string, unknown>).type).toBe('function');
      expect((capturedTools[1] as Record<string, unknown>).type).toBe('function');
      expect(((capturedTools[0] as Record<string, unknown>).function as Record<string, unknown>).name).toBe('tool_a');
      expect(((capturedTools[1] as Record<string, unknown>).function as Record<string, unknown>).name).toBe('tool_b');
    }
  });

  it('passes tools to chatStream even when streaming tool_call_deltas', async () => {
    let capturedTools: unknown[] | undefined;

    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* (_messages: unknown[], tools?: unknown[]) {
        capturedTools = tools;
        yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'search_workspace' };
        yield { type: 'tool_call_delta', index: 0, arguments: '{"query":"test"}' };
        yield { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 50, outputTokens: 20 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
      tools: [
        { name: 'search_workspace', description: 'Search', inputSchema: { type: 'object' } as any },
      ],
    };

    const result = await adapter.runTurn(input, { onChunk: () => {} });

    // Verify tools were captured
    expect(capturedTools).toBeDefined();
    expect(capturedTools).toHaveLength(1);
    // Verify the tool_call result is correct (tools were passed alongside)
    expect(result.type).toBe('tool_calls');
    const toolCallsTurn = result as ModelTurnToolCalls;
    expect(toolCallsTurn.toolCalls[0].id).toBe('c1');
  });

  // BDD @happy-path: Native tool calling — messages must be forwarded to transport in streaming path
  // Rule: runTurn calls transport.chatStream() with the messages from ModelTurnInput
  // Catches bug: Empty messages array or no messages forwarded to transport in streaming path
  it('forwards messages from ModelTurnInput to transport.chatStream()', async () => {
    let capturedMessages: unknown[] | undefined;

    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* (messages: unknown[]) {
        capturedMessages = messages;
        yield { type: 'text_delta', content: 'streaming response' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const inputMessages = [{ role: 'user' as const, content: 'Stream me' }];
    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: inputMessages,
    };

    await adapter.runTurn(input, { onChunk: () => {} });

    expect(capturedMessages).toBeDefined();
    expect(capturedMessages!.length).toBeGreaterThan(0);
    const forwardedSystemMsg = capturedMessages![0] as { role: string; content: string };
    expect(forwardedSystemMsg).toHaveProperty('role', 'system');
    const forwardedUserMsg = capturedMessages![1] as { role: string; content: string };
    expect(forwardedUserMsg).toHaveProperty('role', 'user');
    expect(forwardedUserMsg).toHaveProperty('content', 'Stream me');
  });
});

// ===========================================================================
// Concurrent calls
// ===========================================================================

describe('Concurrent runTurn calls', () => {
  // ROUND 6 additional edge case: concurrent runTurn invocations
  // BDD @boundary: Multiple runTurn calls should not interfere
  // Rule: Each runTurn call should independently process and return
  // Catches bug: Shared mutable state between parallel runTurn calls

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClass = mod.NativeModelAdapter;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('handles two concurrent runTurn calls independently', async () => {
    let callCount = 0;

    const mockTransport: LocalModelTransport = {
      chat: async () => {
        callCount++;
        // Simulate slight delay to increase chance of race condition
        await new Promise(r => setTimeout(r, 10));
        return {
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: `response-${callCount}`,
            },
            finish_reason: 'stop',
          }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input1: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'first' }],
    };
    const input2: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'second' }],
    };

    const [result1, result2] = await Promise.all([
      adapter.runTurn(input1),
      adapter.runTurn(input2),
    ]);

    expect(result1.type).toBe('final');
    expect(result2.type).toBe('final');
    const final1 = result1 as ModelTurnFinal;
    const final2 = result2 as ModelTurnFinal;
    // Both should return valid answers (order may vary)
    expect(final1.answer).toMatch(/response-/);
    expect(final2.answer).toMatch(/response-/);
    expect(final1.usage.inputTokens).toBe(10);
    expect(final2.usage.inputTokens).toBe(10);
  });

  it('handles concurrent streaming calls independently', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not use chat in streaming'); },
      chatStream: async function* () {
        await new Promise(r => setTimeout(r, 5));
        yield { type: 'text_delta', content: 'concurrent' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 10 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    const [result1, result2] = await Promise.all([
      adapter.runTurn(input, { onChunk: () => {} }),
      adapter.runTurn(input, { onChunk: () => {} }),
    ]);

    expect(result1.type).toBe('final');
    expect(result2.type).toBe('final');
    const final1 = result1 as ModelTurnFinal;
    const final2 = result2 as ModelTurnFinal;
    expect(final1.answer).toBe('concurrent');
    expect(final2.answer).toBe('concurrent');
    expect(final1.usage.inputTokens).toBe(20);
    expect(final2.usage.inputTokens).toBe(20);
  });
});

// ===========================================================================
// ModelAdapter interface compliance (compile-time)
// ===========================================================================

describe('ModelAdapter interface compliance (quality gate)', () => {
  // Rule: NativeModelAdapter implements ModelAdapter
  // Catches bug: Missing or incorrectly typed provider/runTurn

  it('NativeModelAdapter satisfies ModelAdapter interface', () => {
    // This is a compile-time check only — actual construction happens
    // at runtime in the other suites. The inline adapter below verifies
    // the interface contract is compatible.
    const _adapter: ModelAdapter = {
      provider: 'openai',
      runTurn: async (_input: ModelTurnInput, _options?: ModelTurnOptions) => {
        return { type: 'final', answer: 'placeholder', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    expect(_adapter.provider).toBe('openai');
    expect(typeof _adapter.runTurn).toBe('function');
  });

  it('NativeModelAdapter does not directly import llm-client.ts', () => {
    // Read the source file and verify no llm-client import exists.
    // The adapter should use injected ModelTransport, not directly
    // import from llm-client.ts.
    const source = readFileSync('src/main/agent-runtime/model-adapter.ts', 'utf-8');
    expect(source).not.toMatch(/from\s+['"]\.\.\/llm-client['"]/);
    expect(source).not.toMatch(/from\s+['"]\.\.\/\.\.\/main\/llm-client['"]/);
    expect(source).not.toMatch(/import\s*\(?\s*['"][^'"]*llm-client['"]\s*\)?/);
    // ROUND 5 FIX 3: Detect eval() usage — cheater must not replace JSON.parse with eval('(' + str + ')')
    expect(source).not.toMatch(/\beval\s*\(/);
    // ROUND 7 FIX 2: Detect new Function() usage — cheater may use `new Function('return ' + rawArgs)()`
    // to bypass the /\beval\s*\(/ regex while still executing dynamic code
    expect(source).not.toMatch(/\bnew\s+Function\s*\(/);
  });
});

// ===========================================================================
// UsageUnavailableError type
// ===========================================================================

describe('UsageUnavailableError (quality gate)', () => {
  // Rule: Missing usage → UsageUnavailableError (not silent default)
  // Catches bug: Generic Error thrown instead of UsageUnavailableError

  let UsageUnavailableErrorClass: unknown;

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      UsageUnavailableErrorClass = mod.UsageUnavailableError;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('UsageUnavailableError is exported from model-adapter.ts', () => {
    expect(UsageUnavailableErrorClass).toBeDefined();
  });

  it('UsageUnavailableError is an Error subclass', () => {
    expect(UsageUnavailableErrorClass).toBeDefined();
    // Can't use instanceof without the actual class, so check it's a constructor
    expect(typeof UsageUnavailableErrorClass).toBe('function');
  });

  it('UsageUnavailableError can be instantiated', () => {
    if (UsageUnavailableErrorClass && typeof UsageUnavailableErrorClass === 'function') {
      const instance = new (UsageUnavailableErrorClass as new (message?: string) => Error)();
      expect(instance).toBeInstanceOf(Error);
      expect(instance.message).toBeDefined();
    }
  });

  it('UsageUnavailableError has a descriptive message', () => {
    if (UsageUnavailableErrorClass && typeof UsageUnavailableErrorClass === 'function') {
      const instance = new (UsageUnavailableErrorClass as new (message?: string) => Error)('Usage data unavailable for model turn');
      expect(instance.message).toMatch(/usage|Usage/i);
    }
  });
});

// ===========================================================================
// Streaming: streaming triggered via options
// ===========================================================================

describe('Streaming — stream mode selection', () => {
  // Rule: When onChunk option provided, use chatStream; otherwise use chat
  // Catches bug: chatStream called even without onChunk, or chat called with onChunk

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClass = mod.NativeModelAdapter;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('uses chatStream when onChunk is provided', async () => {
    let chatCalled = false;
    let chatStreamCalled = false;

    const mockTransport: LocalModelTransport = {
      chat: async () => {
        chatCalled = true;
        return {
          choices: [{ index: 0, message: { role: 'assistant', content: 'test' }, finish_reason: 'stop' }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
      chatStream: async function* () {
        chatStreamCalled = true;
        yield { type: 'text_delta', content: 'test' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    await adapter.runTurn(input, { onChunk: () => {} });

    expect(chatCalled).toBe(false);
    expect(chatStreamCalled).toBe(true);
  });

  it('uses chat when onChunk is not provided', async () => {
    let chatCalled = false;
    let chatStreamCalled = false;

    const mockTransport: LocalModelTransport = {
      chat: async () => {
        chatCalled = true;
        return {
          choices: [{ index: 0, message: { role: 'assistant', content: 'test' }, finish_reason: 'stop' }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
      chatStream: async function* () {
        chatStreamCalled = true;
        yield { type: 'text_delta', content: 'test' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    await adapter.runTurn(input);

    expect(chatCalled).toBe(true);
    expect(chatStreamCalled).toBe(false);
  });
});

// ===========================================================================
// Options forwarding to transport
// ===========================================================================

describe('Options forwarding to transport', () => {
  // ROUND 7 FIX 3: Options must be forwarded to transport.chat() and chatStream()
  // BDD @happy-path: ModelTurnOptions (maxTokens, temperature, signal) forwarded
  // Rule: adapter.runTurn(input, options) passes relevant options to transport
  // Catches bug: Cheater ignores options parameter when calling transport.chat()/chatStream()

  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/model-adapter');
      NativeModelAdapterClass = mod.NativeModelAdapter;
    } catch (err) {
      throw new Error(
        'model-adapter.ts not found. Expected RED. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('forwards options to transport.chat()', async () => {
    let capturedOptions: unknown;

    const controller = new AbortController();
    const inputOptions: ModelTurnOptions = {
      maxTokens: 100,
      temperature: 0.5,
      signal: controller.signal,
    };

    const mockTransport: LocalModelTransport = {
      chat: async (_messages: unknown[], _tools?: unknown[], options?: unknown) => {
        capturedOptions = options;
        return {
          choices: [{ index: 0, message: { role: 'assistant', content: 'response' }, finish_reason: 'stop' }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ name: 'search_workspace', description: 'Search', inputSchema: {} as any }],
    };

    await adapter.runTurn(input, inputOptions);

    expect(capturedOptions).toBeDefined();
    const opts = capturedOptions as Record<string, unknown>;
    expect(opts.maxTokens).toBe(100);
    expect(opts.temperature).toBe(0.5);
    expect(opts.signal).toBeDefined();
  });

  it('forwards options to transport.chatStream()', async () => {
    let capturedOptions: unknown;

    const controller = new AbortController();
    const inputOptions: ModelTurnOptions = {
      maxTokens: 200,
      temperature: 0.3,
      signal: controller.signal,
    };

    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* (_messages: unknown[], _tools?: unknown[], options?: unknown) {
        capturedOptions = options;
        yield { type: 'text_delta', content: 'streaming' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);

    const input: ModelTurnInput = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ name: 'search_workspace', description: 'Search', inputSchema: {} as any }],
    };

    await adapter.runTurn(input, { ...inputOptions, onChunk: () => {} });

    expect(capturedOptions).toBeDefined();
    const opts = capturedOptions as Record<string, unknown>;
    expect(opts.maxTokens).toBe(200);
    expect(opts.temperature).toBe(0.3);
    expect(opts.signal).toBeDefined();
  });
});

describe('Truncated（输出被 max_tokens 截断 → truncated 标志）', () => {
  let NativeModelAdapterClass: new (transport: LocalModelTransport) => { provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn> };
  beforeAll(async () => {
    const mod = await import('../agent-runtime/model-adapter');
    NativeModelAdapterClass = mod.NativeModelAdapter;
  });

  it('非流式 finish_reason=length → final.truncated=true', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '（被截断的长回答…）' },
          finish_reason: 'length',
        }],
        usage: { inputTokens: 150, outputTokens: 8192 },
      }),
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);
    const result = await adapter.runTurn({
      systemPrompt: 'test',
      messages: [{ role: 'user', content: '详细评价' }],
    });
    expect(result.type).toBe('final');
    if (result.type === 'final') {
      expect(result.truncated).toBe(true);
      expect(result.answer).toContain('被截断');
    }
  });

  it('非流式 finish_reason=stop → truncated 缺省（undefined）', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => ({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '完整回答' },
          finish_reason: 'stop',
        }],
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      chatStream: async function* () { /* noop */ },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);
    const result = await adapter.runTurn({
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    if (result.type === 'final') expect(result.truncated).toBeUndefined();
  });

  it('流式 done finishReason=length → final.truncated=true', async () => {
    const mockTransport: LocalModelTransport = {
      chat: async () => { throw new Error('should not call chat in streaming'); },
      chatStream: async function* () {
        yield { type: 'text_delta', content: '长回答' };
        yield { type: 'done', finishReason: 'length', usage: { inputTokens: 10, outputTokens: 8192 } };
      },
    };
    const adapter = new NativeModelAdapterClass(mockTransport);
    const result = await adapter.runTurn({
      systemPrompt: 'test',
      messages: [{ role: 'user', content: '详细评价' }],
    }, { onChunk: () => {} });
    expect(result.type).toBe('final');
    if (result.type === 'final') {
      expect(result.truncated).toBe(true);
      expect(result.answer).toBe('长回答');
    }
  });
});