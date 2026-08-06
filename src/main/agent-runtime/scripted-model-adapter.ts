/**
 * scripted-model-adapter.ts — ScriptedModelAdapter for deterministic testing.
 *
 * Implements the ModelAdapter interface by returning pre-programmed turns
 * in FIFO order. Designed for testing the agent runtime without an external LLM.
 *
 * Task: I7_T03
 */

import type {
  ModelAdapter,
  ModelTurn,
  ModelTurnInput,
  ModelTurnOptions,
  ToolCall,
  Usage,
} from './model-types';
import type { EvidenceRef } from './tool-types';

// ===========================================================================
// Exported types
// ===========================================================================

/**
 * ScriptedTurn — a pre-programmed model turn for deterministic testing.
 *
 * Two variants:
 * - `tool_calls`: returns tool calls for the runtime to execute
 * - `final`: returns a final answer with optional citations
 *
 * Every variant requires a `usage` field with token counts.
 */
export type ScriptedTurn =
  | {
      type: 'tool_calls';
      toolCalls: ToolCall[];
      usage: Usage;
      /** 思维链（DeepSeek V4 思考模式；随工具轮回传） */
      reasoning?: string;
    }
  | {
      type: 'final';
      answer: string;
      citations?: EvidenceRef[];
      usage: Usage;
      reasoning?: string;
    };

// ===========================================================================
// Error classes
// ===========================================================================

/**
 * ScriptExhaustedError — thrown when all pre-programmed turns have been consumed.
 */
export class ScriptExhaustedError extends Error {
  constructor(message?: string) {
    super(message ?? 'ScriptedModelAdapter has no more turns');
    this.name = 'ScriptExhaustedError';
  }
}

/**
 * InvalidScriptError — thrown when a turn with an invalid type is provided to the constructor.
 */
export class InvalidScriptError extends Error {
  constructor(message?: string) {
    super(message ?? 'Invalid script turn type');
    this.name = 'InvalidScriptError';
  }
}

// ===========================================================================
// ScriptedModelAdapter
// ===========================================================================

/**
 * ScriptedModelAdapter — a deterministic ModelAdapter for testing.
 *
 * Returns pre-programmed turns in FIFO order. Does not manage observation
 * history or mock results — those are handled by RunCoordinator.
 */
export class ScriptedModelAdapter implements ModelAdapter {
  readonly provider = 'scripted';

  private readonly turns: ScriptedTurn[];
  private currentIndex: number;

  constructor(turns?: ScriptedTurn[]) {
    this.turns = turns ?? [];
    this.currentIndex = 0;

    // Validate turn types at construction time
    for (const turn of this.turns) {
      if (turn.type !== 'tool_calls' && turn.type !== 'final') {
        throw new InvalidScriptError(
          `Invalid script turn type: "${(turn as { type: string }).type}". Expected "tool_calls" or "final".`,
        );
      }
    }
  }

  /**
   * Static factory — creates an adapter with variadic turn arguments.
   */
  static fromTurns(...turns: ScriptedTurn[]): ScriptedModelAdapter {
    return new ScriptedModelAdapter(turns);
  }

  /**
   * Return the next pre-programmed turn in FIFO order.
   *
   * Ignores the input and options parameters — the adapter always returns
   * the next turn from its pre-programmed script.
   *
   * Throws ScriptExhaustedError (as a rejected promise) when all turns
   * have been consumed.
   */
  async runTurn(
    _input: ModelTurnInput,
    _options?: ModelTurnOptions,
  ): Promise<ModelTurn> {
    if (this.currentIndex >= this.turns.length) {
      throw new ScriptExhaustedError(
        `ScriptedModelAdapter exhausted after ${this.turns.length} turn(s)`,
      );
    }

    const turn = this.turns[this.currentIndex];
    this.currentIndex++;

    if (turn.type === 'tool_calls') {
      return {
        type: 'tool_calls',
        toolCalls: turn.toolCalls,
        usage: turn.usage,
        ...(turn.reasoning !== undefined ? { reasoning: turn.reasoning } : {}),
      } as ModelTurn;
    }

    // type === 'final'
    return {
      type: 'final',
      answer: turn.answer,
      ...(turn.citations !== undefined ? { citations: turn.citations } : {}),
      ...(turn.reasoning !== undefined ? { reasoning: turn.reasoning } : {}),
      usage: turn.usage,
    } as ModelTurn;
  }
}
