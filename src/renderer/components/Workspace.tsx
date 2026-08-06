/**
 * Workspace.tsx — 右栏：知识库对象详情查看器（ux-review §4.6）。
 *
 * 职责收敛为单一功能：查看/编辑当前选中的知识库对象（节点、设定）。
 * 只保留两种模式：节点详情（草稿/正式版/版本历史/重命名/子节点/提交为正式版/删除——
 * 可见视图与正文已归正文模块）、设定详情（标题/类型/内容编辑/删除）。
 *
 * - 回退按钮 = 查看历史栈（浏览器式 ←）：左栏选择不压栈，跳转类操作压栈；
 * - 空态 = 项目概况（大纲节点数 / 设定数 / 输出数等轻统计，静态信息）。
 */
import React from 'react';
import { store, useStore } from '../store';
import { confirmDialog, promptDialog } from './ui/dialog';
import { MarkdownEditor } from './ui/MarkdownEditor';
import { MarkdownView } from './ui/MarkdownView';
import type { NodeSummary, NodeVersion } from '../../shared/ipc-types';

// ---------------------------------------------------------------------------
// 节点版本历史（§5.5）
// ---------------------------------------------------------------------------

function VersionHistory({ node }: { node: NodeSummary }): React.ReactElement {
  const [versions, setVersions] = React.useState<NodeVersion[] | null>(null);
  const [preview, setPreview] = React.useState<{ snapshotId: string; content: string } | null>(null);

  React.useEffect(() => {
    void store.loadVersions(node.id).then(setVersions);
  }, [node.id]);

  const view = async (snapshotId: string): Promise<void> => {
    const content = await store.readVersion(node.id, snapshotId);
    setPreview({ snapshotId, content });
  };

  const restore = async (snapshotId: string): Promise<void> => {
    if (!preview || preview.snapshotId !== snapshotId) return;
    const ok = await confirmDialog({
      title: '恢复该版本为正式版？',
      message: `正式版将替换为 ${snapshotId} 的内容。`,
      confirmText: '恢复',
    });
    if (!ok) return;
    await store.writeOfficial(node.id, preview.content);
    store.showToast('已恢复该版本为正式版', 'success');
  };

  if (versions === null) return <p className="muted">加载中…</p>;
  if (versions.length === 0) {
    return <p className="muted">还没有版本历史。提交为正式版（§5.5）后，每一版都会出现在这里。</p>;
  }
  return (
    <div className="editor">
      <ul className="changes">
        {versions.map((v) => (
          <li key={v.snapshotId}>
            <strong>{v.snapshotId}</strong>
            <span className="muted small"> {new Date(v.createdAt).toLocaleString()}</span>
            <span className="muted small"> hash {v.hash.slice(0, 8)}…</span>
            <button className="tiny-btn" onClick={() => void view(v.snapshotId)}>查看</button>
            {preview?.snapshotId === v.snapshotId && (
              <button className="tiny-btn" onClick={() => void restore(v.snapshotId)}>恢复此版本</button>
            )}
          </li>
        ))}
      </ul>
      {preview && <div className="compare-block"><MarkdownView text={preview.content} /></div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 节点查看（ux-review §4.6：草稿 / 正式版 / 版本历史 / 重命名 / 子节点 / 提交 / 删除）
// ---------------------------------------------------------------------------

function NodeView({ node }: { node: NodeSummary }): React.ReactElement {
  const [draft, setDraft] = React.useState('');
  const [official, setOfficial] = React.useState('');
  const isScene = node.type === 'scene';
  const [tab, setTab] = React.useState<'draft' | 'official'>('draft');
  const [showVersions, setShowVersions] = React.useState(false);

  // 初始化编辑器（读盘）；保存（hasDraft/hasOfficial 变化）后重新同步
  React.useEffect(() => {
    void store.readNodeContent(node.id).then((c) => {
      setDraft(c.draft ?? '');
      setOfficial(c.official ?? '');
    });
  }, [node.id, node.hasDraft, node.hasOfficial]);

  /** 提交为正式版（§5.5）：先展示影响汇总，默认排除带「待定：」标记的节点。 */
  const commit = async (): Promise<void> => {
    const ids = store.subtreeIds(node.id);
    const contents = await Promise.all(ids.map(async (id) => ({ id, content: await store.readNodeContent(id) })));
    const withDraft = contents.filter((x) => x.content.draft);
    const pending = withDraft.filter((x) => x.content.draft!.includes('待定：'));
    const toCommit = withDraft.filter((x) => !x.content.draft!.includes('待定：'));
    const summary = [
      `子树共 ${ids.length} 个节点`,
      `待提交 ${toCommit.length} 个（${toCommit.map((x) => x.content.title).join('、') || '—'}）`,
      pending.length > 0 ? `默认排除「待定：」标记节点 ${pending.length} 个（${pending.map((x) => x.content.title).join('、')}）` : '',
      '提交 = 草稿复制为正式版，并写入版本历史（§5.5）。',
    ].filter(Boolean).join('\n');
    const ok = await confirmDialog({ title: '提交为正式版？', message: summary, confirmText: '提交' });
    if (!ok) return;
    const msg = await store.commitNodes(ids, false);
    store.showToast(msg ?? '无草稿可提交', msg ? 'success' : 'info');
  };

  const addChild = async (): Promise<void> => {
    const type = await promptDialog({
      title: '新建子节点',
      message: '类型（volume / chapter / scene）。场景下不允许再建子节点；卷下建场景会自动插入隐藏章（§3.1）。',
      defaultValue: 'chapter',
    });
    if (!type) return;
    const title = await promptDialog({ title: '新节点标题', defaultValue: '' });
    if (title) {
      try {
        await store.createNode(node.id, type as never, title);
      } catch (err) {
        store.showToast((err as Error).message, 'error');
      }
    }
  };

  const remove = async (): Promise<void> => {
    if (node.id === 'overview') return;
    const ok = await confirmDialog({
      title: `删除节点「${node.title}」及其子树？`,
      message: '删除先进回收站（§9.4），可在左栏「回收站」恢复。',
      confirmText: '删除',
      danger: true,
    });
    if (ok) void store.deleteNode(node.id);
  };

  const rename = async (): Promise<void> => {
    const title = await promptDialog({ title: '重命名', defaultValue: node.title });
    if (title && title !== node.title) void store.renameNode(node.id, title);
  };

  /** 保存草稿（带反馈：成功 toast + 失败原因，避免「点击没反应」）。 */
  const saveDraft = async (): Promise<void> => {
    try {
      await store.writeDraft(node.id, draft);
      store.showToast('草稿已保存', 'success');
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    }
  };

  /** 保存正式版（带反馈）。 */
  const saveOfficial = async (): Promise<void> => {
    try {
      await store.writeOfficial(node.id, official);
      store.showToast('正式版已保存', 'success');
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    }
  };

  const activeTab = tab === 'draft' || tab === 'official' ? tab : 'draft';

  return (
    <div className="workspace-body">
      <div className="ws-head">
        <span className="tree-type tree-type-node">{node.type}</span>
        <h2>{node.title}</h2>
        {node.aiCreated && <span className="badge badge-ai">AI 新增</span>}
        {node.hasDraft && <span className="badge">有草稿</span>}
        {node.visibleView?.exists && <span className="badge">可见视图</span>}
        {node.outputFormats.length > 0 && <span className="badge">正文 ×{node.outputFormats.length}</span>}
      </div>
      <div className="row">
        <button className="small-btn" onClick={() => void rename()}>重命名</button>
        <button className="small-btn" onClick={() => void addChild()}>＋ 子节点</button>
        <button className="small-btn" onClick={() => void commit()}>提交为正式版（含子树）</button>
        <button className="small-btn" onClick={() => setShowVersions(!showVersions)}>
          {showVersions ? '收起版本历史' : '版本历史'}
        </button>
        {node.id !== 'overview' && <button className="small-btn danger" onClick={() => void remove()}>删除</button>}
      </div>

      {showVersions && <VersionHistory node={node} />}

      <div className="tabs">
        <button className={activeTab === 'draft' ? 'tab active' : 'tab'} onClick={() => setTab('draft')}>草稿</button>
        <button className={activeTab === 'official' ? 'tab active' : 'tab'} onClick={() => setTab('official')}>正式版</button>
      </div>

      {activeTab === 'draft' && (
        <MarkdownEditor
          dataTestId="draft-editor"
          placeholder="草稿内容（写细纲 / 审阅 AI 整理结果）"
          value={draft}
          onChange={setDraft}
          onSave={() => void saveDraft()}
          showMarkerCount={isScene}
        />
      )}
      {activeTab === 'draft' && (
        <div className="row">
          <button className="primary" onClick={() => void saveDraft()}>保存草稿</button>
          <span className="muted small">Ctrl+S 保存 · 提交正式版会把草稿复制为正式版（§5.5）</span>
        </div>
      )}
      {activeTab === 'official' && (
        <MarkdownEditor
          dataTestId="official-editor"
          placeholder="正式版内容"
          value={official}
          onChange={setOfficial}
          onSave={() => void saveOfficial()}
          showMarkerCount={isScene}
        />
      )}
      {activeTab === 'official' && (
        <div className="row">
          <button className="primary" onClick={() => void saveOfficial()}>保存正式版</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 设定
// ---------------------------------------------------------------------------

function AssetView({ assetId }: { assetId: string }): React.ReactElement {
  const project = useStore((s) => s.project);
  const asset = project?.assets.find((a) => a.id === assetId);
  const [type, setType] = React.useState(asset?.type ?? 'misc');
  const [title, setTitle] = React.useState(asset?.title ?? '');
  const [content, setContent] = React.useState(asset?.content ?? '');

  React.useEffect(() => {
    setType(asset?.type ?? 'misc');
    setTitle(asset?.title ?? '');
    setContent(asset?.content ?? '');
  }, [assetId, asset?.hash]);

  const remove = async (): Promise<void> => {
    if (!asset) return;
    const ok = await confirmDialog({ title: '删除该设定？', message: '删除后不可恢复（§3.6：设定写出来就是事实，错误靠快照回滚兜底）。', confirmText: '删除', danger: true });
    if (ok) void store.deleteAsset(asset.id);
  };

  /** 保存设定（带反馈：成功 toast + 失败原因）。 */
  const save = async (): Promise<void> => {
    if (!asset) return;
    try {
      await store.updateAsset(asset.id, { type, title, content });
      store.showToast('设定已保存', 'success');
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    }
  };

  if (!asset) return <div className="workspace-body"><p className="muted">设定不存在。</p></div>;

  return (
    <div className="workspace-body">
      <div className="ws-head"><h2>{asset.title || '（未命名）'}</h2></div>
      <div className="editor">
        <div className="row">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标题" style={{ flex: 1 }} />
          <input value={type} onChange={(e) => setType(e.target.value)} placeholder="类型" style={{ width: 150 }} />
        </div>
        <MarkdownEditor
          placeholder="设定内容（markdown，自由格式）"
          value={content}
          onChange={setContent}
          onSave={() => void save()}
        />
        <div className="row">
          <button className="primary" onClick={() => void save()}>保存</button>
          <button className="small-btn danger" onClick={() => void remove()}>删除</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 空态：项目概况（ux-review §4.6：轻统计，静态信息，非引导卡）
// ---------------------------------------------------------------------------

function ProjectOverview(): React.ReactElement {
  const project = useStore((s) => s.project);
  if (!project) return <></>;
  const nodeCount = project.nodes.length;
  const sceneCount = project.nodes.filter((n) => n.type === 'scene').length;
  const outputCount = project.nodes.reduce((sum, n) => sum + n.outputFormats.length, 0);
  return (
    <div className="workspace-body">
      <div className="ws-head"><h2>项目概况</h2></div>
      <div className="overview-grid">
        <div className="overview-item"><span className="overview-num">{nodeCount}</span><span className="muted small">大纲节点（场景 {sceneCount}）</span></div>
        <div className="overview-item"><span className="overview-num">{project.assets.length}</span><span className="muted small">设定</span></div>
        <div className="overview-item"><span className="overview-num">{project.attachments.length}</span><span className="muted small">附件</span></div>
        <div className="overview-item"><span className="overview-num">{outputCount}</span><span className="muted small">已生成正文</span></div>
      </div>
      <p className="muted small">从左侧选择节点或设定查看详情。</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 工作台入口
// ---------------------------------------------------------------------------

export function Workspace(): React.ReactElement {
  const mode = useStore((s) => s.workspaceMode);
  const selected = useStore((s) => s.selected);
  const viewHistory = useStore((s) => s.viewHistory);
  const project = useStore((s) => s.project);

  if (!project) return <></>;

  let body: React.ReactElement;
  if (mode === 'node' && selected?.kind === 'node') {
    const node = project.nodes.find((n) => n.id === selected.id);
    body = node ? <NodeView node={node} /> : <div className="workspace-body"><p className="muted">节点不存在。</p></div>;
  } else if (mode === 'asset' && selected?.kind === 'asset') {
    body = <AssetView assetId={selected.id} />;
  } else {
    body = <ProjectOverview />;
  }

  const backLabel = viewHistory.length > 0
    ? viewHistory[viewHistory.length - 1].kind === 'node'
      ? project.nodes.find((n) => n.id === viewHistory[viewHistory.length - 1].id)?.title
      : project.assets.find((a) => a.id === viewHistory[viewHistory.length - 1].id)?.title
    : undefined;

  return (
    <aside className="workspace">
      {backLabel && (
        <div className="ws-back">
          <button className="tiny-btn" onClick={() => store.viewBack()} title="回到跳转前正在查看的对象（§4.6）">
            ← {backLabel}
          </button>
        </div>
      )}
      {body}
    </aside>
  );
}
