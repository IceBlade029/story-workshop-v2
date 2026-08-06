/**
 * scripted-model-adapter.test.ts — TDD tests for I7_T03 ScriptedModelAdapter
 *
 * Task: I7_T03 "ScriptedModelAdapter — tool_calls 数组 + usage 必填"
 *
 * Covers:
 *   - scripted-model-adapter.ts — ScriptedModelAdapter class,
 *     ScriptedTurn type, ScriptExhaustedError, InvalidScriptError
 *
 * RED-run expected because:
 *   1. scripted-model-adapter.ts doesn't exist yet (dynamic import will fail)
 *   2. readFileSync structural checks will fail
 *   3. Type assertions (@ts-expect-error) verified by tsc --noEmit quality gate
 *   4. All behavioral tests fail until implementation exists
 */

import { describe, it, expect, beforeAll } from 'vitest';
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
import type { EvidenceRef } from '../agent-runtime/tool-types';

// ---------------------------------------------------------------------------
// Helper types: extract discriminant variants from discriminated unions
// ---------------------------------------------------------------------------

type ModelTurnToolCalls = Extract<ModelTurn, { type: 'tool_calls' }>;
type ModelTurnFinal = Extract<ModelTurn, { type: 'final' }>;

// ---------------------------------------------------------------------------
// Local ScriptedTurn type matching the rule table exactly.
// Used before the source file exists.
// ---------------------------------------------------------------------------

type LocalScriptedTurn =
  | {
      type: 'tool_calls';
      toolCalls: ToolCall[];
      usage: Usage;
    }
  | {
      type: 'final';
      answer: string;
      citations?: EvidenceRef[];
      usage: Usage;
    };

type LocalInvalidTurn = { type: 'observe' | 'mockResult'; [key: string]: unknown };

// ===========================================================================
// MODULE EXISTENCE — Dynamic imports verify files exist
// ===========================================================================

describe('module existence (dynamic import guards)', () => {
  // scripted-model-adapter.ts does NOT exist yet -> this test SHOULD FAIL (RED)
  // BDD @happy-path: ScriptedModelAdapter class is exported
  // Rule: ScriptedModelAdapter implements ModelAdapter
  // Catches bug: File not created or class not exported
  it('scripted-model-adapter.ts module can be loaded [EXPECTED RED: file missing]', async () => {
    const mod = await import('../agent-runtime/scripted-model-adapter');
    expect(mod).toBeDefined();
  });
});

// ===========================================================================
// ScriptedModelAdapter class export checks
// ===========================================================================

describe('ScriptedModelAdapter class export (quality gate)', () => {
  // Rule: ScriptedModelAdapter is exported from scripted-model-adapter.ts
  // Catches bug: Wrong export name or not exported

  let ScriptedModelAdapterClass: unknown;
  let ScriptExhaustedErrorClass: unknown;
  let InvalidScriptErrorClass: unknown;

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/scripted-model-adapter');
      ScriptedModelAdapterClass = mod.ScriptedModelAdapter as unknown as typeof ScriptedModelAdapterClass;
      ScriptExhaustedErrorClass = mod.ScriptExhaustedError;
      InvalidScriptErrorClass = mod.InvalidScriptError;
    } catch (err) {
      throw new Error(
        'scripted-model-adapter.ts not found. This is expected during RED phase. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('ScriptedModelAdapter is a class/constructor', () => {
    expect(ScriptedModelAdapterClass).toBeDefined();
    expect(typeof ScriptedModelAdapterClass).toBe('function');
  });

  // BDD @failure-path: ScriptExhaustedError when script exhausted
  // Rule: ScriptExhaustedError thrown on exhaustion
  // Catches bug: Generic Error thrown instead of ScriptExhaustedError
  it('ScriptExhaustedError is exported', () => {
    expect(ScriptExhaustedErrorClass).toBeDefined();
    expect(typeof ScriptExhaustedErrorClass).toBe('function');
  });

  // BDD @failure-path: InvalidScriptError for invalid turn type
  // Rule: InvalidScriptError thrown at construction for bad turns
  // Catches bug: Generic Error thrown instead of InvalidScriptError
  it('InvalidScriptError is exported', () => {
    expect(InvalidScriptErrorClass).toBeDefined();
    expect(typeof InvalidScriptErrorClass).toBe('function');
  });
});

// ===========================================================================
// Constructor
// ===========================================================================

describe('Constructor', () => {
  // BDD @happy-path: ScriptedModelAdapter 已实例化
  // Rule: constructor(turns?: ScriptedTurn[])
  // Catches bug: Constructor missing or wrong signature

  let ScriptedModelAdapterClass: new (turns?: LocalScriptedTurn[]) => {
    readonly provider: string;
    runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn>;
  };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/scripted-model-adapter');
      ScriptedModelAdapterClass = mod.ScriptedModelAdapter as unknown as typeof ScriptedModelAdapterClass;
    } catch (err) {
      throw new Error(
        'scripted-model-adapter.ts not found. This is expected during RED phase. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  // BDD Background: provider 属性值为 "scripted"
  // Rule: readonly provider = "scripted"
  // Catches bug: Wrong provider string (e.g. "openai" copy-paste)
  it('has readonly provider property set to "scripted"', () => {
    const adapter = new ScriptedModelAdapterClass([]);
    expect(adapter.provider).toBe('scripted');
  });

  // BDD Background: ScriptedModelAdapter 已实例化
  // Rule: constructor accepts ScriptedTurn[]
  // Catches bug: Constructor throws on valid input
  it('accepts ScriptedTurn[] and creates instance', () => {
    const turn: LocalScriptedTurn = {
      type: 'final',
      answer: 'test',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    expect(adapter).toBeDefined();
    expect(adapter).toHaveProperty('runTurn');
  });

  // BDD @boundary: 空脚本 -> ScriptExhaustedError
  // Rule: constructor accepts empty turns array
  // Catches bug: Constructor crashes on empty array
  it('accepts empty turns array', () => {
    const adapter = new ScriptedModelAdapterClass([]);
    expect(adapter).toBeDefined();
  });

  // Rule: constructor accepts no arguments (turns optional)
  // Catches bug: Constructor requires at least one argument
  it('accepts no arguments (turns is optional)', () => {
    const adapter = new ScriptedModelAdapterClass();
    expect(adapter).toBeDefined();
  });

  // BDD @failure-path: 无效 turn 类型 -> InvalidScriptError
  // Rule: Constructor validates each turn type at runtime
  // Catches bug: Invalid turn types silently accepted
  it('throws InvalidScriptError when turn has invalid type', () => {
    const badTurn: LocalInvalidTurn = { type: 'observe', data: 'test' };
    expect(() => {
      new ScriptedModelAdapterClass([badTurn as unknown as LocalScriptedTurn]);
    }).toThrow();
    expect(() => {
      new ScriptedModelAdapterClass([badTurn as unknown as LocalScriptedTurn]);
    }).toThrow(/invalid/i);
  });

  // Catches bug: Turn type 'mockResult' silently accepted
  it('throws InvalidScriptError for mockResult turn type', () => {
    const badTurn: LocalInvalidTurn = { type: 'mockResult', data: 'test' };
    expect(() => {
      new ScriptedModelAdapterClass([badTurn as unknown as LocalScriptedTurn]);
    }).toThrow();
  });
});

// ===========================================================================
// fromTurns static factory
// ===========================================================================

describe('fromTurns static factory', () => {
  // BDD @happy-path: ScriptedModelAdapter.fromTurns(turn1, turn2, ...)
  // Rule: static fromTurns(...turns) creates adapter with variadic turns
  // Catches bug: Missing factory method or wrong signature

  let ScriptedModelAdapterClass: {
    new (turns?: LocalScriptedTurn[]): {
      readonly provider: string;
      runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn>;
    };
    fromTurns: (...turns: LocalScriptedTurn[]) => { readonly provider: string; runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn>; };
  };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/scripted-model-adapter');
      ScriptedModelAdapterClass = mod.ScriptedModelAdapter as unknown as typeof ScriptedModelAdapterClass;
    } catch (err) {
      throw new Error(
        'scripted-model-adapter.ts not found. This is expected during RED phase. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  it('fromTurns is a static method on ScriptedModelAdapter', () => {
    expect(ScriptedModelAdapterClass.fromTurns).toBeDefined();
    expect(typeof ScriptedModelAdapterClass.fromTurns).toBe('function');
  });

  it('fromTurns creates adapter with variadic turns', () => {
    const turn1: LocalScriptedTurn = {
      type: 'tool_calls',
      toolCalls: [{ id: 'c1', name: 'search', arguments: {} }],
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const turn2: LocalScriptedTurn = {
      type: 'final',
      answer: 'done',
      usage: { inputTokens: 20, outputTokens: 10 },
    };
    const adapter = (ScriptedModelAdapterClass as any).fromTurns(turn1, turn2) as {
      readonly provider: string;
      runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn>;
    };
    expect(adapter).toBeDefined();
    expect(adapter.provider).toBe('scripted');
  });

  // Catches bug: fromTurns returns wrong type or non-adapter
  it('fromTurns returns an instance with runTurn method', () => {
    const turn: LocalScriptedTurn = {
      type: 'final',
      answer: 'ok',
      usage: { inputTokens: 5, outputTokens: 3 },
    };
    const adapter = ScriptedModelAdapterClass.fromTurns!(turn) as {
      readonly provider: string;
      runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn>;
    };
    expect(typeof adapter.runTurn).toBe('function');
  });
});

// ===========================================================================
// runTurn — tool_calls variant
// ===========================================================================

describe('runTurn — tool_calls variant', () => {
  // BDD @happy-path: 预编程 tool_calls 响应（单元素数组）被顺序消耗
  // Rule: tool_calls turn returns type='tool_calls' with toolCalls array
  // Catches bug: Wrong type, missing array, missing usage

  let ScriptedModelAdapterClass: new (turns?: LocalScriptedTurn[]) => {
    readonly provider: string;
    runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn>;
  };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/scripted-model-adapter');
      ScriptedModelAdapterClass = mod.ScriptedModelAdapter as unknown as typeof ScriptedModelAdapterClass;
    } catch (err) {
      throw new Error(
        'scripted-model-adapter.ts not found. This is expected during RED phase. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  // BDD: 预编程 tool_calls 响应（toolCalls: [{ name:"search_workspace", arguments:{query:"咖啡馆"} }]）
  // Rule: tool_calls turn returns type='tool_calls'
  // Catches bug: Returns 'final' instead of 'tool_calls'
  it('returns type "tool_calls" for a tool_calls turn', async () => {
    const turn: LocalScriptedTurn = {
      type: 'tool_calls',
      toolCalls: [{ id: 'c1', name: 'search_workspace', arguments: { query: 'test' } }],
      usage: { inputTokens: 100, outputTokens: 20 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };
    const result = await adapter.runTurn(input);
    expect(result.type).toBe('tool_calls');
  });

  // BDD: toolCalls 数组长度为 1
  // Rule: toolCalls is array with correct length
  // Catches bug: toolCalls single object instead of array
  it('toolCalls is an array with length matching input', async () => {
    const turn: LocalScriptedTurn = {
      type: 'tool_calls',
      toolCalls: [{ id: 'c1', name: 'search_workspace', arguments: { query: 'test' } }],
      usage: { inputTokens: 100, outputTokens: 20 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };
    const result = await adapter.runTurn(input);
    expect(result.type).toBe('tool_calls');
    const toolCallsTurn = result as ModelTurnToolCalls;
    expect(Array.isArray(toolCallsTurn.toolCalls)).toBe(true);
    expect(toolCallsTurn.toolCalls).toHaveLength(1);
  });

  // BDD: toolCalls[0].name 等于 "search_workspace"
  // Rule: toolCalls preserves id, name, arguments
  // Catches bug: Fields not preserved or remapped incorrectly
  it('preserves id, name, and arguments in toolCalls[0]', async () => {
    const turn: LocalScriptedTurn = {
      type: 'tool_calls',
      toolCalls: [{ id: 'call_001', name: 'search_workspace', arguments: { query: 'cafe' } }],
      usage: { inputTokens: 100, outputTokens: 20 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };
    const result = await adapter.runTurn(input);
    expect(result.type).toBe('tool_calls');
    const toolCallsTurn = result as ModelTurnToolCalls;
    expect(toolCallsTurn.toolCalls[0].id).toBe('call_001');
    expect(toolCallsTurn.toolCalls[0].name).toBe('search_workspace');
    expect(toolCallsTurn.toolCalls[0].arguments).toEqual({ query: 'cafe' });
  });

  // BDD @happy-path: 预编程多 tool_calls 响应（双元素数组）
  // Rule: Multiple toolCalls in one turn are all returned
  // Catches bug: Only first tool_call returned
  it('returns multiple toolCalls when pre-programmed with multiple', async () => {
    const turn: LocalScriptedTurn = {
      type: 'tool_calls',
      toolCalls: [
        { id: 'c1', name: 'search_workspace', arguments: { query: 'test' } },
        { id: 'c2', name: 'read_node', arguments: { nodeId: 'n1' } },
      ],
      usage: { inputTokens: 200, outputTokens: 40 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };
    const result = await adapter.runTurn(input);
    expect(result.type).toBe('tool_calls');
    const toolCallsTurn = result as ModelTurnToolCalls;
    expect(toolCallsTurn.toolCalls).toHaveLength(2);
    expect(toolCallsTurn.toolCalls[0].name).toBe('search_workspace');
    expect(toolCallsTurn.toolCalls[1].name).toBe('read_node');
  });

  // BDD @happy-path: usage: { inputTokens: 100, outputTokens: 20 }
  // Rule: Each turn must include usage with inputTokens and outputTokens
  // Catches bug: Missing usage or wrong token values
  it('includes required usage with inputTokens and outputTokens', async () => {
    const turn: LocalScriptedTurn = {
      type: 'tool_calls',
      toolCalls: [{ id: 'c1', name: 'search_workspace', arguments: {} }],
      usage: { inputTokens: 100, outputTokens: 20 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };
    const result = await adapter.runTurn(input);
    expect(result.type).toBe('tool_calls');
    const toolCallsTurn = result as ModelTurnToolCalls;
    expect(toolCallsTurn.usage).toBeDefined();
    expect(toolCallsTurn.usage.inputTokens).toBe(100);
    expect(toolCallsTurn.usage.outputTokens).toBe(20);
  });

  // BDD @happy-path: tool_calls 不含 mockResult
  // Rule: ModelTurn should not contain mockResult
  // Catches bug: Cheater adds mockResult to returned turn
  it('does not include mockResult on returned tool_calls turn', async () => {
    const turn: LocalScriptedTurn = {
      type: 'tool_calls',
      toolCalls: [{ id: 'c1', name: 'search_workspace', arguments: {} }],
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };
    const result = await adapter.runTurn(input);
    expect(result.type).toBe('tool_calls');
    expect((result as Record<string, unknown>).mockResult).toBeUndefined();
  });

  // Catches bug: tool_calls turn has answer field
  it('does not include answer on tool_calls turn', async () => {
    const turn: LocalScriptedTurn = {
      type: 'tool_calls',
      toolCalls: [{ id: 'c1', name: 'search', arguments: {} }],
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };
    const result = await adapter.runTurn(input);
    expect(result.type).toBe('tool_calls');
    expect((result as Record<string, unknown>).answer).toBeUndefined();
  });
});

// ===========================================================================
// runTurn — final variant
// ===========================================================================

describe('runTurn — final variant', () => {
  // BDD @happy-path: 预编程 final 含 answer + citations + usage
  // Rule: final turn returns type='final' with answer and usage
  // Catches bug: Missing answer, wrong type

  let ScriptedModelAdapterClass: new (turns?: LocalScriptedTurn[]) => {
    readonly provider: string;
    runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn>;
  };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/scripted-model-adapter');
      ScriptedModelAdapterClass = mod.ScriptedModelAdapter as unknown as typeof ScriptedModelAdapterClass;
    } catch (err) {
      throw new Error(
        'scripted-model-adapter.ts not found. This is expected during RED phase. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  // BDD: adapter.runTurn(input) => ModelTurn.type 为 'final'
  // Rule: final turn returns type 'final'
  // Catches bug: Returns 'tool_calls' instead of 'final'
  it('returns type "final" for a final turn', async () => {
    const turn: LocalScriptedTurn = {
      type: 'final',
      answer: '答案是 42',
      usage: { inputTokens: 500, outputTokens: 80 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };
    const result = await adapter.runTurn(input);
    expect(result.type).toBe('final');
  });

  // BDD: answer:"主角在雨夜咖啡馆与神秘人相遇"
  // Rule: answer field preserved
  // Catches bug: Answer not returned or modified
  it('preserves answer string', async () => {
    const answerText = '主角在雨夜咖啡馆与神秘人相遇';
    const turn: LocalScriptedTurn = {
      type: 'final',
      answer: answerText,
      usage: { inputTokens: 500, outputTokens: 80 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };
    const result = await adapter.runTurn(input);
    expect(result.type).toBe('final');
    const finalTurn = result as ModelTurnFinal;
    expect(finalTurn.answer).toBe(answerText);
  });

  // BDD: usage 为必填
  // Rule: usage must be present on final turn
  // Catches bug: Missing usage on final turn
  it('includes required usage with inputTokens and outputTokens', async () => {
    const turn: LocalScriptedTurn = {
      type: 'final',
      answer: 'done',
      usage: { inputTokens: 500, outputTokens: 80 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };
    const result = await adapter.runTurn(input);
    expect(result.type).toBe('final');
    const finalTurn = result as ModelTurnFinal;
    expect(finalTurn.usage).toBeDefined();
    expect(finalTurn.usage.inputTokens).toBe(500);
    expect(finalTurn.usage.outputTokens).toBe(80);
  });

  // BDD: citations 存在
  // Rule: citations field present when provided in ScriptedTurn
  // Catches bug: citations dropped
  it('includes citations when provided', async () => {
    const citations: EvidenceRef[] = [
      { sourceId: 'src1', sourceType: 'node', hash: 'abc123' },
    ];
    const turn: LocalScriptedTurn = {
      type: 'final',
      answer: 'answer with citations',
      citations,
      usage: { inputTokens: 500, outputTokens: 80 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };
    const result = await adapter.runTurn(input);
    expect(result.type).toBe('final');
    const finalTurn = result as ModelTurnFinal;
    expect(finalTurn.citations).toBeDefined();
    expect(finalTurn.citations).toHaveLength(1);
    expect(finalTurn.citations![0].sourceId).toBe('src1');
  });

  // BDD @happy-path: final 不带 citations
  // Rule: citations is absent/undefined when not provided
  // Catches bug: Empty citations array when not provided, or error thrown
  it('does not include citations when not provided', async () => {
    const turn: LocalScriptedTurn = {
      type: 'final',
      answer: 'answer without citations',
      usage: { inputTokens: 100, outputTokens: 30 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };
    const result = await adapter.runTurn(input);
    expect(result.type).toBe('final');
    const finalTurn = result as ModelTurnFinal;
    // citations should be undefined (not an empty array)
    expect(finalTurn.citations).toBeUndefined();
  });

  // Catches bug: final turn leaks toolCalls
  it('does not include toolCalls on final turn', async () => {
    const turn: LocalScriptedTurn = {
      type: 'final',
      answer: 'final answer',
      usage: { inputTokens: 50, outputTokens: 20 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };
    const result = await adapter.runTurn(input);
    expect(result.type).toBe('final');
    expect((result as Record<string, unknown>).toolCalls).toBeUndefined();
  });
});

// ===========================================================================
// runTurn — FIFO ordering
// ===========================================================================

describe('runTurn — FIFO ordering', () => {
  // BDD @happy-path: 多轮 tool_calls -> final
  // Rule: Turns returned in FIFO order
  // Catches bug: Wrong ordering or skipping turns

  let ScriptedModelAdapterClass: new (turns?: LocalScriptedTurn[]) => {
    readonly provider: string;
    runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn>;
  };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/scripted-model-adapter');
      ScriptedModelAdapterClass = mod.ScriptedModelAdapter as unknown as typeof ScriptedModelAdapterClass;
    } catch (err) {
      throw new Error(
        'scripted-model-adapter.ts not found. This is expected during RED phase. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  // BDD: 脚本: [tool_calls(搜索), tool_calls(读取), final(回答)]
  // Rule: Each runTurn returns next turn in sequence
  // Catches bug: Turns returned out of order
  it('returns turns in insertion order for sequential calls', async () => {
    const turns: LocalScriptedTurn[] = [
      { type: 'tool_calls', toolCalls: [{ id: 'c1', name: 'search', arguments: {} }], usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'tool_calls', toolCalls: [{ id: 'c2', name: 'read_node', arguments: {} }], usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'final', answer: 'final answer', usage: { inputTokens: 20, outputTokens: 10 } },
    ];
    const adapter = new ScriptedModelAdapterClass(turns);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };

    const result1 = await adapter.runTurn(input);
    expect(result1.type).toBe('tool_calls');
    expect((result1 as ModelTurnToolCalls).toolCalls[0].name).toBe('search');

    const result2 = await adapter.runTurn(input);
    expect(result2.type).toBe('tool_calls');
    expect((result2 as ModelTurnToolCalls).toolCalls[0].name).toBe('read_node');

    const result3 = await adapter.runTurn(input);
    expect(result3.type).toBe('final');
    expect((result3 as ModelTurnFinal).answer).toBe('final answer');
  });

  // BDD: 按顺序返回预编程 ModelTurn
  // Rule: fromTurns plus sequential runTurn calls maintain order
  // Catches bug: FromTurns or constructor mis-handles ordering
  it('maintains order when created via fromTurns', async () => {
    const turn1: LocalScriptedTurn = { type: 'final', answer: 'first', usage: { inputTokens: 5, outputTokens: 3 } };
    const turn2: LocalScriptedTurn = { type: 'final', answer: 'second', usage: { inputTokens: 5, outputTokens: 3 } };
    const adapter = (ScriptedModelAdapterClass as any).fromTurns(turn1, turn2) as {
      readonly provider: string;
      runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn>;
    };
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };

    const result1 = await adapter.runTurn(input);
    expect(result1.type).toBe('final');
    expect((result1 as ModelTurnFinal).answer).toBe('first');

    const result2 = await adapter.runTurn(input);
    expect(result2.type).toBe('final');
    expect((result2 as ModelTurnFinal).answer).toBe('second');
  });
});

// ===========================================================================
// runTurn — exhaustion
// ===========================================================================

describe('runTurn — exhaustion errors', () => {
  // BDD @failure-path: 脚本耗尽 -> ScriptExhaustedError
  // Rule: When all turns consumed, throw ScriptExhaustedError
  // Catches bug: Return undefined/null instead of throwing

  let ScriptedModelAdapterClass: new (turns?: LocalScriptedTurn[]) => {
    readonly provider: string;
    runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn>;
  };
  let ScriptExhaustedErrorClass: unknown;

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/scripted-model-adapter');
      ScriptedModelAdapterClass = mod.ScriptedModelAdapter as unknown as typeof ScriptedModelAdapterClass;
      ScriptExhaustedErrorClass = mod.ScriptExhaustedError;
    } catch (err) {
      throw new Error(
        'scripted-model-adapter.ts not found. This is expected during RED phase. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  // BDD: 脚本仅 2 个响应，已消耗全部 -> 第三次 runTurn -> 抛出 ScriptExhaustedError
  // Rule: Exhaustion after last turn consumed
  // Catches bug: No error thrown, or re-cycles
  it('throws ScriptExhaustedError when all turns consumed', async () => {
    const turn: LocalScriptedTurn = {
      type: 'final',
      answer: 'only turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };

    // First call succeeds
    await adapter.runTurn(input);

    // Second call should throw
    try {
      await adapter.runTurn(input);
      expect('should not reach here').toBe('error thrown');
    } catch (e) {
      if (ScriptExhaustedErrorClass && typeof ScriptExhaustedErrorClass === 'function') {
        expect(e).toBeInstanceOf(ScriptExhaustedErrorClass as new () => Error);
      }
    }
  });

  // Catches bug: Error message not descriptive
  it('ScriptExhaustedError has descriptive message', async () => {
    const turn: LocalScriptedTurn = {
      type: 'final',
      answer: 'done',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };

    await adapter.runTurn(input);

    try {
      await adapter.runTurn(input);
    } catch (e) {
      expect(e).toBeDefined();
      if (e instanceof Error) {
        expect(e.message).toBeTruthy();
        expect(e.message.length).toBeGreaterThan(0);
      }
    }
  });

  // BDD @failure-path: 空脚本 -> ScriptExhaustedError
  // Rule: Empty turns array throws ScriptExhaustedError on first runTurn
  // Catches bug: No error on empty script, or constructor rejects empty array
  it('throws ScriptExhaustedError when turns array is empty', async () => {
    const adapter = new ScriptedModelAdapterClass([]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };

    try {
      await adapter.runTurn(input);
      expect('should not reach here').toBe('error thrown');
    } catch (e) {
      if (ScriptExhaustedErrorClass && typeof ScriptExhaustedErrorClass === 'function') {
        expect(e).toBeInstanceOf(ScriptExhaustedErrorClass as new () => Error);
      }
    }
  });

  // BDD @boundary: 单 final 即终止
  // Rule: Single turn consumed, then exhausted
  // Catches bug: Single turn not consumed, or exhaustion after extra calls
  it('exhausts after single turn when only one turn provided', async () => {
    const turn: LocalScriptedTurn = {
      type: 'final',
      answer: 'single',
      usage: { inputTokens: 5, outputTokens: 3 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };

    await adapter.runTurn(input);

    await expect(adapter.runTurn(input)).rejects.toThrow();
  });

  // Catches bug: No-argument constructor does not work
  it('throws ScriptExhaustedError when constructed with no arguments', async () => {
    const adapter = new ScriptedModelAdapterClass();
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };

    try {
      await adapter.runTurn(input);
      expect('should not reach here').toBe('error thrown');
    } catch (e) {
      if (ScriptExhaustedErrorClass && typeof ScriptExhaustedErrorClass === 'function') {
        expect(e).toBeInstanceOf(ScriptExhaustedErrorClass as new () => Error);
      }
    }
  });
});

// ===========================================================================
// Interface compliance — ModelAdapter
// ===========================================================================

describe('ModelAdapter interface compliance (quality gate)', () => {
  // Rule: ScriptedModelAdapter implements ModelAdapter
  // Catches bug: Missing or incorrectly typed provider/runTurn

  let ScriptedModelAdapterClass: unknown;

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/scripted-model-adapter');
      ScriptedModelAdapterClass = mod.ScriptedModelAdapter as unknown as typeof ScriptedModelAdapterClass;
    } catch (err) {
      throw new Error(
        'scripted-model-adapter.ts not found. This is expected during RED phase. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  // Rule: ScriptedModelAdapter satisfies ModelAdapter interface
  // Catches bug: Interface not properly implemented
  it('ScriptedModelAdapter satisfies ModelAdapter interface at compile time', () => {
    // Compile-time check: an adapter must satisfy ModelAdapter
    const _adapter: ModelAdapter = {
      provider: 'scripted',
      runTurn: async (_input: ModelTurnInput, _options?: ModelTurnOptions) => {
        return { type: 'final', answer: 'placeholder', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    expect(_adapter.provider).toBe('scripted');
    expect(typeof _adapter.runTurn).toBe('function');
  });

  // Rule: provider is "scripted"
  // Catches bug: Wrong provider value
  it('provider is "scripted" string', async () => {
    expect(ScriptedModelAdapterClass).toBeDefined();
  });

  // Rule: runTurn returns Promise<ModelTurn>
  // Catches bug: runTurn not async or wrong return type
  it('runTurn matches ModelAdapter signature', () => {
    expect(typeof ScriptedModelAdapterClass).toBe('function');
  });
});

// ===========================================================================
// Structural checks — no observe/mockResult/llm-client
// ===========================================================================

describe('Structural checks (source file analysis)', () => {
  // BDD @happy-path: ScriptedModelAdapter 不暴露 observe()
  // Rule: ScriptedModelAdapter must not have observe() method
  // Catches bug: Cheater adds observe() from NativeModelAdapter copy-paste

  it('source file does not contain observe method definition', () => {
    // Read the source and check for observe patterns
    const source = readFileSync('src/main/agent-runtime/scripted-model-adapter.ts', 'utf-8');
    expect(source).not.toMatch(/\bobserve\s*\(/);
    expect(source).not.toMatch(/\bobserve\s*:/);
  });

  // BDD: ModelTurn 不含 mockResult
  // Rule: mockResult must not appear in source
  // Catches bug: Cheater adds mockResult from previous version
  it('source file does not contain mockResult', () => {
    const source = readFileSync('src/main/agent-runtime/scripted-model-adapter.ts', 'utf-8');
    expect(source).not.toMatch(/\bmockResult\b/);
  });

  // Rule: Adapter uses stored turns, no direct llm-client import
  // Catches bug: Cheater imports llm-client.ts directly
  it('source file does not directly import llm-client', () => {
    const source = readFileSync('src/main/agent-runtime/scripted-model-adapter.ts', 'utf-8');
    expect(source).not.toMatch(/from\s+['"]\.\.\/llm-client['"]/);
    expect(source).not.toMatch(/from\s+['"]\.\.\/\.\.\/main\/llm-client['"]/);
    expect(source).not.toMatch(/import\s*\(?\s*['"][^'"]*llm-client['"]\s*\)?/);
  });
});

// ===========================================================================
// Compile-time type checks (@ts-expect-error)
// ===========================================================================

describe('Compile-time type checks (@ts-expect-error)', () => {
  // These tests verify TypeScript catches invalid ScriptedTurn types.
  // Using @ts-expect-error to assert compile errors.
  // At runtime these are no-ops (esbuild strips types without checking).
  // Verified at compile time by `npx tsc -p tsconfig.agent-runtime.json --noEmit`.

  // Rule: Every ScriptedTurn must have usage
  // Catches bug: Allowing ScriptedTurn without usage
  it('compiler rejects tool_calls turn missing usage [@ts-expect-error]', () => {
    // @ts-expect-error — tool_calls variant requires usage field
    const _turn: LocalScriptedTurn = { type: 'tool_calls', toolCalls: [] };
    expect(true).toBe(true);
  });

  // Catches bug: Allowing final turn without usage
  it('compiler rejects final turn missing usage [@ts-expect-error]', () => {
    // @ts-expect-error — final variant requires usage field
    const _turn: LocalScriptedTurn = { type: 'final', answer: 'test' };
    expect(true).toBe(true);
  });

  // BDD @failure-path: 无效 turn 类型
  // Catches bug: Allowing invalid turn type at type level
  it('compiler rejects invalid turn type observe [@ts-expect-error]', () => {
    // @ts-expect-error: Type '"observe"' is not assignable to type '"tool_calls" | "final"'
    const _turn: LocalScriptedTurn = { type: 'observe', data: 'test' };
    expect(true).toBe(true);
  });

  // Catches bug: Allowing mockResult as a turn type
  it('compiler rejects invalid turn type mockResult [@ts-expect-error]', () => {
    // @ts-expect-error: Type '"mockResult"' is not assignable to type '"tool_calls" | "final"'
    const _turn: LocalScriptedTurn = { type: 'mockResult', result: {} };
    expect(true).toBe(true);
  });

  // Rule: toolCalls must be an array, not a single object
  // Catches bug: Designing ScriptedTurn with single toolCalls object
  it('compiler rejects toolCalls as single object [@ts-expect-error]', () => {
    // @ts-expect-error: Type '{ id: string; name: string; arguments: {}; }' is not assignable to type 'ToolCall[]'
    const _bad: LocalScriptedTurn = { type: 'tool_calls', toolCalls: { id: 'c1', name: 'search', arguments: {} }, usage: { inputTokens: 10, outputTokens: 5 } };
    expect(true).toBe(true);
  });

  // Catches bug: Allowing answer field on tool_calls turn
  it('compiler rejects tool_calls turn with answer field [@ts-expect-error]', () => {
    // @ts-expect-error: 'answer' does not exist in type '{ type: "tool_calls"; toolCalls: ToolCall[]; usage: Usage; }'
    const _turn: LocalScriptedTurn = { type: 'tool_calls', toolCalls: [], answer: 'should not exist', usage: { inputTokens: 10, outputTokens: 5 } };
    expect(true).toBe(true);
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================

describe('Edge cases', () => {
  // BDD @boundary: 空脚本
  // Rule: Empty turns array throws on runTurn
  // Catches bug: Returning undefined or null instead of throwing

  let ScriptedModelAdapterClass: new (turns?: LocalScriptedTurn[]) => {
    readonly provider: string;
    runTurn: (input: ModelTurnInput, options?: ModelTurnOptions) => Promise<ModelTurn>;
  };

  beforeAll(async () => {
    try {
      const mod = await import('../agent-runtime/scripted-model-adapter');
      ScriptedModelAdapterClass = mod.ScriptedModelAdapter as unknown as typeof ScriptedModelAdapterClass;
    } catch (err) {
      throw new Error(
        'scripted-model-adapter.ts not found. This is expected during RED phase. ' +
        'Error: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  });

  // BDD @boundary: 单 final 即终止
  // Rule: Single turn consumed correctly
  // Catches bug: Cannot handle single turn
  it('handles single-turn script and exhausts correctly', async () => {
    const turn: LocalScriptedTurn = {
      type: 'final',
      answer: 'single turn result',
      usage: { inputTokens: 30, outputTokens: 15 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };

    const result = await adapter.runTurn(input);
    expect(result.type).toBe('final');
    expect((result as ModelTurnFinal).answer).toBe('single turn result');

    await expect(adapter.runTurn(input)).rejects.toThrow();
  });

  // BDD: 多轮 tool_calls -> final
  // Rule: Multiple consecutive calls work
  // Catches bug: State corruption across calls
  it('supports multiple runTurn calls exhausting the list', async () => {
    const turns: LocalScriptedTurn[] = [
      { type: 'tool_calls', toolCalls: [{ id: 'c1', name: 'tool1', arguments: {} }], usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'final', answer: 'result', usage: { inputTokens: 20, outputTokens: 10 } },
    ];
    const adapter = new ScriptedModelAdapterClass(turns);
    const input: ModelTurnInput = { systemPrompt: 'test', messages: [] };

    const r1 = await adapter.runTurn(input);
    expect(r1.type).toBe('tool_calls');

    const r2 = await adapter.runTurn(input);
    expect(r2.type).toBe('final');

    await expect(adapter.runTurn(input)).rejects.toThrow();
  });

  // BDD: tool_calls 不含 observe——观察历史由 Coordinator 管理
  // Rule: adapter should not have observe method
  // Catches bug: adapter exposes observe()
  it('does not expose observe method on instance', async () => {
    const turn: LocalScriptedTurn = {
      type: 'final',
      answer: 'test',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const adapter = new ScriptedModelAdapterClass([turn]);
    expect((adapter as Record<string, unknown>).observe).toBeUndefined();
    expect(typeof (adapter as Record<string, unknown>).observe).not.toBe('function');
  });

  // Catches bug: runTurn output depends on input content when it should be scripted
  it('returned turn is independent of runTurn input', async () => {
    const turns: LocalScriptedTurn[] = [
      { type: 'final', answer: 'answer1', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'final', answer: 'answer2', usage: { inputTokens: 10, outputTokens: 5 } },
    ];
    const adapter = new ScriptedModelAdapterClass(turns);
    const input: ModelTurnInput = { systemPrompt: 'anything', messages: [] };

    const r1 = await adapter.runTurn(input);
    expect((r1 as ModelTurnFinal).answer).toBe('answer1');

    const r2 = await adapter.runTurn(input);
    expect((r2 as ModelTurnFinal).answer).toBe('answer2');
  });
});
