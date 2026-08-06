/**
 * store.test.ts — 渲染层 store 逻辑测试（jsdom）。
 * 用 mock api 验证：活动路径派生、未整理计数、流式事件应用、
 * 子树展开、run 完成后的模式切换。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { store } from '../store';
import { setApiForTest } from '../api';
import type { RendererApi, ProjectState, RunStreamEvent } from '../../shared/ipc-types';
import type { ChatMessage, ToolCallTrace } from '../../shared/types';

function msg(id: string, role: ChatMessage['role'], content: string, parentId?: string): ChatMessage {
  return { id, role, content, timestamp: 't', parentId };
}

function makeProject(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    dir: '/proj',
    name: '测试',
    outline: null,
    nodes: [
      { id: 'v1', type: 'volume', title: '第一卷', parentId: null, depth: 0, hasDraft: true, hasOfficial: false, outputFormats: [] },
      { id: 'c1', type: 'chapter', title: '第一章', parentId: 'v1', depth: 1, hasDraft: false, hasOfficial: false, outputFormats: [] },
      { id: 'c2', type: 'chapter', title: '第二章', parentId: 'v1', depth: 1, hasDraft: true, hasOfficial: false, outputFormats: [] },
    ],
    assets: [],
    attachments: [],
    messages: [
      msg('m1', 'user', '问题一'),
      msg('m2', 'ai', '回答一', 'm1'),
      msg('m3', 'ai', '回答一 B', 'm1'),
    ],
    sessions: [],
    activeMessageId: 'm2',
    runSummaries: [],
    hasApiKey: false,
    trash: [],
    settings: { model: 'deepseek-v4-flash', thinking: true, reasoningEffort: 'high', notifications: true },
    ...overrides,
  };
}

function makeApi(overrides: Partial<RendererApi> = {}): RendererApi {
  const project = makeProject();
  const stub = {
    app: { getVersion: vi.fn(async () => '0.1.0') },
    project: {
      list: vi.fn(async () => []),
      create: vi.fn(async () => project),
      open: vi.fn(async () => project),
      pickFolder: vi.fn(async () => null),
    },
    state: { get: vi.fn(async () => project) },
    outline: {
      createNode: vi.fn(async () => project),
      renameNode: vi.fn(async () => project),
      deleteNode: vi.fn(async () => project),
      moveNode: vi.fn(async () => project),
      writeDraft: vi.fn(async () => project),
      writeOfficial: vi.fn(async () => project),
      commitNodes: vi.fn(async () => ({ runId: 'commit-1', committed: ['v1'], skippedPending: [], affected: ['v1'] })),
      readContent: vi.fn(async () => ({ id: 's1', title: '场景', type: 'scene', official: null, draft: 'draft' })),
    },
    asset: {
      create: vi.fn(async () => project),
      update: vi.fn(async () => project),
      delete: vi.fn(async () => project),
    },
    attachment: {
      add: vi.fn(async () => project),
      addFiles: vi.fn(async () => project),
      pickFiles: vi.fn(async () => project),
      scanWorkspace: vi.fn(async () => []),
      importWorkspace: vi.fn(async () => project),
    },
    visibleView: {
      read: vi.fn(async () => null),
      generate: vi.fn(async () => project),
      save: vi.fn(async () => project),
    },
    output: {
      formats: vi.fn(async () => ['novel']),
      list: vi.fn(async () => []),
      read: vi.fn(async () => 'content'),
    },
    conversation: {
      send: vi.fn(async () => project),
      newTopic: vi.fn(async () => project),
      switchSession: vi.fn(async () => project),
      archiveSession: vi.fn(async () => project),
      unarchiveSession: vi.fn(async () => project),
      deleteSession: vi.fn(async () => project),
      switchBranch: vi.fn(async () => project),
      edit: vi.fn(async () => project),
    },
    context: {
      inspect: vi.fn(async () => ({ messageCount: 2, budgetTokens: 30000, estimatedTokens: 50, compressed: false, keptRawCount: 2, blocked: false })),
      recompress: vi.fn(async () => project),
    },
    nodeVersion: {
      list: vi.fn(async () => []),
      read: vi.fn(async () => '版本内容'),
    },
    trash: {
      restore: vi.fn(async () => project),
      purge: vi.fn(async () => project),
    },
    run: {
      start: vi.fn(async () => ({ runId: 'run_1' })),
      cancel: vi.fn(async () => {}),
      onEvent: vi.fn(() => () => {}),
      refresh: vi.fn(async () => ({ runId: 'run_2' })),
      detailFill: vi.fn(async () => ({ runId: 'run_3' })),
      list: vi.fn(async () => []),
      diff: vi.fn(async () => []),
      accept: vi.fn(async () => project),
      rollback: vi.fn(async () => project),
    },
    settings: { setKey: vi.fn(async () => project), update: vi.fn(async () => project) },
  };
  return { ...stub, ...overrides } as RendererApi;
}

beforeEach(() => {
  // 重置 store 内部状态：通过重新导入模块不可行（单例），用 actions 清理
  setApiForTest(makeApi());
});

describe('store — 派生视图', () => {
  it('activePath 沿 parentId 回溯（与主进程一致）', async () => {
    const project = makeProject({
      messages: [
        msg('m1', 'user', '问题'),
        msg('m2', 'ai', '回答', 'm1'),
        msg('m3', 'ai', '分支回答', 'm1'),
        msg('m4', 'user', '追问', 'm3'),
      ],
      activeMessageId: 'm4',
    });
    setApiForTest(makeApi({ project: { ...makeApi().project, open: vi.fn(async () => project) } }));
    await store.openProject('/proj');
    expect(store.activePath().map((m) => m.id)).toEqual(['m1', 'm3', 'm4']);
  });

  it('unorganizedCount：光标后、沿活动路径', async () => {
    const project = makeProject({
      messages: [
        msg('m1', 'user', '一'),
        msg('m2', 'ai', '二', 'm1'),
        msg('m3', 'user', '三', 'm1'),
        msg('m4', 'ai', '四', 'm3'),
      ],
      activeMessageId: 'm4',
      organizeCursor: 'm1',
    });
    setApiForTest(makeApi({ state: { get: vi.fn(async () => project) } }));
    await store.openProject('/proj');
    expect(store.unorganizedCount()).toBe(2); // m3, m4
  });

  it('subtreeIds 展开子树（含自身）', async () => {
    setApiForTest(makeApi({ state: { get: vi.fn(async () => makeProject()) } }));
    await store.openProject('/proj');
    expect(store.subtreeIds('v1')).toEqual(['v1', 'c1', 'c2']);
    expect(store.subtreeIds('c1')).toEqual(['c1']);
  });
});

describe('store — run 流式事件', () => {
  it('applyRunEvent：chunk/trace 累积，done 后刷新状态并切到摘要', async () => {
    const project = makeProject({ runSummaries: [{ runId: 'run_1', taskKind: 'organize', snapshotId: 'run_1', scope: '未整理', changes: [], createdAt: 't' }] });
    const stateGet = vi.fn(async () => project);
    setApiForTest(makeApi({ state: { get: stateGet } }));
    await store.openProject('/proj');

    await store.startRun('organize', {});
    expect(store.getState().activeRun?.status).toBe('running');

    store.applyRunEvent({ runId: 'run_1', type: 'chunk', text: '正在整理…' } as RunStreamEvent);
    const trace: ToolCallTrace = { toolName: 'create_node', args: {}, status: 'completed', timestamp: 't' };
    store.applyRunEvent({ runId: 'run_1', type: 'trace', trace } as RunStreamEvent);
    expect(store.getState().activeRun?.chunks).toEqual(['正在整理…']);
    expect(store.getState().activeRun?.traces).toHaveLength(1);

    await store.applyRunEvent({
      runId: 'run_1',
      type: 'done',
      result: { runId: 'run_1', taskKind: 'organize', finalAnswer: 'ok', turns: 1, toolCallCount: 1, snapshotId: 'run_1', changes: [], cancelled: false },
    } as RunStreamEvent);
    // 异步刷新完成：organize 完成不再强切右栏模式（ux-review §4.3，P0-3）
    await vi.waitFor(() => expect(store.getState().activeRun?.status).toBe('done'));
    expect(store.getState().workspaceMode).toBeNull();
  });

  it('error 事件：标记失败并显示 toast', async () => {
    setApiForTest(makeApi());
    await store.openProject('/proj');
    await store.startRun('organize', {});
    store.applyRunEvent({ runId: 'run_1', type: 'error', message: '没有未整理的内容' } as RunStreamEvent);
    await vi.waitFor(() => expect(store.getState().activeRun?.status).toBe('error'));
  });

  it('done 事件带 result.error：同样提示（不静默，API 失败可见）', async () => {
    setApiForTest(makeApi());
    await store.openProject('/proj');
    await store.startRun('chat', {});
    store.applyRunEvent({
      runId: 'run_1',
      type: 'done',
      result: { runId: 'run_1', taskKind: 'chat', finalAnswer: '', turns: 1, toolCallCount: 0, changes: [], cancelled: false, error: 'MODEL_ERROR: DeepSeek API error (401)' },
    } as RunStreamEvent);
    await vi.waitFor(() => expect(store.getState().toast?.message).toContain('DeepSeek API error'));
    expect(store.getState().toast?.kind).toBe('error');
  });

  it('忽略非当前 runId 的事件', async () => {
    setApiForTest(makeApi());
    await store.openProject('/proj');
    await store.startRun('chat', {});
    store.applyRunEvent({ runId: 'other_run', type: 'chunk', text: 'x' } as RunStreamEvent);
    expect(store.getState().activeRun?.chunks).toEqual([]);
  });
});

describe('store — 对话操作', () => {
  it('sendAndRun：清空输入、落消息、启动 chat run', async () => {
    const send = vi.fn(async () => makeProject({ activeMessageId: 'm_new' }));
    const start = vi.fn(async () => ({ runId: 'run_x' }));
    setApiForTest(makeApi({ conversation: { ...makeApi().conversation, send }, run: { ...makeApi().run, start } }));
    await store.openProject('/proj');
    store.setInputText('你好');
    await store.sendAndRun('你好');
    expect(send).toHaveBeenCalledWith('你好');
    expect(store.getState().inputText).toBe('');
    expect(start).toHaveBeenCalledWith({ kind: 'chat', parentMessageId: 'm_new' });
  });

  it('刷新消息：启动 refresh run 并显示流式指示', async () => {
    const refresh = vi.fn(async () => ({ runId: 'rf_1' }));
    setApiForTest(makeApi({ run: { ...makeApi().run, refresh } }));
    await store.openProject('/proj');
    await store.refreshMessage('m2');
    expect(refresh).toHaveBeenCalledWith('m2');
    expect(store.getState().activeRun?.kind).toBe('chat');
  });

  it('detailFill：启动正文生成 run（kind=detail_fill）', async () => {
    const detailFill = vi.fn(async () => ({ runId: 'df_1' }));
    setApiForTest(makeApi({ run: { ...makeApi().run, detailFill } }));
    await store.openProject('/proj');
    await store.detailFill('s1', 'novel', '反馈意见');
    expect(detailFill).toHaveBeenCalledWith('s1', 'novel', '反馈意见');
    expect(store.getState().activeRun?.kind).toBe('detail_fill');
  });

  it('可见视图操作：生成后 adopt 新 state', async () => {
    const project = makeProject();
    const generate = vi.fn(async () => project);
    setApiForTest(makeApi({ visibleView: { ...makeApi().visibleView, generate } }));
    await store.openProject('/proj');
    await store.generateVisibleView('s1');
    expect(generate).toHaveBeenCalledWith('s1');
    expect(store.getState().project).toBe(project);
  });

  it('moveNode：调用 API 并 adopt 新 state（§3.1 拖拽重排）', async () => {
    const project = makeProject();
    const moveNode = vi.fn(async () => project);
    setApiForTest(makeApi({ outline: { ...makeApi().outline, moveNode } }));
    await store.openProject('/proj');
    await store.moveNode('c1', 'v1', 0);
    expect(moveNode).toHaveBeenCalledWith('c1', 'v1', 0);
    expect(store.getState().project).toBe(project);
  });

  it('大纲树展开状态：默认展开，toggle 后收起（切 tab 不丢）', async () => {
    setApiForTest(makeApi());
    await store.openProject('/proj');
    // 默认展开（store 记录的是「收起」集合）
    expect(store.getState().expandedIds.has('v1')).toBe(false);
    store.toggleExpanded('v1');
    expect(store.getState().expandedIds.has('v1')).toBe(true);
    store.toggleExpanded('v1');
    expect(store.getState().expandedIds.has('v1')).toBe(false);
  });
});
