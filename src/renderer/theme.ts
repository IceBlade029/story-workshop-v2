/**
 * theme.ts — 主题系统的渲染层工具与元数据。
 *
 * - applyTheme(): 设置 <html data-theme> + 写 localStorage 镜像（首帧用）；
 * - THEMES: 展示元数据（名称 / 明暗 / 代表色），供顶栏浮层与设置预览卡使用。
 */
import type { ThemeId } from '../shared/llm-types';
import { THEME_IDS } from '../shared/llm-types';

/** localStorage 镜像键：只在启动第一帧用，正式配置以 settings.json 为准。 */
export const THEME_MIRROR_KEY = 'sw2:theme';

/** 主题展示元数据。 */
export interface ThemeMeta {
  id: ThemeId;
  name: string;
  /** 明暗属性（跟随系统特殊：跟随 OS） */
  mode: '跟随系统' | '亮色' | '暗色';
  /** 代表色（展示色块：背景 / 面板 / 强调 / 正文） */
  colors: [string, string, string, string];
  /** 卡片缩略图配色（背景 / 顶栏 / 侧栏 / 对话 / 强调） */
  thumb: { bg: string; bar: string; left: string; mid: string; right: string };
  /** 是否已实现（未实现的主题在入口中禁用，标「即将推出」） */
  available: boolean;
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'system',
    name: '跟随系统',
    mode: '跟随系统',
    colors: ['#f7f8fa', '#ffffff', '#1f6feb', '#1f2329'],
    thumb: { bg: '#f7f8fa', bar: '#ffffff', left: '#f2f4f7', mid: '#ffffff', right: '#e8f0fe' },
    available: true,
  },
  {
    id: 'nebula',
    name: '星云夜航',
    mode: '暗色',
    colors: ['#101527', '#1a1e2e', '#8aa5ff', '#e8eaf6'],
    thumb: { bg: '#101527', bar: '#181d31', left: '#181c2e', mid: '#1c2134', right: '#2c2550' },
    available: true,
  },
  {
    id: 'parchment',
    name: '羊皮手稿',
    mode: '亮色',
    colors: ['#f6efe2', '#fbf6ea', '#8a6a2f', '#4a3c28'],
    thumb: { bg: '#f6efe2', bar: '#fbf6ea', left: '#f0e6d2', mid: '#fbf6ea', right: '#efe0c2' },
    available: true,
  },
  {
    id: 'sakura',
    name: '樱花物语',
    mode: '亮色',
    colors: ['#fdf0f4', '#fff7f9', '#e0558e', '#5d3a4a'],
    thumb: { bg: '#fdf0f4', bar: '#fff7f9', left: '#f9e3ea', mid: '#fff7f9', right: '#f9dbe6' },
    available: true,
  },
  {
    id: 'emerald',
    name: '翡翠秘境',
    mode: '暗色',
    colors: ['#0e1c17', '#14261f', '#3ecf8e', '#dceee6'],
    thumb: { bg: '#0e1c17', bar: '#14261f', left: '#12221b', mid: '#162a22', right: '#1d3a2d' },
    available: true,
  },
];

export function isValidTheme(v: unknown): v is ThemeId {
  return typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v);
}

/**
 * 应用主题：设置 <html data-theme>。mirrorOnly 用于首帧——只写 DOM，不碰镜像。
 * system 主题同样设置 data-theme="system"（亮/暗由 prefers-color-scheme 原生跟随）。
 */
export function applyTheme(theme: string, mirrorOnly = false): void {
  const id = isValidTheme(theme) ? theme : 'system';
  document.documentElement.dataset.theme = id;
  if (!mirrorOnly) {
    try {
      localStorage.setItem(THEME_MIRROR_KEY, id);
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }
}
