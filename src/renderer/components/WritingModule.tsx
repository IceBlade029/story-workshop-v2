/**
 * WritingModule.tsx — 正文模块（ux-review §5.1）。
 *
 * ┌──────────┬────────────────────────────────────────┐
 * │ 场景列表   │ [格式选择] [生成正文] [复制全文]           │
 * │ (树形导航  ├────────────────────────────────────────┤
 * │  卷→章→   │ 可见视图折叠区（模块内闭环）               │
 * │  场景)    │  - 细纲/可见视图对照 · 重新生成 · 手改      │
 * │          ├────────────────────────────────────────┤
 * │          │ 正文工作区：                             │
 * │          │  阅读模式（markdown 渲染）               │
 * │          │    ↕ 「编辑」切换                        │
 * │          │  编辑模式（textarea）                    │
 * │          ├────────────────────────────────────────┤
 * │          │ [基于反馈重写]（展开输入框，全局重生成）    │
 * └──────────┴────────────────────────────────────────┘
 *
 * - 场景列表：卷→章→场景树形导航到场景，只导航、场景外节点不可选；
 * - 可见视图在模块内闭环（细纲→可见视图→正文不用切模块）；
 * - 生成中：正文工作区流式显示正文（「正在写作…」+ 停止按钮），讨论模块零打扰；
 * - 反馈重生成（全局）收进操作条，与就地改写（局部，§5.3 Phase 6）并列。
 */
import React, { useEffect, useRef } from 'react';
import { store, useStore } from '../store';
import { confirmDialog } from './ui/dialog';
import { MarkdownView } from './ui/MarkdownView';
import { CallInspectionDialog } from './ui/CallInspectionDialog';
import type { NodeSummary } from '../../shared/ipc-types';
import type { VisibleView } from '../../shared/types';

// --------------------------------------------------------------------------- 场景树

function SceneTreeItem({ node, depth, onSelect }: {
  node: NodeSummary;
  depth: number;
  onSelect: (id: string) => void;
}): React.ReactElement {
  const project = useStore((s) => s.project);
  const selected = useStore((s) => s.writingSceneId === node.id);
  const [open, setOpen] = React.useState(true);
  const directChildren = project?.nodes.filter((n) => n.parentId === node.id) ?? [];
  // 隐藏中间层级（§3.1）：不显示，其子节点提升一层显示
  const visibleChildren = directChildren.flatMap((c) => {
    if (c.hidden) return project?.nodes.filter((n) => n.parentId === c.id) ?? [];
    return [c];
  });
  const isScene = node.type === 'scene';
  const selectable = isScene;
  const typeLabel: Record<string, string> = { overview: '总纲', volume: '卷', chapter: '章', scene: '场景' };

  return (
    <div className="tree-item">
      <div
        className={`tree-row${selected ? ' selected' : ''}${!selectable ? ' tree-row-nav' : ''}`}
        style={{ paddingLeft: depth * 14 + 6 }}
        data-testid={isScene ? `writing-scene-${node.id}` : undefined}
        onClick={() => { if (selectable) onSelect(node.id); }}
        title={selectable ? node.title : `${node.title}（导航）`}
      >
        {visibleChildren.length > 0 && (
          <button
            className="tree-toggle"
            onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
          >
            {open ? '▾' : '▸'}
          </button>
        )}
        <span className={`tree-type tree-type-${node.type}`}>{typeLabel[node.type] ?? node.type}</span>
        <span className="tree-title">{node.title}</span>
        {isScene && node.visibleView?.exists && <span className="badge">视图</span>}
        {isScene && node.outputFormats.length > 0 && <span className="badge">正文 ×{node.outputFormats.length}</span>}
      </div>
      {open && visibleChildren.map((c) => <SceneTreeItem key={c.id} node={c} depth={depth + 1} onSelect={onSelect} />)}
    </div>
  );
}

// --------------------------------------------------------------------------- 可见视图折叠区（模块内闭环，§5.1）

function VisibleViewFold({ scene }: { scene: NodeSummary }): React.ReactElement {
  const project = useStore((s) => s.project);
  const viewStatus = project?.nodes.find((n) => n.id === scene.id)?.visibleView;
  const [open, setOpen] = React.useState(true);
  const [view, setView] = React.useState<VisibleView | null>(null);
  const [text, setText] = React.useState('');
  const [source, setSource] = React.useState<string | null>(null);
  const [showCompare, setShowCompare] = React.useState(false);

  const reload = React.useCallback(async (): Promise<void> => {
    const v = await store.loadVisibleView(scene.id);
    setView(v);
    setText(v?.content ?? '');
    setSource(null);
    setShowCompare(false);
  }, [scene.id]);

  useEffect(() => { void reload(); }, [reload, viewStatus?.sourceHash]);

  const generate = async (): Promise<void> => {
    try {
      await store.generateVisibleView(scene.id);
      store.showToast('可见视图已生成', 'success');
      await reload();
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    }
  };

  const save = async (): Promise<void> => {
    try {
      await store.saveVisibleView(scene.id, text);
      store.showToast('已保存手改（该视图此后受保护，不静默覆盖）', 'success');
      await reload();
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    }
  };

  const regenerate = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: '重新生成可见视图？',
      message: '重新生成会覆盖你的手改（§6.4）。',
      confirmText: '重新生成',
      danger: true,
    });
    if (ok) await generate();
  };

  const toggleCompare = async (): Promise<void> => {
    if (!showCompare && source === null) {
      const content = await store.readNodeContent(scene.id);
      setSource(content.draft ?? content.official);
    }
    setShowCompare(!showCompare);
  };

  return (
    <div className="view-fold">
      <button className="view-fold-head" onClick={() => setOpen(!open)}>
        <span>{open ? '▾' : '▸'}</span> 可见视图
        {view && <span className="muted small">（生成于 {new Date(view.generatedAt).toLocaleString()}）</span>}
        {view?.userEdited && <span className="badge">已手改</span>}
        {view?.needsRegeneration && <span className="badge badge-stale">需重新生成</span>}
      </button>
      {open && (
        <div className="view-fold-body">
          {!view && <p className="muted small">尚未生成。可见视图 = 从细纲确定性移除全部「暂不明示」标记（§6.3，无模型参与）。</p>}
          {view?.needsRegeneration && (
            <div className="stale-banner">
              细纲已变更。重新生成会覆盖你的手改，确认后执行（§6.4）。
              <button className="small-btn" onClick={() => void regenerate()}>重新生成（覆盖手改）</button>
            </div>
          )}
          <textarea
            data-testid="view-editor"
            className="view-textarea"
            placeholder={view ? '可见视图文本（可手改，§6.4）' : '点击「生成可见视图」从细纲生成'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!view}
          />
          {view && (
            <div className="row">
              <button className="small-btn" onClick={() => void save()}>保存手改</button>
              <button className="tiny-btn" onClick={() => void toggleCompare()}>
                {showCompare ? '收起对照' : '对照细纲'}
              </button>
              {view.needsRegeneration && (
                <button className="small-btn" onClick={() => void regenerate()}>重新生成（覆盖手改）</button>
              )}
            </div>
          )}
          {!view && (
            <div className="row">
              <button className="small-btn" onClick={() => void generate()}>生成可见视图</button>
            </div>
          )}
          {showCompare && (
            <div className="compare-row">
              <div>
                <div className="muted small">细纲（含暂不明示标记）</div>
                <div className="compare-block"><MarkdownView text={source ?? '（无细纲内容）'} /></div>
              </div>
              <div>
                <div className="muted small">可见视图（已移除标记）</div>
                <div className="compare-block"><MarkdownView text={view?.content ?? ''} /></div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- 正文工作区

/** 就地改写预设动作（ux-review §5.3：预设 + 自定义同管道）。 */
const REVISE_PRESETS = ['更有张力', '扩写', '精简', '润色'];

function TextWorkspace({ scene, format }: { scene: NodeSummary; format: string }): React.ReactElement {
  const project = useStore((s) => s.project);
  const activeRun = useStore((s) => s.activeRun);
  const running = activeRun?.kind === 'detail_fill' && activeRun.status === 'running';
  const revising = activeRun?.kind === 'revise' && activeRun.status === 'running';
  const viewStatus = project?.nodes.find((n) => n.id === scene.id)?.visibleView;
  const [mode, setMode] = React.useState<'read' | 'edit'>('read');
  const [text, setText] = React.useState('');
  const [outputs, setOutputs] = React.useState<Array<{ format: string; stale: boolean }>>([]);
  const [feedbackOpen, setFeedbackOpen] = React.useState(false);
  const [feedback, setFeedback] = React.useState('');
  // §5.3：选区改写（textarea selectionStart/End 直接对应文件区间）
  const [selection, setSelection] = React.useState<{ start: number; end: number } | null>(null);
  const [customRevise, setCustomRevise] = React.useState(false);
  const [customText, setCustomText] = React.useState('');
  const [preview, setPreview] = React.useState<{ start: number; end: number } | null>(null);
  const taRef = React.useRef<HTMLTextAreaElement>(null);

  const reload = React.useCallback(async (): Promise<void> => {
    setOutputs(await store.loadOutputs(scene.id));
    const content = await store.readOutput(scene.id, format).catch(() => '');
    setText(content);
  }, [scene.id, format]);

  // 重新生成/反馈重生成/改写完成后刷新；编辑模式不覆盖用户输入
  useEffect(() => {
    if (!running && !revising) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, revising, activeRun?.runId, scene.id, format]);

  // §5.1：生成中正文工作区流式显示正文（「正在写作…」+ 停止按钮，讨论模块零打扰）
  const streamingText = running ? activeRun.chunks.join('') : '';
  const displayText = running ? streamingText : text;

  const generate = (feedbackText?: string): void => {
    if (activeRun?.status === 'running') return;
    if (!viewStatus?.exists) {
      store.showToast('请先生成可见视图', 'error');
      return;
    }
    if (viewStatus.needsRegeneration) {
      store.showToast('可见视图与细纲不一致，请先在「可见视图」折叠区重新生成（§6.4）', 'error');
      return;
    }
    void store.detailFill(scene.id, format, feedbackText).catch((err) => store.showToast((err as Error).message, 'error'));
    if (feedbackText) setFeedback('');
  };

  // §5.3：编辑模式选中文本 → 浮动条改写（预设动作 / 自定义同管道）
  const onSelect = (): void => {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart, selectionEnd } = ta;
    if (selectionEnd > selectionStart) {
      setSelection({ start: selectionStart, end: selectionEnd });
    } else {
      setSelection(null);
    }
  };

  const startRevise = (instruction: string): void => {
    if (!selection || revising) return;
    const start = selection.start;
    const end = selection.end;
    setPreview({ start, end });
    setSelection(null);
    setCustomRevise(false);
    setCustomText('');
    void store.revise(scene.id, format, start, end, instruction).catch((err) => store.showToast((err as Error).message, 'error'));
  };

  const acceptRevise = (): void => {
    if (!preview) return;
    const replacement = activeRun?.chunks.join('') ?? '';
    void store
      .applyRevise(scene.id, format, preview.start, preview.end, replacement)
      .then(() => {
        store.showToast('改写已接受', 'success');
        setPreview(null);
      })
      .catch((err) => store.showToast((err as Error).message, 'error'));
  };

  const undoLastRevise = async (): Promise<void> => {
    try {
      await store.undoRevise(scene.id, format);
      store.showToast('已撤销上次改写', 'success');
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    }
  };

  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(
      () => store.showToast('全文已复制', 'success'),
      () => store.showToast('复制失败', 'error'),
    );
  };

  return (
    <div className="text-workspace">
      {running && (
        <div className="writing-status">
          <span>正在写作…（流式生成中，可随时停止）</span>
          <button className="small-btn" onClick={() => void store.cancelRun()}>停止</button>
        </div>
      )}
      {revising && preview && (
        <div className="revise-card">
          <div className="revise-card-head">
            <span>就地改写中…（替换选中区间，§5.3）</span>
            <button className="small-btn" onClick={() => void store.cancelRun()}>停止</button>
          </div>
          <pre className="msg-content">{activeRun.chunks.join('') || '（改写中…）'}</pre>
          <div className="row">
            <button className="primary" disabled={activeRun.status === 'running'} onClick={acceptRevise}>
              接受
            </button>
            <button className="small-btn" disabled={activeRun.status === 'running'} onClick={() => setPreview(null)}>
              放弃
            </button>
            <button className="small-btn" disabled={activeRun.status === 'running'} onClick={() => void store.retryRun()}>
              重试
            </button>
            <span className="muted small">替换精度契约：AI 只返回选中区间的完整替换文本（要删除返回空）</span>
          </div>
        </div>
      )}
      {mode === 'read' ? (
        <div className="writing-content" onClick={() => { if (!running && !revising) setMode('edit'); }} title={running ? '生成中…' : '点击进入编辑模式'}>
          {displayText ? (
            running ? <pre className="msg-content">{displayText}</pre> : <MarkdownView text={displayText} />
          ) : (
            <p className="muted">还没有正文。选择格式后点击「生成正文」；也可编辑正文（点击此处切换编辑模式）。</p>
          )}
        </div>
      ) : (
        <div className="writing-edit-wrap">
          {selection && !revising && (
            <div className="revise-bar">
              {REVISE_PRESETS.map((p) => (
                <button key={p} className="tiny-btn" onClick={() => startRevise(p)}>{p}</button>
              ))}
              <button className="tiny-btn" onClick={() => setCustomRevise(!customRevise)}>自定义…</button>
              {customRevise && (
                <input
                  className="revise-custom"
                  placeholder="告诉 AI 你想怎么改…"
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') startRevise(customText.trim()); }}
                />
              )}
              <span className="muted small">已选中 {selection.end - selection.start} 字</span>
            </div>
          )}
          <textarea
            ref={taRef}
            data-testid="output-editor"
            className="writing-editor"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onSelect={onSelect}
            onMouseUp={onSelect}
            onKeyUp={onSelect}
            placeholder="正文编辑模式：选中文本可就地改写（§5.3）"
          />
        </div>
      )}
      <div className="row">
        <button className="tiny-btn" onClick={() => setMode(mode === 'read' ? 'edit' : 'read')}>
          {mode === 'read' ? '编辑' : '完成编辑'}
        </button>
        <button className="tiny-btn" onClick={() => void undoLastRevise()} title="撤销上次改写（单级，§5.3）">
          ↩ 撤销上次改写
        </button>
        {outputs.find((o) => o.format === format)?.stale && <span className="badge badge-stale">已失效（可见视图已变更）</span>}
        <span className="spacer" />
        <button className="small-btn" onClick={() => setFeedbackOpen(!feedbackOpen)}>基于反馈重写</button>
      </div>
      {feedbackOpen && (
        <div className="row">
          <textarea
            className="feedback-box"
            placeholder="修改意见（重生成的输入 = 上一版输出 + 反馈，仍只读可见视图，§6.5）…"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="small-btn" disabled={!feedback.trim()} onClick={() => generate(feedback.trim())}>
            重新生成
          </button>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- 模块

export function WritingModule(): React.ReactElement {
  const project = useStore((s) => s.project);
  const sceneId = useStore((s) => s.writingSceneId);
  const activeRun = useStore((s) => s.activeRun);
  const running = (activeRun?.kind === 'detail_fill' || activeRun?.kind === 'revise') && activeRun.status === 'running';
  // 最近一次写作任务的调用详情入口（沙箱隔离后写作任务在讨论中零痕迹，§4.7）
  const lastWritingRunId = useStore((s) => s.lastWritingRunId);
  const [inspectOpen, setInspectOpen] = React.useState(false);
  const [formats, setFormats] = React.useState<string[]>([]);
  const [format, setFormat] = React.useState('');

  useEffect(() => {
    void store.loadFormats().then((f) => {
      setFormats(f);
      setFormat((prev) => (prev && f.includes(prev) ? prev : f[0] ?? ''));
    });
  }, []);

  if (!project) return <></>;
  const roots = project.nodes.filter((n) => n.parentId === null);
  const scene = project.nodes.find((n) => n.id === sceneId && n.type === 'scene') ?? null;

  return (
    <div className="writing-module">
      <aside className="writing-scenes">
        <div className="ws-head"><h3>场景</h3><span className="muted small">只导航 · 选择后右侧操作</span></div>
        <div className="scene-tree">
          {roots.map((n) => <SceneTreeItem key={n.id} node={n} depth={0} onSelect={(id) => store.setWritingScene(id)} />)}
          {roots.length === 0 && <p className="muted small">还没有大纲节点。</p>}
        </div>
      </aside>
      <div className="writing-main">
        {!scene ? (
          <div className="workspace-body">
            <div className="empty-state">
              <span className="empty-icon">◇</span>
              <p>从左侧选择一个场景。</p>
              <p className="muted small">正文工作区：可见视图 → 正文（§5.1），大纲与讨论在「情节讨论」模块。</p>
            </div>
          </div>
        ) : (
          <>
            <div className="writing-toolbar">
              <select value={format} onChange={(e) => setFormat(e.target.value)} disabled={running}>
                {formats.map((f) => <option key={f} value={f}>{f === 'novel' ? '小说' : f === 'script' ? '剧本' : f}</option>)}
              </select>
              <button className="primary" disabled={running} onClick={() => generate(scene.id, format)}>
                {running ? '写作中…' : '生成正文'}
              </button>
              <button className="small-btn" onClick={() => void copy(scene.id, format)}>复制全文</button>
              {lastWritingRunId && (
                <button className="tiny-btn" onClick={() => setInspectOpen(true)} title="最近一次写作任务的调用详情（§4.7）">
                  ⓘ 调用详情
                </button>
              )}
              <span className="muted small">输出落盘 outputs/（§6.5：正文生成只读可见视图 + 模板）</span>
            </div>
            {inspectOpen && lastWritingRunId && <CallInspectionDialog runId={lastWritingRunId} onClose={() => setInspectOpen(false)} />}
            <VisibleViewFold scene={scene} />
            <TextWorkspace scene={scene} format={format} />
          </>
        )}
      </div>
    </div>
  );

  // 生成正文（含反馈）：校验视图后启动 detail_fill run
  function generate(sceneId: string, format: string): void {
    if (!project) return;
    const viewStatus = project.nodes.find((n) => n.id === sceneId)?.visibleView;
    if (!viewStatus?.exists) {
      store.showToast('请先生成可见视图', 'error');
      return;
    }
    if (viewStatus.needsRegeneration) {
      store.showToast('可见视图与细纲不一致，请先在「可见视图」折叠区重新生成（§6.4）', 'error');
      return;
    }
    void store.detailFill(sceneId, format).catch((err) => store.showToast((err as Error).message, 'error'));
  }

  function copy(sceneId: string, format: string): void {
    void store.readOutput(sceneId, format).then((content) => navigator.clipboard.writeText(content))
      .then(() => store.showToast('全文已复制', 'success'))
      .catch(() => store.showToast('复制失败', 'error'));
  }
}
