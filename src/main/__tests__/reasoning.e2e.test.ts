/**
 * reasoning.e2e.test.ts — DeepSeek V4 思考模式链路（文档：api-docs 思考模式）。
 *
 * 覆盖：
 * - 请求参数：model / thinking / reasoning_effort 随请求发出
 * - 流式：delta.reasoning_content → reasoning_delta → ModelTurn.reasoning
 * - 工具轮：assistant(tool_calls) 消息必须回传 reasoning_content（否则 400）
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import * as path from 'path';
import { ProjectWorkspace } from '../storage/workspace';
import { createAgentRuntime } from '../agent-runtime/agent-factory';
import { ScriptedModelAdapter, type ScriptedTurn } from '../agent-runtime/scripted-model-adapter';
import { DeepSeekTransport } from '../model-transport';
import { NativeModelAdapter } from '../agent-runtime/model-adapter';
import { makeProject, removeDir } from './helpers/temp-project';
import type { ModelAdapter, ModelTurnInput, ModelTurn } from '../agent-runtime/model-types';
import type { ChatMessage } from '../../shared/types';

vi.mock('../api-key-store', () => ({
  loadApiKey: vi.fn(() => 'sk-test-mock-key'),
}));

// 固定设置为 pro · 思考开 · max（验证参数透传）
vi.mock('../settings-store', () => ({
  getSettings: () => ({ model: 'deepseek-v4-pro', thinking: true, reasoningEffort: 'max' }),
  saveSettings: (p: unknown) => p,
}));

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(removeDir));

function usage(i: number, o: number) {
  return { inputTokens: i, outputTokens: o };
}

/** 记录每次模型输入并回放脚本的适配器（断言 reasoning 回传）。 */
class RecordingAdapter implements ModelAdapter {
  readonly provider = 'recording';
  readonly inputs: ModelTurnInput[] = [];
  constructor(private readonly inner: ModelAdapter) {}
  async runTurn(input: ModelTurnInput, options?: unknown): Promise<ModelTurn> {
    this.inputs.push(input);
    return this.inner.runTurn(input, options as never);
  }
}

function setup(script: ScriptedTurn[]) {
  const { projectDir } = makeProject();
  tempDirs.push(projectDir);
  const workspace = ProjectWorkspace.open(projectDir)!;
  const runtime = createAgentRuntime(workspace, new ScriptedModelAdapter(script));
  return { projectDir, workspace, runtime };
}

function userMessage(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, timestamp: `t${id}` };
}

describe('DeepSeek V4 思考模式链路', () => {
  it('请求参数：model / thinking / reasoning_effort 随请求发出（设置里选 pro·max）', async () => {
    const chatCompletion = vi.fn(async () => ({
      content: '好',
      finishReason: 'stop',
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.model).toBe('deepseek-v4-pro');
      expect(body.thinking).toEqual({ type: 'enabled' });
      expect(body.reasoning_effort).toBe('max');
      return new Response(JSON.stringify({
        id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    void chatCompletion;
    const transport = new DeepSeekTransport();
    const adapter = new NativeModelAdapter(transport);
    const turn = await adapter.runTurn({ systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(turn.type).toBe('final');
    vi.restoreAllMocks();
  });

  it('流式：reasoning_content → 工具轮回传（assistant 消息携带 reasoning_content）', async () => {
    const { workspace } = setup([]);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        chunk({ choices: [{ delta: { reasoning_content: '让我想想' }, finish_reason: null }] });
        chunk({ choices: [{ delta: { reasoning_content: '，先查一下' }, finish_reason: null }] });
        chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'search_nodes', arguments: '{"query":"x"}' } }] }, finish_reason: null }] });
        chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        chunk({ choices: [], finish_reason: 'stop', usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } });
        controller.close();
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, { status: 200 }));

    const transport = new DeepSeekTransport();
    const adapter = new NativeModelAdapter(transport);
    const turn = await adapter.runTurn(
      { systemPrompt: 'sys', messages: [{ role: 'user', content: '查一下' }], tools: [{ name: 'search_nodes', description: 'd', inputSchema: {} }] },
      { onChunk: () => {} }, // 传 onChunk → 走流式（SSE）
    );
    expect(turn.type).toBe('tool_calls');
    expect(turn.reasoning).toBe('让我想想，先查一下');

    // 第二轮：assistant(tool_calls) 必须回传 reasoning_content（400 校验）
    const script: ScriptedTurn[] = [
      { type: 'tool_calls', toolCalls: [{ id: 'c1', name: 'search_nodes', arguments: { query: 'x' } }], usage: usage(5, 2), reasoning: '让我想想，先查一下' },
      { type: 'final', answer: '找到了', usage: usage(8, 2) },
    ];
    const recording = new RecordingAdapter(new ScriptedModelAdapter(script));
    const runtime = createAgentRuntime(workspace, recording);
    await runtime.coordinator.run({
      taskKind: 'chat',
      messages: [userMessage('m1', '查一下')],
    });
    const secondTurn = recording.inputs[1];
    const assistantMsg = secondTurn.messages.find((m) => m.role === 'assistant' && m.tool_calls) as
      | { reasoning_content?: string }
      | undefined;
    expect(assistantMsg).toBeTruthy();
    expect(assistantMsg!.reasoning_content).toBe('让我想想，先查一下');
    vi.restoreAllMocks();
  });
});
