/**
 * GlobalSearchDialog.tsx — 全局搜索弹窗（§6.9）。
 *
 * Ctrl+K 打开；跨大纲（标题/草稿/正式版）、设定、对话、附件正文、
 * 已生成正文、可见视图搜索；结果分组展示，点击跳转到对应对象。
 */
import React, { useEffect, useRef, useState } from 'react';
import { store } from '../../store';
import type { GlobalSearchResult } from '../../../shared/ipc-types';

const KIND_LABELS: Record<GlobalSearchResult['kind'], string> = {
  node: '大纲',
  asset: '设定',
  conversation: '对话',
  attachment: '附件',
  output: '正文',
  visible_view: '可见视图',
};

export function GlobalSearchDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<GlobalSearchResult[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 防抖搜索（300ms）
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void store.globalSearch(q).then((r) => {
        setResults(r);
        setSearching(false);
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  /** 点击结果跳转（§6.9）。 */
  const jump = (r: GlobalSearchResult): void => {
    onClose();
    switch (r.kind) {
      case 'node':
        void store.selectNode(r.id);
        store.setModule('discussion');
        break;
      case 'asset':
        void store.selectAsset(r.id);
        store.setModule('discussion');
        break;
      case 'conversation':
        void store.jumpToMessage(r.id);
        store.setModule('discussion');
        break;
      case 'attachment': {
        // meta = 引用该附件的消息 id（msg:<id>）
        const msgId = r.meta?.startsWith('msg:') ? r.meta.slice(4) : undefined;
        if (msgId) void store.jumpToMessage(msgId);
        else store.showToast('该附件未被任何消息引用，无法定位', 'info');
        store.setModule('discussion');
        break;
      }
      case 'output':
      case 'visible_view':
        store.setWritingTarget(r.id, r.kind === 'output' ? r.meta ?? '' : '');
        store.setModule('writing');
        break;
    }
  };

  const grouped = React.useMemo(() => {
    if (!results) return null;
    const order: Array<GlobalSearchResult['kind']> = ['node', 'asset', 'conversation', 'attachment', 'output', 'visible_view'];
    return order
      .map((kind) => ({ kind, items: results.filter((r) => r.kind === kind) }))
      .filter((g) => g.items.length > 0);
  }, [results]);

  return (
    <div
      className="dialog-overlay"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      tabIndex={-1}
    >
      <div className="dialog search-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">全局搜索</h3>
        <div className="dialog-body">
          <input
            ref={inputRef}
            data-testid="global-search-input"
            placeholder="搜索大纲 / 草稿 / 设定 / 对话 / 附件 / 正文…（Esc 关闭）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter' && grouped && grouped.length > 0 && grouped[0].items.length > 0) {
                jump(grouped[0].items[0]);
              }
            }}
          />
          {searching && <p className="muted small">搜索中…</p>}
          {!searching && query.trim() !== '' && grouped !== null && grouped.length === 0 && (
            <p className="muted small">没有找到匹配内容。</p>
          )}
          {grouped !== null && (
            <div className="search-results">
              {grouped.map((g) => (
                <div key={g.kind} className="search-group">
                  <div className="search-group-title">{KIND_LABELS[g.kind]}（{g.items.length}）</div>
                  {g.items.map((r, i) => (
                    <button
                      key={`${r.kind}:${r.id}:${i}`}
                      className="search-result"
                      data-testid={`search-result-${r.kind}`}
                      onClick={() => jump(r)}
                      title="点击跳转"
                    >
                      <div className="search-result-title">
                        {r.title}
                        {r.meta && !r.meta.startsWith('msg:') && <span className="muted small"> · {r.meta}</span>}
                      </div>
                      <div className="search-result-excerpt">{r.excerpt}</div>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="dialog-actions">
          <button className="small-btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
