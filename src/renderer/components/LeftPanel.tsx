/**
 * LeftPanel.tsx — 左栏：大纲 | 设定 | 会话 | 回收站（§5.1、§9.4）。
 *
 * 大纲树：搜索过滤（匹配高亮）、展开状态持久（store）、拖拽重排（§3.1）。
 * 隐藏中间层级（§3.1）不显示，其子节点提升一层显示。
 */
import React from 'react';
import { store, useStore, type TabId } from '../store';
import { confirmDialog, promptDialog } from './ui/dialog';
import type { NodeSummary } from '../../shared/ipc-types';
import type { ConversationSession } from '../../shared/types';
import { ASSET_TYPE_LABELS, assetTypeLabel } from '../../shared/types';

// --------------------------------------------------------------------------- 大纲树

function useExpanded(): {
  isExpanded: (id: string) => boolean;
  toggle: (id: string) => void;
} {
  const collapsed = useStore((s) => s.expandedIds);
  return {
    // 语义：store 记录的是「收起」的节点集合；默认全部展开（与历史行为一致）
    isExpanded: (id: string) => !collapsed.has(id),
    toggle: (id: string) => store.toggleExpanded(id),
  };
}

function OutlineTreeItem({ node, depth }: { node: NodeSummary; depth: number }): React.ReactElement {
  const selected = useStore((s) => s.selected?.kind === 'node' && s.selected.id === node.id);
  const project = useStore((s) => s.project);
  const search = useStore((s) => s.treeSearch);
  const directChildren = project?.nodes.filter((n) => n.parentId === node.id) ?? [];
  // §3.1 隐藏中间层级：不显示，其子节点提升一层显示
  const visibleChildren = directChildren.flatMap((c) => {
    if (c.hidden) return project?.nodes.filter((n) => n.parentId === c.id) ?? [];
    return [c];
  });
  const { isExpanded, toggle } = useExpanded();
  const expanded = isExpanded(node.id);

  const nodeTypeLabel: Record<string, string> = {
    overview: '总纲', volume: '卷', chapter: '章', scene: '场景',
  };

  // ---- 拖拽重排（§3.1）：拖动到行上/下 = 兄弟插入；中带 = 移入该节点
  const [dragState, setDragState] = React.useState<'top' | 'bottom' | 'inside' | null>(null);
  const [dragging, setDragging] = React.useState(false);

  const onDragStart = (e: React.DragEvent): void => {
    e.dataTransfer.setData('text/sw2-node', node.id);
    e.dataTransfer.effectAllowed = 'move';
    setDragging(true);
  };

  const onDragOver = (e: React.DragEvent): void => {
    if (dragging) return;
    const srcId = e.dataTransfer.getData('text/sw2-node');
    if (!srcId || srcId === node.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    const isLeaf = visibleChildren.length === 0;
    // 叶子节点：上半=插上面，下半=插下面；非叶子：上下 1/4 插兄弟，中间=移入
    if (isLeaf || node.type === 'scene') {
      setDragState(ratio < 0.5 ? 'top' : 'bottom');
    } else if (ratio < 0.25) {
      setDragState('top');
    } else if (ratio > 0.75) {
      setDragState('bottom');
    } else {
      setDragState('inside');
    }
  };

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    const srcId = e.dataTransfer.getData('text/sw2-node');
    setDragState(null);
    if (!srcId || srcId === node.id) return;
    const siblings = project?.nodes.filter((n) => n.parentId === node.parentId && !n.hidden) ?? [];
    const idx = siblings.findIndex((n) => n.id === node.id);
    const target = dragState === 'inside' ? node.id : (node.parentId ?? 'overview');
    const index = dragState === 'inside' || dragState === 'top' ? idx : idx + 1;
    void store.moveNode(srcId, target, index >= 0 ? index : undefined).catch((err) => store.showToast((err as Error).message, 'error'));
  };

  const onDragEnd = (): void => {
    setDragging(false);
    setDragState(null);
  };

  const match = (text: string): boolean => !search || text.toLowerCase().includes(search.toLowerCase());

  const titleMatches = match(node.title);
  const childMatches = visibleChildren.some((c) => match(c.title) || match(c.type));
  // 搜索时只显示匹配行（自身或子树有匹配）
  if (search && !titleMatches && !childMatches) return <></>;

  const rowClass = [
    'tree-row',
    selected ? 'selected' : '',
    dragging ? 'dragging' : '',
    dragState === 'top' ? 'drag-over-top' : '',
    dragState === 'bottom' ? 'drag-over-bottom' : '',
    dragState === 'inside' ? 'drag-over-inside' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="tree-item">
      <div
        className={rowClass}
        style={{ paddingLeft: depth * 14 + 6 }}
        draggable={node.id !== 'overview'}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={() => setDragState(null)}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
        onClick={() => store.selectNode(node.id)}
      >
        {visibleChildren.length > 0 && (
          <button
            className="tree-toggle"
            onClick={(e) => { e.stopPropagation(); toggle(node.id); }}
          >
            {expanded ? '▾' : '▸'}
          </button>
        )}
        <span className={`tree-type tree-type-${node.type}`}>{nodeTypeLabel[node.type] ?? node.type}</span>
        <span className="tree-title">
          {search && titleMatches ? <Highlight text={node.title} query={search} /> : node.title}
        </span>
        {node.aiCreated && <span className="badge badge-ai">AI</span>}
        {node.hasDraft && !node.hasOfficial && <span className="badge">草稿</span>}
        {visibleChildren.length > 0 && !expanded && <span className="tree-count">{visibleChildren.length}</span>}
      </div>
      {expanded && visibleChildren.map((c) => <OutlineTreeItem key={c.id} node={c} depth={depth + 1} />)}
    </div>
  );
}

function Highlight({ text, query }: { text: string; query: string }): React.ReactElement {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

// --------------------------------------------------------------------------- 设定/会话/回收站

function AssetItem({ assetId, title, type }: { assetId: string; title: string; type: string }): React.ReactElement {
  const selected = useStore((s) => s.selected?.kind === 'asset' && s.selected.id === assetId);
  return (
    <div
      className={`tree-row${selected ? ' selected' : ''}`}
      onClick={() => store.selectAsset(assetId)}
    >
      <span className="tree-type">{assetTypeLabel(type)}</span>
      <span className="tree-title">{title || '（未命名）'}</span>
    </div>
  );
}

function SessionItem({ session }: { session: ConversationSession }): React.ReactElement {
  const activeSessionId = useStore((s) => s.project?.activeSessionId);
  const isActive = session.id === activeSessionId;
  const archived = session.archived === true;
  // 用户反馈 2：归档/删除改为右键菜单触发（ChatGPT 式收敛，行内不再平铺按钮）
  const [menu, setMenu] = React.useState<{ x: number; y: number } | null>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!menu) return;
    const onDocClick = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menu]);

  const archive = async (): Promise<void> => {
    try {
      if (archived) {
        await store.unarchiveSession(session.id);
        store.showToast('已移回活跃对话，可继续聊', 'success');
      } else {
        await store.archiveSession(session.id);
        store.showToast('已归档（只读，可取消归档）', 'success');
      }
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    }
  };

  const remove = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: `删除会话「${session.title}」？`,
      message: '该会话的全部消息将从对话日志中永久删除，不可恢复（ux-review §4.5）。',
      confirmText: '永久删除',
      danger: true,
    });
    if (ok) void store.deleteSession(session.id).catch((err) => store.showToast((err as Error).message, 'error'));
  };

  return (
    <div
      className={`tree-row session-row${isActive ? ' selected' : ''}`}
      onClick={() => void store.switchSession(session.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      title={archived ? '查看归档会话（只读）· 右键管理' : '切换到该会话继续聊 · 右键管理'}
    >
      <span className="tree-title">{session.title || '（未命名）'}</span>
      {isActive && <span className="badge">当前</span>}
      {archived && <span className="badge">已归档</span>}
      <span className="muted small">{new Date(session.archivedAt).toLocaleDateString()}</span>
      {menu && (
        <div className="ctx-menu" ref={menuRef} style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button
            className="ctx-menu-item"
            onClick={() => {
              void archive();
              setMenu(null);
            }}
          >
            {archived ? '取消归档' : '归档'}
          </button>
          <button
            className="ctx-menu-item danger"
            onClick={() => {
              void remove();
              setMenu(null);
            }}
          >
            删除…
          </button>
        </div>
      )}
    </div>
  );
}

function TrashItem({ id, title, type, movedAt }: { id: string; title: string; type: string; movedAt: string }): React.ReactElement {
  const restore = async (): Promise<void> => {
    const ok = await confirmDialog({ title: `恢复「${title}」？`, message: '节点及其内容将回到大纲树（原父节点不存在时挂回总纲根，§9.4）。', confirmText: '恢复' });
    if (ok) void store.restoreTrash(id).catch((err) => store.showToast((err as Error).message, 'error'));
  };
  const purge = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: `永久删除「${title}」？`,
      message: '此操作不可恢复：内容文件将从回收站彻底删除（§9.4）。',
      confirmText: '永久删除',
      danger: true,
    });
    if (ok) void store.purgeTrash(id).catch((err) => store.showToast((err as Error).message, 'error'));
  };
  return (
    <div className="tree-row">
      <span className={`tree-type tree-type-${type}`}>{type}</span>
      <span className="tree-title">{title}</span>
      <span className="muted small">{new Date(movedAt).toLocaleDateString()}</span>
      <div className="row">
        <button className="tiny-btn" onClick={() => void restore()}>恢复</button>
        <button className="tiny-btn" onClick={() => void purge()}>永久删除</button>
      </div>
    </div>
  );
}

function NewAssetForm({ onClose }: { onClose: () => void }): React.ReactElement {
  const [type, setType] = React.useState('character');
  const [title, setTitle] = React.useState('');
  const [content, setContent] = React.useState('');
  return (
    <div className="mini-form">
      <select value={type} onChange={(e) => setType(e.target.value)}>
        {Object.entries(ASSET_TYPE_LABELS).map(([value, label]) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>
      <input placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea placeholder="内容（markdown）" value={content} onChange={(e) => setContent(e.target.value)} />
      <div className="row">
        <button
          className="primary"
          disabled={!title.trim()}
          onClick={() => { void store.createAsset(type, title, content); onClose(); }}
        >
          保存
        </button>
        <button className="small-btn" onClick={onClose}>取消</button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- 面板

export function LeftPanel({ collapsed }: { collapsed?: boolean }): React.ReactElement {
  const tab = useStore((s) => s.tab);
  const project = useStore((s) => s.project);
  const treeSearch = useStore((s) => s.treeSearch);
  const [showNewAsset, setShowNewAsset] = React.useState(false);
  const [showNewNode, setShowNewNode] = React.useState(false);
  const [newNodeType, setNewNodeType] = React.useState<'volume' | 'chapter' | 'scene'>('chapter');
  const [newNodeTitle, setNewNodeTitle] = React.useState('');

  if (!project) return <></>;

  const roots = project.nodes.filter((n) => n.parentId === null);
  const assets = project.assets;
  const sessions = project.sessions;
  const trash = project.trash;
  const hasAssets = assets.length > 0;

  const switchTab = (t: TabId): void => {
    store.setTab(t);
    if (t === 'assets' && !hasAssets) setShowNewAsset(true);
  };

  const createNode = async (): Promise<void> => {
    if (!newNodeTitle.trim()) return;
    const selected = store.getState().selected;
    const parentId = selected?.kind === 'node' ? selected.id : project.nodes[0]?.id;
    if (!parentId) return;
    try {
      await store.createNode(parentId, newNodeType, newNodeTitle.trim());
      setNewNodeTitle('');
      setShowNewNode(false);
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    }
  };

  return (
    <aside className={`left-panel${collapsed ? ' collapsed' : ''}`}>
      <div className="tabs">
        <button className={tab === 'outline' ? 'tab active' : 'tab'} onClick={() => switchTab('outline')}>大纲</button>
        <button className={tab === 'assets' ? 'tab active' : 'tab'} onClick={() => switchTab('assets')}>设定{assets.length > 0 ? ` (${assets.length})` : ''}</button>
        <button className={tab === 'sessions' ? 'tab active' : 'tab'} onClick={() => switchTab('sessions')}>会话{sessions.length > 0 ? ` (${sessions.length})` : ''}</button>
        {trash.length > 0 && (
          <button className={tab === 'trash' ? 'tab active' : 'tab'} onClick={() => switchTab('trash')}>回收站 ({trash.length})</button>
        )}
      </div>

      <div className="panel-body">
        {tab === 'outline' && (
          <>
            <div className="tree-search">
              <input
                placeholder="搜索节点…"
                value={treeSearch}
                onChange={(e) => store.setTreeSearch(e.target.value)}
              />
            </div>
            {roots.map((n) => <OutlineTreeItem key={n.id} node={n} depth={0} />)}
            {roots.length === 0 && <p className="muted small">还没有节点。</p>}
            <button className="subtle" onClick={() => setShowNewNode(!showNewNode)}>
              ＋ 新建节点
            </button>
            {showNewNode && (
              <div className="mini-form">
                <select value={newNodeType} onChange={(e) => setNewNodeType(e.target.value as never)}>
                  <option value="volume">卷</option>
                  <option value="chapter">章</option>
                  <option value="scene">场景</option>
                </select>
                <input
                  autoFocus
                  placeholder="标题"
                  value={newNodeTitle}
                  onChange={(e) => setNewNodeTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void createNode(); }}
                />
                <button className="primary" onClick={() => void createNode()}>创建</button>
              </div>
            )}
          </>
        )}

        {tab === 'assets' && (
          <>
            {assets.length === 0 && !showNewAsset && (
              <p className="muted small">还没有设定。讨论中的灵感整理后会自动落到这里。</p>
            )}
            {assets.map((a) => <AssetItem key={a.id} assetId={a.id} title={a.title} type={a.type} />)}
            <button className="subtle" onClick={() => setShowNewAsset(!showNewAsset)}>＋ 新建设定</button>
            {showNewAsset && <NewAssetForm onClose={() => setShowNewAsset(false)} />}
          </>
        )}

        {tab === 'sessions' && (
          <>
            {sessions.length === 0 && <p className="muted small">还没有会话。「开启新话题」会新建一条对话；归档后移入下方「归档」层级。</p>}
            {(() => {
              const active = sessions.filter((s) => s.archived !== true);
              const archivedList = sessions.filter((s) => s.archived === true);
              return (
                <>
                  {active.length > 0 && (
                    <>
                      <div className="session-group-title">活跃对话（可继续聊）</div>
                      {active.map((s) => <SessionItem key={s.id} session={s} />)}
                    </>
                  )}
                  {archivedList.length > 0 && (
                    <>
                      <div className="session-group-title">归档（只读）</div>
                      {archivedList.map((s) => <SessionItem key={s.id} session={s} />)}
                    </>
                  )}
                </>
              );
            })()}
          </>
        )}

        {tab === 'trash' && (
          <>
            <p className="muted small">删除的节点先进回收站（§9.4）；永久删除需单独确认。</p>
            {trash.map((t) => (
              <TrashItem key={t.id} id={t.id} title={t.title} type={t.type} movedAt={t.movedAt} />
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
