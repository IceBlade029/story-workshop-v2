/**
 * SettingsDialog.tsx — 设置弹窗（ux-review §2：设置 = 顶部齿轮弹窗，
 * 全局配置不属于创作上下文，不占右栏、不占模块位）。
 */
import React from 'react';
import { store, useStore } from '../../store';
import type { AppSettings } from '../../../shared/llm-types';

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

  return (
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
    </div>
  );
}
