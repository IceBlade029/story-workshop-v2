/**
 * Workspace 回归测试 — 保存草稿按钮（用户反馈：点击没反应）。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { store } from '../store';
import { setApiForTest } from '../api';
import { Workspace } from '../components/Workspace';
import type { RendererApi, ProjectState } from '../../shared/ipc-types';
import type { ChatMessage } from '../../shared/types';

function msg(id: string, role: ChatMessage['role'], content: string, parentId?: string): ChatMessage {
  return { id, role, content, timestamp: 't', parentId };
}

function makeProject(): ProjectState {
  return {
    dir: '/proj',
    name: '测试项目',
    outline: null,
    nodes: [
      { id: 'overview', type: 'overview', title: '总纲', parentId: null, depth: 0, hasDraft: false, hasOfficial: false, outputFormats: [], outputStale: [] },
      { id: 'c1', type: 'chapter', title: '第一章', parentId: 'overview', depth: 1, hasDraft: true, hasOfficial: false, outputFormats: [], outputStale: [] },
    ],
    assets: [],
    attachments: [],
    messages: [msg('m1', 'user', '问题')],
    sessions: [{ id: 'sess1', title: '话题 1', rootMessageId: 'm1', tailMessageId: 'm1', archivedAt: 't' }],
    activeSessionId: 'sess1',
    activeMessageId: 'm1',
    runSummaries: [],
    hasApiKey: false,
    trash: [],
    settings: { model: 'deepseek-v4-flash', thinking: true, reasoningEffort: 'high', notifications: true },
  };
}

function makeApi(): RendererApi {
  const project = makeProject();
  return {
    app: { getVersion: vi.fn(async () => '0.1.0') },
    project: { list: vi.fn(async () => []), create: vi.fn(async () => project), open: vi.fn(async () => project), pickFolder: vi.fn(async () => null), delete: vi.fn(async () => {}), showInFolder: vi.fn(async () => {}), rename: vi.fn(async () => {}) },
    state: { get: vi.fn(async () => project) },
    outline: {
      createNode: vi.fn(async () => project),
      renameNode: vi.fn(async () => project),
      deleteNode: vi.fn(async () => project),
      moveNode: vi.fn(async () => project),
      writeDraft: vi.fn(async () => project),
      writeOfficial: vi.fn(async () => project),
      commitNodes: vi.fn(async () => ({ runId: 'c', committed: [], skippedPending: [], affected: [] })),
      readContent: vi.fn(async () => ({ id: 'c1', title: '第一章', type: 'chapter' as const, official: null, draft: '旧草稿' })),
    },
    asset: { create: vi.fn(async () => project), update: vi.fn(async () => project), delete: vi.fn(async () => project) },
    attachment: {
      pickFiles: vi.fn(async () => [{ name: 'x.md', content: 'x' }]),
      scanWorkspace: vi.fn(async () => []),
      readWorkspace: vi.fn(async () => ({ name: 'x.md', content: 'x' })),
      readContent: vi.fn(async () => ({ name: 'x', content: 'x' })),
      delete: vi.fn(async () => project),
    },
    visibleView: { read: vi.fn(async () => null), generate: vi.fn(async () => project), save: vi.fn(async () => project) },
    output: {
      formats: vi.fn(async () => ['novel']), list: vi.fn(async () => []), read: vi.fn(async () => ''),
      save: vi.fn(async () => project), versions: vi.fn(async () => []), readVersion: vi.fn(async () => ''),
      export: vi.fn(async () => ({ saved: false, canceled: true, missing: [] })),
      applyRevise: vi.fn(async () => project), undoRevise: vi.fn(async () => project),
    },
    conversation: {
      send: vi.fn(async () => project), sendWithAttachments: vi.fn(async () => project), newTopic: vi.fn(async () => project),
      switchSession: vi.fn(async () => project), archiveSession: vi.fn(async () => project),
      unarchiveSession: vi.fn(async () => project), deleteSession: vi.fn(async () => project),
      switchBranch: vi.fn(async () => project), edit: vi.fn(async () => project),
    },
    context: { inspect: vi.fn(async () => ({ messageCount: 2, budgetTokens: 30000, estimatedTokens: 50, compressed: false, keptRawCount: 2, blocked: false })), recompress: vi.fn(async () => project) },
    search: { global: vi.fn(async () => []) },
    nodeVersion: { list: vi.fn(async () => []), read: vi.fn(async () => '') },
    trash: { restore: vi.fn(async () => project), purge: vi.fn(async () => project) },
    run: {
      start: vi.fn(async () => ({ runId: 'r' })), cancel: vi.fn(async () => {}), onEvent: vi.fn(() => () => {}),
      refresh: vi.fn(async () => ({ runId: 'r' })), detailFill: vi.fn(async () => ({ runId: 'r' })),
      revise: vi.fn(async () => ({ runId: 'r' })), list: vi.fn(async () => []), inspect: vi.fn(async () => null),
      diff: vi.fn(async () => []), accept: vi.fn(async () => project), rollback: vi.fn(async () => project),
    },
    settings: { setKey: vi.fn(async () => project), update: vi.fn(async () => project) },
  };
}

describe('Workspace — 保存草稿按钮（回归：点击没反应）', () => {
  beforeEach(() => {
    store.reset();
    setApiForTest(makeApi());
  });

  afterEach(() => cleanup());

  it('草稿未改动时「保存草稿」禁用；改动后亮起，点击触发 writeDraft 并保存后再次变灰（用户反馈）', async () => {
    const api = makeApi();
    const writeDraft = vi.fn(async () => makeProject());
    setApiForTest({ ...api, outline: { ...api.outline, writeDraft } });
    await store.openProject('/proj');
    store.selectNode('c1');
    render(<Workspace />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // 默认预览 → 手动切到编辑，加载内容
    await act(async () => {
      fireEvent.click(screen.getByText('编辑'));
      await new Promise((r) => setTimeout(r, 0));
    });
    const editor = screen.getByTestId('draft-editor') as HTMLTextAreaElement;
    expect(editor.value).toBe('旧草稿');

    // 未改动 → 保存按钮灰色不可交互
    const saveBtn = screen.getByText('保存草稿') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    // 改动内容 → 按钮亮起
    fireEvent.change(editor, { target: { value: '旧草稿\n\n新增内容' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(saveBtn.disabled).toBe(false);

    // 点击保存草稿 → 触发 writeDraft + 成功反馈 + 按钮重新变灰
    await act(async () => {
      fireEvent.click(saveBtn);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(writeDraft).toHaveBeenCalledTimes(1);
    expect(writeDraft).toHaveBeenCalledWith('c1', '旧草稿\n\n新增内容');
    expect(store.getState().toast?.message).toBe('草稿已保存');
    expect(saveBtn.disabled).toBe(true);
  });

  it('保存失败时显示错误反馈（不再静默无反应）', async () => {
    const api = makeApi();
    const writeDraft = vi.fn(async () => { throw new Error('WRITE_FAILED: 磁盘错误'); });
    setApiForTest({ ...api, outline: { ...api.outline, writeDraft } });
    await store.openProject('/proj');
    store.selectNode('c1');
    render(<Workspace />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    // 改动内容后再保存（未改动时按钮禁用）
    await act(async () => {
      fireEvent.click(screen.getByText('编辑'));
      await new Promise((r) => setTimeout(r, 0));
    });
    const editor = screen.getByTestId('draft-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '改过的内容' } });
    await act(async () => {
      fireEvent.click(screen.getByText('保存草稿'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(store.getState().toast?.kind).toBe('error');
    expect(store.getState().toast?.message).toContain('WRITE_FAILED');
  });

  it('「提交为正式版（含子树）」位于草稿底部与保存草稿同排；正式版 tab 只读无保存按钮（用户反馈 6/7）', async () => {
    const api = makeApi();
    await store.openProject('/proj');
    store.selectNode('c1');
    render(<Workspace />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // 草稿 tab：保存草稿 + 提交为正式版 同一行（draft-actions）
    const row = document.querySelector('.draft-actions');
    const labels = row ? Array.from(row.querySelectorAll('button')).map((b) => b.textContent) : [];
    expect(labels).toEqual(['保存草稿', '提交为正式版（含子树）']);
    // 顶部操作行不再有提交按钮
    const headRow = document.querySelector('.ws-head + .row');
    expect(headRow?.textContent).not.toContain('提交为正式版');

    // 正式版 tab：只读展示，无「保存正式版」按钮、无编辑器 textarea
    await act(async () => {
      fireEvent.click(screen.getByText('正式版'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByText('保存正式版')).toBeNull();
    expect(screen.queryByTestId('official-editor')).toBeNull();
    expect(screen.getByText(/正式版由「提交为正式版/)).toBeTruthy();
  });

  it('默认预览模式：草稿 tab 显示渲染后的内容，编辑需手动切换', async () => {
    const api = makeApi();
    await store.openProject('/proj');
    store.selectNode('c1');
    render(<Workspace />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // 默认预览：内容以 markdown 渲染呈现（无 textarea）
    expect(screen.queryByTestId('draft-editor')).toBeNull();
    expect(screen.getByText('旧草稿')).toBeTruthy();
    // 切换按钮顺序：预览在前、编辑在后
    const toolbar = document.querySelector('.editor-toolbar');
    const labels = toolbar ? Array.from(toolbar.querySelectorAll('button')).map((b) => b.textContent) : [];
    expect(labels).toEqual(['预览', '编辑']);
    // 手动切到编辑 → textarea 出现
    await act(async () => {
      fireEvent.click(screen.getByText('编辑'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId('draft-editor')).toBeTruthy();
  });
});
