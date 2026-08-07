/**
 * model-adapter.ts — NativeModelAdapter for OpenAI/DeepSeek tool_calls format.
 *
 * Implements the ModelAdapter interface from model-types.ts, supporting:
 * - Native tool calling (OpenAI/DeepSeek format)
 * - JSON fallback mode when no tools are provided
 * - Streaming via ChatChunk discriminated union
 * - ModelTransport injection (no direct llm-client dependency)
 *
 * Task: I7_T02
 */

import type {
  ModelAdapter,
  ModelTurn,
  ModelTurnInput,
  ModelTurnOptions,
  ToolCall,
  Usage,
} from './model-types';

// ===========================================================================
// Exported types
// ===========================================================================

/**
 * ChatChunk — discriminated union for streaming responses.
 *
 * - `text_delta`: incremental text content for final answers
 * - `reasoning_delta`: incremental thinking-chain content (DeepSeek V4)
 * - `tool_call_delta`: incremental tool call data, accumulated by index
 * - `search_status`: server-side web search progress (Responses API)
 * - `done`: terminal chunk carrying finishReason and usage
 */
export type ChatChunk =
  | { type: 'text_delta'; content: string }
  | { type: 'reasoning_delta'; content: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; arguments?: string }
  | { type: 'search_status'; status: 'searching' | 'completed' }
  | { type: 'done'; finishReason: 'stop' | 'tool_calls'; usage: Usage };

/**
 * ChatResponse — non-streaming response following OpenAI/DeepSeek format.
 */
export interface ChatResponse {
  choices: Array<{
    index: number;
    message: {
      role: string;
      content?: string | null;
      /** 思维链（DeepSeek V4 思考模式） */
      reasoning_content?: string | null;
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

/**
 * ModelTransport — injectable transport interface.
 *
 * Implementations handle the actual HTTP/API communication.
 * The adapter never imports llm-client.ts directly.
 */
export interface ModelTransport {
  chat(
    messages: unknown[],
    tools?: unknown[],
    options?: unknown,
  ): Promise<ChatResponse>;
  chatStream(
    messages: unknown[],
    tools?: unknown[],
    options?: unknown,
  ): AsyncIterable<ChatChunk>;
}

// ===========================================================================
// Error classes
// ===========================================================================

/**
 * UsageUnavailableError — thrown when usage data is missing from a response.
 *
 * The ModelTurn contract requires usage on every variant. Missing usage
 * is a terminal condition that the RunCoordinator handles as USAGE_UNAVAILABLE.
 */
export class UsageUnavailableError extends Error {
  constructor(message?: string) {
    super(message ?? 'Usage data unavailable for model turn');
    this.name = 'UsageUnavailableError';
  }
}

// ===========================================================================
// Internal helpers
// ===========================================================================

/**
 * Transform a tool definition from ModelTurnInput format to
 * OpenAI/DeepSeek API format.
 *
 * - web_search → { type: "web_search" }（Responses API 原生联网搜索，服务端执行）
 * - 其余   → { type: "function", function: { name, description, parameters } }
 */
function transformTool(tool: {
  name: string;
  description: string;
  inputSchema: unknown;
}): Record<string, unknown> {
  if (tool.name === 'web_search') {
    return { type: 'web_search' };
  }
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

/**
 * Parse a single tool_call entry from an API response.
 *
 * Validates:
 * - function field is present (not null/undefined)
 * - function.name is non-empty
 * - function.arguments is valid JSON
 */
function parseToolCall(tc: {
  id: string;
  type: string;
  function?: { name: string; arguments: string } | null;
}): ToolCall {
  if (!tc.function) {
    throw new Error('Tool call entry has null or undefined function');
  }
  if (!tc.function.name) {
    throw new Error('Tool call entry has missing function.name');
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(tc.function.arguments);
  } catch {
    throw new Error('Invalid JSON in function.arguments');
  }

  return {
    id: tc.id,
    name: tc.function.name,
    arguments: parsedArgs as Record<string, unknown>,
  };
}

/**
 * Validate the top-level structure of a ChatResponse and extract usage.
 * Throws UsageUnavailableError if usage is missing or incomplete.
 */
function validateUsage(usage: Usage | undefined): Usage {
  if (!usage || typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') {
    throw new UsageUnavailableError('Usage data unavailable for model turn');
  }
  return usage;
}

// ===========================================================================
// NativeModelAdapter
// ===========================================================================

/**
 * NativeModelAdapter — adapts OpenAI/DeepSeek-compatible APIs to ModelAdapter.
 *
 * Supports two modes:
 * 1. Native tool calling: tools are transformed to {type:"function", function:{...}}
 *    and passed to the transport alongside messages.
 * 2. JSON fallback: when no tools are provided, the system prompt is modified
 *    with a JSON output constraint and the response is parsed as JSON.
 */
export class NativeModelAdapter implements ModelAdapter {
  /** Provider identifier — "openai" or "deepseek" */
  readonly provider: string;
  /** The injected transport used for all API communication */
  private transport: ModelTransport;

  constructor(transport: ModelTransport) {
    this.transport = transport;
    this.provider = 'openai';
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async runTurn(
    input: ModelTurnInput,
    options?: ModelTurnOptions,
  ): Promise<ModelTurn> {
    const hasNativeTools = input.tools !== undefined;

    if (hasNativeTools) {
      // Native tool calling mode
      const messages = this.buildMessages(input.systemPrompt, input.messages);
      const tools = input.tools!.map(transformTool);
      return this.runWithTools(messages, tools, options);
    }

    // JSON fallback mode — no tools provided
    const fallbackPrompt =
      input.systemPrompt +
      '\n\nRespond with JSON: { "type":"tool_calls"|"final", ... }';
    const messages = this.buildMessages(fallbackPrompt, input.messages);
    return this.runJsonFallback(messages, options);
  }

  // -------------------------------------------------------------------------
  // Message construction
  // -------------------------------------------------------------------------

  /**
   * Build the message array sent to the transport.
   * Prepends a system message with the system prompt.
   */
  private buildMessages(
    systemPrompt: string,
    inputMessages: ModelTurnInput['messages'],
  ): unknown[] {
    return [
      { role: 'system', content: systemPrompt },
      ...inputMessages,
    ];
  }

  // -------------------------------------------------------------------------
  // Route non-streaming vs streaming
  // -------------------------------------------------------------------------

  /**
   * Native tool calling mode — routes to streaming or non-streaming path.
   */
  private async runWithTools(
    messages: unknown[],
    tools: unknown[],
    options?: ModelTurnOptions,
  ): Promise<ModelTurn> {
    if (options?.onChunk) {
      return this.runStream(messages, tools, options);
    }
    return this.runNonStream(messages, tools, options);
  }

  /**
   * JSON fallback mode — routes to streaming or non-streaming path.
   */
  private async runJsonFallback(
    messages: unknown[],
    options?: ModelTurnOptions,
  ): Promise<ModelTurn> {
    if (options?.onChunk) {
      return this.runStream(messages, undefined, options);
    }
    return this.runNonStreamJson(messages, options);
  }

  // -------------------------------------------------------------------------
  // Non-streaming: native tool calling
  // -------------------------------------------------------------------------

  /**
   * Execute a non-streaming call with tools via transport.chat().
   */
  private async runNonStream(
    messages: unknown[],
    tools: unknown[],
    options?: ModelTurnOptions,
  ): Promise<ModelTurn> {
    const transportOptions = this.buildOptions(options);
    let response: ChatResponse;
    try {
      response = await this.transport.chat(
        messages,
        tools,
        transportOptions,
      );
    } catch (err) {
      // Propagate transport errors (API errors with status codes pass through)
      throw err;
    }
    return this.handleChatResponse(response);
  }

  // -------------------------------------------------------------------------
  // Non-streaming: JSON fallback
  // -------------------------------------------------------------------------

  /**
   * Execute a non-streaming call in JSON fallback mode (no tools).
   * Tries to parse the response content as JSON; falls back to plain text.
   */
  private async runNonStreamJson(
    messages: unknown[],
    options?: ModelTurnOptions,
  ): Promise<ModelTurn> {
    const transportOptions = this.buildOptions(options);
    let response: ChatResponse;
    try {
      response = await this.transport.chat(
        messages,
        undefined,
        transportOptions,
      );
    } catch (err) {
      throw err;
    }
    return this.handleJsonResponse(response);
  }

  // -------------------------------------------------------------------------
  // Options construction
  // -------------------------------------------------------------------------

  /**
   * Build the options object forwarded to transport methods.
   */
  private buildOptions(
    options?: ModelTurnOptions,
  ): Record<string, unknown> | undefined {
    if (!options) return undefined;
    const result: Record<string, unknown> = {};
    if (options.maxTokens !== undefined) {
      result.maxTokens = options.maxTokens;
    }
    if (options.temperature !== undefined) {
      result.temperature = options.temperature;
    }
    if (options.signal !== undefined) {
      result.signal = options.signal;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  // -------------------------------------------------------------------------
  // Response handling: native tool calling
  // -------------------------------------------------------------------------

  /**
   * Handle a ChatResponse for native tool calling mode.
   *
   * Behavior depends on the presence of tool_calls in the message:
   * - If tool_calls is a non-empty array: parse each entry and return a
   *   tool_calls ModelTurn.
   * - If tool_calls is an empty array and finish_reason is 'tool_calls':
   *   throw (invalid state).
   * - Otherwise: treat as a final response with the message content as answer.
   */
  private handleChatResponse(response: ChatResponse): ModelTurn {
    const choice = this.validateChoice(response);
    const usage = validateUsage(response.usage);
    const { message, finish_reason } = choice;
    const reasoning = message.reasoning_content || undefined;

    // Check for tool_calls in the response
    if (message.tool_calls) {
      if (message.tool_calls.length === 0 && finish_reason === 'tool_calls') {
        throw new Error('Empty tool_calls array with tool_calls finish_reason');
      }
      if (message.tool_calls.length > 0) {
        const toolCalls = message.tool_calls.map((tc) => parseToolCall(tc));
        return { type: 'tool_calls', toolCalls, usage, ...(reasoning ? { reasoning } : {}) };
      }
    }

    // Final response — message.content must not be null
    if (message.content == null) {
      throw new Error('Null content in final response');
    }

    return {
      type: 'final',
      answer: message.content,
      usage,
      ...(reasoning ? { reasoning } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Response handling: JSON fallback
  // -------------------------------------------------------------------------

  /**
   * Handle a ChatResponse in JSON fallback mode.
   *
   * Attempts to parse the response content as JSON with the structure:
   *   { type: 'tool_calls', toolCalls: [...] } or { type: 'final', answer: "..." }
   *
   * If content is not valid JSON, falls back to treating it as a plain final
   * response.
   */
  private handleJsonResponse(response: ChatResponse): ModelTurn {
    const choice = this.validateChoice(response);
    const usage = validateUsage(response.usage);
    const { message } = choice;

    // Try to parse the response content as JSON
    if (message.content) {
      try {
        const parsed = JSON.parse(message.content);
        if (parsed && typeof parsed === 'object') {
          if (parsed.type === 'tool_calls') {
            return {
              type: 'tool_calls',
              toolCalls: parsed.toolCalls ?? [],
              usage,
            };
          }
          if (parsed.type === 'final') {
            return {
              type: 'final',
              answer: parsed.answer ?? '',
              usage,
            };
          }
        }
      } catch {
        // Not valid JSON — fall through to plain-text final response
      }
    }

    // Fall back to treating the content as a regular final response
    if (message.content == null) {
      throw new Error('Null content in final response');
    }

    return {
      type: 'final',
      answer: message.content,
      usage,
    };
  }

  // -------------------------------------------------------------------------
  // Response validation
  // -------------------------------------------------------------------------

  /**
   * Validate the basic structure of a ChatResponse and extract the first choice.
   */
  private validateChoice(response: ChatResponse): ChatResponse['choices'][0] {
    if (!response.choices || response.choices.length === 0) {
      throw new Error('Empty choices array in model response');
    }

    const choice = response.choices[0];

    if (!choice.message) {
      throw new Error('Null message in model response');
    }

    return choice;
  }

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  /**
   * Execute a streaming call via transport.chatStream().
   *
   * Processes ChatChunk discriminants:
   * - text_delta: accumulates content and calls onChunk callback
   * - tool_call_delta: accumulates arguments fragments by tool index
   * - done: terminates the stream with the final usage
   *
   * Throws UsageUnavailableError if the stream ends without a done chunk
   * or the done chunk lacks usage data.
   */
  private async runStream(
    messages: unknown[],
    tools: unknown[] | undefined,
    options: ModelTurnOptions,
  ): Promise<ModelTurn> {
    const transportOptions = this.buildOptions(options);
    const iterable = this.transport.chatStream(
      messages,
      tools,
      transportOptions,
    );

    const textFragments: string[] = [];
    const reasoningFragments: string[] = [];
    const toolAccumulators = new Map<
      number,
      { id?: string; name?: string; arguments: string }
    >();
    let seenDone = false;
    let finalUsage: Usage | null = null;

    for await (const chunk of iterable) {
      if (chunk.type === 'text_delta') {
        textFragments.push(chunk.content);
        if (options.onChunk) {
          options.onChunk(chunk.content);
        }
      } else if (chunk.type === 'reasoning_delta') {
        reasoningFragments.push(chunk.content);
        if (options.onReasoning) {
          options.onReasoning(chunk.content);
        }
      } else if (chunk.type === 'tool_call_delta') {
        let acc = toolAccumulators.get(chunk.index);
        if (!acc) {
          acc = { arguments: '' };
          toolAccumulators.set(chunk.index, acc);
        }
        if (chunk.id !== undefined) {
          acc.id = chunk.id;
        }
        if (chunk.name !== undefined) {
          acc.name = chunk.name;
        }
        if (chunk.arguments !== undefined) {
          acc.arguments += chunk.arguments;
        }
      } else if (chunk.type === 'search_status') {
        if (options.onSearchStatus) {
          options.onSearchStatus(chunk.status);
        }
      } else if (chunk.type === 'done') {
        seenDone = true;
        if (
          !chunk.usage ||
          typeof chunk.usage.inputTokens !== 'number' ||
          typeof chunk.usage.outputTokens !== 'number'
        ) {
          throw new UsageUnavailableError('Done chunk missing usage data');
        }
        finalUsage = chunk.usage;
      }
    }

    // Stream ended without a done chunk
    if (!seenDone) {
      throw new UsageUnavailableError('Stream ended without done chunk');
    }

    // Safety check — should not happen if seenDone and validation passed
    if (!finalUsage) {
      throw new UsageUnavailableError('Done chunk missing usage data');
    }

    const reasoning = reasoningFragments.length > 0 ? reasoningFragments.join('') : undefined;

    // If we accumulated tool_call_deltas, return a tool_calls ModelTurn
    if (toolAccumulators.size > 0) {
      const toolCalls: ToolCall[] = [];
      const sortedIndices = [...toolAccumulators.keys()].sort(
        (a, b) => a - b,
      );
      for (const index of sortedIndices) {
        const acc = toolAccumulators.get(index)!;
        const parsedArgs = acc.arguments
          ? (JSON.parse(acc.arguments) as Record<string, unknown>)
          : {};
        toolCalls.push({
          id: acc.id ?? '',
          name: acc.name ?? '',
          arguments: parsedArgs,
        });
      }
      // 思维链随工具轮回传（DeepSeek V4 带 tools 请求必须完整回传）
      return { type: 'tool_calls', toolCalls, usage: finalUsage, ...(reasoning ? { reasoning } : {}) };
    }

    // Final response from text_delta accumulation
    return {
      type: 'final',
      answer: textFragments.join(''),
      usage: finalUsage,
      ...(reasoning ? { reasoning } : {}),
    };
  }
}
