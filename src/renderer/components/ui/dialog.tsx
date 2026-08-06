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

type Request =
  | ({ kind: 'confirm' } & ConfirmOptions)
  | ({ kind: 'prompt' } & PromptOptions);

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

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    current = { kind: 'prompt', ...opts };
    resolver = (v) => resolve(typeof v === 'string' ? v : null);
    notify();
  });
}

export function DialogHost(): React.ReactElement | null {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  const [promptValue, setPromptValue] = React.useState('');

  React.useEffect(() => {
    listeners.add(force);
    return () => { listeners.delete(force); };
  }, []);

  React.useEffect(() => {
    setPromptValue((current?.kind === 'prompt' ? current.defaultValue : '') ?? '');
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
        <div className="dialog-actions">
          <button className="small-btn" onClick={() => settle(req.kind === 'confirm' ? false : null)}>
            {req.cancelText ?? '取消'}
          </button>
          <button
            className={req.danger ? 'small-btn danger' : 'primary'}
            autoFocus={req.kind === 'confirm'}
            onClick={() => settle(req.kind === 'confirm' ? true : promptValue)}
          >
            {req.confirmText ?? (req.kind === 'confirm' ? '确认' : '确定')}
          </button>
        </div>
      </div>
    </div>
  );
}
