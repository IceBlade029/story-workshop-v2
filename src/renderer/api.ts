/**
 * api.ts — 渲染层对 window.electronAPI 的类型化封装。
 */
import type { RendererApi } from '../shared/ipc-types';

declare global {
  interface Window {
    electronAPI?: RendererApi;
  }
}

let apiInstance: RendererApi | null = null;

export function getApi(): RendererApi {
  if (!apiInstance) {
    if (!window.electronAPI) {
      throw new Error('ELECTRON_API_MISSING');
    }
    apiInstance = window.electronAPI;
  }
  return apiInstance;
}

/** 测试注入用。 */
export function setApiForTest(api: RendererApi): void {
  apiInstance = api;
}
