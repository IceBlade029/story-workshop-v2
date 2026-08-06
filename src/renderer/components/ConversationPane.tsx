/**
 * ConversationPane.tsx — 全局对话（§3.2、§5.1）。
 *
 * - 消息流（流式 / 工具追踪 / markdown 渲染 / 分支 popover）
 * - 刷新（对最后一条 AI 消息重新生成）、分支切换、开启新话题、就地编辑消息（§3.2）
 * - 输入框 + 整理按钮（§4.2）；附件：上传文件 / 拖入 / 项目文件（§3.1）
 */
import React, { useEffect, useRef } from 'react';
import { store, useStore } from '../store';
import { confirmDialog } from './ui/dialog';
import { MarkdownView } from './ui/MarkdownView';
import { DiffView } from './ui/DiffView';
import { CallInspectionDialog } from './ui/CallInspectionDialog';
import type { ChatMessage, Attachment } from '../../shared/types';

// --------------------------------------------------------------------------- 附件行

/** 人类可读大小（附件行展示，§3.1）。 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentRow({ attachment }: { attachment: Attachment | undefined }): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  const [content, setContent] = React.useState<string | null>(null);
  if (!attachment) return null;

  const toggle = async (): Promise<void> => {
    const next = !open;
    setOpen(next);
    if (next && content === null) {
      const read = await store.readAttachmentContent(attachment.id).catch(() => null);
      setContent(read?.content ?? '（读取失败）');
    }
  };

  return (
    <div className="attachment-row">
      <button className="attachment-row-main" onClick={() => void toggle()} title={open ? '收起全文' : '展开全文'}>
        <span className="attachment-icon">📎</span>
        <span className="attachment-name">{attachment.name}</span>
        <span className="muted small"> · {formatSize(attachment.size)}</span>
        {attachment.needsRestructure && <span className="badge badge-stale">已更新</span>}
        <span className="muted small attachment-toggle">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="attachment-body">
          <pre className="msg-content">{content ?? '加载中…'}</pre>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- 工具追踪

function ToolTraceView({ traces }: { traces: ChatMessage['toolTrace'] }): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  const [detail, setDetail] = React.useState<string | null>(null);
  if (!traces || traces.length === 0) return null;
  const failed = traces.filter((t) => t.status === 'failed').length;
  return (
    <div className="tool-trace">
      <button className="tiny-btn" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} 工具 {traces.length}{failed > 0 ? ` · ${failed} 失败` : ''}
      </button>
      {open && (
        <ul>
          {traces.map((t, i) => (
            <li key={i} className={t.status}>
              <span
                className="tool-trace-name"
                onClick={() => setDetail(detail === `${i}` ? null : `${i}`)}
                title="查看参数/结果"
                style={{ cursor: 'pointer' }}
              >
                {t.toolName} · {t.status}
              </span>
              {t.error && <span className="muted small"> {t.error}</span>}
              {detail === `${i}` && (
                <div className="tool-trace-detail">{JSON.stringify(t.args, null, 1)}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- 分支

function BranchPopover({ message, siblings, onClose }: {
  message: ChatMessage;
  siblings: ChatMessage[];
  onClose: () => void;
}): React.ReactElement {
  const activeMessageId = useStore((s) => s.project?.activeMessageId);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [onClose]);

  return (
    <div className="branch-popover" ref={ref} onClick={(e) => e.stopPropagation()}>
      {siblings.map((sib) => (
        <button
          key={sib.id}
          className={`branch-popover-item${sib.id === activeMessageId ? ' active' : ''}`}
          onClick={() => { void store.switchBranch(sib.id); onClose(); }}
        >
          <span className={`avatar ${sib.role === 'user' ? 'avatar-user' : 'avatar-ai'}`}>
            {sib.role === 'user' ? '你' : 'AI'}
          </span>
          <span className="popover-preview">{sib.content.slice(0, 40) || '（空）'}</span>
          {sib.supersededBy && <span className="badge">已取代</span>}
        </button>
      ))}
    </div>
  );
}

function BranchChip({ message }: { message: ChatMessage }): React.ReactElement | null {
  const project = useStore((s) => s.project);
  const siblings = project?.messages.filter((m) => m.parentId === message.id) ?? [];
  const [open, setOpen] = React.useState(false);
  if (siblings.length <= 1) return null;
  return (
    <span className="branch-chip">
      <button className="tiny-btn" onClick={() => setOpen(!open)} title="切换分支">
        ↑↓ {siblings.length} 个分支
      </button>
      {open && <BranchPopover message={message} siblings={siblings} onClose={() => setOpen(false)} />}
    </span>
  );
}

// --------------------------------------------------------------------------- 变更详情（organize 总结消息内展开，ux-review §4.2：Cline 式）

export function OrganizeChangesExpand({ runId }: { runId: string }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [changes, setChanges] = React.useState<Array<import('../../shared/types').ChangeItem> | null>(null);
  const [diffs, setDiffs] = React.useState<import('../../shared/ipc-types').FileDiff[] | null>(null);
  const [diffOpen, setDiffOpen] = React.useState(false);
  const [accepted, setAccepted] = React.useState(false);

  const toggle = async (): Promise<void> => {
    // 展开-收起 toggle（§4.2）：已展开 → 收起；未展开 → 懒加载后展开
    if (open) {
      setOpen(false);
      return;
    }
    if (changes === null) {
      try {
        const runs = await store.listRuns();
        const entry = runs.find((r) => r.runId === runId);
        setChanges(entry?.changes ?? []);
      } catch {
        return;
      }
    }
    setOpen(true);
  };

  const toggleDiffs = async (): Promise<void> => {
    if (diffOpen) {
      setDiffOpen(false);
      return;
    }
    if (diffs === null) {
      try {
        setDiffs(await store.loadRunDiff(runId));
      } catch (err) {
        store.showToast((err as Error).message, 'error');
        return;
      }
    }
    setDiffOpen(true);
  };

  const changeText = (c: import('../../shared/types').ChangeItem): string => {
    switch (c.action) {
      case 'node_created': return `新建节点：${c.title}`;
      case 'node_deleted': return `删除节点：${c.nodeId}`;
      case 'node_renamed': return `重命名：${c.from} → ${c.to}`;
      case 'draft_updated': return `更新草稿：${c.nodeId}`;
      case 'asset_created': return `新建设定：${c.title}（${c.type}）`;
      case 'asset_updated': return `更新设定：${c.assetId}`;
      default: return JSON.stringify(c);
    }
  };

  const jumpNode = (nodeId: string): void => {
    store.jumpTo('node', nodeId);
  };

  return (
    <div className="organize-changes">
      <button className="tiny-btn" onClick={() => void toggle()}>
        {open ? '收起变更详情' : '查看变更详情'}
      </button>
      {open && changes !== null && (
        <div className="changes-block">
          {changes.length === 0 && <p className="muted small">无结构变更。</p>}
          <ul className="changes">
            {changes.map((c, i) => (
              <li key={i}>
                {changeText(c)}
                {c.action === 'node_created' && (
                  <button className="tiny-btn" onClick={() => jumpNode(c.nodeId)} title="右栏查看该节点">打开</button>
                )}
                {c.action === 'asset_created' && (
                  <button className="tiny-btn" onClick={() => store.jumpTo('asset', c.assetId)} title="右栏查看该设定">打开</button>
                )}
              </li>
            ))}
          </ul>
          <div className="row">
            <button className="tiny-btn" onClick={() => void toggleDiffs()}>{diffOpen ? '收起 diff' : '查看 diff'}</button>
            <button
              className="tiny-btn"
              disabled={accepted}
              onClick={() => { void store.acceptRun(runId); setAccepted(true); store.showToast('已接受', 'success'); }}
            >
              {accepted ? '已接受' : '接受（清除 AI 标记）'}
            </button>
            <button
              className="tiny-btn"
              onClick={async () => {
                const ok = await confirmDialog({ title: '回滚该次运行的全部改动？', message: '从快照恢复受影响文件（§5.4 整体可回滚）。', confirmText: '回滚', danger: true });
                if (ok) void store.rollbackRun(runId);
              }}
            >
              回滚
            </button>
          </div>
          {diffOpen && diffs !== null && <DiffView diffs={diffs} />}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- 消息

function MessageItem({ message, archivedView }: { message: ChatMessage; archivedView?: boolean }): React.ReactElement {
  const project = useStore((s) => s.project);
  const attachment = message.refs?.attachmentIds
    ? project?.attachments.find((m) => message.refs!.attachmentIds!.includes(m.id))
    : undefined;
  const activeMessageId = project?.activeMessageId;
  const [editing, setEditing] = React.useState(false);
  const [editText, setEditText] = React.useState('');
  const [showReasoning, setShowReasoning] = React.useState(false);
  const [showOld, setShowOld] = React.useState(false);
  const [inspectOpen, setInspectOpen] = React.useState(false);

  if (message.role === 'system') {
    // §4.3：运行开始/结束合并为一行轻提示（居中细条），变更明细不进对话正文
    if (message.content.startsWith('运行开始（') || message.content.startsWith('运行结束（')) {
      const firstLine = message.content.split('\n')[0];
      return (
        <div className="msg msg-run-strip">
          <span className="muted small">{firstLine}</span>
          {message.runId && (
            <button className="tiny-btn" onClick={() => setInspectOpen(true)} title="调用详情（§4.7）">ⓘ</button>
          )}
          {inspectOpen && message.runId && <CallInspectionDialog runId={message.runId} onClose={() => setInspectOpen(false)} />}
        </div>
      );
    }
    return (
      <div className="msg msg-system">
        <pre className="msg-content">{message.content}</pre>
      </div>
    );
  }

  const isActive = message.id === activeMessageId;
  const startEdit = (): void => {
    setEditText(message.content);
    setEditing(true);
  };
  const saveEdit = (): void => {
    const content = editText.trim();
    if (!content || content === message.content) {
      setEditing(false);
      return;
    }
    void store.editMessage(message.id, content)
      .then(() => { setEditing(false); store.showToast('已重发（原消息与旧分支保留，活动路径从该点截断重走）', 'success'); })
      .catch((err) => store.showToast((err as Error).message, 'error'));
  };
  const copy = (): void => {
    void navigator.clipboard.writeText(message.content)
      .then(() => store.showToast('已复制', 'success'))
      .catch(() => store.showToast('复制失败', 'error'));
  };

  // 被取代的消息折叠为「查看上一版」（ux-review §4.1）
  if (message.supersededBy) {
    return (
      <div className="msg msg-system">
        <button className="tiny-btn" onClick={() => setShowOld(!showOld)}>
          {showOld ? '收起' : `查看上一版（${message.role === 'user' ? '你' : 'AI'}）`}
        </button>
        {showOld && (
          <div className="msg msg-superseded-old">
            {message.role === 'user' ? (
              <pre className="msg-content">{message.content}</pre>
            ) : (
              <MarkdownView text={message.content} />
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`msg msg-${message.role}`}>
      <div className="msg-head">
        <span className={`avatar ${message.role === 'user' ? 'avatar-user' : 'avatar-ai'}`}>
          {message.role === 'user' ? '你' : 'AI'}
        </span>
        <span className="msg-role">{message.role === 'user' ? '你' : 'AI'}</span>
        <BranchChip message={message} />
        <span className="msg-time">{new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      {message.role === 'ai' && message.reasoning && (
        <button className="tiny-btn reasoning-fold" onClick={() => setShowReasoning(!showReasoning)}>
          {showReasoning ? '收起' : `已深度思考（${message.thinkingSeconds ?? 0} 秒）`}
        </button>
      )}
      {showReasoning && message.reasoning && (
        <div className="msg-content reasoning-body muted small">
          {message.reasoning.slice(0, 4000)}
        </div>
      )}
      {editing ? (
        <div className="msg-edit">
          <textarea
            autoFocus
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
              if (e.key === 'Escape') setEditing(false);
            }}
          />
          <div className="row">
            <button className="tiny-btn" onClick={() => void saveEdit()}>保存 → 重发</button>
            <button className="tiny-btn" onClick={() => setEditing(false)}>取消</button>
          </div>
        </div>
      ) : message.role === 'user' ? (
        // 附件消息（§3.1）：日志只存引用，正文以附件行呈现，不重复展示占位文本
        attachment ? (
          <AttachmentRow attachment={attachment} />
        ) : (
          <pre className="msg-content">{message.content}</pre>
        )
      ) : (
        <MarkdownView text={message.content} />
      )}
      <div className="msg-actions">
        {message.role === 'ai' && (
          <>
            <button className="tiny-btn" onClick={() => void copy()} title="复制">⧉ 复制</button>
            {isActive && !archivedView && (
              <button className="tiny-btn" onClick={() => void store.refreshMessage(message.id)} title="重新生成，旧回复保留为分支">
                ⟳ 重新生成
              </button>
            )}
            {!archivedView && (
              <button className="tiny-btn" onClick={startEdit} title="就地编辑重发（非弹窗）">✎ 编辑</button>
            )}
            {message.runId && (
              <button className="tiny-btn" onClick={() => setInspectOpen(true)} title="调用详情（§4.7）">ⓘ 调用详情</button>
            )}
            <ToolTraceView traces={message.toolTrace} />
            {message.runId && <OrganizeChangesExpand runId={message.runId} />}
          </>
        )}
        {message.role === 'user' && (
          <>
            <button className="tiny-btn" onClick={() => void copy()} title="复制">⧉ 复制</button>
            {!archivedView && (
              <button className="tiny-btn" onClick={startEdit} title="就地编辑重发（原消息保留为分支）">✎ 编辑</button>
            )}
          </>
        )}
      </div>
      {inspectOpen && message.runId && <CallInspectionDialog runId={message.runId} onClose={() => setInspectOpen(false)} />}
    </div>
  );
}

function StreamingIndicator(): React.ReactElement | null {
  const activeRun = useStore((s) => s.activeRun);
  const project = useStore((s) => s.project);
  const [elapsed, setElapsed] = React.useState(0);
  const [showReasoning, setShowReasoning] = React.useState(false);
  React.useEffect(() => {
    if (!activeRun || activeRun.status !== 'running') {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [activeRun?.runId, activeRun?.status]);
  // §5.1/§5.3：正文生成与就地改写（detail_fill / revise）在正文模块内流式显示，讨论模块零打扰
  if (!activeRun || activeRun.kind === 'detail_fill' || activeRun.kind === 'revise') return null;
  const reasoningText = activeRun.reasoning.join('');
  const reasoningActive = reasoningText.length > 0;
  const chunks = activeRun.chunks.join('');
  const failed = activeRun.status === 'error' || activeRun.error !== undefined;

  // §4.4：轻量进度「正在整理…（已写入：第 3 章草稿 / 角色卡·林默）」——基于 toolTrace
  const written: string[] = [];
  for (const t of activeRun.traces) {
    if (t.status !== 'completed') continue;
    if (t.toolName === 'write_draft') {
      const nodeId = (t.args as { nodeId?: string })?.nodeId;
      const title = nodeId ? project?.nodes.find((n) => n.id === nodeId)?.title : undefined;
      written.push(title ? `已写入：${title}草稿` : '已写入草稿');
    } else if (t.toolName === 'write_asset') {
      const title = (t.args as { title?: string })?.title;
      written.push(title ? `已写入：${title}` : '已写入设定');
    } else if (t.toolName === 'write_output') {
      written.push('已写入正文');
    }
  }
  const progress = written.length > 0 ? `（${[...new Set(written)].slice(-3).join(' / ')}）` : '';

  if (activeRun.status === 'error') {
    // 取消/出错：已产生的文本保留为可复制的失败块（P0-1），带重试按钮（§4.1）
    const cancelled = activeRun.error === '已取消';
    return (
      <div className="msg msg-failed">
        <div className="msg-head">
          <span className="avatar avatar-ai">AI</span>
          <span className="msg-role">AI</span>
          <span className="badge badge-stale">
            {cancelled ? '已取消' : `运行出错${activeRun.error ? `：${activeRun.error}` : ''}`}
          </span>
        </div>
        {chunks ? (
          <>
            <pre className="msg-content">{chunks}</pre>
            <div className="msg-actions">
              <button
                className="tiny-btn"
                onClick={() => void navigator.clipboard.writeText(chunks).then(
                  () => store.showToast('已复制', 'success'),
                  () => store.showToast('复制失败', 'error'),
                )}
              >
                ⧉ 复制已产生内容
              </button>
              <button className="tiny-btn" onClick={() => void store.retryRun()}>⟳ 重试</button>
            </div>
          </>
        ) : (
          <div className="msg-actions">
            <p className="muted small">{cancelled ? '运行已取消' : activeRun.error}</p>
            <button className="tiny-btn" onClick={() => void store.retryRun()}>⟳ 重试</button>
          </div>
        )}
      </div>
    );
  }

  // 成功完成：AI 消息已进对话流，指示器收起
  if (activeRun.status !== 'running') return null;

  // running
  return (
    <div className="msg msg-streaming">
      <div className="msg-head">
        <span className="avatar avatar-ai">AI</span>
        <span className="msg-role">AI</span>
        <span className="muted small">
          {activeRun.kind === 'organize'
            ? `正在整理…${progress}`
            : reasoningActive ? '深度思考中…' : '正在生成…'}
          {elapsed > 0 && `（已等待 ${elapsed}s）`}
        </span>
        {reasoningActive && (
          <button className="tiny-btn" onClick={() => setShowReasoning(!showReasoning)}>
            {showReasoning ? '收起思考' : `思考中（${reasoningText.length} 字）`}
          </button>
        )}
        {activeRun.traces.length > 0 && (
          <span className="badge" title="模型正在调用工具（可展开查看）">工具 ×{activeRun.traces.length}</span>
        )}
      </div>
      {showReasoning && reasoningActive && (
        <div className="msg-content muted small" style={{ fontSize: 12, marginBottom: 6 }}>
          {reasoningText.slice(-600)}
        </div>
      )}
      {chunks ? (
        // §4.1：流式期间即时渲染 markdown（当前是 <pre> 原文，完成后才渲染，体验断裂）
        <MarkdownView text={chunks} />
      ) : (
        <pre className="msg-content">{reasoningActive ? '' : '（思考中…）'}</pre>
      )}
      <ToolTraceView traces={activeRun.traces} />
    </div>
  );
}

// --------------------------------------------------------------------------- 输入栏

/** 长文本自动识别为附件的阈值（≈2000 字，§3.2）。 */
const LONG_TEXT_THRESHOLD = 2000;

function AttachmentPicker({ onClose }: { onClose: () => void }): React.ReactElement {
  const [projectFiles, setProjectFiles] = React.useState<Array<{ name: string; size: number }> | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [onClose]);

  const loadProjectFiles = async (): Promise<void> => {
    if (projectFiles !== null) return;
    const files = await store.scanWorkspaceFiles().catch(() => []);
    setProjectFiles(files);
  };

  const addProjectFile = async (name: string): Promise<void> => {
    try {
      await store.importWorkspaceFiles([name]);
      store.showToast(`已添加项目文件「${name}」为附件（原文件保留）`, 'success');
      onClose();
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    }
  };

  return (
    <div className="attachment-picker" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className="small-btn" onClick={() => void store.pickFiles().catch((err) => store.showToast((err as Error).message, 'error'))}>
        选择文件…
      </button>
      <div className="attachment-picker-group">
        <div className="muted small attachment-picker-title" onClick={() => void loadProjectFiles()}>
          项目文件（可选，点击添加）
        </div>
        {projectFiles === null && <p className="muted small">展开查看项目文件夹中的 .md / .txt 文件</p>}
        {projectFiles !== null && projectFiles.length === 0 && <p className="muted small">项目文件夹中没有散落的文本文件</p>}
        {projectFiles !== null && projectFiles.map((f) => (
          <button key={f.name} className="attachment-picker-item" onClick={() => void addProjectFile(f.name)}>
            <span>{f.name}</span>
            <span className="muted small">{formatSize(f.size)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function InputBar(): React.ReactElement {
  const inputText = useStore((s) => s.inputText);
  const running = useStore((s) => s.activeRun?.status === 'running');
  const project = useStore((s) => s.project);
  const activePath = useStore((s) => s.activePath);
  // 归档会话完全只读（ux-review §4.5）：不显示输入区
  const archivedView = useStore((s) => {
    const sess = s.project?.sessions.find((x) => x.id === s.project?.activeSessionId);
    return sess?.archived === true;
  });
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const longText = inputText.length >= LONG_TEXT_THRESHOLD;
  const settings = project?.settings;

  // 输入框自适应高度
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(160, Math.max(64, ta.scrollHeight))}px`;
  }, [inputText]);

  // §4.1：token/上下文「已使用 X%」轻进度（字符估算，与主进程 budget 同口径 ≈1.5 字/token）
  const chars = activePath.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  const tokenPct = Math.min(100, Math.round((chars / 1.5 / 30000) * 100));

  const send = (): void => {
    const text = inputText.trim();
    if (!text || running) return;
    if (text.length >= LONG_TEXT_THRESHOLD) {
      // §3.2：长文本自动识别为附件消息（日志存引用，正文可展开）
      const name = text.split('\n')[0].slice(0, 30) || '粘贴文本.md';
      void store.sendAttachmentAndRun(name, text).catch((err) => store.showToast((err as Error).message, 'error'));
    } else {
      void store.sendAndRun(text).catch((err) => store.showToast((err as Error).message, 'error'));
    }
  };

  if (archivedView) {
    return (
      <div className="input-bar">
        <div className="archived-banner">
          <span className="badge">已归档 · 只读</span>
          <span className="muted small">该话题已显式归档，不能再追加对话；可「取消归档」后继续，或「开启新话题」新建一条（ux-review §4.5）。</span>
        </div>
      </div>
    );
  }

  return (
    <div className="input-bar">
      {/* §4.1：模型/思考切换移到输入框上方（当前埋在设置页） */}
      <div className="input-model-bar">
        <select
          className="model-select"
          value={settings?.model ?? 'deepseek-v4-flash'}
          onChange={(e) => void store.updateSettings({ model: e.target.value as never }).catch((err) => store.showToast((err as Error).message, 'error'))}
          title="模型"
        >
          <option value="deepseek-v4-flash">flash（快）</option>
          <option value="deepseek-v4-pro">pro（强）</option>
        </select>
        <label className="muted small thinking-toggle">
          <input
            type="checkbox"
            checked={settings?.thinking ?? true}
            onChange={(e) => void store.updateSettings({ thinking: e.target.checked }).catch((err) => store.showToast((err as Error).message, 'error'))}
          />
          思考
        </label>
        <span className="spacer" />
        <span className={`muted small token-meter${tokenPct >= 85 ? ' token-meter-warn' : ''}`} title="已使用上下文估算进度">
          已使用 {tokenPct}%
        </span>
      </div>
      <div className="input-tools">
        <span className="attachment-btn-wrap">
          <button className="small-btn" onClick={() => setPickerOpen(!pickerOpen)} title="上传文件或添加项目文件为附件（§3.1）">
            📎 附件
          </button>
          {pickerOpen && <AttachmentPicker onClose={() => setPickerOpen(false)} />}
        </span>
        <span className="spacer" />
        {!running && (
          <button
            className="small-btn organize-btn"
            onClick={() => void store.organize().catch((err) => store.showToast((err as Error).message, 'error'))}
            title="消化整理光标之后的未整理内容（§4.2：无计数，无催促感）"
          >
            整理
          </button>
        )}
      </div>
      <div className="input-row">
        <textarea
          ref={taRef}
          data-testid="chat-input"
          placeholder={'讨论情节、设定、灵感…（Enter 发送，Shift+Enter 换行）'}
          value={inputText}
          onChange={(e) => store.setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="input-buttons">
          {running ? (
            <button className="small-btn" onClick={() => void store.cancelRun()}>取消</button>
          ) : (
            <button data-testid="chat-send" className="primary" onClick={send} disabled={!inputText.trim()}>
              发送
            </button>
          )}
        </div>
      </div>
      {longText && (
        <div className="input-hint">长文本将作为附件发送（对话日志只存引用，正文可展开，§3.2）</div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- 整理详情（ux-review §4.2：点击「查看」展开）

function OrganizeDetailPanel({ onClose }: { onClose: () => void }): React.ReactElement {
  const project = useStore((s) => s.project);
  const path = useStore((s) => s.activePath);
  const [note, setNote] = React.useState('');
  const cursor = project?.organizeCursor;
  // 消息起止范围（从整理光标到活动路径末端）
  const cursorIdx = cursor ? path.findIndex((m) => m.id === cursor) : -1;
  const rangeText = cursorIdx >= 0
    ? `第 ${cursorIdx + 1}–${path.length} 轮消息（光标 #${cursor}）`
    : '全部未整理消息（无光标）';
  // 附件清单（范围内消息引用的附件）
  const attachmentIds = new Set<string>();
  for (const m of path.slice(cursorIdx >= 0 ? cursorIdx + 1 : 0)) {
    for (const id of m.refs?.attachmentIds ?? []) attachmentIds.add(id);
  }
  const attachments = project?.attachments.filter((a) => attachmentIds.has(a.id)) ?? [];

  const confirm = (): void => {
    void store.organize('unorganized', note.trim() || undefined)
      .catch((err) => store.showToast((err as Error).message, 'error'));
    onClose();
  };

  const organizeAll = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: '重新整理全部对话？',
      message: '覆盖选项：将重新整理全部历史对话，含已整理过的内容。',
      confirmText: '重新整理全部',
      danger: true,
    });
    if (ok !== null) {
      void store.organize('all').catch((err) => store.showToast((err as Error).message, 'error'));
      onClose();
    }
  };

  return (
    <div className="organize-detail">
      <div className="muted small">本次范围：{rangeText}</div>
      {attachments.length > 0 && (
        <div className="muted small">范围内附件：{attachments.map((a) => a.name).join('、')}</div>
      )}
      <textarea
        className="organize-note"
        placeholder={'追加说明（可选，自然语言）：如「只整理我刚上传的文件」…'}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="row">
        <button className="primary" onClick={() => void confirm()} disabled={store.getState().activeRun?.status === 'running'}>
          确认整理
        </button>
        <button className="tiny-btn" onClick={() => void organizeAll()} title="覆盖选项：重新整理全部对话（危险操作保留确认）">
          重新整理全部…
        </button>
        <span className="spacer" />
        <button className="tiny-btn" onClick={onClose}>收起</button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- 面板

export function ConversationPane(): React.ReactElement {
  const path = useStore((s) => s.activePath);
  const project = useStore((s) => s.project);
  const activeRun = useStore((s) => s.activeRun);
  // 当前活动会话（ux-review §4.5：header 标题/归档按钮/只读判定；原始值选择器防重渲染循环）
  const activeSessionId = useStore((s) => s.project?.activeSessionId ?? null);
  const activeSessionTitle = useStore((s) => s.project?.sessions.find((x) => x.id === s.project?.activeSessionId)?.title ?? null);
  const activeSessionArchived = useStore((s) => s.project?.sessions.find((x) => x.id === s.project?.activeSessionId)?.archived === true);
  const activeSession = activeSessionId
    ? { session: { id: activeSessionId, title: activeSessionTitle ?? '', archived: activeSessionArchived }, archived: activeSessionArchived }
    : null;
  const [dragOver, setDragOver] = React.useState(false);
  const [organizeOpen, setOrganizeOpen] = React.useState(false);
  const [showJump, setShowJump] = React.useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);

  // 智能滚动（ux-review §4.1）：用户在历史中回看时不强制滚底；出现「跳到底部」浮标
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const onScroll = (): void => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      nearBottomRef.current = nearBottom;
      setShowJump(!nearBottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (nearBottomRef.current) {
      bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' });
    }
  }, [path.length, activeRun?.chunks.length, activeRun?.status]);

  const jumpToBottom = (): void => {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  };

  /** 拖入文件 → 附件消息（§3.1：内容落 attachments/，日志存引用）。 */
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    for (const file of files) {
      void file
        .text()
        .then((text) => store.addAttachment(file.name, text, 'uploaded'))
        .catch((err) => store.showToast((err as Error).message, 'error'));
    }
    store.showToast(`已添加 ${files.length} 个附件`, 'success');
  };

  return (
    <main
      className={`conversation${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="conversation-header">
        <span>{store.getState().project?.name}</span>
        {activeSession && (
          <span className="muted small" style={{ fontWeight: 400 }}>
            {activeSession.session.title || '（未命名话题）'}
            {activeSession.archived ? ' · 已归档（只读）' : ' · 可继续聊'}
          </span>
        )}
        <span className="spacer" />
        {activeSession && !activeSession.archived && (
          <button
            className="tiny-btn"
            onClick={() => void store.archiveSession(activeSession.session.id).catch((err) => store.showToast((err as Error).message, 'error'))}
            title="显式归档当前话题：移入「归档」隐藏层级，完全只读，可取消归档（ux-review §4.5）"
          >
            归档当前话题
          </button>
        )}
        <button
          className="tiny-btn"
          onClick={() => void store.newTopic().catch((err) => store.showToast((err as Error).message, 'error'))}
          title="开启新话题：新建一条对话，当前话题保持活跃可随时切回（ux-review §4.5）"
        >
          ＋ 开启新话题
        </button>
      </div>
      <div className="conversation-subbar">
        {project && store.getState().unorganizedCount > 0 && (
          <button className="organize-hint" onClick={() => setOrganizeOpen(!organizeOpen)}>
            有新内容未整理 · {organizeOpen ? '收起' : '查看'}
          </button>
        )}
        {organizeOpen && <OrganizeDetailPanel onClose={() => setOrganizeOpen(false)} />}
      </div>
      <div className="messages" ref={messagesRef}>
        {path.map((m) => <MessageItem key={m.id} message={m} archivedView={activeSession?.archived} />)}
        <StreamingIndicator />
        <div ref={bottomRef} />
      </div>
      {showJump && (
        <button className="jump-bottom" onClick={() => void jumpToBottom()} title="跳到底部">
          ↓ 跳到底部
        </button>
      )}
      <InputBar />
    </main>
  );
}
