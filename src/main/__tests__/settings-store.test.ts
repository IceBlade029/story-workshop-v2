/**
 * settings-store.test.ts — 全局设置（模型 / 思考模式 / 思考强度 / 完成通知）。
 *
 * P1 修复：生产路径必须可依赖注入——测试全部使用独立临时目录，
 * 禁止触碰开发者的真实 ~/.story-workshop/settings.json。
 */
import { describe, it, expect, afterEach, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { configureSettingsDir, getSettings, saveSettings } from '../settings-store';

let SETTINGS_DIR: string;
let SETTINGS_FILE: string;

beforeEach(() => {
  SETTINGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw2-settings-'));
  SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');
  configureSettingsDir(SETTINGS_DIR);
});

afterEach(() => {
  try { fs.rmSync(SETTINGS_DIR, { recursive: true, force: true }); } catch { /* noop */ }
});

afterAll(() => {
  // 复位为生产默认路径（不影响真实文件：本测试从未触碰 os.homedir()）
  configureSettingsDir(undefined);
});

describe('settings-store', () => {
  it('无配置文件 → 返回默认（v4-flash · 思考开启 · effort high · 通知开 · 主题跟随系统 · DeepSeek 输出风格 · 16384 输出上限）', () => {
    const s = getSettings();
    expect(s).toEqual({ model: 'deepseek-v4-flash', thinking: true, reasoningEffort: 'high', notifications: true, theme: 'system', outputStyle: 'deepseek', maxOutputTokens: 16384 });
  });

  it('保存并读回；非法值回退默认', () => {
    saveSettings({ model: 'deepseek-v4-pro', thinking: false, reasoningEffort: 'max' });
    expect(getSettings()).toEqual({ model: 'deepseek-v4-pro', thinking: false, reasoningEffort: 'max', notifications: true, theme: 'system', outputStyle: 'deepseek', maxOutputTokens: 16384 });

    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ model: 'unknown-model', thinking: 'yes', reasoningEffort: 'insane', notifications: 'maybe', theme: 'rainbow', outputStyle: 'fancy', maxOutputTokens: 99999 }), 'utf-8');
    const s = getSettings();
    expect(s.model).toBe('deepseek-v4-flash');
    expect(s.thinking).toBe(true);
    expect(s.reasoningEffort).toBe('high');
    expect(s.notifications).toBe(true);
    expect(s.theme).toBe('system');
    expect(s.outputStyle).toBe('deepseek');
    expect(s.maxOutputTokens).toBe(16384);
  });

  it('部分更新保留其余字段', () => {
    saveSettings({ model: 'deepseek-v4-pro' });
    saveSettings({ thinking: false });
    expect(getSettings()).toEqual({ model: 'deepseek-v4-pro', thinking: false, reasoningEffort: 'high', notifications: true, theme: 'system', outputStyle: 'deepseek', maxOutputTokens: 16384 });
  });

  it('主题：保存并读回；非法值写不进去', () => {
    saveSettings({ theme: 'nebula' });
    expect(getSettings().theme).toBe('nebula');
    // 非法主题 → 保留当前值（不入库）
    const next = saveSettings({ theme: 'rainbow' as never });
    expect(next.theme).toBe('nebula');
    expect(getSettings().theme).toBe('nebula');
  });

  it('输出样式与最大输出长度：保存并读回；非法值保留当前值', () => {
    saveSettings({ outputStyle: 'opencode', maxOutputTokens: 32768 });
    expect(getSettings().outputStyle).toBe('opencode');
    expect(getSettings().maxOutputTokens).toBe(32768);
    // 非法值 → 不入库
    const next = saveSettings({ outputStyle: 'fancy' as never, maxOutputTokens: 12345 as never });
    expect(next.outputStyle).toBe('opencode');
    expect(next.maxOutputTokens).toBe(32768);
    expect(getSettings().outputStyle).toBe('opencode');
  });

  it('损坏文件 → 回退默认', () => {
    fs.writeFileSync(SETTINGS_FILE, 'not json', 'utf-8');
    expect(getSettings().model).toBe('deepseek-v4-flash');
  });
});
