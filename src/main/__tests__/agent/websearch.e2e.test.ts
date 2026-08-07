/**
 * websearch.e2e.test.ts — 原生 web_search 全链路 e2e（run-loop + adapter + transport）。
 *
 * 场景：chat 任务带 web_search 工具 → 模型返回纯搜索轮（web_search_call）
 * → run-loop 执行占位工具 → tool 结果回传（transport 缓存原样注入）
 * → 第二轮模型给出最终回答。
 *
 * 注：run-loop 恒传 onChunk，adapter 总是走流式路径（responsesStream）。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { DeepSeekTransport } from '../../model-transport';
import { NativeModelAdapter } from '../../agent-runtime/model-adapter';
import { createAgentRuntime } from '../../agent-runtime/agent-factory';
import { ProjectWorkspace } from '../../storage/workspace';
import { makeProject, removeDir } from '../helpers/temp-project';
import type { ChatMessage } from '../../../shared/types';

const responsesStream = vi.fn();

vi.mock('../../llm-client', () => ({
  chatCompletion: vi.fn(),
  chatCompletionStream: vi.fn(),
  responsesCompletion: vi.fn(),
  responsesStream: (...args: unknown[]) => responsesStream(...args),
}));

vi.mock('../../settings-store', () => ({
  getSettings: () => ({ model: 'deepseek-v4-flash', thinking: true, reasoningEffort: 'high', notifications: true }),
}));

const tempDirs: string[] = [];
afterEach(() => {
  tempDirs.forEach(removeDir);
  vi.restoreAllMocks();
  responsesStream.mockReset();
});

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

function userMessage(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, timestamp: 't' };
}

type OnChunk = (c: {
  content: string;
  finishReason: string | null;
  searchStatus?: 'searching' | 'completed';
  toolCalls?: unknown[];
  webSearchCalls?: unknown[];
  usage?: typeof usage;
}) => void;

/** 模拟一整个流式响应（含 usage 收尾 chunk）。 */
function mockStreamResponse(events: Array<Partial<Parameters<OnChunk>[0]>>): void {
  responsesStream.mockImplementationOnce(async (_req: unknown, _cache: unknown, onChunk: OnChunk) => {
    for (const e of events) onChunk({ content: '', finishReason: null, ...e });
  });
}

describe('web_search 全链路', () => {
  let transport: DeepSeekTransport;

  beforeEach(() => {
    transport = new DeepSeekTransport();
  });

  it('搜索轮 → 占位执行 → 回传 → 第二轮最终回答', async () => {
    const { projectDir } = makeProject('搜索项目');
    tempDirs.push(projectDir);
    const workspace = ProjectWorkspace.open(projectDir)!;

    // 第一轮：纯搜索轮（web_search_call，无 message）
    mockStreamResponse([
      { searchStatus: 'searching' },
      { searchStatus: 'completed' },
      {
        finishReason: 'tool_calls',
        webSearchCalls: [{ id: 'ws_1', status: 'in_progress', action: { type: 'search', queries: ['2026世界杯'] } }],
        usage,
      },
    ]);
    // 第二轮：最终回答
    mockStreamResponse([
      { content: '决赛在', finishReason: null },
      { content: '美国新泽西举行。', finishReason: null },
      { finishReason: 'stop', usage },
    ]);

    const adapter = new NativeModelAdapter(transport);
    const runtime = createAgentRuntime(workspace, adapter);

    const searchStatuses: string[] = [];
    const traces: string[] = [];
    const result = await runtime.coordinator.run({
      taskKind: 'chat',
      messages: [userMessage('m1', '2026年世界杯决赛在哪举行？')],
      onSearchStatus: (s) => { searchStatuses.push(s); },
      onToolTrace: (t) => { traces.push(t.toolName); },
    });

    expect(responsesStream).toHaveBeenCalledTimes(2);
    expect(result.error).toBeUndefined();
    expect(result.finalAnswer).toBe('决赛在美国新泽西举行。');
    expect(result.toolCallCount).toBe(1);
    // onToolTrace 每次调用发 started + completed 两次事件（既有设计）
    expect([...new Set(traces)]).toEqual(['web_search']);
    expect(searchStatuses).toContain('searching');

    // 回传的请求必须包含原样 web_search_call（第二轮 input；
    // transport 层把 web_search tool_call 序列化为 web_search 类型，
    // 丢弃 tool 结果消息发生在 llm-client 的 items 转换——见 llm-client-responses.test）
    const secondReq = responsesStream.mock.calls[1][0] as { messages: Array<Record<string, unknown>> };
    const assistantWsCall = secondReq.messages.find(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls),
    ) as { tool_calls?: Array<{ type?: string }> };
    expect(assistantWsCall?.tool_calls?.some((tc) => tc.type === 'web_search')).toBe(true);
  });

  it('搜索自动完成（单轮出答案）不触发工具轮', async () => {
    const { projectDir } = makeProject('自动完成');
    tempDirs.push(projectDir);
    const workspace = ProjectWorkspace.open(projectDir)!;

    mockStreamResponse([
      { searchStatus: 'searching' },
      { searchStatus: 'completed' },
      { content: '决赛在', finishReason: null },
      { content: '美国新泽西举行。', finishReason: null },
      {
        finishReason: 'stop',
        webSearchCalls: [{ id: 'ws_1', status: 'completed', action: { type: 'search', queries: ['2026世界杯'] } }],
        usage,
      },
    ]);

    const adapter = new NativeModelAdapter(transport);
    const runtime = createAgentRuntime(workspace, adapter);

    const result = await runtime.coordinator.run({
      taskKind: 'chat',
      messages: [userMessage('m1', '2026年世界杯决赛在哪举行？')],
    });

    expect(responsesStream).toHaveBeenCalledTimes(1);
    expect(result.error).toBeUndefined();
    expect(result.finalAnswer).toBe('决赛在美国新泽西举行。');
    expect(result.toolCallCount).toBe(0);
  });

  it('搜索后再追问（多轮历史回传）', async () => {
    const { projectDir } = makeProject('多轮');
    tempDirs.push(projectDir);
    const workspace = ProjectWorkspace.open(projectDir)!;

    mockStreamResponse([
      { searchStatus: 'searching' },
      {
        finishReason: 'tool_calls',
        webSearchCalls: [{ id: 'ws_1', status: 'in_progress', action: { type: 'search', queries: ['q'] } }],
        usage,
      },
    ]);
    mockStreamResponse([
      { content: '在美国。', finishReason: null },
      { finishReason: 'stop', usage },
    ]);
    // 第二次 run 同样走「搜索轮 + 回答轮」
    mockStreamResponse([
      { searchStatus: 'searching' },
      {
        finishReason: 'tool_calls',
        webSearchCalls: [{ id: 'ws_2', status: 'in_progress', action: { type: 'search', queries: ['q2'] } }],
        usage,
      },
    ]);
    mockStreamResponse([
      { content: '大都会人寿球场。', finishReason: null },
      { finishReason: 'stop', usage },
    ]);

    const adapter = new NativeModelAdapter(transport);
    const runtime = createAgentRuntime(workspace, adapter);
    await runtime.coordinator.run({
      taskKind: 'chat',
      messages: [userMessage('m1', '2026世界杯决赛在哪？')],
    });
    // 第二次 run（新的 runId，但同一 transport 实例缓存 web_search_call）
    const result2 = await runtime.coordinator.run({
      taskKind: 'chat',
      messages: [userMessage('m2', '追问：具体哪个球场？')],
    });
    expect(result2.error).toBeUndefined();
    expect(responsesStream).toHaveBeenCalledTimes(4);
  });
});
