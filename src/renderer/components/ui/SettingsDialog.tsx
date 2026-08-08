/**
 * SettingsDialog.tsx — 设置弹窗（ux-review §2：设置 = 顶部齿轮弹窗，
 * 全局配置不属于创作上下文，不占右栏、不占模块位）。
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { store, useStore } from '../../store';
import { THEMES } from '../../theme';
import type { AppSettings, ThemeId } from '../../../shared/llm-types';

export function SettingsDialog({ onClose }: { onClose: () => void }): React.ReactElement | null {
  const project = useStore((s) => s.project);
  const [key, setKey] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  if (!project) return null;
  const settings = project.settings;

  const update = async (partial: Partial<AppSettings>): Promise<void> => {
    setSaving(true);
    try {
      await store.updateSettings(partial);
      store.showToast('设置已保存', 'success');
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog-wide" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">设置</h3>
        <div className="dialog-body">
          <div className="editor">
            <div className="ws-head"><h3>API</h3></div>
            <p className="muted small">DeepSeek API Key（仅存储在本机加密凭据库，不经过渲染层传输回显）</p>
            <input
              type="password"
              placeholder={project?.hasApiKey ? `已配置（${project.maskedApiKey}）——输入新 key 覆盖` : 'sk-…'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <div className="row">
              <button
                className="primary"
                disabled={!key.trim()}
                onClick={() => { void store.saveApiKey(key.trim()); setKey(''); store.showToast('API Key 已保存', 'success'); }}
              >
                保存
              </button>
            </div>

            <div className="ws-head" style={{ marginTop: 8 }}><h3>外观</h3></div>
            <p className="muted small">主题会改变界面配色、装饰与动效，不影响正文内容；单击卡片即刻应用。</p>
            <div className="theme-grid">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={`theme-card${settings?.theme === t.id ? ' active' : ''}`}
                  disabled={saving || !t.available}
                  title={t.available ? undefined : '即将推出'}
                  onClick={() => void update({ theme: t.id as ThemeId })}
                >
                  <span className={`theme-card-thumb theme-card-thumb-${t.id}`} style={{ background: t.thumb.bg }}>
                    <span className="tc-bar" style={{ background: t.thumb.bar, display: 'block', borderBottom: '1px solid rgba(0,0,0,.1)' }} />
                    <span className="tc-body">
                      <span style={{ background: t.thumb.left }} />
                      <span style={{ background: t.thumb.mid }} />
                      <span style={{ background: t.thumb.right }} />
                    </span>
                  </span>
                  <span className="theme-card-info">
                    <span className="theme-name">{t.name}</span>
                    <span className="theme-meta">{t.mode}</span>
                    <span className="row" style={{ gap: 4, marginTop: 2 }}>
                      {t.colors.map((c) => (
                        <span key={c} className="theme-swatch" style={{ background: c, width: 12, height: 12 }} />
                      ))}
                    </span>
                  </span>
                  {settings?.theme === t.id && <span className="muted small" style={{ marginLeft: 'auto' }}>使用中</span>}
                </button>
              ))}
            </div>

            <div className="ws-head" style={{ marginTop: 8 }}><h3>模型</h3></div>
            <div className="row">
              <label className="muted small">模型</label>
              <select
                value={settings?.model ?? 'deepseek-v4-flash'}
                disabled={saving}
                onChange={(e) => void update({ model: e.target.value as never })}
              >
                <option value="deepseek-v4-flash">deepseek-v4-flash（快）</option>
                <option value="deepseek-v4-pro">deepseek-v4-pro（强）</option>
              </select>
              <span className="muted small">DeepSeek V4：flash 速度快、pro 推理更强</span>
            </div>
            <div className="row">
              <label className="muted small">思考模式</label>
              <select
                value={settings?.thinking ? 'enabled' : 'disabled'}
                disabled={saving}
                onChange={(e) => void update({ thinking: e.target.value === 'enabled' })}
              >
                <option value="enabled">开启（默认，回答更准确）</option>
                <option value="disabled">关闭（响应更快）</option>
              </select>
            </div>
            {settings?.thinking && (
              <div className="row">
                <label className="muted small">思考强度</label>
                <select
                  value={settings?.reasoningEffort ?? 'high'}
                  disabled={saving}
                  onChange={(e) => void update({ reasoningEffort: e.target.value as never })}
                >
                  <option value="low">low</option>
                  <option value="high">high（默认）</option>
                  <option value="max">max</option>
                </select>
              </div>
            )}
            <div className="row">
              <label className="muted small thinking-toggle" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={settings?.notifications ?? true}
                  disabled={saving}
                  onChange={(e) => void update({ notifications: e.target.checked })}
                />
                完成通知（窗口后台时任务完成发桌面通知，§4.1）
              </label>
            </div>
            <p className="muted small">思考模式下思维链会折叠显示在对话里；思考模式不支持 temperature 参数（DeepSeek 文档）。</p>
          </div>
        </div>
        <div className="dialog-actions">
          <button className="small-btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
