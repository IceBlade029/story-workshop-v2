/**
 * ConversationPane.tsx — 全局对话（§3.2、§5.1）。
 *
 * - 消息流（流式 / 工具追踪 / markdown 渲染 / 版本导航 ◀ i/N ▶）
 * - 刷新（对最后一条 AI 消息重新生成）、版本切换、开启新话题、就地编辑消息（§3.2）
 * - 输入框 + 整理按钮（§4.2）；附件：上传文件 / 拖入 / 项目文件（§3.1）
 */
import React, { useEffect, useRef } from 'react';
import { store, useStore, LONG_TEXT_THRESHOLD } from '../store';
import { confirmDialog } from './ui/dialog';
import { MarkdownView } from './ui/MarkdownView';
import { DiffView } from './ui/DiffView';
import { CallInspectionDialog } from './ui/CallInspectionDialog';
import type { ChatMessage, Attachment } from '../../shared/types';
import type { ContextInspection } from '../../shared/ipc-types';
import { assetTypeLabel } from '../../shared/types';

// --------------------------------------------------------------------------- 附件行

/** 人类可读大小（附件行展示，§3.1）。 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentRow({ attachment, deletable }: { attachment: Attachment | undefined; deletable?: boolean }): React.ReactElement | null {
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

  const remove = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: `删除附件「${attachment.name}」？`,
      message: '该附件将从项目中永久删除，所有会话的 AI 都无法再读取；引用它的历史消息中本行将隐藏。',
      confirmText: '永久删除',
      danger: true,
    });
    if (ok) void store.deleteAttachment(attachment.id).catch((err) => store.showToast((err as Error).message, 'error'));
  };

  return (
    <div className="attachment-row">
      <div className="attachment-row-head">
        <button className="attachment-row-main" onClick={() => void toggle()} title={open ? '收起全文' : '展开全文'}>
          <span className="attachment-icon">📎</span>
          <span className="attachment-name">{attachment.name}</span>
          <span className="muted small"> · {formatSize(attachment.size)}</span>
          {attachment.needsRestructure && <span className="badge badge-stale">已更新</span>}
          <span className="muted small attachment-toggle">{open ? '▾' : '▸'}</span>
        </button>
        {deletable && (
          <button className="tiny-btn attachment-delete" onClick={() => void remove()} title="删除附件（永久删除，不可恢复）">🗑</button>
        )}
      </div>
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

// --------------------------------------------------------------------------- 版本导航（DeepSeek 式 ◀ i/N ▶）

function VersionNav({ message }: { message: ChatMessage }): React.ReactElement | null {
  const project = useStore((s) => s.project);
  const count = message.versionCount ?? 1;
  if (count <= 1 || !message.versionGroupId) return null;
  const index = message.versionIndex ?? 1;
  const versions = (project?.messages ?? []).filter((m) => m.versionGroupId === message.versionGroupId);
  const prev = versions.find((v) => v.versionIndex === index - 1);
  const next = versions.find((v) => v.versionIndex === index + 1);
  return (
    <span className="version-nav" title="消息版本（编辑/重新生成产生）：◀/▶ 切换，切回旧版本会回到该版本的完整续写链">
      <button className="tiny-btn" disabled={!prev} onClick={() => { if (prev) void store.switchBranch(prev.id); }} title="上一个版本">◀</button>
      <span className="muted small version-nav-index">{index}/{count}</span>
      <button className="tiny-btn" disabled={!next} onClick={() => { if (next) void store.switchBranch(next.id); }} title="下一个版本">▶</button>
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
      case 'asset_created': return `新建设定：${c.title}（${assetTypeLabel(c.type)}）`;
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

function MessageItem({ message, archivedView }: { message: ChatMessage; archivedView?: boolean }): React.ReactElement | null {
  const project = useStore((s) => s.project);
  const activePath = useStore((s) => s.activePath);
  const running = useStore((s) => s.activeRun?.status === 'running');
  // 输出样式（输出系统：对话回答的 Markdown 渲染风格）
  const outputStyle = project?.settings.outputStyle ?? 'deepseek';
  // 重新生成就地替换（bug 修复）：该消息正在被刷新 → 立即用流式卡片替换旧回答
  const refreshingRun = useStore((s) => (s.refreshingMessageId === message.id ? s.activeRun : null));
  const attachment = message.refs?.attachmentIds
    ? project?.attachments.find((m) => message.refs!.attachmentIds!.includes(m.id))
    : undefined;
  const [editing, setEditing] = React.useState(false);
  const [editText, setEditText] = React.useState('');
  const [showReasoning, setShowReasoning] = React.useState(false);
  const [inspectOpen, setInspectOpen] = React.useState(false);

  // 重新生成中：旧回答立即被流式卡片替换（DeepSeek 式就地刷新）
  if (message.role === 'ai' && refreshingRun && refreshingRun.status === 'running') {
    const reasoningText = refreshingRun.reasoning.join('');
    const chunks = refreshingRun.chunks.join('');
    return (
      <div className="msg msg-streaming">
        <div className="msg-head">
          <span className="avatar avatar-ai">AI</span>
          <span className="msg-role">AI</span>
          <span className="badge badge-ai">重新生成中…</span>
          {reasoningText && (
            <button className="tiny-btn" onClick={() => setShowReasoning(!showReasoning)}>
              {showReasoning ? '收起思考' : `思考中（${reasoningText.length} 字）`}
            </button>
          )}
        </div>
        {showReasoning && reasoningText && (
          <div className="msg-content muted small" style={{ fontSize: 12, marginBottom: 6 }}>
            {reasoningText.slice(-600)}
          </div>
        )}
        {chunks ? (
          <MarkdownView text={chunks} style={outputStyle} />
        ) : (
          <pre className="msg-content">{reasoningText ? '' : '（重新生成中…）'}</pre>
        )}
      </div>
    );
  }

  if (message.role === 'system') {
    // 用户反馈：运行开始/结束细条不再显示（日志保留，整理光标/压缩逻辑不受影响）；
    // 运行状态由流式指示器覆盖，organize 结果由 AI 总结消息覆盖。
    // 「消息已编辑」记账事件同样隐藏（旧版本经 ◀ ▶ 版本导航查看，日志保留原文）。
    if (
      message.content.startsWith('运行开始（') ||
      message.content.startsWith('运行结束（') ||
      message.content.startsWith('（消息已编辑）')
    ) {
      return null;
    }
    return (
      <div className="msg msg-system">
        <pre className="msg-content">{message.content}</pre>
      </div>
    );
  }

  // DeepSeek 式：重新生成只出现在当前路径的最后一条 AI 回答下方，常驻可见
  // （注意：run 结束后 activeMessageId 指向隐藏的运行结束事件，不能用它判断）
  const isLastAi = message.role === 'ai' && activePath.filter((m) => m.role === 'ai').at(-1)?.id === message.id;
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
      .then(() => { setEditing(false); store.showToast('已重发为新版本（◀ ▶ 可切换回旧版本）', 'success'); })
      .catch((err) => store.showToast((err as Error).message, 'error'));
  };
  const copy = (): void => {
    void navigator.clipboard.writeText(message.content)
      .then(() => store.showToast('已复制', 'success'))
      .catch(() => store.showToast('复制失败', 'error'));
  };

  return (
    <div className={`msg msg-${message.role}`}>
      <div className="msg-head">
        <span className={`avatar ${message.role === 'user' ? 'avatar-user' : 'avatar-ai'}`}>
          {message.role === 'user' ? '你' : 'AI'}
        </span>
        <span className="msg-role">{message.role === 'user' ? '你' : 'AI'}</span>
        {message.truncated && (
          <span className="badge badge-stale" title="回答达到最大输出长度被截断，可在设置中调大「最大输出长度」">
            已截断 · 可调大输出上限
          </span>
        )}
        <VersionNav message={message} />
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
            <button className="tiny-btn primary" onClick={() => void saveEdit()} title="发送（Enter）">发送</button>
            <button className="tiny-btn" onClick={() => setEditing(false)} title="取消（Esc）">取消</button>
          </div>
        </div>
      ) : message.role === 'user' ? (
        // 附件消息（§3.1）：日志只存引用，正文以附件行呈现，不重复展示占位文本
        attachment ? (
          <AttachmentRow attachment={attachment} deletable />
        ) : (
          <pre className="msg-content">{message.content}</pre>
        )
      ) : (
        <MarkdownView text={message.content} style={outputStyle} />
      )}
      {/* DeepSeek 式：重新生成按钮常驻在最后一条 AI 回答下方（◀ ▶ 版本导航在头部） */}
      {isLastAi && !archivedView && (
        <div className="msg-regenerate">
          <button
            className="tiny-btn"
            disabled={running}
            onClick={() => void store.refreshMessage(message.id).catch((err) => store.showToast((err as Error).message, 'error'))}
            title={running ? '运行中，请等待完成或取消后再重新生成' : '重新生成（生成新版本，◀ ▶ 可切换回旧回答）'}
          >
            ⟳ 重新生成
          </button>
        </div>
      )}
      <div className="msg-actions">
        {message.role === 'ai' && (
          <>
            <button className="tiny-btn" onClick={() => void copy()} title="复制">⧉ 复制</button>
            {message.runId && (
              <button className="tiny-btn" onClick={() => setInspectOpen(true)} title="调用详情（§4.7）">ⓘ 调用详情</button>
            )}
            <ToolTraceView traces={message.toolTrace} />
          </>
        )}
        {message.role === 'user' && (
          <>
            <button className="tiny-btn" onClick={() => void copy()} title="复制">⧉ 复制</button>
            {!archivedView && (
              <button className="tiny-btn" onClick={startEdit} title="就地编辑为新版本（◀ ▶ 可切换）">✎ 编辑</button>
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
  const outputStyle = project?.settings.outputStyle ?? 'deepseek';
  // 重新生成：流式内容已在原消息位置就地渲染（MessageItem），底部不再叠加新卡片
  const refreshing = useStore((s) => s.refreshingMessageId !== null);
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
  if (refreshing) return null;
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
            : activeRun.searching
              ? '正在联网搜索…'
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
        <MarkdownView text={chunks} style={outputStyle} />
      ) : (
        <pre className="msg-content">{reasoningActive ? '' : '（思考中…）'}</pre>
      )}
      <ToolTraceView traces={activeRun.traces} />
    </div>
  );
}

// --------------------------------------------------------------------------- 输入栏

/** 待发送附件 chip 行（Part 3，ChatGPT/DeepSeek 式：上传先显示在输入框上方，发送时才进对话）。 */
function PendingAttachmentRow(): React.ReactElement | null {
  const pending = useStore((s) => s.pendingAttachments);
  if (pending.length === 0) return null;
  return (
    <div className="pending-attachments">
      {pending.map((a) => (
        <span key={a.key} className="pending-chip" title={a.content.slice(0, 200)}>
          <span className="attachment-icon">📎</span>
          <span className="pending-chip-name">{a.name}</span>
          <span className="muted small"> · {formatSize(a.size)}</span>
          <button className="tiny-btn pending-chip-remove" onClick={() => store.removePendingAttachment(a.key)} title="移除（未发送，直接丢弃）">×</button>
        </span>
      ))}
    </div>
  );
}

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
      await store.stageWorkspaceFile(name);
      store.showToast(`已加入待发送区「${name}」（原文件保留，发送时落盘）`, 'success');
      onClose();
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    }
  };

  return (
    <div className="attachment-picker" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        className="small-btn"
        onClick={() => void store.pickFiles()
          .then((n) => {
            if (n > 0) {
              store.showToast(`已加入待发送区 ${n} 个附件（发送时落盘进对话）`, 'success');
              onClose();
            }
          })
          .catch((err) => store.showToast((err as Error).message, 'error'))}
      >
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

// --------------------------------------------------------------------------- 上下文用量

/** 紧凑 token 数值：202300 → 202.3k，900000 → 900k。 */
export function formatTokenCount(value: number): string {
  const safe = Math.max(0, Math.round(value));
  if (safe >= 1_000_000) {
    const scaled = safe / 1_000_000;
    return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}m`;
  }
  if (safe >= 1_000) {
    const scaled = safe / 1_000;
    return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}k`;
  }
  return safe.toLocaleString('zh-CN');
}

/**
 * 输入工具栏的上下文用量组件。
 * 数据来自主进程 context.inspect，避免渲染层重复硬编码预算或字符换算。
 */
export function ContextUsageMeter(): React.ReactElement {
  const project = useStore((s) => s.project);
  const activePath = useStore((s) => s.activePath);
  const [inspection, setInspection] = React.useState<ContextInspection | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const requestSequence = useRef(0);
  const tooltipId = React.useId();

  const refresh = React.useCallback(async (): Promise<void> => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const next = await store.inspectContext();
      if (sequence !== requestSequence.current) return;
      setInspection(next);
      setFailed(false);
    } catch {
      if (sequence !== requestSequence.current) return;
      setFailed(true);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => { requestSequence.current += 1; };
  }, [
    refresh,
    project?.dir,
    project?.activeSessionId,
    project?.activeMessageId,
    project?.attachments.length,
    activePath,
  ]);

  const used = inspection?.usedTokens ?? 0;
  const limit = inspection?.budgetTokens ?? 0;
  const exactPercent = limit > 0 ? (used / limit) * 100 : 0;
  const displayPercent = Math.max(0, Math.round(exactPercent));
  const barPercent = Math.min(100, Math.max(0, exactPercent));
  const warning = exactPercent >= 85;
  const unavailable = failed && inspection === null;
  const statusText = unavailable ? '用量暂不可用' : loading && inspection === null ? '正在读取用量' : `已使用 ${displayPercent}%`;

  return (
    <div
      className={`context-usage${warning ? ' context-usage-warn' : ''}`}
      onPointerEnter={() => { if (!loading) void refresh(); }}
      data-testid="context-usage"
    >
      <div
        className="context-usage-trigger"
        role="progressbar"
        tabIndex={0}
        aria-label={statusText}
        aria-describedby={tooltipId}
        aria-valuemin={inspection ? 0 : undefined}
        aria-valuemax={inspection ? limit : undefined}
        aria-valuenow={inspection ? used : undefined}
        onFocus={() => { if (!loading) void refresh(); }}
      >
        <span className="context-usage-label">{unavailable ? '已使用 --' : loading && inspection === null ? '读取中…' : `已使用 ${displayPercent}%`}</span>
        <span className="context-usage-mini-track" aria-hidden="true">
          <span className="context-usage-fill" style={{ width: `${barPercent}%` }} />
        </span>
      </div>
      <div id={tooltipId} className="context-usage-popover" role="tooltip" aria-live="polite">
        <div className="context-usage-popover-head">
          <strong>上下文用量</strong>
          {inspection?.compressed && <span className="context-usage-badge">已压缩</span>}
        </div>
        {inspection ? (
          <>
            <div className="context-usage-value">
              <span>{formatTokenCount(used)}</span>
              <span className="context-usage-limit"> / {formatTokenCount(limit)}</span>
            </div>
            <div className="context-usage-detail-track" role="presentation">
              <span className="context-usage-fill" style={{ width: `${barPercent}%` }} />
            </div>
            <div className="context-usage-meta">
              <span>{exactPercent.toFixed(1)}%</span>
              <span>{inspection.measurement === 'server-anchored' ? '服务端校准 + 新增估算' : '当前活动话题 · 全量估算'}</span>
            </div>
            {inspection.measurement === 'server-anchored' && (
              <div className="context-usage-meta">
                <span>上次服务端 {formatTokenCount(inspection.providerTokens ?? 0)}</span>
                <span>新增估算 +{formatTokenCount(inspection.trailingEstimatedTokens ?? 0)}</span>
              </div>
            )}
            {inspection.measurement === 'server-anchored' && (inspection.transientEstimatedTokens ?? 0) > 0 && (
              <div className="context-usage-meta">
                <span>临时工具上下文</span>
                <span>估算扣除 -{formatTokenCount(inspection.transientEstimatedTokens ?? 0)}</span>
              </div>
            )}
            {inspection.blocked && <div className="context-usage-alert">自动压缩已暂停</div>}
            {failed && <div className="context-usage-alert">刷新失败，显示上次结果</div>}
          </>
        ) : (
          <div className="context-usage-empty">{failed ? '用量暂不可用' : '正在读取上下文用量…'}</div>
        )}
      </div>
    </div>
  );
}

function InputBar(): React.ReactElement {
  const inputText = useStore((s) => s.inputText);
  const running = useStore((s) => s.activeRun?.status === 'running');
  const project = useStore((s) => s.project);
  // 回答详略档位（每次发送可选，localStorage 记忆）
  const answerDetail = useStore((s) => s.answerDetail);
  // 归档会话完全只读（ux-review §4.5）：不显示输入区
  const archivedView = useStore((s) => {
    const sess = s.project?.sessions.find((x) => x.id === s.project?.activeSessionId);
    return sess?.archived === true;
  });
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const pendingCount = useStore((s) => s.pendingAttachments.length);
  const longText = inputText.length >= LONG_TEXT_THRESHOLD;
  const settings = project?.settings;

  // 输入框自适应高度
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(160, Math.max(64, ta.scrollHeight))}px`;
  }, [inputText]);

  const send = (): void => {
    if (running) return;
    if (inputText.trim() === '' && store.getState().pendingAttachments.length === 0) return;
    // Part 3（ChatGPT/DeepSeek 式）：文本 + 待发送附件一次提交；
    // 长文本（≥2000 字）自动转为 pasted 附件，逻辑在 store.sendWithPending
    void store.sendWithPending(inputText).catch((err) => store.showToast((err as Error).message, 'error'));
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
      {/* §4.1：模型/思考切换 + 附件/整理 合并为一行工具栏（用户反馈：不要两行） */}
      <div className="input-tools">
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
        <select
          className="model-select"
          value={answerDetail}
          onChange={(e) => store.setAnswerDetail(e.target.value as 'concise' | 'auto' | 'detailed')}
          title="回答详略（每次发送可选；重新生成沿用当前档位）"
        >
          <option value="concise">简略</option>
          <option value="auto">自动</option>
          <option value="detailed">详细</option>
        </select>
        <span className="spacer" />
        <ContextUsageMeter />
        <span className="attachment-btn-wrap">
          <button className="small-btn" onClick={() => setPickerOpen(!pickerOpen)} title="上传文件或添加项目文件为附件（§3.1）">
            📎 附件
          </button>
          {pickerOpen && <AttachmentPicker onClose={() => setPickerOpen(false)} />}
        </span>
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
      <PendingAttachmentRow />
      <div className="input-row">
        <textarea
          ref={taRef}
          data-testid="chat-input"
          placeholder={pendingCount > 0 ? `发送时一并提交 ${pendingCount} 个附件…（Enter 发送，Shift+Enter 换行）` : '讨论情节、设定、灵感…（Enter 发送，Shift+Enter 换行）'}
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
            <button data-testid="chat-send" className="primary" onClick={send} disabled={!inputText.trim() && pendingCount === 0}>
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

// --------------------------------------------------------------------------- 整理结果卡片（Part 4：organize 沙箱化后不落日志，瞬态展示）

function OrganizeResultCard(): React.ReactElement | null {
  const lastOrganize = useStore((s) => s.lastOrganize);
  const [answerOpen, setAnswerOpen] = React.useState(false);
  if (!lastOrganize) return null;
  const answer = lastOrganize.finalAnswer;
  const preview = answer.length > 2000 ? `${answer.slice(0, 2000)}…` : answer;
  if (lastOrganize.failed) {
    // P1 修复：失败/取消的整理——展示错误 + 部分修改详情 + 回滚入口
    return (
      <div className="organize-result-card organize-result-failed">
        <div className="organize-result-head">
          <span className="badge badge-error">整理未完成</span>
          <span className="muted small">任务失败/取消前可能已写入部分内容，可查看变更详情并回滚</span>
          <span className="spacer" />
          <button className="tiny-btn" onClick={() => store.dismissOrganize()} title="收起（快照与调用详情仍保留）">收起</button>
        </div>
        {lastOrganize.error && <p className="organize-result-error">{lastOrganize.error}</p>}
        <OrganizeChangesExpand runId={lastOrganize.runId} />
      </div>
    );
  }
  return (
    <div className="organize-result-card">
      <div className="organize-result-head">
        <span className="badge">整理完成</span>
        <span className="muted small">结果已写入大纲/设定；整理过程未进入讨论上下文</span>
        <span className="spacer" />
        <button className="tiny-btn" onClick={() => store.dismissOrganize()} title="收起（run 记录仍可通过调用详情查看）">收起</button>
      </div>
      {answer && (
        <button className="tiny-btn" onClick={() => setAnswerOpen(!answerOpen)} title="最终总结（范围/产出清单/待定缺口）">
          {answerOpen ? '收起总结' : '查看整理总结'}
        </button>
      )}
      {answerOpen && (
        <div className="organize-result-answer">
          <MarkdownView text={preview} />
        </div>
      )}
      <OrganizeChangesExpand runId={lastOrganize.runId} />
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
  // 用户反馈：当前话题为空（无消息）时不允许开启新话题
  const emptyTopic = activeSession ? path.length === 0 : true;

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

  /** 拖入文件 → 待发送区（Part 3：先暂存输入框上方，发送时才落盘进对话）。 */
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    for (const file of files) {
      void file
        .text()
        .then((text) => store.stageAttachment(file.name, text, 'uploaded'))
        .catch((err) => store.showToast((err as Error).message, 'error'));
    }
    store.showToast(`已加入待发送区 ${files.length} 个附件（发送时落盘进对话）`, 'success');
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
          disabled={emptyTopic}
          onClick={() => void store.newTopic().catch((err) => store.showToast((err as Error).message, 'error'))}
          title={emptyTopic ? '当前话题为空：先发送第一条消息后再开启新话题' : '开启新话题：新建一条对话，当前话题保持活跃可随时切回（ux-review §4.5）'}
        >
          ＋ 开启新话题
        </button>
      </div>
      <div className="conversation-subbar">
        <OrganizeResultCard />
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
