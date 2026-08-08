/**
 * ThemePicker.tsx — 主题选择器（顶栏 🎨 / 项目首页入口共用）。
 *
 * 单击主题即刻预览并保存（不弹确认）；浮层外点击关闭。
 */
import React from 'react';
import { store, useStore } from '../../store';
import { applyTheme, THEMES } from '../../theme';
import type { ThemeId } from '../../../shared/llm-types';

export function ThemePicker(): React.ReactElement {
  const project = useStore((s) => s.project);
  const [open, setOpen] = React.useState(false);
  const [localTheme, setLocalTheme] = React.useState<ThemeId | null>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  // 项目打开时以 project.settings 为准；项目屏（无 project）用本地选择状态
  const current: ThemeId = project?.settings?.theme ?? localTheme ?? 'system';

  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const pick = (id: ThemeId): void => {
    setOpen(false);
    setLocalTheme(id);
    // 立即预览（settings.json 落盘由 updateSettings 完成）。
    // 失败回滚用「点击前实际生效的主题」——不能依赖 render 闭包里的 current，
    // 否则连续切换时回滚到的是上一次点击的主题（相邻错位）。
    const previous = (document.documentElement.dataset.theme as ThemeId | undefined) ?? 'system';
    applyTheme(id);
    void store.updateSettings({ theme: id }).catch(() => applyTheme(previous));
  };

  return (
    <div className="theme-picker-wrap" ref={wrapRef}>
      <button className="tiny-btn" onClick={() => setOpen(!open)} title="主题（外观）">🎨</button>
      {open && (
        <div className="theme-popover">
          <div className="theme-title">外观主题</div>
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`theme-item${t.id === current ? ' active' : ''}`}
              disabled={!t.available}
              title={t.available ? undefined : '即将推出'}
              onClick={() => pick(t.id)}
            >
              <span
                className="theme-swatch"
                style={{ background: `linear-gradient(135deg, ${t.colors[1]} 50%, ${t.colors[2]} 50%)` }}
              />
              <span>{t.name}</span>
              <span className="muted small">{t.available ? t.mode : '即将推出'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
