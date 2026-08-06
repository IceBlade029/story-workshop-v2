/**
 * MarkdownEditor.tsx — 通用编辑/预览编辑器（草稿、正式版、设定、可见视图共用）。
 *
 * - 默认预览模式（阅读优先）：markdown 渲染，暂不明示标记高亮 + 计数（§6.1）
 * - 编辑模式：手动切换后 textarea（Ctrl+S 触发 onSave）
 * - 字数统计
 */
import React from 'react';
import { MarkdownView, countMarkers } from './MarkdownView';

export interface MarkdownEditorProps {
  value: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
  placeholder?: string;
  minHeight?: number;
  disabled?: boolean;
  /** 预览模式是否展示暂不明示标记计数（§6.1） */
  showMarkerCount?: boolean;
  dataTestId?: string;
}

export function MarkdownEditor({
  value,
  onChange,
  onSave,
  placeholder,
  minHeight = 240,
  disabled,
  showMarkerCount = false,
  dataTestId,
}: MarkdownEditorProps): React.ReactElement {
  // 默认预览（阅读优先）；编辑需手动切换
  const [mode, setMode] = React.useState<'preview' | 'edit'>('preview');
  const markers = showMarkerCount ? countMarkers(value) : 0;

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSave?.();
    }
  };

  return (
    <div className="editor">
      <div className="editor-toolbar">
        <div className="editor-mode">
          <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')} type="button">预览</button>
          <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')} type="button">编辑</button>
        </div>
        <span className="spacer" />
        <span className="editor-count">{value.length} 字</span>
        {showMarkerCount && markers > 0 && <span className="marker-count">暂不明示 ×{markers}</span>}
      </div>

      {mode === 'edit' ? (
        <textarea
          data-testid={dataTestId}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          style={{ minHeight }}
          onChange={(e) => onChange?.(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      ) : (
        <div className="compare-block" style={{ minHeight }}>
          <MarkdownView text={value} />
        </div>
      )}
    </div>
  );
}
