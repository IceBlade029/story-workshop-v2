/**
 * store.test.ts — 渲染层 store 逻辑测试（jsdom）。
 * 用 mock api 验证：活动路径派生、未整理计数、流式事件应用、
 * 子树展开、run 完成后的模式切换。
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { store, registerEditorGuard } from '../store';
import { setApiForTest } from '../api';
import { confirmDiscardDialog } from '../components/ui/dialog';
import type { RendererApi, ProjectState, RunStreamEvent } from '../../shared/ipc-types';
import type { ChatMessage, ToolCallTrace } from '../../shared/types';

// 未保存保护测试需要可控的三选一确认；其余测试不渲染 DialogHost，mock 安全
vi.mock('../components/ui/dialog', () => ({
  confirmDialog: vi.fn(async () => true),
  confirmDiscardDialog: vi.fn(async () => 'discard'),
  promptDialog: vi.fn(async () => null),
}));

const mockDiscard = confirmDiscardDialog as unknown as ReturnType<typeof vi.fn>;

// 非 jsdom 环境：折叠状态持久化（§6.12）需要 localStorage → 提供内存 stub
const lsData: Record<string, string> = {};
beforeAll(() => {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => lsData[k] ?? null,
    setItem: (k: string, v: string) => { lsData[k] = v; },
    removeItem: (k: string) => { delete lsData[k]; },
    clear: () => { for (const k of Object.keys(lsData)) delete lsData[k]; },
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

function msg(id: string, role: ChatMessage['role'], content: string, parentId?: string): ChatMessage {
  return { id, role, content, timestamp: 't', parentId };
}

function makeProject(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    dir: '/proj',
    name: '测试',
    outline: null,
    nodes: [
      { id: 'v1', type: 'volume', title: '第一卷', parentId: null, depth: 0, hasDraft: true, hasOfficial: false, outputFormats: [], outputStale: [] },
      { id: 'c1', type: 'chapter', title: '第一章', parentId: 'v1', depth: 1, hasDraft: false, hasOfficial: false, outputFormats: [], outputStale: [] },
      { id: 'c2', type: 'chapter', title: '第二章', parentId: 'v1', depth: 1, hasDraft: true, hasOfficial: false, outputFormats: [], outputStale: [] },
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
    settings: { model: 'deepseek-v4-flash', thinking: true, reasoningEffort: 'high', notifications: true, theme: 'system', outputStyle: 'deepseek', maxOutputTokens: 16384, projectsDir: '' },
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
      delete: vi.fn(async () => {}),
      showInFolder: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
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
      pickFiles: vi.fn(async () => [{ name: 'a.txt', content: '内容' }]),
      scanWorkspace: vi.fn(async () => []),
      readWorkspace: vi.fn(async () => ({ name: 'a.txt', content: '内容' })),
      readContent: vi.fn(async () => ({ name: 'a.txt', content: '内容' })),
      delete: vi.fn(async () => project),
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
      sendWithAttachments: vi.fn(async () => project),
      newTopic: vi.fn(async () => project),
      switchSession: vi.fn(async () => project),
      archiveSession: vi.fn(async () => project),
      unarchiveSession: vi.fn(async () => project),
      deleteSession: vi.fn(async () => project),
      switchBranch: vi.fn(async () => project),
      edit: vi.fn(async () => project),
    },
    context: {
      inspect: vi.fn(async () => ({ messageCount: 2, budgetTokens: 900000, usedTokens: 202300, estimatedTokens: 202300, measurement: 'estimated' as const, compressed: false, keptRawCount: 2, blocked: false })),
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
    settings: {
      setKey: vi.fn(async () => project),
      get: vi.fn(async () => project.settings),
      update: vi.fn(async () => project),
      pickProjectsDir: vi.fn(async () => null),
      setProjectsDir: vi.fn(async () => ({ movedCount: 0, reopened: false })),
    },
  };
  return { ...stub, ...overrides } as RendererApi;
}

beforeEach(() => {
  // 重置 store 内部状态：通过重新导入模块不可行（单例），用 actions 清理
  setApiForTest(makeApi());
  mockDiscard.mockClear();
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

  it('organize 成功（Part 4）：结果进瞬态卡片 lastOrganize，不写日志；dismissOrganize 清除', async () => {
    setApiForTest(makeApi());
    await store.openProject('/proj');
    await store.startRun('organize', { scope: { type: 'unorganized' } });
    store.applyRunEvent({
      runId: 'run_1',
      type: 'done',
      result: { runId: 'run_1', taskKind: 'organize', finalAnswer: '已整理：1 卷 + 15 设定。', turns: 3, toolCallCount: 5, changes: [], cancelled: false },
    } as RunStreamEvent);
    expect(store.getState().lastOrganize).toEqual({ runId: 'run_1', finalAnswer: '已整理：1 卷 + 15 设定。' });
    store.dismissOrganize();
    expect(store.getState().lastOrganize).toBeNull();
  });

  it('organize 失败（P1 修复）：进失败卡片（failed + 错误原因），可查看部分写入并回滚', async () => {
    setApiForTest(makeApi());
    await store.openProject('/proj');
    await store.startRun('organize', { scope: { type: 'unorganized' } });
    store.applyRunEvent({
      runId: 'run_1',
      type: 'done',
      result: { runId: 'run_1', taskKind: 'organize', finalAnswer: '', turns: 1, toolCallCount: 0, changes: [], cancelled: false, error: 'ORGANIZE_NO_WRITE_TOOL: 整理任务未调用任何写入工具' },
    } as RunStreamEvent);
    expect(store.getState().lastOrganize).toEqual({
      runId: 'run_1',
      finalAnswer: '',
      failed: true,
      error: 'ORGANIZE_NO_WRITE_TOOL: 整理任务未调用任何写入工具',
    });
    await vi.waitFor(() => expect(store.getState().activeRun?.status).toBe('done'));
  });

  it('organize 取消（P1 修复）：进失败卡片（已取消 + 部分写入提示）', async () => {
    setApiForTest(makeApi());
    await store.openProject('/proj');
    await store.startRun('organize', { scope: { type: 'unorganized' } });
    store.applyRunEvent({
      runId: 'run_1',
      type: 'done',
      result: { runId: 'run_1', taskKind: 'organize', finalAnswer: '', turns: 2, toolCallCount: 2, changes: [], cancelled: true },
    } as RunStreamEvent);
    expect(store.getState().lastOrganize).toMatchObject({ runId: 'run_1', failed: true });
    expect(store.getState().lastOrganize?.error).toContain('已取消');
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
    expect(start).toHaveBeenCalledWith({ kind: 'chat', parentMessageId: 'm_new', answerDetail: 'auto' });
  });

  it('刷新消息：启动 refresh run 并显示流式指示', async () => {
    store.reset();
    const refresh = vi.fn(async () => ({ runId: 'rf_1' }));
    setApiForTest(makeApi({ run: { ...makeApi().run, refresh } }));
    await store.openProject('/proj');
    await store.refreshMessage('m2');
    expect(refresh).toHaveBeenCalledWith('m2', 'auto');
    expect(store.getState().activeRun?.kind).toBe('chat');
  });

  it('编辑消息（DeepSeek 式）：提交新版本并自动启动 chat run（重新发送）', async () => {
    store.reset();
    const edited = makeProject({
      messages: [
        msg('m1', 'user', '旧问题'),
        msg('m2', 'ai', '回答', 'm1'),
        { ...msg('m3', 'user', '新问题', 'm1'), timestamp: 't', supersedesId: 'm1' },
      ],
      activeMessageId: 'm3',
    });
    const edit = vi.fn(async () => edited);
    const start = vi.fn(async () => ({ runId: 'run_x' }));
    setApiForTest(makeApi({ conversation: { ...makeApi().conversation, edit }, run: { ...makeApi().run, start } }));
    await store.openProject('/proj');
    await store.editMessage('m1', '新问题');
    expect(edit).toHaveBeenCalledWith('m1', '新问题');
    // 自动重新发送：run 以取代消息（新版本）为父节点，续写从它开始
    expect(start).toHaveBeenCalledWith({ kind: 'chat', parentMessageId: 'm3', answerDetail: 'auto' });
    expect(store.getState().activeRun?.status).toBe('running');
  });

  it('运行中编辑被拒绝（防止并发 run）', async () => {
    store.reset();
    setApiForTest(makeApi());
    await store.openProject('/proj');
    await store.startRun('chat', {});
    await expect(store.editMessage('m1', 'x')).rejects.toThrow('RUN_IN_PROGRESS');
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

describe('store — 待发送附件（Part 3，ChatGPT 式）', () => {  it('stageAttachment 入暂存区（不调 API）；removePendingAttachment 移除', () => {
    setApiForTest(makeApi());
    store.stageAttachment('大纲.md', '第一章内容', 'uploaded');
    expect(store.getState().pendingAttachments).toHaveLength(1);
    expect(store.getState().pendingAttachments[0]).toMatchObject({ name: '大纲.md', content: '第一章内容', source: 'uploaded' });
    const key = store.getState().pendingAttachments[0].key;
    store.removePendingAttachment(key);
    expect(store.getState().pendingAttachments).toHaveLength(0);
  });

  it('sendWithPending：文本 + 待发送附件一次提交，清空暂存并启动 run', async () => {
    const sendWithAttachments = vi.fn(async () => makeProject({ activeMessageId: 'm_new' }));
    const start = vi.fn(async () => ({ runId: 'run_x' }));
    setApiForTest(makeApi({ conversation: { ...makeApi().conversation, sendWithAttachments }, run: { ...makeApi().run, start } }));
    await store.openProject('/proj');
    store.setInputText('帮我看看');
    store.stageAttachment('旧大纲.txt', '第一章内容', 'uploaded');
    await store.sendWithPending('帮我看看');
    expect(sendWithAttachments).toHaveBeenCalledWith('帮我看看', [{ name: '旧大纲.txt', content: '第一章内容', source: 'uploaded' }]);
    expect(store.getState().inputText).toBe('');
    expect(store.getState().pendingAttachments).toHaveLength(0);
    expect(start).toHaveBeenCalledWith({ kind: 'chat', parentMessageId: 'm_new', answerDetail: 'auto' });
  });

  it('sendWithPending：空文本但有附件也可发送；无文本无附件则跳过', async () => {
    const sendWithAttachments = vi.fn(async () => makeProject({ activeMessageId: 'm_new' }));
    const start = vi.fn(async () => ({ runId: 'run_x' }));
    const api = makeApi({ conversation: { ...makeApi().conversation, sendWithAttachments }, run: { ...makeApi().run, start } });
    setApiForTest(api);
    await store.openProject('/proj');
    // 无文本无附件 → 不调 API
    await store.sendWithPending('');
    expect(sendWithAttachments).not.toHaveBeenCalled();
    // 仅有附件
    store.stageAttachment('旧大纲.txt', '第一章内容', 'uploaded');
    await store.sendWithPending('');
    expect(sendWithAttachments).toHaveBeenCalledWith('', [{ name: '旧大纲.txt', content: '第一章内容', source: 'uploaded' }]);
  });

  it('sendWithPending：长文本自动转为 pasted 附件', async () => {
    const sendWithAttachments = vi.fn(async () => makeProject({ activeMessageId: 'm_new' }));
    setApiForTest(makeApi({ conversation: { ...makeApi().conversation, sendWithAttachments } }));
    await store.openProject('/proj');
    const longText = '长'.repeat(2001);
    await store.sendWithPending(longText);
    const calls = sendWithAttachments.mock.calls as unknown as [string, Array<{ name: string; content: string; source: string }>][];
    const attachments = calls[0][1];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ name: '长'.repeat(30), content: longText, source: 'pasted' });
  });

  it('pickFiles：预读文件入暂存区并返回数量', async () => {
    setApiForTest(makeApi({ attachment: { ...makeApi().attachment, pickFiles: vi.fn(async () => [{ name: 'a.md', content: 'A' }, { name: 'b.md', content: 'B' }]) } }));
    await store.openProject('/proj');
    const n = await store.pickFiles();
    expect(n).toBe(2);
    expect(store.getState().pendingAttachments.map((a) => a.name)).toEqual(['a.md', 'b.md']);
  });

  it('deleteAttachment：调用 API 删除并 adopt 新 state', async () => {
    const project = makeProject();
    const del = vi.fn(async () => project);
    setApiForTest(makeApi({ attachment: { ...makeApi().attachment, delete: del } }));
    await store.openProject('/proj');
    await store.deleteAttachment('att_1');
    expect(del).toHaveBeenCalledWith('att_1');
    expect(store.getState().project).toBe(project);
  });
});

describe('store — 项目删除（项目级，移到系统回收站）', () => {
  it('删除非打开项目：调用 API 并刷新项目列表，停留在当前项目', async () => {
    store.reset();
    const del = vi.fn(async () => {});
    const list = vi.fn(async () => [{ dir: '/other', name: '别的项目', createdAt: 't' }]);
    setApiForTest(makeApi({ project: { ...makeApi().project, delete: del, list } }));
    await store.openProject('/proj');
    await store.deleteProject('/other');
    expect(del).toHaveBeenCalledWith('/other');
    expect(list).toHaveBeenCalled();
    // 当前打开项目不受影响
    expect(store.getState().project?.dir).toBe('/proj');
  });

  it('删除当前打开项目：调用 API、回到项目列表并刷新', async () => {
    store.reset();
    const del = vi.fn(async () => {});
    const list = vi.fn(async () => []);
    setApiForTest(makeApi({ project: { ...makeApi().project, delete: del, list } }));
    await store.openProject('/proj');
    store.setInputText('草稿');
    store.stageAttachment('a.txt', '内容', 'uploaded');
    await store.deleteProject('/proj');
    expect(del).toHaveBeenCalledWith('/proj');
    expect(store.getState().project).toBeNull();
    expect(store.getState().inputText).toBe('');
    expect(store.getState().pendingAttachments).toHaveLength(0);
    expect(list).toHaveBeenCalled();
  });
});

describe('store — 项目切换（§6.10）', () => {
  it('backToProjects：清空项目态并刷新列表', async () => {
    store.reset();
    const list = vi.fn(async () => [{ dir: '/proj', name: '测试', createdAt: 't' }]);
    setApiForTest(makeApi({ project: { ...makeApi().project, list } }));
    await store.openProject('/proj');
    store.setWritingScene('s1');
    await store.backToProjects();
    expect(store.getState().project).toBeNull();
    expect(store.getState().writingSceneId).toBeNull();
    expect(store.getState().selected).toBeNull();
    expect(list).toHaveBeenCalled();
  });

  it('renameProject：调用 API 并刷新状态名称', async () => {
    const project = makeProject({ name: '新名' });
    const stateGet = vi.fn(async () => project);
    setApiForTest(makeApi({ state: { get: stateGet } }));
    await store.openProject('/proj');
    await store.renameProject('新名');
    expect(store.getState().project?.name).toBe('新名');
  });
});

describe('store — 折叠与专注模式（§6.12）', () => {
  it('左右栏/场景树独立 toggle；专注一键全折全展', () => {
    store.reset();
    store.toggleLeftPanel();
    expect(store.getState().leftCollapsed).toBe(true);
    expect(store.getState().rightCollapsed).toBe(false);
    store.toggleRightPanel();
    store.toggleScenes();
    expect(store.getState().rightCollapsed).toBe(true);
    expect(store.getState().scenesCollapsed).toBe(true);
    // 专注 = 三栏全折叠
    store.reset();
    store.toggleFocus();
    expect(store.getState().leftCollapsed).toBe(true);
    expect(store.getState().rightCollapsed).toBe(true);
    expect(store.getState().scenesCollapsed).toBe(true);
    // 再点一次全展开
    store.toggleFocus();
    expect(store.getState().leftCollapsed).toBe(false);
    expect(store.getState().rightCollapsed).toBe(false);
    expect(store.getState().scenesCollapsed).toBe(false);
  });

  it('折叠状态持久化到 localStorage 并可恢复', () => {
    store.reset();
    store.toggleLeftPanel();
    store.toggleScenes();
    const saved = JSON.parse(localStorage.getItem('sw2:collapsed') ?? '{}') as Record<string, boolean>;
    expect(saved).toEqual({ left: true, right: false, scenes: true });
    // 模拟重启：新 store 实例通过 initCollapsed 恢复
    store.reset();
    expect(store.getState().leftCollapsed).toBe(false);
    store.initCollapsed();
    expect(store.getState().leftCollapsed).toBe(true);
    expect(store.getState().scenesCollapsed).toBe(true);
  });
});

describe('store — 未保存保护（ux-review §6.8）', () => {
  it('脏编辑器 + 取消 → 不切换', async () => {
    await store.openProject('/proj');
    await store.selectNode('v1');
    const unreg = registerEditorGuard({ key: 'draft:v1', isDirty: () => true, save: async () => true });
    mockDiscard.mockResolvedValueOnce('cancel');
    await store.selectNode('c2');
    expect(store.getState().selected?.id).toBe('v1');
    unreg();
  });

  it('保存并继续 → 调用 save 后切换', async () => {
    await store.openProject('/proj');
    await store.selectNode('v1');
    const saveFn = vi.fn(async () => true);
    const unreg = registerEditorGuard({ key: 'draft:v1', isDirty: () => true, save: saveFn });
    mockDiscard.mockResolvedValueOnce('save');
    await store.selectNode('c2');
    expect(saveFn).toHaveBeenCalled();
    expect(store.getState().selected).toEqual({ kind: 'node', id: 'c2' });
    unreg();
  });

  it('放弃修改 → 不保存直接切换', async () => {
    await store.openProject('/proj');
    await store.selectNode('v1');
    const saveFn = vi.fn(async () => true);
    const unreg = registerEditorGuard({ key: 'draft:v1', isDirty: () => true, save: saveFn });
    mockDiscard.mockResolvedValueOnce('discard');
    await store.selectNode('c2');
    expect(saveFn).not.toHaveBeenCalled();
    expect(store.getState().selected?.id).toBe('c2');
    unreg();
  });

  it('保存失败 → 不导航（保留本地内容重试）', async () => {
    await store.openProject('/proj');
    await store.selectNode('v1');
    const unreg = registerEditorGuard({ key: 'draft:v1', isDirty: () => true, save: async () => false });
    mockDiscard.mockResolvedValueOnce('save');
    await store.selectNode('c2');
    expect(store.getState().selected?.id).toBe('v1');
    unreg();
  });

  it('不脏的编辑器不拦截', async () => {
    await store.openProject('/proj');
    await store.selectNode('v1');
    const unreg = registerEditorGuard({ key: 'draft:v1', isDirty: () => false, save: async () => true });
    await store.selectNode('c2');
    expect(store.getState().selected?.id).toBe('c2');
    unreg();
  });

  it('key 不匹配不拦截（切设定不影响草稿）', async () => {
    await store.openProject('/proj');
    await store.selectNode('v1');
    const unreg = registerEditorGuard({ key: 'draft:v1', isDirty: () => true, save: async () => true });
    await store.selectAsset('a1');
    await store.selectAsset('a2');
    expect(store.getState().selected?.id).toBe('a2');
    expect(mockDiscard).not.toHaveBeenCalled();
    unreg();
  });

  it('setWritingScene：输出/视图守卫拦截；确认后切换', async () => {
    await store.openProject('/proj');
    store.setWritingScene('s1');
    const unreg = registerEditorGuard({ key: 'output:s1:novel', isDirty: () => true, save: async () => true });
    mockDiscard.mockResolvedValueOnce('discard');
    await store.setWritingScene('s2');
    expect(store.getState().writingSceneId).toBe('s2');
    unreg();
  });

  it('hasDirtyEditors：关窗检查（脏=true；清除/不脏=false）', async () => {
    const unreg = registerEditorGuard({ key: 'draft:v1', isDirty: () => true, save: async () => true });
    expect(store.hasDirtyEditors()).toBe(true);
    unreg();
    expect(store.hasDirtyEditors()).toBe(false);
    const clean = registerEditorGuard({ key: 'draft:v1', isDirty: () => false, save: async () => true });
    expect(store.hasDirtyEditors()).toBe(false);
    clean();
  });
});
