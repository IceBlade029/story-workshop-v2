/**
 * settings-store.ts — 全局设置存储（模型、思考模式、思考强度）。
 *
 * 明文存于 ~/.story-workshop/settings.json（非敏感配置，API key 走加密凭据库）。
 * 缺省：deepseek-v4-flash · 思考开启 · effort high（DeepSeek 默认）。
 *
 * P1 修复：路径可注入（configureSettingsDir），测试指向临时目录，
 * 默认 npm test 不得触碰开发者的真实 ~/.story-workshop。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { defaultSettings, type AppSettings } from '../shared/llm-types';

let settingsDir = path.join(os.homedir(), '.story-workshop');

/** 覆盖设置存储目录（仅测试使用；恢复默认传 undefined）。 */
export function configureSettingsDir(dir: string | undefined): void {
  settingsDir = dir ?? path.join(os.homedir(), '.story-workshop');
}

const SETTINGS_FILE = () => path.join(settingsDir, 'settings.json');

export function getSettings(): AppSettings {
  const defaults = defaultSettings();
  try {
    if (!fs.existsSync(SETTINGS_FILE())) return defaults;
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf-8')) as Partial<AppSettings>;
    return {
      model: raw.model === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : defaults.model,
      thinking: typeof raw.thinking === 'boolean' ? raw.thinking : defaults.thinking,
      reasoningEffort: raw.reasoningEffort === 'low' || raw.reasoningEffort === 'max' ? raw.reasoningEffort : defaults.reasoningEffort,
      notifications: typeof raw.notifications === 'boolean' ? raw.notifications : defaults.notifications,
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(partial: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...getSettings(), ...partial };
  if (!fs.existsSync(settingsDir)) fs.mkdirSync(settingsDir, { recursive: true });
  // 原子写：临时文件 + rename
  const tmp = `${SETTINGS_FILE()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, SETTINGS_FILE());
  return next;
}
