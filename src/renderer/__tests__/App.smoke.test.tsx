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
      { id: 'overview', type: 'overview', title: '总纲', parentId: null, depth: 0, hasDraft: false, hasOfficial: false, outputFormats: [] },
      { id: 'v1', type: 'volume', title: '第一卷', parentId: 'overview', depth: 1, hasDraft: true, hasOfficial: false, aiCreated: true, outputFormats: [] },
      { id: 's1', type: 'scene', title: '第一场', parentId: 'v1', depth: 2, hasDraft: true, hasOfficial: false, outputFormats: [] },
    ],
    assets: [],
    attachments: [],
    messages: [msg('m1', 'user', '主角是侦探'), msg('m2', 'ai', '明白。', 'm1')],
    sessions: [{ id: 'sess1', title: '话题 1', tailMessageId: 'm2', rootMessageId: 'm1', archivedAt: 't' }],
    activeSessionId: 'sess1',
    activeMessageId: 'm2',
    runSummaries: [],
    hasApiKey: false,
    trash: [],
    settings: { model: 'deepseek-v4-flash', thinking: true, reasoningEffort: 'high', notifications: true },
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
      add: vi.fn(async () => project),
      addFiles: vi.fn(async () => project),
      pickFiles: vi.fn(async () => project),
      scanWorkspace: vi.fn(async () => [{ name: '旧大纲.txt', size: 10 }]),
      importWorkspace: vi.fn(async () => project),
      readContent: vi.fn(async () => ({ name: '旧大纲.txt', content: '大纲内容' })),
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
      applyRevise: vi.fn(async () => project),
      undoRevise: vi.fn(async () => project),
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
      revise: vi.fn(async () => ({ runId: 'run_4' })),
      inspect: vi.fn(async () => null),
      list: vi.fn(async () => []),
      diff: vi.fn(async () => []),
      accept: vi.fn(async () => project),
      rollback: vi.fn(async () => project),
    },
    settings: { setKey: vi.fn(async () => project), update: vi.fn(async () => project) },
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

  it('场景节点：右栏收敛（无可见视图/正文 tab）；正文模块内闭环（ux-review §4.6、§5.1）', async () => {
    await renderApp();
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

    // 会话 tab：取消归档 → 输入区恢复
    fireEvent.click(screen.getByRole('button', { name: /会话/ }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => {
      fireEvent.click(screen.getByText('取消归档'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId('chat-input')).toBeTruthy();
  });

  it('删除会话：从会话列表移除，消息不可见', async () => {
    await openProject();
    fireEvent.click(screen.getByRole('button', { name: /会话/ }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => {
      fireEvent.click(screen.getByText('删除'));
      await new Promise((r) => setTimeout(r, 0));
    });
    // 确认弹窗
    await act(async () => {
      fireEvent.click(screen.getByText('永久删除'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByText('话题 1')).toBeNull();
  });
});
