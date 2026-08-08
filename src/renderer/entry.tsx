/**
 * entry.tsx — 渲染层入口。
 *
 * 首帧主题流程（防启动白闪）：
 *   1. 同步读 localStorage 镜像（sw2:theme）设置 data-theme → 挂载前就位；
 *   2. 异步 settings:get 读取权威配置（settings.json），不一致则校正并回写镜像。
 * 挂载 React 前必须完成第 1 步，因为 CSP script-src 'self' 不允许内联脚本，
 * data-theme 只能在 bundled JS（同步执行部分）里设置。
 */
import { createRoot } from 'react-dom/client';
import { applyTheme, THEME_MIRROR_KEY } from './theme';
import { getApi } from './api';
import { App } from './App';

function initFirstFrame(): void {
  try {
    const mirror = localStorage.getItem(THEME_MIRROR_KEY);
    if (mirror) applyTheme(mirror as import('../shared/llm-types').ThemeId, true);
  } catch {
    /* localStorage 不可用：回退系统默认 */
  }
}

async function syncThemeFromMain(): Promise<void> {
  try {
    const settings = await getApi().settings.get();
    applyTheme(settings.theme);
  } catch {
    /* 主进程不可用（测试环境）：保持镜像/默认 */
  }
}

initFirstFrame();
void syncThemeFromMain();

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
