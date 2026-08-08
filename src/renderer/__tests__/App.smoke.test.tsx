/**
 * App 冒烟测试 — 用 jsdom + mock api 渲染完整 App。
 *
 * 目的：捕获「创建项目后白屏」类回归（useSyncExternalStore 快照不稳定、
 * 组件渲染抛错等）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { store } from '../store';
import { setApiForTest } from '../api';
import { App } from '../App';
import type { RendererApi, ProjectState } from '../../shared/ipc-types';
import type { ChatMessage } from '../../shared/types';

function msg(id: string, role: ChatMessage['role'], content: string, parentId?: string): ChatMessage {
  return { id, role, content, timestamp: 't', parentId };
}

function makeProjectState(): ProjectState {
  return {
    dir: '/proj',
    name: '测试项目',
    outline: null,
    nodes: [
      { id: 'overview', type: 'overview', title: '总纲', parentId: null, depth: 0, hasDraft: false, hasOfficial: false, outputFormats: [], outputStale: [] },
      { id: 'v1', type: 'volume', title: '第一卷', parentId: 'overview', depth: 1, hasDraft: true, hasOfficial: false, aiCreated: true, outputFormats: [], outputStale: [] },
      { id: 's1', type: 'scene', title: '第一场', parentId: 'v1', depth: 2, hasDraft: true, hasOfficial: false, outputFormats: [], outputStale: [] },
    ],
    assets: [],
    attachments: [],
    messages: [
      msg('m1', 'user', '主角是侦探'),
      msg('rs', 'system', '运行开始（chat）', 'm1'),
      msg('m2', 'ai', '明白。', 'rs'),
    ],
    sessions: [{ id: 'sess1', title: '话题 1', tailMessageId: 'm2', rootMessageId: 'm1', archivedAt: 't' }],
    activeSessionId: 'sess1',
    activeMessageId: 'm2',
    runSummaries: [],
    hasApiKey: false,
    trash: [],
    settings: { model: 'deepseek-v4-flash', thinking: true, reasoningEffort: 'high', notifications: true, theme: 'system', outputStyle: 'deepseek', maxOutputTokens: 16384 },
  };
}

function makeApi(): RendererApi {
  const project = makeProjectState();
  return {
    app: { getVersion: vi.fn(async () => '0.1.0') },
    project: {
      list: vi.fn(async () => [{ dir: '/proj', name: '测试项目', createdAt: 't' }]),
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
      readContent: vi.fn(async () => ({ id: 's1', title: '第一场', type: 'scene' as const, official: null, draft: '细纲草稿' })),
    },
    asset: {
      create: vi.fn(async () => project),
      update: vi.fn(async () => project),
      delete: vi.fn(async () => project),
    },
    attachment: {
      pickFiles: vi.fn(async () => [{ name: '旧大纲.txt', content: '大纲内容' }]),
      scanWorkspace: vi.fn(async () => [{ name: '旧大纲.txt', size: 10 }]),
      readWorkspace: vi.fn(async () => ({ name: '旧大纲.txt', content: '大纲内容' })),
      readContent: vi.fn(async () => ({ name: '旧大纲.txt', content: '大纲内容' })),
      delete: vi.fn(async () => project),
    },
    visibleView: {
      read: vi.fn(async () => null),
      generate: vi.fn(async () => project),
      save: vi.fn(async () => project),
    },
    output: {
      formats: vi.fn(async () => ['novel', 'script']),
      list: vi.fn(async () => []),
      read: vi.fn(async () => '正文内容'),
      save: vi.fn(async () => project),
      versions: vi.fn(async () => []),
      readVersion: vi.fn(async () => ''),
      export: vi.fn(async () => ({ saved: false, canceled: true, missing: [] })),
      applyRevise: vi.fn(async () => project),
      undoRevise: vi.fn(async () => project),
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
      inspect: vi.fn(async () => ({ messageCount: 2, budgetTokens: 30000, estimatedTokens: 50, compressed: false, keptRawCount: 2, blocked: false })),
      recompress: vi.fn(async () => project),
    },
    search: {
      global: vi.fn(async (_query: string) => []),
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
      revise: vi.fn(async () => ({ runId: 'run_4' })),
      inspect: vi.fn(async () => null),
      list: vi.fn(async () => []),
      diff: vi.fn(async () => []),
      accept: vi.fn(async () => project),
      rollback: vi.fn(async () => project),
    },
    settings: {
      setKey: vi.fn(async () => project),
      get: vi.fn(async () => project.settings),
      update: vi.fn(async () => project),
    },
  };
}

async function renderApp(): Promise<void> {
  render(<App />);
  await act(async () => {});
}

/**
 * 有状态的会话 mock（ux-review §4.5 ChatGPT 式）：模拟主进程的
 * newTopic / switchSession / archive / unarchive / delete 语义，
 * 用于验证「新话题不归档、旧话题可切回继续聊、归档只读、删除剔除」。
 */
function makeStatefulApi(): RendererApi {
  const base = makeApi();
  let messages: ChatMessage[] = [msg('m1', 'user', '话题一：主角是侦探'), msg('m2', 'ai', '明白。', 'm1')];
  let sessions: Array<import('../../shared/types').ConversationSession> = [
    { id: 'sess1', title: '话题 1', rootMessageId: 'm1', tailMessageId: 'm2', archivedAt: 't' },
  ];
  let activeSessionId = 'sess1';
  let activeMessageId: string | undefined = 'm2';
  let seq = 100;
  const state = (): ProjectState => {
    const p = makeProjectState();
    return { ...p, messages: [...messages], sessions: [...sessions], activeSessionId, activeMessageId };
  };
  const conversation = {
    ...base.conversation,
    send: vi.fn(async (content: string) => {
      const id = `m${seq++}`;
      const parent = messages.find((m) => m.id === activeMessageId);
      messages = [...messages, msg(id, 'user', content, parent ? parent.id : undefined)];
      activeMessageId = id;
      sessions = sessions.map((s) => (s.id === activeSessionId ? { ...s, tailMessageId: id, rootMessageId: s.rootMessageId ?? id } : s));
      return state();
    }),
    sendWithAttachments: vi.fn(async (content: string, attachments: Array<{ name: string; content: string }>) => {
      let parent = messages.find((m) => m.id === activeMessageId);
      for (const a of attachments) {
        const id = `m${seq++}`;
        messages = [...messages, { ...msg(id, 'user', `（附件：${a.name}）`, parent ? parent.id : undefined), refs: { attachmentIds: [`att-${id}`] } }];
        parent = messages.at(-1);
      }
      if (content.trim() !== '') {
        const id = `m${seq++}`;
        messages = [...messages, msg(id, 'user', content, parent ? parent.id : undefined)];
        parent = messages.at(-1);
      }
      activeMessageId = parent?.id;
      sessions = sessions.map((s) => (s.id === activeSessionId ? { ...s, tailMessageId: parent?.id, rootMessageId: s.rootMessageId ?? parent?.id } : s));
      return state();
    }),
    newTopic: vi.fn(async () => {
      const sid = `sess${seq++}`;
      sessions = [...sessions, { id: sid, title: `话题 ${sessions.length + 1}`, archivedAt: 't' }];
      activeSessionId = sid;
      activeMessageId = undefined;
      return state();
    }),
    switchSession: vi.fn(async (sid: string) => {
      const s = sessions.find((x) => x.id === sid);
      activeSessionId = sid;
      activeMessageId = s?.tailMessageId;
      return state();
    }),
    archiveSession: vi.fn(async (sid: string) => {
      sessions = sessions.map((s) => (s.id === sid ? { ...s, archived: true } : s));
      return state();
    }),
    unarchiveSession: vi.fn(async (sid: string) => {
      sessions = sessions.map((s) => (s.id === sid ? { ...s, archived: false } : s));
      return state();
    }),
    deleteSession: vi.fn(async (sid: string) => {
      const removed = new Set<string>();
      const s = sessions.find((x) => x.id === sid);
      const collect = (root?: string): void => {
        if (!root || removed.has(root)) return;
        removed.add(root);
        for (const m of messages) if (m.parentId === root) collect(m.id);
      };
      collect(s?.rootMessageId);
      messages = messages.filter((m) => !removed.has(m.id));
      sessions = sessions.filter((x) => x.id !== sid);
      if (activeSessionId === sid) {
        const first = sessions.find((x) => x.archived !== true) ?? sessions[0];
        activeSessionId = first?.id;
        activeMessageId = first?.tailMessageId;
      }
      return state();
    }),
  };
  return {
    ...base,
    project: { ...base.project, create: vi.fn(async () => state()), open: vi.fn(async () => state()) },
    conversation,
    state: { get: vi.fn(async () => state()) },
  };
}

beforeEach(() => {
  setApiForTest(makeApi());
  store.reset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('App 冒烟 — 创建项目后布局完整显示（防白屏回归）', () => {
  it('项目删除（项目级）：列表行 🗑 → 确认 → 调 project.delete 并回到项目列表', async () => {
    const api = makeApi();
    const projects: Array<{ dir: string; name: string; createdAt: string }> = [{ dir: '/proj', name: '测试项目', createdAt: 't' }];
    const del = vi.fn(async () => { projects.length = 0; }); // 删除后刷新列表为空
    api.project.delete = del;
    api.project.list = vi.fn(async () => [...projects]);
    setApiForTest(api);
    store.reset();
    await renderApp();
    // 项目屏：列表行有删除按钮
    expect(screen.getByText('测试项目')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTitle('删除项目（移到系统回收站，可恢复）'));
      await new Promise((r) => setTimeout(r, 0));
    });
    // 确认弹窗（danger）
    expect(screen.getByText(/删除项目「测试项目」/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('移到回收站'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(del).toHaveBeenCalledWith('/proj');
    // 列表已刷新（删除后为空）
    expect(screen.queryByText('测试项目')).toBeNull();
  });
  it('项目屏幕渲染，创建项目后讨论模块完整显示', async () => {
    await renderApp();
    // 项目屏幕
    expect(screen.getByPlaceholderText('项目名称')).toBeTruthy();

    // 创建项目
    fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: '我的故事' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-create'));
      await new Promise((r) => setTimeout(r, 0));
    });

    // 顶部栏（项目名 + 两个模块 tab + 设置齿轮） + 左栏大纲树 + 对话 + 输入框 + 整理按钮
    expect(screen.getAllByText('测试项目').length).toBeGreaterThan(0);
    expect(screen.getByText('情节讨论')).toBeTruthy();
    expect(screen.getByText('正文写作')).toBeTruthy();
    expect(screen.getAllByText('总纲').length).toBeGreaterThan(0);
    expect(screen.getAllByText('第一卷').length).toBeGreaterThan(0);
    expect(screen.getByText('主角是侦探')).toBeTruthy();
    expect(screen.getByText('明白。')).toBeTruthy();
    expect(screen.getByTestId('chat-input')).toBeTruthy();
    expect(screen.getAllByText(/整理/).length).toBeGreaterThan(0);
    // 会话（ux-review §4.5）：header 显示当前话题 + 新话题/归档按钮；输入栏可用
    expect(screen.getByText('＋ 开启新话题')).toBeTruthy();
    expect(screen.getByText('归档当前话题')).toBeTruthy();
    expect(screen.getByTestId('chat-input')).toBeTruthy();
    // 用户反馈 8：运行开始/结束细条不再显示（记账 system 消息不渲染）
    expect(screen.queryByText(/运行开始（|运行结束（/)).toBeNull();
    // 用户反馈 9：AI 回答没有编辑按钮（仅用户消息可编辑）
    expect(screen.getAllByText('✎ 编辑')).toHaveLength(1);
  });

  it('对话发送后流式 chunk 渲染，无白屏', async () => {
    await renderApp();
    fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: '我的故事' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-create'));
      await new Promise((r) => setTimeout(r, 0));
    });

    // 输入并发送
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '再想想' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-send'));
      await new Promise((r) => setTimeout(r, 0));
    });
    // 运行中：显示正在生成指示
    expect(screen.getByText(/正在生成/)).toBeTruthy();

    // 模拟流式 chunk 事件
    await act(async () => {
      store.applyRunEvent({ runId: 'run_1', type: 'chunk', text: '好，' });
      store.applyRunEvent({ runId: 'run_1', type: 'chunk', text: '继续。' });
    });
    expect(screen.getByText(/好，继续/)).toBeTruthy();

    // 完成事件
    await act(async () => {
      store.applyRunEvent({
        runId: 'run_1',
        type: 'done',
        result: { runId: 'run_1', taskKind: 'chat', finalAnswer: '好，继续。', turns: 1, toolCallCount: 0, changes: [], cancelled: false },
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId('chat-input')).toBeTruthy();
  });

  it('场景节点：右栏收敛（无可见视图/正文 tab）；正文模块内闭环（ux-review §4.6、§5.1）', async () => {    await renderApp();
    fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: '我的故事' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-create'));
      await new Promise((r) => setTimeout(r, 0));
    });

    // 点选场景节点 → 右栏只有 草稿/正式版（可见视图、正文已归正文模块）
    fireEvent.click(screen.getAllByText('第一场')[0]);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.queryByText('保存手改')).toBeNull();

    // 顶部 tab 切到正文模块
    fireEvent.click(screen.getByText('正文写作'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // 场景树（正文模块内）选择场景 → 操作条 + 可见视图折叠区 + 正文工作区
    fireEvent.click(screen.getByTestId('writing-scene-s1'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByText('生成正文')).toBeTruthy();
    expect(screen.getAllByText(/可见视图/).length).toBeGreaterThan(0);
    expect(screen.getByText('生成可见视图')).toBeTruthy();
  });

  it('沙箱隔离：写作任务完成后讨论流零痕迹，正文模块出现 ⓘ 调用详情入口（ux-review §4.7、§5.2 修订）', async () => {
    await renderApp();
    fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: '我的故事' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-create'));
      await new Promise((r) => setTimeout(r, 0));
    });
    const messageCount = store.getState().activePath.length;

    // 正文模块选场景 → 模拟 detail_fill 完成（done 事件携带内部 runId）
    fireEvent.click(screen.getByText('正文写作'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    fireEvent.click(screen.getByTestId('writing-scene-s1'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => {
      await store.detailFill('s1', 'novel');
      store.applyRunEvent({
        runId: 'run_3',
        type: 'done',
        result: { runId: 'run_internal_1', taskKind: 'detail_fill', finalAnswer: 'ok', turns: 1, toolCallCount: 1, changes: [], cancelled: false },
      } as never);
      await new Promise((r) => setTimeout(r, 0));
    });

    // 正文模块：ⓘ 调用详情入口出现，点击打开弹窗
    expect(screen.getByText('ⓘ 调用详情')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('ⓘ 调用详情'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText('调用详情')).toBeTruthy();
    // 关闭弹窗
    await act(async () => {
      fireEvent.click(screen.getByText('关闭'));
      await new Promise((r) => setTimeout(r, 0));
    });

    // 切回讨论模块：消息流零痕迹（无总结文本、无运行提示、无「已生成 → 打开」）
    fireEvent.click(screen.getByRole('button', { name: '情节讨论' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(store.getState().activePath.length).toBe(messageCount);
    expect(screen.queryByText(/已生成 → 打开|运行开始（|运行结束（/)).toBeNull();
    expect(screen.queryByText(/已完成场景/)).toBeNull();
  });

  it('重新生成（DeepSeek 式）：按钮常驻最后一条 AI 回答下方；生成新版本后出现 ◀ ▶ 导航', async () => {
    const base = makeProjectState();
    const versioned = makeProjectState();
    versioned.messages = [
      msg('m1', 'user', '写个开头'),
      { ...msg('m2', 'ai', '回答 v1', 'm1'), timestamp: 't', supersededBy: 'm3', versionGroupId: 'm2', versionIndex: 1, versionCount: 2 },
      { ...msg('m3', 'ai', '回答 v2', 'm1'), timestamp: 't', supersedesId: 'm2', versionGroupId: 'm2', versionIndex: 2, versionCount: 2 },
    ];
    versioned.activeMessageId = 'm3';
    versioned.sessions = [{ id: 'sess1', title: '话题 1', tailMessageId: 'm3', rootMessageId: 'm1', archivedAt: 't' }];
    let refreshed = false;
    const api = makeApi();
    api.state.get = vi.fn(async () => (refreshed ? versioned : base));
    api.project.create = vi.fn(async () => base);
    api.project.open = vi.fn(async () => base);
    const refresh = vi.fn(async (messageId: string) => {
      expect(messageId).toBe('m2');
      refreshed = true;
      return { runId: 'run_rf' };
    });
    api.run.refresh = refresh;
    // ◀ 切回旧版本：返回 activeMessageId = m2 的状态
    api.conversation.switchBranch = vi.fn(async () => ({
      ...versioned,
      activeMessageId: 'm2',
      sessions: [{ ...versioned.sessions[0], tailMessageId: 'm2' }],
    }));
    setApiForTest(api);
    store.reset();
    await renderApp();
    fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: '我的故事' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-create'));
      await new Promise((r) => setTimeout(r, 0));
    });

    // 重新生成按钮常驻（不依赖 hover），点击 → refresh('m2')
    const regenBtn = screen.getByText('⟳ 重新生成');
    expect(regenBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(regenBtn);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(refresh).toHaveBeenCalledWith('m2', 'auto');
    // 就地替换（bug 修复）：旧回答立即被流式卡片替换，不再「先新增卡片、完成后才替换」
    expect(screen.queryByText('明白。')).toBeNull();
    expect(screen.getByText('重新生成中…')).toBeTruthy();
    expect(screen.queryByText('⟳ 重新生成')).toBeNull();
    // 流式增量直接在原位置渲染
    await act(async () => {
      store.applyRunEvent({ runId: 'run_rf', type: 'chunk', text: '回答 v2' });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText('回答 v2')).toBeTruthy();
    expect(screen.queryByText('明白。')).toBeNull();

    // 完成 → 状态刷新为新版本 → 头部出现 ◀ 2/2 ▶ 版本导航，重新生成仍在
    await act(async () => {
      store.applyRunEvent({
        runId: 'run_rf',
        type: 'done',
        result: { runId: 'run_rf', taskKind: 'chat', finalAnswer: '回答 v2', turns: 1, toolCallCount: 0, changes: [], cancelled: false },
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByText('2/2')).toBeTruthy();
    expect(screen.getByText('⟳ 重新生成')).toBeTruthy();
    // ◀ 切回旧版本
    await act(async () => {
      fireEvent.click(screen.getByTitle('上一个版本'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText('回答 v1')).toBeTruthy();
  });

  it('版本导航（DeepSeek 式 ◀ i/N ▶）：刷新后的消息显示 2/2，◀ 切换调用 switchBranch；「消息已编辑」事件隐藏', async () => {
    const versioned = makeProjectState();
    versioned.messages = [
      msg('m1', 'user', '写个开头'),
      { ...msg('m2', 'ai', '回答 v1', 'm1'), timestamp: 't', supersededBy: 'm3', versionGroupId: 'm2', versionIndex: 1, versionCount: 2 },
      { ...msg('m3', 'ai', '回答 v2', 'm1'), timestamp: 't', supersedesId: 'm2', versionGroupId: 'm2', versionIndex: 2, versionCount: 2 },
      { ...msg('evt', 'system', '（消息已编辑）原内容：旧文本', 'm3'), timestamp: 't' },
    ];
    versioned.sessions = [{ id: 'sess1', title: '话题 1', tailMessageId: 'm3', rootMessageId: 'm1', archivedAt: 't' }];
    versioned.activeMessageId = 'm3';
    const api = makeApi();
    api.state.get = vi.fn(async () => versioned);
    api.project.create = vi.fn(async () => versioned);
    api.project.open = vi.fn(async () => versioned);
    const switchBranch = vi.fn(async () => versioned);
    api.conversation.switchBranch = switchBranch;
    setApiForTest(api);
    store.reset();
    await renderApp();
    fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: '我的故事' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-create'));
      await new Promise((r) => setTimeout(r, 0));
    });

    // 当前版本 2/2 可见；旧版本消息与「消息已编辑」事件均不渲染
    expect(screen.getByText('2/2')).toBeTruthy();
    expect(screen.queryByText('回答 v1')).toBeNull();
    expect(screen.queryByText(/消息已编辑/)).toBeNull();
    // ◀ 点击 → switchBranch 到上一个版本（m2）
    await act(async () => {
      fireEvent.click(screen.getByTitle('上一个版本'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(switchBranch).toHaveBeenCalledWith('m2');
    // ▶ 为端点 → 禁用
    expect((screen.getByTitle('下一个版本') as HTMLButtonElement).disabled).toBe(true);
  });

  it('就地编辑（DeepSeek 式）：✎ → 消息体变 textarea → 发送调 edit，取消恢复', async () => {
    const api = makeApi();
    const edit = vi.fn(async () => makeProjectState());
    api.conversation.edit = edit;
    setApiForTest(api);
    store.reset();
    await renderApp();
    fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: '我的故事' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-create'));
      await new Promise((r) => setTimeout(r, 0));
    });

    // 点击用户消息的 ✎ 编辑 → textarea 出现
    await act(async () => {
      fireEvent.click(screen.getAllByText('✎ 编辑')[0]);
      await new Promise((r) => setTimeout(r, 0));
    });
    const ta = document.querySelector('.msg-edit textarea') as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    fireEvent.change(ta, { target: { value: '写个开头（修改版）' } });
    await act(async () => {
      fireEvent.click(screen.getByTitle('发送（Enter）'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(edit).toHaveBeenCalledWith('m1', '写个开头（修改版）');
  });
});

describe('主题系统 — 切换持久化（data-theme + localStorage 镜像 + settings.update）', () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
    window.localStorage.removeItem('sw2:theme');
  });

  it('挂载无语义主题装饰层；默认主题由 CSS 保持隐藏', async () => {
    setApiForTest(makeApi());
    store.reset();
    await renderApp();
    const backdrop = document.querySelector('.theme-backdrop');
    expect(backdrop).toBeTruthy();
    expect(backdrop?.getAttribute('aria-hidden')).toBe('true');
    expect(backdrop?.querySelectorAll('.theme-ornament')).toHaveLength(3);
  });

  it('顶栏 🎨：打开浮层 → 点星云夜航 → data-theme / 镜像 / settings.update 全生效', async () => {
    const api = makeApi();
    const update = vi.fn(async () => makeProjectState());
    api.settings.update = update;
    setApiForTest(api);
    store.reset();
    await renderApp();
    fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: '我的故事' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-create'));
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle('主题（外观）'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText('星云夜航')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('星云夜航'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(update).toHaveBeenCalledWith({ theme: 'nebula' });
    expect(document.documentElement.dataset.theme).toBe('nebula');
    expect(window.localStorage.getItem('sw2:theme')).toBe('nebula');
    // 浮层已关闭
    expect(screen.queryByText('外观主题')).toBeNull();

    // 设置弹窗必须脱离带 backdrop-filter 的星云顶栏，否则 fixed 会以 44px 顶栏为定位基准。
    await act(async () => {
      fireEvent.click(screen.getByTitle('设置（弹窗）'));
      await new Promise((r) => setTimeout(r, 0));
    });
    const settingsOverlay = document.querySelector('.dialog-overlay');
    expect(settingsOverlay).toBeTruthy();
    expect(settingsOverlay?.parentElement).toBe(document.body);
    expect(settingsOverlay?.closest('.topbar')).toBeNull();
  });

  it('项目首页（无项目）也可切换主题；不影响创建项目流程', async () => {
    const api = makeApi();
    // 无项目打开：settings:update 返回 null（主进程真实行为）
    const update = vi.fn(async () => null);
    api.settings.update = update;
    setApiForTest(api);
    store.reset();
    await renderApp();
    await act(async () => {
      fireEvent.click(screen.getByTitle('主题（外观）'));
      await new Promise((r) => setTimeout(r, 0));
    });
    // 五套主题全部可点；点翡翠秘境切换
    await act(async () => {
      fireEvent.click(screen.getByText('翡翠秘境'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(update).toHaveBeenCalledWith({ theme: 'emerald' });
    expect(document.documentElement.dataset.theme).toBe('emerald');
    expect(screen.getByTestId('project-create')).toBeTruthy();
  });

  it('settings:update 失败时回滚到点击前实际生效的主题（不是上一次点击的相邻主题）', async () => {
    const api = makeApi();
    api.settings.update = vi.fn(async () => {
      throw new Error('NO_PROJECT_OPEN');
    });
    setApiForTest(api);
    store.reset();
    await renderApp();
    // 第一次点击星云夜航：预览后失败 → 回滚到 system
    await act(async () => {
      fireEvent.click(screen.getByTitle('主题（外观）'));
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('星云夜航'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.documentElement.dataset.theme).toBe('system');
    // 第二次点击羊皮手稿：失败后应回到「实际生效的」system，
    // 而不是旧实现 rollback 的 render 闭包 current（= 上一次点击的星云夜航，相邻错位）
    await act(async () => {
      fireEvent.click(screen.getByTitle('主题（外观）'));
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('羊皮手稿'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.documentElement.dataset.theme).toBe('system');
  });

  it('设置弹窗：外观区域显示主题预览卡，点击切换并标记「使用中」', async () => {
    const api = makeApi();
    const nebulaState = (): ProjectState => {
      const p = makeProjectState();
      return { ...p, settings: { ...p.settings, theme: 'nebula' as const } };
    };
    api.settings.update = vi.fn(async () => nebulaState());
    setApiForTest(api);
    store.reset();
    await renderApp();
    fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: '我的故事' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-create'));
      await new Promise((r) => setTimeout(r, 0));
    });
    // 打开设置
    await act(async () => {
      fireEvent.click(screen.getByTitle('设置（弹窗）'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText('外观')).toBeTruthy();
    // 跟随系统卡片当前标记；点击星云夜航 → 切换
    expect(screen.getAllByText('使用中').length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getByText('星云夜航'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(api.settings.update).toHaveBeenCalledWith({ theme: 'nebula' });
    expect(document.documentElement.dataset.theme).toBe('nebula');
    expect(screen.getAllByText('使用中').length).toBeGreaterThan(0);
  });
});

describe('输出系统 — 回答样式与最大输出长度', () => {
  it('设置弹窗「输出」区：回答样式与最大输出长度可选，修改调用 settings.update', async () => {
    const api = makeApi();
    api.settings.update = vi.fn(async () => makeProjectState());
    setApiForTest(api);
    store.reset();
    await renderApp();
    fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: '我的故事' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-create'));
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle('设置（弹窗）'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText('输出')).toBeTruthy();
    // 默认 DeepSeek 风格；切换到 Opencode 风格
    const styleSelect = screen.getByDisplayValue('DeepSeek 风格（默认）') as HTMLSelectElement;
    fireEvent.change(styleSelect, { target: { value: 'opencode' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(api.settings.update).toHaveBeenCalledWith({ outputStyle: 'opencode' });
    // 最大输出长度 → 32768
    await act(async () => {
      fireEvent.change(screen.getByDisplayValue('16,384 tokens'), { target: { value: '32768' } });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(api.settings.update).toHaveBeenCalledWith({ maxOutputTokens: 32768 });
  });

  it('回答渲染：默认 DeepSeek 风格类；切换纯文本后 AI 消息为 <pre> 原样', async () => {
    const api = makeApi();
    setApiForTest(api);
    store.reset();
    await renderApp();
    fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: '我的故事' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-create'));
      await new Promise((r) => setTimeout(r, 0));
    });
    // 默认 outputStyle=deepseek → AI 消息带 md-style-deepseek
    expect(document.querySelector('.md.md-style-deepseek')).toBeTruthy();

    // 切换纯文本 → 重新渲染为 <pre>
    const plain = makeProjectState();
    plain.settings = { ...plain.settings, outputStyle: 'plain' };
    api.state.get = vi.fn(async () => plain);
    api.settings.update = vi.fn(async () => plain);
    await act(async () => {
      await store.updateSettings({ outputStyle: 'plain' });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.querySelector('.md')).toBeNull();
    expect(document.querySelector('pre.msg-content')).toBeTruthy();
  });

  it('回答详略档位：工具栏选择器存在；切换后发送 → run.start 携带档位；localStorage 记忆', async () => {
    const api = makeApi();
    const start = vi.fn(async () => ({ runId: 'run_1' }));
    api.run.start = start;
    setApiForTest(api);
    store.reset();
    window.localStorage.removeItem('sw2:answer-detail');
    await renderApp();
    fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: '我的故事' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-create'));
      await new Promise((r) => setTimeout(r, 0));
    });

    // 选择器默认「自动」；切换到「详细」
    const detailSelect = screen.getByTitle('回答详略（每次发送可选；重新生成沿用当前档位）') as HTMLSelectElement;
    expect(detailSelect.value).toBe('auto');
    fireEvent.change(detailSelect, { target: { value: 'detailed' } });
    expect(window.localStorage.getItem('sw2:answer-detail')).toBe('detailed');
    expect(store.getState().answerDetail).toBe('detailed');

    // 发送 → run.start 携带档位
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '详细评价' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-send'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ kind: 'chat', answerDetail: 'detailed' }));
  });

  it('回答详略档位：重新生成携带当前选择器档位；重启后从 localStorage 恢复', async () => {
    const api = makeApi();
    const refresh = vi.fn(async () => ({ runId: 'run_rf' }));
    api.run.refresh = refresh;
    setApiForTest(api);
    store.reset();
    // 模拟上次会话的记忆（详细档）
    window.localStorage.setItem('sw2:answer-detail', 'concise');
    await renderApp();
    store.initAnswerDetail();
    expect(store.getState().answerDetail).toBe('concise');

    fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: '我的故事' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-create'));
      await new Promise((r) => setTimeout(r, 0));
    });
    // 重新生成 → refresh 携带当前档位（concise）
    await act(async () => {
      fireEvent.click(screen.getByText('⟳ 重新生成'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(refresh).toHaveBeenCalledWith('m2', 'concise');
  });

  it('截断徽标：AI 消息 truncated=true → 显示「已截断」', async () => {
    const api = makeApi();
    const p = makeProjectState();
    p.messages = [
      msg('m1', 'user', '评价这段设定'),
      msg('m2', 'ai', '（长篇评价……被截断）', 'm1'),
    ];
    (p.messages[1] as { truncated?: boolean }).truncated = true;
    p.activeMessageId = 'm2';
    p.sessions = [{ id: 'sess1', title: '话题 1', tailMessageId: 'm2', rootMessageId: 'm1', archivedAt: 't' }];
    api.project.create = vi.fn(async () => p);
    api.project.open = vi.fn(async () => p);
    api.state.get = vi.fn(async () => p);
    setApiForTest(api);
    store.reset();
    await renderApp();
    fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: '我的故事' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-create'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText(/已截断/)).toBeTruthy();
  });
});

describe('会话（ux-review §4.5，ChatGPT 式）— 状态化 mock 走查', () => {
  beforeEach(() => {
    setApiForTest(makeStatefulApi());
    store.reset();
  });

  async function openProject(): Promise<void> {
    await renderApp();
    fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: '我的故事' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-create'));
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it('开启新话题：不归档旧话题（消息清空为新话题空视图），会话 tab 两条活跃', async () => {
    await openProject();
    // 初始：话题 1 的消息可见，header 显示当前话题
    expect(screen.getByText('话题一：主角是侦探')).toBeTruthy();
    expect(screen.getByText(/话题 1/)).toBeTruthy();

    // 开启新话题 → 旧消息从视图消失（新话题空视图）
    await act(async () => {
      fireEvent.click(screen.getByText('＋ 开启新话题'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByText('话题一：主角是侦探')).toBeNull();
    expect(screen.getByTestId('chat-input')).toBeTruthy(); // 新话题可继续聊

    // 用户反馈 3：当前话题为空（尚无消息）→「开启新话题」禁用
    expect((screen.getByText('＋ 开启新话题') as HTMLButtonElement).disabled).toBe(true);

    // 会话 tab：两条活跃对话（无归档分组）
    fireEvent.click(screen.getByRole('button', { name: /会话/ }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getAllByText(/话题 1|话题 2/).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('归档（只读）')).toBeNull();
  });

  it('切回旧话题：完整链可见并可继续追加；归档后只读；取消归档恢复', async () => {
    await openProject();
    // 新话题
    await act(async () => {
      fireEvent.click(screen.getByText('＋ 开启新话题'));
      await new Promise((r) => setTimeout(r, 0));
    });
    // 切回话题 1（会话 tab）
    fireEvent.click(screen.getByRole('button', { name: /会话/ }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    fireEvent.click(screen.getByText('话题 1'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByText('话题一：主角是侦探')).toBeTruthy(); // 完整链可见
    expect(screen.getByText('明白。')).toBeTruthy();
    expect(screen.getByTestId('chat-input')).toBeTruthy(); // 可继续追加

    // 归档当前话题 → 输入区替换为只读提示
    await act(async () => {
      fireEvent.click(screen.getByText('归档当前话题'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByTestId('chat-input')).toBeNull();
    expect(screen.getByText(/已归档 · 只读/)).toBeTruthy();
    // 消息仍可查看（复制等只读操作保留，编辑/重新生成隐藏）
    expect(screen.getByText('话题一：主角是侦探')).toBeTruthy();
    expect(screen.queryByText('✎ 编辑')).toBeNull();
    expect(screen.queryByText('⟳ 重新生成')).toBeNull();

    // 会话 tab：右键话题 → 菜单中「取消归档」→ 输入区恢复（用户反馈 2：归档/删除走右键菜单）
    fireEvent.click(screen.getByRole('button', { name: /会话/ }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => {
      fireEvent.contextMenu(screen.getByText('话题 1'));
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('取消归档'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId('chat-input')).toBeTruthy();
  });

  it('删除会话：右键菜单 → 删除 → 确认后从会话列表移除，消息不可见', async () => {
    await openProject();
    fireEvent.click(screen.getByRole('button', { name: /会话/ }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    // 右键菜单（用户反馈 2）触发删除
    await act(async () => {
      fireEvent.contextMenu(screen.getByText('话题 1'));
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('删除…'));
      await new Promise((r) => setTimeout(r, 0));
    });
    // 确认弹窗
    await act(async () => {
      fireEvent.click(screen.getByText('永久删除'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByText('话题 1')).toBeNull();
  });

  it('全局搜索（§6.9）：Ctrl+K 打开 → 输入 → 结果分组 → 点击跳转节点', async () => {
    const project = makeProjectState();
    const searchGlobal = vi.fn(async (_q: string) => [
      { kind: 'node', id: 's1', title: '第一场', excerpt: '陈默在码头…' },
      { kind: 'output', id: 's1', title: '第一场（novel）', excerpt: '码头夜色…', meta: 'novel' },
    ] as never);
    setApiForTest({ ...makeApi(), search: { global: searchGlobal } });
    await openProject();

    // Ctrl+K 打开搜索弹窗
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
      await new Promise((r) => setTimeout(r, 0));
    });
    const input = screen.getByTestId('global-search-input');
    expect(input).toBeTruthy();

    // 输入查询 → 防抖 300ms 后出现分组结果
    await act(async () => {
      fireEvent.change(input, { target: { value: '码头' } });
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(searchGlobal).toHaveBeenCalledWith('码头');
    expect(screen.getByText('大纲（1）')).toBeTruthy();
    expect(screen.getByText('正文（1）')).toBeTruthy();

    // 点击节点结果 → 跳转讨论模块并选中
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('search-result-node')[0]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(store.getState().module).toBe('discussion');
    expect(store.getState().selected).toEqual({ kind: 'node', id: 's1' });
    expect(screen.queryByTestId('global-search-input')).toBeNull(); // 弹窗关闭
  });

  it('项目菜单（§6.10）：项目名可点开菜单 → 返回项目列表', async () => {
    await openProject();
    await act(async () => {
      fireEvent.click(screen.getByText('测试项目 ▾'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText('返回项目列表')).toBeTruthy();
    expect(screen.getByText('在资源管理器中显示')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('返回项目列表'));
      await new Promise((r) => setTimeout(r, 0));
    });
    // 回到项目选择屏
    expect(screen.getByPlaceholderText('项目名称')).toBeTruthy();
  });

  it('一键折叠（§6.12）：左栏按钮折叠/恢复；专注模式折叠全部侧栏', async () => {
    await openProject();
    const leftPanel = (): HTMLElement | null => document.querySelector('.left-panel');
    const workspace = (): HTMLElement | null => document.querySelector('.workspace');
    const writingModule = (): HTMLElement | null => document.querySelector('.writing-module');

    // 初始展开
    expect(leftPanel()?.className).not.toContain('collapsed');
    expect(workspace()?.className).not.toContain('collapsed');

    // 折叠左栏
    await act(async () => {
      fireEvent.click(screen.getByTitle('折叠左栏（大纲/设定/会话）'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(leftPanel()?.className).toContain('collapsed');
    expect(screen.getByTestId('chat-input')).toBeTruthy(); // 对话区仍在

    // 恢复左栏
    await act(async () => {
      fireEvent.click(screen.getByTitle('展开左栏（大纲/设定/会话）'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(leftPanel()?.className).not.toContain('collapsed');

    // 专注模式：左栏 + 右栏全部折叠
    await act(async () => {
      fireEvent.click(screen.getByTitle('专注写作：一键折叠/展开全部侧栏'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(leftPanel()?.className).toContain('collapsed');
    expect(workspace()?.className).toContain('collapsed');

    // 再点恢复（写作模块场景树也一并恢复）
    await act(async () => {
      fireEvent.click(screen.getByTitle('专注写作：一键折叠/展开全部侧栏'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(leftPanel()?.className).not.toContain('collapsed');
    expect(workspace()?.className).not.toContain('collapsed');
    expect(writingModule()?.className).not.toContain('scenes-collapsed');

    // 写作模块内「场景」按钮折叠场景树
    await act(async () => {
      fireEvent.click(screen.getByText('正文写作'));
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle('折叠场景树'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(writingModule()?.className).toContain('scenes-collapsed');
    await act(async () => {
      fireEvent.click(screen.getByTitle('展开场景树'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(writingModule()?.className).not.toContain('scenes-collapsed');
  });
});
