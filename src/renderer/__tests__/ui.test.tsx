/**
 * ui.test.tsx — 基础设施组件测试（jsdom）。
 * Dialog 服务、MarkdownView（暂不明示标记高亮/计数）、DiffView（行级 diff）。
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { DialogHost, confirmDialog, promptDialog } from '../components/ui/dialog';
import { MarkdownView, countMarkers, highlightMarkers } from '../components/ui/MarkdownView';
import { DiffView } from '../components/ui/DiffView';
import { OrganizeChangesExpand } from '../components/ConversationPane';
import { store } from '../store';
import { setApiForTest } from '../api';
import type { FileDiff, RendererApi } from '../../shared/ipc-types';
import type { ChangeItem } from '../../shared/types';

afterEach(() => {
  cleanup();
});

describe('Dialog 服务（替换 confirm/prompt）', () => {
  async function renderHost(): Promise<void> {
    render(<DialogHost />);
    await act(async () => {});
  }

  it('confirmDialog：确认返回 true，取消返回 false', async () => {
    await renderHost();
    let result: boolean | undefined;
    const promise = confirmDialog({ title: '确认操作', message: '继续吗？' }).then((r) => { result = r; });
    await act(async () => {});
    expect(screen.getByText('确认操作')).toBeTruthy();
    expect(screen.getByText('继续吗？')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('确认'));
      await promise;
    });
    expect(result).toBe(true);

    const promise2 = confirmDialog({ title: '取消操作', message: '要取消吗？' });
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByText('取消'));
      await promise2;
    });
    expect(await promise2).toBe(false);
  });

  it('promptDialog：输入值返回，取消返回 null', async () => {
    await renderHost();
    const promise = promptDialog({ title: '输入标题', defaultValue: '默认' });
    await act(async () => {});
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: '新标题' } });
      fireEvent.click(screen.getByText('确定'));
      await promise;
    });
    expect(await promise).toBe('新标题');

    const promise2 = promptDialog({ title: '再输入' });
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByText('取消'));
      await promise2;
    });
    expect(await promise2).toBeNull();
  });

  it('Esc 关闭（视为取消）', async () => {
    await renderHost();
    const promise = confirmDialog({ title: 'Esc 测试' });
    await act(async () => {});
    await act(async () => {
      fireEvent.keyDown(screen.getByText('Esc 测试'), { key: 'Escape' });
      await promise;
    });
    expect(await promise).toBe(false);
  });
});

describe('MarkdownView — 暂不明示标记（§6.1）', () => {
  it('countMarkers 统计标记数', () => {
    expect(countMarkers('普通文本')).toBe(0);
    expect(countMarkers('甲{{暂不明示：x}}乙{{暂不明示：y}}')).toBe(2);
  });

  it('highlightMarkers 把标记转为高亮 span（内容转义）', () => {
    const html = highlightMarkers('甲{{暂不明示：<script>}}乙');
    expect(html).toContain('marker-highlight');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('MarkdownView 渲染 markdown 且不含未消毒 HTML', () => {
    render(<MarkdownView text={'# 标题\n\n段落 **加粗**\n\n{{暂不明示：秘密}}' } />);
    expect(screen.getByText('标题')).toBeTruthy();
    expect(screen.getByText('加粗')).toBeTruthy();
    expect(document.querySelector('.marker-highlight')).toBeTruthy();
  });
});

describe('DiffView — 文件级 diff（§5.4）', () => {
  it('修改文件：渲染增/删/上下文行', () => {
    const diffs: FileDiff[] = [{
      path: 'nodes/n1.draft.md',
      before: '第一行\n旧内容\n第三行',
      after: '第一行\n新内容\n第三行',
    }];
    render(<DiffView diffs={diffs} />);
    expect(screen.getByText('nodes/n1.draft.md')).toBeTruthy();
    expect(screen.getByText('修改')).toBeTruthy();
    expect(screen.getByText('旧内容')).toBeTruthy();
    expect(screen.getByText('新内容')).toBeTruthy();
  });

  it('新增文件（before=null）与删除文件（after=null）', () => {
    const diffs: FileDiff[] = [
      { path: 'nodes/new.md', before: null, after: '全新内容' },
      { path: 'nodes/old.md', before: '旧内容', after: null },
    ];
    render(<DiffView diffs={diffs} />);
    expect(screen.getByText('新增')).toBeTruthy();
    expect(screen.getByText('删除')).toBeTruthy();
    expect(screen.getByText('全新内容')).toBeTruthy();
    expect(screen.getByText('旧内容')).toBeTruthy();
  });

  it('无 diff 时显示空态', () => {
    render(<DiffView diffs={[]} />);
    expect(screen.getByText(/没有文件级变化/)).toBeTruthy();
  });
});

describe('OrganizeChangesExpand — 展开/收起 toggle（ux-review §4.2，回归：收起无效果）', () => {
  const changes: ChangeItem[] = [{ action: 'node_created', nodeId: 'n1', parentId: 'overview', title: '新章' }];

  beforeEach(() => {
    store.reset();
    const api = { run: { list: vi.fn(async () => [{ runId: 'r1', taskKind: 'organize', snapshotId: 's1', scope: '范围', changes, createdAt: 't' }]), diff: vi.fn(async () => []) } } as unknown as RendererApi;
    setApiForTest(api);
  });

  afterEach(() => cleanup());

  it('查看变更详情 → 展开；再次点击 → 收起；往返多次稳定', async () => {
    render(<OrganizeChangesExpand runId="r1" />);
    const btn = screen.getByText('查看变更详情');
    // 展开
    await act(async () => {
      fireEvent.click(btn);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText('新建节点：新章')).toBeTruthy();
    // 收起（回归：此前 load 早退导致无效果）
    await act(async () => {
      fireEvent.click(screen.getByText('收起变更详情'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByText('新建节点：新章')).toBeNull();
    expect(screen.getByText('查看变更详情')).toBeTruthy();
    // 再展开一次（懒加载缓存后直接展开）
    await act(async () => {
      fireEvent.click(screen.getByText('查看变更详情'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText('新建节点：新章')).toBeTruthy();
  });

  it('查看 diff → 展开；再次点击 → 收起', async () => {
    render(<OrganizeChangesExpand runId="r1" />);
    await act(async () => {
      fireEvent.click(screen.getByText('查看变更详情'));
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('查看 diff'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText(/没有文件级变化/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('收起 diff'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByText(/没有文件级变化/)).toBeNull();
    expect(screen.getByText('查看 diff')).toBeTruthy();
  });
});
