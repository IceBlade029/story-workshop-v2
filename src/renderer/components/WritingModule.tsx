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
import { store, useStore, registerEditorGuard } from '../store';
import { confirmDialog, confirmDiscardDialog } from './ui/dialog';
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
        {/* §6.11 管道状态：缺视图 / 视图失效 / 正文失效 / 正文 ×N */}
        {isScene && !node.visibleView?.exists && <span className="badge badge-muted">缺视图</span>}
        {isScene && node.visibleView?.exists && node.visibleView.needsRegeneration && <span className="badge badge-stale">视图失效</span>}
        {isScene && node.outputStale.length > 0 && <span className="badge badge-stale">正文失效</span>}
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
  const [savedText, setSavedText] = React.useState('');
  const [source, setSource] = React.useState<string | null>(null);
  const [showCompare, setShowCompare] = React.useState(false);

  // 脏状态经 ref 暴露给守卫（避免注册闭包陈旧）
  const textRef = useRef(text);
  textRef.current = text;
  const savedTextRef = useRef(savedText);
  savedTextRef.current = savedText;
  const dirty = text !== savedText;

  const save = React.useCallback(async (): Promise<boolean> => {
    if (textRef.current === savedTextRef.current) return true;
    try {
      await store.saveVisibleView(scene.id, textRef.current);
      setSavedText(textRef.current);
      store.showToast('已保存手改（该视图此后受保护，不静默覆盖）', 'success');
      return true;
    } catch (err) {
      store.showToast((err as Error).message, 'error');
      return false;
    }
  }, [scene.id]);

  // 未保存保护注册（ux-review §6.8）
  useEffect(() => {
    return registerEditorGuard({
      key: `view:${scene.id}`,
      isDirty: () => textRef.current !== savedTextRef.current,
      save,
    });
  }, [scene.id, save]);

  const reload = React.useCallback(async (): Promise<void> => {
    const v = await store.loadVisibleView(scene.id);
    setView(v);
    setText(v?.content ?? '');
    setSavedText(v?.content ?? '');
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

  const saveView = async (): Promise<void> => {
    await save();
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
              <button className="small-btn" disabled={!dirty} onClick={() => void saveView()} title={dirty ? '保存手改' : '已保存（改动后按钮重新亮起）'}>
                保存手改
              </button>
              {dirty && <span className="save-indicator save-dirty">未保存</span>}
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

/** 正文保存状态（ux-review §6.8：持续指示替代 toast 轰炸）。 */
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function TextWorkspace({ scene, format }: { scene: NodeSummary; format: string }): React.ReactElement {
  const project = useStore((s) => s.project);
  const activeRun = useStore((s) => s.activeRun);
  const running = activeRun?.kind === 'detail_fill' && activeRun.status === 'running';
  const revising = activeRun?.kind === 'revise' && activeRun.status === 'running';
  const viewStatus = project?.nodes.find((n) => n.id === scene.id)?.visibleView;
  const [mode, setMode] = React.useState<'read' | 'edit'>('read');
  const [text, setText] = React.useState('');
  const [savedText, setSavedText] = React.useState('');
  const [saveState, setSaveState] = React.useState<SaveState>('idle');
  const [outputs, setOutputs] = React.useState<Array<{ format: string; stale: boolean }>>([]);
  const [feedbackOpen, setFeedbackOpen] = React.useState(false);
  const [feedback, setFeedback] = React.useState('');
  // §5.3：选区改写（textarea selectionStart/End 直接对应文件区间）
  const [selection, setSelection] = React.useState<{ start: number; end: number } | null>(null);
  const [customRevise, setCustomRevise] = React.useState(false);
  const [customText, setCustomText] = React.useState('');
  const [preview, setPreview] = React.useState<{ start: number; end: number } | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const taRef = React.useRef<HTMLTextAreaElement>(null);

  // 脏状态经 ref 暴露给守卫（避免注册闭包陈旧）
  const textRef = useRef(text);
  textRef.current = text;
  const savedTextRef = useRef(savedText);
  savedTextRef.current = savedText;
  const dirty = text !== savedText;

  /** 保存当前正文（写入前主进程建快照 → 版本历史）。返回是否成功。 */
  const save = React.useCallback(async (): Promise<boolean> => {
    if (textRef.current === savedTextRef.current) {
      setSaveState('saved');
      return true;
    }
    setSaveState('saving');
    try {
      await store.saveOutput(scene.id, format, textRef.current);
      setSavedText(textRef.current);
      setSaveState('saved');
      return true;
    } catch (err) {
      setSaveState('error');
      store.showToast((err as Error).message, 'error');
      return false;
    }
  }, [scene.id, format]);

  // 未保存保护注册（ux-review §6.8）
  useEffect(() => {
    return registerEditorGuard({
      key: `output:${scene.id}:${format}`,
      isDirty: () => textRef.current !== savedTextRef.current,
      save,
    });
  }, [scene.id, format, save]);

  const reload = React.useCallback(async (): Promise<void> => {
    setOutputs(await store.loadOutputs(scene.id));
    const content = await store.readOutput(scene.id, format).catch(() => '');
    setText(content);
    setSavedText(content);
    setSaveState('idle');
  }, [scene.id, format]);

  // 生成/改写完成或场景/格式切换（守卫已确认保存或放弃）后刷新；
  // 用户有未保存修改时跳过（不覆盖本地输入）
  useEffect(() => {
    if (!running && !revising) {
      if (textRef.current !== savedTextRef.current) return; // 编辑中：保留本地输入
      void reload();
    }
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
        void reload();
      })
      .catch((err) => store.showToast((err as Error).message, 'error'));
  };

  const undoLastRevise = async (): Promise<void> => {
    try {
      await store.undoRevise(scene.id, format);
      store.showToast('已撤销上次改写', 'success');
      void reload();
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

  /** 完成编辑：脏内容自动保存后切回阅读模式。 */
  const finishEdit = (): void => {
    if (dirty) void save();
    setMode('read');
  };

  const saveIndicator = (): React.ReactElement | null => {
    switch (saveState) {
      case 'saving': return <span className="save-indicator save-saving">保存中…</span>;
      case 'saved': return <span className="save-indicator save-ok">已保存</span>;
      case 'error': return <span className="save-indicator save-error">保存失败（内容已保留，可重试）</span>;
      default: return dirty ? <span className="save-indicator save-dirty">未保存</span> : null;
    }
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
            onKeyDown={(e) => {
              if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
              }
            }}
            placeholder="正文编辑模式：选中文本可就地改写（§5.3）"
          />
        </div>
      )}
      <div className="row">
        <button className="tiny-btn" onClick={() => setMode(mode === 'read' ? 'edit' : 'read')}>
          {mode === 'read' ? '编辑' : '完成编辑'}
        </button>
        {mode === 'edit' && (
          <button className="tiny-btn" disabled={!dirty || saveState === 'saving'} onClick={() => void save()} title="Ctrl+S 保存（写入前自动快照）">
            保存
          </button>
        )}
        <button className="tiny-btn" onClick={() => void undoLastRevise()} title="撤销上次改写（单级，§5.3；多级由版本历史兜底）">
          ↩ 撤销上次改写
        </button>
        <button className="tiny-btn" onClick={() => setHistoryOpen(true)} title="正文版本历史（生成/改写/手工保存各成一版）">
          版本历史
        </button>
        {outputs.find((o) => o.format === format)?.stale && <span className="badge badge-stale">已失效（可见视图已变更）</span>}
        {saveIndicator()}
        <span className="spacer" />
        <button className="small-btn" onClick={() => setFeedbackOpen(!feedbackOpen)}>基于反馈重写</button>
      </div>
      {historyOpen && (
        <OutputVersionDialog
          scene={scene}
          format={format}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => void reload()}
        />
      )}
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

// --------------------------------------------------------------------------- 正文版本历史（ux-review §6.8：复用快照）

function OutputVersionDialog({ scene, format, onClose, onRestored }: {
  scene: NodeSummary;
  format: string;
  onClose: () => void;
  onRestored: () => void;
}): React.ReactElement {
  const [versions, setVersions] = React.useState<Array<import('../../shared/ipc-types').OutputVersion> | null>(null);
  const [preview, setPreview] = React.useState<{ snapshotId: string; content: string } | null>(null);

  React.useEffect(() => {
    void store.loadOutputVersions(scene.id, format).then(setVersions);
  }, [scene.id, format]);

  const view = async (snapshotId: string): Promise<void> => {
    const content = await store.readOutputVersion(scene.id, format, snapshotId);
    setPreview({ snapshotId, content });
  };

  /** 恢复 = 把版本内容作为当前正文保存（写入前自动建新快照，可继续回退）。 */
  const restore = async (snapshotId: string): Promise<void> => {
    if (!preview || preview.snapshotId !== snapshotId) return;
    const ok = await confirmDialog({
      title: '恢复该版本为当前正文？',
      message: '当前正文将被该版本替换（写入前自动快照，可继续回退）。',
      confirmText: '恢复',
    });
    if (!ok) return;
    try {
      await store.saveOutput(scene.id, format, preview.content);
      store.showToast('已恢复该版本', 'success');
      onRestored();
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">正文版本历史 · {scene.title}</h3>
        <div className="dialog-body">
          {versions === null && <p className="muted small">加载中…</p>}
          {versions !== null && versions.length === 0 && (
            <p className="muted small">还没有版本。生成正文、接受改写或手工保存后，每一版都会出现在这里。</p>
          )}
          {versions !== null && versions.length > 0 && (
            <ul className="changes">
              {versions.map((v) => (
                <li key={v.snapshotId}>
                  <strong>{v.snapshotId === 'current' ? '当前版本' : v.snapshotId}</strong>
                  <span className="muted small"> {new Date(v.createdAt).toLocaleString()}</span>
                  <span className="muted small"> hash {v.hash.slice(0, 8)}…</span>
                  <button className="tiny-btn" onClick={() => void view(v.snapshotId)}>查看</button>
                  {v.snapshotId !== 'current' && preview?.snapshotId === v.snapshotId && (
                    <button className="tiny-btn" onClick={() => void restore(v.snapshotId)}>恢复此版本</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {preview && <div className="compare-block"><MarkdownView text={preview.content} /></div>}
        </div>
        <div className="dialog-actions">
          <button className="small-btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- 导出成稿对话框（§6.7）

function ExportDialog({ currentFormat, onClose }: {
  currentFormat: string;
  onClose: () => void;
}): React.ReactElement {
  const [formats, setFormats] = React.useState<string[]>([]);
  const [format, setFormat] = React.useState(currentFormat);
  const [includeTitles, setIncludeTitles] = React.useState(true);
  const [missing, setMissing] = React.useState<Array<{ nodeId: string; title: string }> | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    void store.loadFormats().then(setFormats);
  }, []);

  const run = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await store.exportBook(format, { includeTitles });
      setMissing(result.missing);
      if (result.saved) {
        store.showToast(`已导出成稿：${result.path}`, 'success');
        onClose();
      }
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">导出成稿</h3>
        <div className="dialog-body">
          <div className="row">
            <span className="muted small">格式：</span>
            <select value={format} onChange={(e) => setFormat(e.target.value)}>
              {formats.map((f) => <option key={f} value={f}>{f === 'novel' ? '小说' : f === 'script' ? '剧本' : f}</option>)}
            </select>
            <label className="row">
              <input type="checkbox" checked={includeTitles} onChange={(e) => setIncludeTitles(e.target.checked)} />
              <span className="muted small">包含卷/章/场景标题</span>
            </label>
          </div>
          <p className="muted small">按大纲顺序合并各场景正文（缺失正文的场景会列出，不阻断导出）。</p>
          {missing !== null && !busy && (
            missing.length === 0
              ? <p className="muted small">全部场景正文完整。</p>
              : <p className="muted small">缺失正文 {missing.length} 个场景：{missing.map((m) => m.title).join('、')}</p>
          )}
        </div>
        <div className="dialog-actions">
          <button className="small-btn" onClick={onClose}>取消</button>
          <button className="primary" disabled={busy || !format} onClick={() => void run()}>
            {busy ? '导出中…' : '导出…'}
          </button>
        </div>
      </div>
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
  const [exportOpen, setExportOpen] = React.useState(false);
  const [formats, setFormats] = React.useState<string[]>([]);
  const [format, setFormat] = React.useState('');
  const pendingFormat = useStore((s) => s.pendingWritingFormat);

  useEffect(() => {
    void store.loadFormats().then((f) => {
      setFormats(f);
      setFormat((prev) => (prev && f.includes(prev) ? prev : f[0] ?? ''));
    });
  }, []);

  // 全局搜索跳转（§6.9）：应用待定格式后清除
  useEffect(() => {
    if (!pendingFormat) return;
    if (formats.includes(pendingFormat)) setFormat(pendingFormat);
    store.clearPendingWritingFormat();
  }, [pendingFormat, formats]);

  /** 格式切换守卫（未保存保护，ux-review §6.8）。 */
  const switchFormat = async (next: string): Promise<void> => {
    if (next === format) return;
    const ok = sceneId
      ? await store.guardLeave((key) => key.startsWith(`output:${sceneId}:`) || key === `view:${sceneId}`)
      : true;
    if (!ok) return;
    setFormat(next);
  };

  if (!project) return <></>;
  const roots = project.nodes.filter((n) => n.parentId === null);
  const scene = project.nodes.find((n) => n.id === sceneId && n.type === 'scene') ?? null;

  return (
    <div className="writing-module">
      <aside className="writing-scenes">
        <div className="ws-head"><h3>场景</h3><span className="muted small">只导航 · 选择后右侧操作</span></div>
        <div className="scene-tree">
          {roots.map((n) => <SceneTreeItem key={n.id} node={n} depth={0} onSelect={(id) => void store.setWritingScene(id)} />)}
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
              <select value={format} onChange={(e) => void switchFormat(e.target.value)} disabled={running}>
                {formats.map((f) => <option key={f} value={f}>{f === 'novel' ? '小说' : f === 'script' ? '剧本' : f}</option>)}
              </select>
              <button className="primary" disabled={running} onClick={() => generate(scene.id, format)}>
                {running ? '写作中…' : '生成正文'}
              </button>
              <button className="small-btn" onClick={() => void copy(scene.id, format)}>复制全文</button>
              <button className="small-btn" onClick={() => setExportOpen(true)} title="按大纲顺序合并全部场景正文（§6.7）">
                导出成稿…
              </button>
              {lastWritingRunId && (
                <button className="tiny-btn" onClick={() => setInspectOpen(true)} title="最近一次写作任务的调用详情（§4.7）">
                  ⓘ 调用详情
                </button>
              )}
              <span className="muted small">输出落盘 outputs/（§6.5：正文生成只读可见视图 + 模板）</span>
            </div>
            {inspectOpen && lastWritingRunId && <CallInspectionDialog runId={lastWritingRunId} onClose={() => setInspectOpen(false)} />}
            {exportOpen && <ExportDialog currentFormat={format} onClose={() => setExportOpen(false)} />}
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
