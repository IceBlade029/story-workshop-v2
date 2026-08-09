/**
 * SettingsDialog.tsx — 设置弹窗（ux-review §2：设置 = 顶部齿轮弹窗，
 * 全局配置不属于创作上下文，不占右栏、不占模块位）。
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { store, useStore } from '../../store';
import { getApi } from '../../api';
import { selectDialog } from './dialog';
import { THEMES } from '../../theme';
import { MAX_OUTPUT_TOKEN_OPTIONS } from '../../../shared/llm-types';
import type { AppSettings, OutputStyle, ThemeId } from '../../../shared/llm-types';

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

  /**
   * 更改项目存储位置：选目录 → 二选一（移动现有项目 / 仅切换）。
   * 当前打开的项目被搬走时主进程会自动重开（reopened=true）。
   */
  const changeProjectsDir = async (): Promise<void> => {
    if (saving) return;
    const api = getApi();
    const dir = await api.settings.pickProjectsDir();
    if (!dir) return;
    const current = settings?.projectsDir || '';
    if (current === dir) {
      store.showToast('已在该位置', 'info');
      return;
    }
    const choice = await selectDialog({
      title: '更改项目存储位置',
      message: `新位置：${dir}\n\n旧位置的项目怎么处理？`,
      options: [
        { value: 'migrate', label: '移动现有项目（拷贝到新位置后删除旧目录）' },
        { value: 'switch', label: '仅切换（旧项目留在原地，仍可「打开文件夹…」打开）' },
      ],
      confirmText: '确定',
      cancelText: '取消',
    });
    if (!choice) return;
    setSaving(true);
    try {
      const result = await store.changeProjectsDir(dir, choice === 'migrate');
      if (choice === 'migrate') {
        store.showToast(`已移动 ${result.movedCount} 个项目到新位置${result.reopened ? '，当前项目已在新位置打开' : ''}`, 'success');
      } else {
        store.showToast('项目存储位置已更改', 'success');
      }
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

            <div className="ws-head" style={{ marginTop: 8 }}><h3>存储</h3></div>
            <p className="muted small">项目以文件夹形式保存在磁盘上；可自定义存储位置（更换后旧项目不会丢失）。</p>
            <div className="row" style={{ alignItems: 'center', gap: 8 }}>
              <code className="path-display" title={settings?.projectsDir || '默认位置'}>
                {settings?.projectsDir || '默认位置（应用数据目录 \\projects）'}
              </code>
              <button className="small-btn" disabled={saving} onClick={() => void changeProjectsDir()}>更改…</button>
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

            <div className="ws-head" style={{ marginTop: 8 }}><h3>输出</h3></div>
            <div className="row">
              <label className="muted small">回答样式</label>
              <select
                value={settings?.outputStyle ?? 'deepseek'}
                disabled={saving}
                onChange={(e) => void update({ outputStyle: e.target.value as OutputStyle })}
              >
                <option value="plain">纯文本（不渲染标记）</option>
                <option value="standard">标准 Markdown（克制）</option>
                <option value="deepseek">DeepSeek 风格（默认）</option>
                <option value="opencode">Opencode 风格（彩色）</option>
              </select>
              <span className="muted small">对话回答的 Markdown 渲染风格（标题/加粗/代码高亮）</span>
            </div>
            <div className="row">
              <label className="muted small">最大输出长度</label>
              <select
                value={settings?.maxOutputTokens ?? 16384}
                disabled={saving}
                onChange={(e) => void update({ maxOutputTokens: Number(e.target.value) })}
              >
                {MAX_OUTPUT_TOKEN_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n.toLocaleString()} tokens</option>
                ))}
              </select>
              <span className="muted small">单次回答上限；长文深度评价被截断（出现「已截断」标记）时调大</span>
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
