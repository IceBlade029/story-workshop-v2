/**
 * dialog.tsx — 应用内对话框服务（替换 window.confirm / window.prompt）。
 *
 * 用法：await confirmDialog({ title, message }) → boolean
 *       await promptDialog({ title, defaultValue, placeholder }) → string | null
 * 在 App 根部挂载 <DialogHost />。Esc / 遮罩点击 = 取消；Enter = 确认。
 */
import React from 'react';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（按钮红色） */
  danger?: boolean;
  /** 第三按钮文案（未保存保护用：保存并继续 / 放弃修改 / 取消） */
  discardText?: string;
}

export interface PromptOptions {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（按钮红色） */
  danger?: boolean;
}

export interface SelectOptions {
  title: string;
  message?: string;
  /** 选项列表（label 为显示文案，value 为返回值） */
  options: Array<{ value: string; label: string }>;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
}

type Request =
  | ({ kind: 'confirm' } & ConfirmOptions)
  | ({ kind: 'prompt' } & PromptOptions)
  | ({ kind: 'select' } & SelectOptions);

type Resolver = (value: boolean | string | null) => void;

let current: Request | null = null;
let resolver: Resolver | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function settle(value: boolean | string | null): void {
  resolver?.(value);
  current = null;
  resolver = null;
  notify();
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    current = { kind: 'confirm', ...opts };
    resolver = (v) => resolve(v === true);
    notify();
  });
}

/** 三选一确认（未保存保护）：'save'（保存并继续）/ 'discard'（放弃修改）/ 'cancel'（取消）。 */
export type DiscardChoice = 'save' | 'discard' | 'cancel';

export function confirmDiscardDialog(opts: ConfirmOptions & { discardText: string }): Promise<DiscardChoice> {
  return new Promise((resolve) => {
    current = { kind: 'confirm', ...opts };
    resolver = (v) => resolve(v === true ? 'save' : v === 'discard' ? 'discard' : 'cancel');
    notify();
  });
}

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    current = { kind: 'prompt', ...opts };
    resolver = (v) => resolve(typeof v === 'string' ? v : null);
    notify();
  });
}

/** 单选项选择（§6.11：新建子节点类型等）；取消返回 null。 */
export function selectDialog(opts: SelectOptions): Promise<string | null> {
  return new Promise((resolve) => {
    current = { kind: 'select', ...opts };
    resolver = (v) => resolve(typeof v === 'string' && v !== '' ? v : null);
    notify();
  });
}

export function DialogHost(): React.ReactElement | null {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  const [promptValue, setPromptValue] = React.useState('');
  const [selected, setSelected] = React.useState('');

  React.useEffect(() => {
    listeners.add(force);
    return () => { listeners.delete(force); };
  }, []);

  React.useEffect(() => {
    setPromptValue((current?.kind === 'prompt' ? current.defaultValue : '') ?? '');
    setSelected(current?.kind === 'select' ? (current.defaultValue ?? current.options[0]?.value ?? '') : '');
  }, [current]);

  if (!current) return null;
  const req = current;

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') settle(req.kind === 'confirm' ? false : null);
    if (e.key === 'Enter' && req.kind === 'prompt' && (e.target as HTMLElement).tagName === 'INPUT') {
      settle(promptValue);
    }
  };

  return (
    <div
      className="dialog-overlay"
      onClick={() => settle(req.kind === 'confirm' ? false : null)}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">{req.title}</h3>
        {req.message && <div className="dialog-body">{req.message}</div>}
        {req.kind === 'prompt' && (
          <div className="dialog-body">
            <input
              autoFocus
              value={promptValue}
              placeholder={req.placeholder}
              onChange={(e) => setPromptValue(e.target.value)}
            />
          </div>
        )}
        {req.kind === 'select' && (
          <div className="dialog-body">
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {req.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        )}
        <div className="dialog-actions">
          {req.kind === 'confirm' && req.discardText && (
            <button className="small-btn" onClick={() => settle('discard')}>
              {req.discardText}
            </button>
          )}
          <button className="small-btn" onClick={() => settle(req.kind === 'confirm' ? false : null)}>
            {req.cancelText ?? '取消'}
          </button>
          <button
            className={req.kind === 'confirm' && req.danger ? 'small-btn danger' : 'primary'}
            autoFocus={req.kind === 'confirm' || req.kind === 'select'}
            onClick={() => settle(req.kind === 'confirm' ? true : req.kind === 'select' ? selected : promptValue)}
          >
            {req.confirmText ?? (req.kind === 'confirm' ? '确认' : '确定')}
          </button>
        </div>
      </div>
    </div>
  );
}
