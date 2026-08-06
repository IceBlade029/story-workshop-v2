/**
 * settings-store.test.ts — 全局设置（模型 / 思考模式 / 思考强度 / 完成通知）。
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getSettings, saveSettings } from '../settings-store';

const SETTINGS_DIR = path.join(os.homedir(), '.story-workshop');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

// 清掉上一次运行（含被中断）遗留的配置，保证「无配置文件」用例确定
beforeEach(() => {
  try { fs.rmSync(SETTINGS_FILE, { force: true }); } catch { /* noop */ }
});

afterEach(() => {
  try { fs.rmSync(SETTINGS_FILE, { force: true }); } catch { /* noop */ }
});

describe('settings-store', () => {
  it('无配置文件 → 返回默认（v4-flash · 思考开启 · effort high · 通知开）', () => {
    const s = getSettings();
    expect(s).toEqual({ model: 'deepseek-v4-flash', thinking: true, reasoningEffort: 'high', notifications: true });
  });

  it('保存并读回；非法值回退默认', () => {
    saveSettings({ model: 'deepseek-v4-pro', thinking: false, reasoningEffort: 'max' });
    expect(getSettings()).toEqual({ model: 'deepseek-v4-pro', thinking: false, reasoningEffort: 'max', notifications: true });

    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ model: 'unknown-model', thinking: 'yes', reasoningEffort: 'insane', notifications: 'maybe' }), 'utf-8');
    const s = getSettings();
    expect(s.model).toBe('deepseek-v4-flash');
    expect(s.thinking).toBe(true);
    expect(s.reasoningEffort).toBe('high');
    expect(s.notifications).toBe(true);
  });

  it('部分更新保留其余字段', () => {
    saveSettings({ model: 'deepseek-v4-pro' });
    saveSettings({ thinking: false });
    expect(getSettings()).toEqual({ model: 'deepseek-v4-pro', thinking: false, reasoningEffort: 'high', notifications: true });
  });

  it('损坏文件 → 回退默认', () => {
    fs.writeFileSync(SETTINGS_FILE, 'not json', 'utf-8');
    expect(getSettings().model).toBe('deepseek-v4-flash');
  });
});
