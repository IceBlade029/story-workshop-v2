/**
 * CallInspectionDialog.tsx — 每消息级「调用详情」（ux-review §4.7）。
 *
 * 弹窗形态：展示一次调用应用给模型发送了什么、模型返回了什么。
 * - 头部：taskKind · scope · 状态 · 耗时 · 轮数 · token 用量
 * - 发送区：系统提示（全文折叠）· 消息清单（引用式：角色 · 来源[原文/摘要] · 字数）·
 *   压缩信息（锚点 + 摘要 + 保留原文区间）· 工具白名单
 * - 返回区：工具调用序列（名称 · 参数 · 状态 · 错误 · 耗时）· 最终回答（标注见本条消息）
 * - 手动重压缩/指定重点入口挂在弹窗内（该 run 走了压缩时显示，§4.7）
 */
import React from 'react';
import { store } from '../../store';
import type { RunRecord } from '../../../shared/types';

const KIND_LABEL: Record<string, string> = {
  chat: '讨论', organize: '整理', detail_fill: '正文生成', compress: '压缩任务',
};
const STATUS_LABEL: Record<string, string> = {
  done: '完成', error: '出错', cancelled: '已取消',
};
const ROLE_LABEL: Record<string, string> = { user: '用户', ai: 'AI', system: '系统' };

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  const [open, setOpen] = React.useState(true);
  return (
    <div className="inspect-section">
      <button className="inspect-section-head" onClick={() => setOpen(!open)}>
        <span>{open ? '▾' : '▸'}</span> {title}
      </button>
      {open && <div className="inspect-section-body">{children}</div>}
    </div>
  );
}

export function CallInspectionDialog({ runId, onClose }: { runId: string; onClose: () => void }): React.ReactElement {
  const [record, setRecord] = React.useState<RunRecord | null | undefined>(undefined);
  const [focusOpen, setFocusOpen] = React.useState(false);
  const [focus, setFocus] = React.useState('');

  React.useEffect(() => {
    void store.inspectRun(runId).then(setRecord).catch(() => setRecord(null));
  }, [runId]);

  const recompress = async (): Promise<void> => {
    try {
      await store.recompressContext(focus.trim() || undefined);
      store.showToast('已重新压缩', 'success');
      setFocusOpen(false);
      onClose();
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog-wide inspect-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">调用详情</h3>
        {record === undefined && <div className="dialog-body"><p className="muted">加载中…</p></div>}
        {record === null && (
          <div className="dialog-body">
            <p className="muted">没有该调用的记录（旧版本产生的消息）。</p>
            <div className="dialog-actions"><button className="small-btn" onClick={onClose}>关闭</button></div>
          </div>
        )}
        {record && (
          <div className="dialog-body inspect-body">
            <div className="inspect-header">
              <span className="badge">{KIND_LABEL[record.taskKind] ?? record.taskKind}</span>
              <span className={`badge${record.status === 'done' ? '' : ' badge-stale'}`}>{STATUS_LABEL[record.status] ?? record.status}</span>
              <span className="muted small">耗时 {fmtDuration(record.durationMs)} · {record.turns} 轮 · {record.usage.inputTokens + record.usage.outputTokens} tokens</span>
            </div>
            {record.scope && <p className="muted small">范围：{record.scope}</p>}

            <Section title="发送区：应用给模型发送了什么">
              <Section title={`系统提示（${record.sent.systemPrompt.length} 字）`}>
                <pre className="inspect-pre">{record.sent.systemPrompt}</pre>
              </Section>
              <Section title={`消息清单（${record.sent.messages.length} 条，引用式）`}>
                <ul className="inspect-list">
                  {record.sent.messages.map((m, i) => (
                    <li key={i}>
                      {ROLE_LABEL[m.role] ?? m.role}
                      <span className="muted small"> · {m.source === 'summary' ? '来源：压缩摘要' : '来源：原文'}</span>
                      <span className="muted small"> · {m.chars} 字</span>
                      {m.source === 'raw' && m.messageId && (
                        <button
                          className="tiny-btn"
                          onClick={() => { onClose(); store.jumpToMessage(m.messageId!); }}
                          title="在对话流中定位该消息"
                        >
                          定位
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
              {record.sent.compression && (
                <Section title={`压缩（锚点 #${record.sent.compression.anchor} · 保留原文 ${record.sent.compression.keptRawCount} 条）`}>
                  <pre className="inspect-pre">{record.sent.compression.summary}</pre>
                  <div className="row">
                    <button className="tiny-btn" onClick={() => setFocusOpen(!focusOpen)}>重新压缩（可指定重点）</button>
                  </div>
                  {focusOpen && (
                    <div className="row">
                      <textarea
                        className="organize-note"
                        placeholder="压缩重点（可选，只影响摘要详略，不改变内容权威，§7.3）…"
                        value={focus}
                        onChange={(e) => setFocus(e.target.value)}
                      />
                      <button className="small-btn" onClick={() => void recompress()}>重新压缩</button>
                    </div>
                  )}
                </Section>
              )}
              <Section title={`工具白名单（${record.sent.whitelist.length} 个）`}>
                <div className="inspect-tags">
                  {record.sent.whitelist.map((w) => <span key={w} className="badge">{w}</span>)}
                </div>
              </Section>
            </Section>

            <Section title="返回区：模型返回了什么">
              <Section title={`工具调用序列（${record.returned.toolCalls.length} 次）`}>
                {record.returned.toolCalls.length === 0 && <p className="muted small">无工具调用。</p>}
                <ul className="inspect-list">
                  {record.returned.toolCalls.map((t, i) => (
                    <li key={i} className={`inspect-tool ${t.status === 'failed' ? 'inspect-tool-failed' : ''}`}>
                      <strong>{t.name}</strong>
                      <span className="muted small"> · {t.status} · {fmtDuration(t.durationMs)}</span>
                      {t.error && <span className="muted small"> · {t.error}</span>}
                      <pre className="inspect-pre">{JSON.stringify(t.args, null, 1)}</pre>
                    </li>
                  ))}
                </ul>
              </Section>
              <div className="muted small">
                最终回答：{record.returned.finalAnswer || '（无回答）'}
                {record.returned.error && <span className="badge badge-stale">错误：{record.returned.error}</span>}
              </div>
            </Section>
          </div>
        )}
        {record && (
          <div className="dialog-actions">
            <button className="small-btn" onClick={onClose}>关闭</button>
          </div>
        )}
      </div>
    </div>
  );
}
