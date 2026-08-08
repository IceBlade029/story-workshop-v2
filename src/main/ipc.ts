/**
 * ipc.ts — Electron IPC 通道注册。
 *
 * 全部业务逻辑在 AppService；本模块只做 electron 接线：
 * - ipcMain.handle 同步请求/响应（event 作为第一个参数传入业务函数）
 * - run 的流式事件通过 webContents.send('run:event') 广播（平铺 payload）
 * - run:cancel 维护 AbortController 注册表
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { AppService } from './app-service';
import type { RunStartRequest } from '../shared/ipc-types';

const RUN_EVENT_CHANNEL = 'run:event';

export function registerIpcHandlers(service: AppService): void {
  const abortControllers = new Map<string, AbortController>();

  const handle = (channel: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      try {
        return fn(event, ...(args as never[]));
      } catch (err) {
        throw new Error((err as Error).message);
      }
    });
  };

  /**
   * 向全部现存窗口广播流式事件（平铺结构：{ runId, type, ... }）。
   * 不依赖发起请求的 event.sender：webContents 已销毁时事件仍能送达当前窗口。
   * 广播失败不影响 run（写入照常落盘）。
   */
  const sendToWindow = (_event: Electron.IpcMainInvokeEvent, payload: unknown): void => {
    try {
      const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
      if (wins.length === 0) return;
      for (const win of wins) {
        win.webContents.send(RUN_EVENT_CHANNEL, payload);
      }
    } catch {
      /* 忽略：run 照常完成 */
    }
  };

  const getProjectsDir = (): string => {
    const dir = path.join(app.getPath('userData'), 'projects');
    const fs = require('fs') as typeof import('fs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  // ------------------------------------------------------------ 项目/状态

  handle('project:list', () => AppService.listProjects(getProjectsDir()));

  handle('project:create', (_event: Electron.IpcMainInvokeEvent, name: string) => {
    if (!name || name.trim() === '') throw new Error('EMPTY_PROJECT_NAME');
    const fs = require('fs') as typeof import('fs');
    const base = getProjectsDir();
    let dir = path.join(base, `${name.trim()}`);
    let n = 2;
    while (fs.existsSync(dir)) {
      dir = path.join(base, `${name.trim()}-${n}`);
      n++;
    }
    return service.createProject(dir, name.trim());
  });

  handle('project:open', (_event: Electron.IpcMainInvokeEvent, dir: string) => service.openProject(dir));

  handle('project:showInFolder', (_event: Electron.IpcMainInvokeEvent, dir: string) => {
    shell.showItemInFolder(dir);
  });

  handle('project:rename', (_event: Electron.IpcMainInvokeEvent, dir: string, name: string) => service.renameProject(dir, name));

  /**
   * 删除项目（确认后永久操作）：校验 + 关闭（若打开中）→ 移到系统回收站
   * （可恢复）。trashItem 失败向上抛，渲染层提示。
   */
  handle('project:delete', async (_event: Electron.IpcMainInvokeEvent, dir: string) => {
    service.deleteProject(dir);
    await shell.trashItem(dir);
  });

  handle('project:pickFolder', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('state:get', () => service.getState());

  // ------------------------------------------------------------ 大纲

  handle('outline:createNode', (_event: Electron.IpcMainInvokeEvent, parentId: string, type: string, title: string) => service.createNode(parentId, type as never, title));
  handle('outline:renameNode', (_event: Electron.IpcMainInvokeEvent, nodeId: string, title: string) => service.renameNode(nodeId, title));
  handle('outline:deleteNode', (_event: Electron.IpcMainInvokeEvent, nodeId: string) => service.deleteNode(nodeId));
  handle('outline:moveNode', (_event: Electron.IpcMainInvokeEvent, nodeId: string, newParentId: string, index?: number) => service.moveNode(nodeId, newParentId, index));
  handle('outline:writeDraft', (_event: Electron.IpcMainInvokeEvent, nodeId: string, content: string) => service.writeDraft(nodeId, content));
  handle('outline:writeOfficial', (_event: Electron.IpcMainInvokeEvent, nodeId: string, content: string) => service.writeOfficial(nodeId, content));
  handle('outline:commitNodes', (_event: Electron.IpcMainInvokeEvent, nodeIds: string[], includePending: boolean) => service.commitNodes(nodeIds, includePending));
  handle('outline:readContent', (_event: Electron.IpcMainInvokeEvent, nodeId: string) => service.readNodeContent(nodeId));

  // ------------------------------------------------------------ 设定/材料

  handle('asset:create', (_event: Electron.IpcMainInvokeEvent, type: string, title: string, content: string) => service.createAsset(type, title, content));
  handle('asset:update', (_event: Electron.IpcMainInvokeEvent, assetId: string, updates: Record<string, string>) => service.updateAsset(assetId, updates));
  handle('asset:delete', (_event: Electron.IpcMainInvokeEvent, assetId: string) => service.deleteAsset(assetId));

  // 附件（ux-review §3：上传 / 项目文件；Part 3：上传只预读，发送时经 conversation:sendWithAttachments 落盘）
  handle('attachment:pickFiles', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '文本', extensions: ['md', 'txt', 'markdown'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const fs = require('fs') as typeof import('fs');
    const out: Array<{ name: string; content: string }> = [];
    for (const p of result.filePaths) {
      try {
        out.push({ name: path.basename(p), content: fs.readFileSync(p, 'utf-8') });
      } catch {
        /* 单个文件失败跳过 */
      }
    }
    return out.length > 0 ? out : null;
  });
  handle('attachment:scanWorkspace', () => service.scanWorkspaceFiles());
  handle('attachment:readWorkspace', (_event: Electron.IpcMainInvokeEvent, name: string) => service.readWorkspaceFile(name));
  handle('attachment:readContent', (_event: Electron.IpcMainInvokeEvent, attachmentId: string) => service.readAttachmentContent(attachmentId));
  handle('attachment:delete', (_event: Electron.IpcMainInvokeEvent, attachmentId: string) => service.deleteAttachment(attachmentId));

  // ------------------------------------------------------------ 可见视图/正文（§6）

  handle('visibleView:read', (_event: Electron.IpcMainInvokeEvent, sceneId: string) => service.readVisibleView(sceneId));
  handle('visibleView:generate', (_event: Electron.IpcMainInvokeEvent, sceneId: string) => service.generateVisibleView(sceneId));
  handle('visibleView:save', (_event: Electron.IpcMainInvokeEvent, sceneId: string, content: string) => service.updateVisibleView(sceneId, content));
  handle('output:formats', () => service.listFormats());
  handle('output:list', (_event: Electron.IpcMainInvokeEvent, sceneId: string) => service.listOutputs(sceneId));
  handle('output:read', (_event: Electron.IpcMainInvokeEvent, sceneId: string, format: string) => service.workspace.outputs.read(sceneId, format));
  handle('output:save', (_event: Electron.IpcMainInvokeEvent, sceneId: string, format: string, content: string) => service.saveOutput(sceneId, format, content));
  handle('output:versions', (_event: Electron.IpcMainInvokeEvent, sceneId: string, format: string) => service.listOutputVersions(sceneId, format));
  handle('output:readVersion', (_event: Electron.IpcMainInvokeEvent, sceneId: string, format: string, snapshotId: string) => service.readOutputVersion(sceneId, format, snapshotId));
  handle('output:export', async (event: Electron.IpcMainInvokeEvent, format: string, options: { includeTitles: boolean }) => {
    const { content, missing } = service.exportBook(format, options);
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showSaveDialog(win!, {
      defaultPath: `${service.workspace.project.getMeta().name}-${format}.md`,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '纯文本', extensions: ['txt'] },
      ],
    });
    if (result.canceled || !result.filePath) return { saved: false, canceled: true, missing };
    fs.writeFileSync(result.filePath, content, 'utf-8');
    return { saved: true, path: result.filePath, missing };
  });

  // ------------------------------------------------------------ 对话

  handle('conversation:send', (_event: Electron.IpcMainInvokeEvent, content: string) => service.sendMessage(content));
  handle('conversation:sendWithAttachments', (_event: Electron.IpcMainInvokeEvent, content: string, attachments: Array<{ name: string; content: string; source?: string }>) =>
    service.sendWithAttachments(content, attachments as Array<{ name: string; content: string; source?: import('../shared/types').Attachment['source'] }>));
  handle('conversation:newTopic', (_event: Electron.IpcMainInvokeEvent, title?: string) => service.newTopic(title));
  handle('conversation:switchSession', (_event: Electron.IpcMainInvokeEvent, sessionId: string) => service.switchSession(sessionId));
  handle('conversation:archiveSession', (_event: Electron.IpcMainInvokeEvent, sessionId: string) => service.archiveSession(sessionId));
  handle('conversation:unarchiveSession', (_event: Electron.IpcMainInvokeEvent, sessionId: string) => service.unarchiveSession(sessionId));
  handle('conversation:deleteSession', (_event: Electron.IpcMainInvokeEvent, sessionId: string) => service.deleteSession(sessionId));
  handle('conversation:switchBranch', (_event: Electron.IpcMainInvokeEvent, messageId: string) => service.switchBranch(messageId));
  handle('conversation:edit', (_event: Electron.IpcMainInvokeEvent, messageId: string, content: string) => service.editMessage(messageId, content));

  // ------------------------------------------------------------ 上下文/压缩（§7）

  handle('context:inspect', () => service.inspectContext());
  handle('context:recompress', async (_event: Electron.IpcMainInvokeEvent, focus?: string) => service.recompressContext(focus));

  // ------------------------------------------------------------ 全局搜索（§6.9）

  handle('search:global', (_event: Electron.IpcMainInvokeEvent, query: string) => service.globalSearch(query));

  // ------------------------------------------------------------ 版本历史（§5.5）

  handle('nodeVersion:list', (_event: Electron.IpcMainInvokeEvent, nodeId: string) => service.listNodeVersions(nodeId));
  handle('nodeVersion:read', (_event: Electron.IpcMainInvokeEvent, nodeId: string, snapshotId: string) => service.readNodeVersion(nodeId, snapshotId));

  // ------------------------------------------------------------ 回收站（§9.4）

  handle('trash:restore', (_event: Electron.IpcMainInvokeEvent, trashId: string) => service.restoreTrash(trashId));
  handle('trash:purge', (_event: Electron.IpcMainInvokeEvent, trashId: string) => service.purgeTrash(trashId));

  // ------------------------------------------------------------ run（流式）

  handle('run:start', async (event: Electron.IpcMainInvokeEvent, req: RunStartRequest) => {
    const controller = new AbortController();
    const runId = `ui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    abortControllers.set(runId, controller);
    sendToWindow(event, { runId, type: 'start' });

    service
      .run(req, {
        onChunk: (text) => sendToWindow(event, { runId, type: 'chunk', text }),
        onReasoning: (reasoningContent) => sendToWindow(event, { runId, type: 'chunk', text: '', reasoningContent }),
        onSearchStatus: (status) => sendToWindow(event, { runId, type: 'search', status }),
        onToolTrace: (trace) => sendToWindow(event, { runId, type: 'trace', trace }),
      }, controller.signal)
      .then((result) => {
        abortControllers.delete(runId);
        if (result.skippedReason) {
          sendToWindow(event, { runId, type: 'error', message: result.skippedReason });
        } else {
          sendToWindow(event, { runId, type: 'done', result });
        }
      })
      .catch((err) => {
        abortControllers.delete(runId);
        console.error(`[run:start] ${runId} 异常：`, err);
        sendToWindow(event, { runId, type: 'error', message: (err as Error).message });
      });

    return { runId };
  });

  handle('run:detailFill', async (event: Electron.IpcMainInvokeEvent, sceneId: string, format: string, feedback?: string) => {
    const controller = new AbortController();
    const runId = `df_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    abortControllers.set(runId, controller);
    sendToWindow(event, { runId, type: 'start' });

    service
      .runDetailFill(sceneId, format, feedback, {
        onChunk: (text) => sendToWindow(event, { runId, type: 'chunk', text }),
        onReasoning: (reasoningContent) => sendToWindow(event, { runId, type: 'chunk', text: '', reasoningContent }),
        onSearchStatus: (status) => sendToWindow(event, { runId, type: 'search', status }),
        onToolTrace: (trace) => sendToWindow(event, { runId, type: 'trace', trace }),
      }, controller.signal)
      .then((result) => {
        abortControllers.delete(runId);
        sendToWindow(event, { runId, type: 'done', result });
      })
      .catch((err) => {
        abortControllers.delete(runId);
        console.error(`[run:detailFill] ${runId} 异常：`, err);
        sendToWindow(event, { runId, type: 'error', message: (err as Error).message });
      });

    return { runId };
  });

  handle('run:cancel', (_event: Electron.IpcMainInvokeEvent, runId: string) => {
    const controller = abortControllers.get(runId);
    controller?.abort();
    abortControllers.delete(runId);
  });

  // 就地改写（ux-review §5.3）：run 返回替换文本；接受/撤销为本地落盘操作
  handle('run:revise', async (event: Electron.IpcMainInvokeEvent, sceneId: string, format: string, start: number, end: number, instruction: string) => {
    const controller = new AbortController();
    const runId = `rv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    abortControllers.set(runId, controller);
    sendToWindow(event, { runId, type: 'start' });
    service
      .runRevise(sceneId, format, start, end, instruction, {
        onChunk: (text) => sendToWindow(event, { runId, type: 'chunk', text }),
        onReasoning: (reasoningContent) => sendToWindow(event, { runId, type: 'chunk', text: '', reasoningContent }),
        onSearchStatus: (status) => sendToWindow(event, { runId, type: 'search', status }),
        onToolTrace: (trace) => sendToWindow(event, { runId, type: 'trace', trace }),
      }, controller.signal)
      .then((result) => {
        abortControllers.delete(runId);
        sendToWindow(event, { runId, type: 'done', result });
      })
      .catch((err) => {
        abortControllers.delete(runId);
        console.error(`[run:revise] ${runId} 异常：`, err);
        sendToWindow(event, { runId, type: 'error', message: (err as Error).message });
      });
    return { runId };
  });
  handle('output:applyRevise', (_event: Electron.IpcMainInvokeEvent, sceneId: string, format: string, start: number, end: number, replacement: string) => service.applyRevise(sceneId, format, start, end, replacement));
  handle('output:undoRevise', (_event: Electron.IpcMainInvokeEvent, sceneId: string, format: string) => service.undoRevise(sceneId, format));

  handle('run:refresh', async (event: Electron.IpcMainInvokeEvent, messageId: string, answerDetail?: 'concise' | 'auto' | 'detailed') => {
    const controller = new AbortController();
    const runId = `rf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    abortControllers.set(runId, controller);
    sendToWindow(event, { runId, type: 'start' });
    service
      .refreshMessage(messageId, {
        onChunk: (text) => sendToWindow(event, { runId, type: 'chunk', text }),
        onReasoning: (reasoningContent) => sendToWindow(event, { runId, type: 'chunk', text: '', reasoningContent }),
        onSearchStatus: (status) => sendToWindow(event, { runId, type: 'search', status }),
        onToolTrace: (trace) => sendToWindow(event, { runId, type: 'trace', trace }),
      }, answerDetail)
      .then((result) => {
        abortControllers.delete(runId);
        sendToWindow(event, { runId, type: 'done', result });
      })
      .catch((err) => {
        abortControllers.delete(runId);
        console.error(`[run:refresh] ${runId} 异常：`, err);
        sendToWindow(event, { runId, type: 'error', message: (err as Error).message });
      });
    return { runId };
  });

  handle('run:list', () => service.listRuns());
  handle('run:inspect', (_event: Electron.IpcMainInvokeEvent, runId: string) => service.inspectRun(runId));
  handle('run:diff', (_event: Electron.IpcMainInvokeEvent, runId: string) => service.runDiff(runId));
  handle('run:accept', (_event: Electron.IpcMainInvokeEvent, runId: string) => service.acceptRun(runId));
  handle('run:rollback', (_event: Electron.IpcMainInvokeEvent, runId: string) => service.rollbackRun(runId));

  // ------------------------------------------------------------ 设置

  handle('settings:setKey', (_event: Electron.IpcMainInvokeEvent, key: string) => service.setApiKey(key));
  handle('settings:get', () => service.getAppSettings());
  handle('settings:update', (_event: Electron.IpcMainInvokeEvent, partial: Record<string, unknown>) => service.updateSettings(partial as never));
}
