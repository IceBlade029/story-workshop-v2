import { contextBridge, ipcRenderer } from 'electron';
import type { RendererApi, RunStartRequest, RunStreamEvent } from '../shared/ipc-types';

// 渲染层 API（类型见 shared/ipc-types.ts）。
// 所有通道：invoke 请求/响应；run 流式事件经 'run:event' 推送。
contextBridge.exposeInMainWorld('electronAPI', {
  app: {
    getVersion: () => ipcRenderer.invoke('get-app-version'),
  },
  project: {
    list: () => ipcRenderer.invoke('project:list'),
    create: (name: string) => ipcRenderer.invoke('project:create', name),
    open: (dir: string) => ipcRenderer.invoke('project:open', dir),
    pickFolder: () => ipcRenderer.invoke('project:pickFolder'),
    delete: (dir: string) => ipcRenderer.invoke('project:delete', dir),
    showInFolder: (dir: string) => ipcRenderer.invoke('project:showInFolder', dir),
    rename: (dir: string, name: string) => ipcRenderer.invoke('project:rename', dir, name),
  },
  state: {
    get: () => ipcRenderer.invoke('state:get'),
  },
  outline: {
    createNode: (parentId: string, type: string, title: string) =>
      ipcRenderer.invoke('outline:createNode', parentId, type, title),
    renameNode: (nodeId: string, title: string) => ipcRenderer.invoke('outline:renameNode', nodeId, title),
    deleteNode: (nodeId: string) => ipcRenderer.invoke('outline:deleteNode', nodeId),
    moveNode: (nodeId: string, newParentId: string, index?: number) =>
      ipcRenderer.invoke('outline:moveNode', nodeId, newParentId, index),
    writeDraft: (nodeId: string, content: string) => ipcRenderer.invoke('outline:writeDraft', nodeId, content),
    writeOfficial: (nodeId: string, content: string) => ipcRenderer.invoke('outline:writeOfficial', nodeId, content),
    commitNodes: (nodeIds: string[], includePending?: boolean) =>
      ipcRenderer.invoke('outline:commitNodes', nodeIds, includePending ?? false),
    readContent: (nodeId: string) => ipcRenderer.invoke('outline:readContent', nodeId),
  },
  asset: {
    create: (type: string, title: string, content: string) => ipcRenderer.invoke('asset:create', type, title, content),
    update: (assetId: string, updates: { title?: string; type?: string; content?: string }) =>
      ipcRenderer.invoke('asset:update', assetId, updates),
    delete: (assetId: string) => ipcRenderer.invoke('asset:delete', assetId),
  },
  attachment: {
    /** 文件选择对话框 → 预读文件内容（Part 3：不落盘，发送时提交）；取消返回 null */
    pickFiles: () => ipcRenderer.invoke('attachment:pickFiles'),
    scanWorkspace: () => ipcRenderer.invoke('attachment:scanWorkspace'),
    /** 只读项目顶层文本文件（待发送附件预读）；不存在返回 null */
    readWorkspace: (name: string) => ipcRenderer.invoke('attachment:readWorkspace', name),
    readContent: (attachmentId: string) => ipcRenderer.invoke('attachment:readContent', attachmentId),
    delete: (attachmentId: string) => ipcRenderer.invoke('attachment:delete', attachmentId),
  },
  visibleView: {
    read: (sceneId: string) => ipcRenderer.invoke('visibleView:read', sceneId),
    generate: (sceneId: string) => ipcRenderer.invoke('visibleView:generate', sceneId),
    save: (sceneId: string, content: string) => ipcRenderer.invoke('visibleView:save', sceneId, content),
  },
  output: {
    formats: () => ipcRenderer.invoke('output:formats'),
    list: (sceneId: string) => ipcRenderer.invoke('output:list', sceneId),
    read: (sceneId: string, format: string) => ipcRenderer.invoke('output:read', sceneId, format),
    save: (sceneId: string, format: string, content: string) => ipcRenderer.invoke('output:save', sceneId, format, content),
    versions: (sceneId: string, format: string) => ipcRenderer.invoke('output:versions', sceneId, format),
    readVersion: (sceneId: string, format: string, snapshotId: string) => ipcRenderer.invoke('output:readVersion', sceneId, format, snapshotId),
    export: (format: string, options: { includeTitles: boolean }) => ipcRenderer.invoke('output:export', format, options),
    applyRevise: (sceneId: string, format: string, start: number, end: number, replacement: string) =>
      ipcRenderer.invoke('output:applyRevise', sceneId, format, start, end, replacement),
    undoRevise: (sceneId: string, format: string) => ipcRenderer.invoke('output:undoRevise', sceneId, format),
  },
  conversation: {
    send: (content: string) => ipcRenderer.invoke('conversation:send', content),
    /** 一次提交「文本 + 待发送附件」（Part 3：附件发送时才落盘进对话） */
    sendWithAttachments: (content: string, attachments: Array<{ name: string; content: string; source?: 'pasted' | 'uploaded' | 'workspace' }>) =>
      ipcRenderer.invoke('conversation:sendWithAttachments', content, attachments),
    newTopic: (title?: string) => ipcRenderer.invoke('conversation:newTopic', title),
    switchSession: (sessionId: string) => ipcRenderer.invoke('conversation:switchSession', sessionId),
    archiveSession: (sessionId: string) => ipcRenderer.invoke('conversation:archiveSession', sessionId),
    unarchiveSession: (sessionId: string) => ipcRenderer.invoke('conversation:unarchiveSession', sessionId),
    deleteSession: (sessionId: string) => ipcRenderer.invoke('conversation:deleteSession', sessionId),
    switchBranch: (messageId: string) => ipcRenderer.invoke('conversation:switchBranch', messageId),
    edit: (messageId: string, content: string) => ipcRenderer.invoke('conversation:edit', messageId, content),
  },
  context: {
    inspect: () => ipcRenderer.invoke('context:inspect'),
    recompress: (focus?: string) => ipcRenderer.invoke('context:recompress', focus),
  },
  search: {
    global: (query: string) => ipcRenderer.invoke('search:global', query),
  },
  nodeVersion: {
    list: (nodeId: string) => ipcRenderer.invoke('nodeVersion:list', nodeId),
    read: (nodeId: string, snapshotId: string) => ipcRenderer.invoke('nodeVersion:read', nodeId, snapshotId),
  },
  trash: {
    restore: (trashId: string) => ipcRenderer.invoke('trash:restore', trashId),
    purge: (trashId: string) => ipcRenderer.invoke('trash:purge', trashId),
  },
  run: {
    start: (req: RunStartRequest) =>
      ipcRenderer.invoke('run:start', req),
    cancel: (runId: string) => ipcRenderer.invoke('run:cancel', runId),
    refresh: (messageId: string) => ipcRenderer.invoke('run:refresh', messageId),
    detailFill: (sceneId: string, format: string, feedback?: string) =>
      ipcRenderer.invoke('run:detailFill', sceneId, format, feedback),
    revise: (sceneId: string, format: string, start: number, end: number, instruction: string) =>
      ipcRenderer.invoke('run:revise', sceneId, format, start, end, instruction),
    onEvent: (listener: (event: RunStreamEvent) => void) => {
      const handler = (_event: unknown, payload: unknown): void => listener(payload as RunStreamEvent);
      ipcRenderer.on('run:event', handler);
      return () => { ipcRenderer.removeListener('run:event', handler); };
    },
    list: () => ipcRenderer.invoke('run:list'),
    inspect: (runId: string) => ipcRenderer.invoke('run:inspect', runId),
    diff: (runId: string) => ipcRenderer.invoke('run:diff', runId),
    accept: (runId: string) => ipcRenderer.invoke('run:accept', runId),
    rollback: (runId: string) => ipcRenderer.invoke('run:rollback', runId),
  },
  settings: {
    setKey: (key: string) => ipcRenderer.invoke('settings:setKey', key),
    get: () => ipcRenderer.invoke('settings:get'),
    update: (partial: Partial<import('../shared/llm-types').AppSettings>) => ipcRenderer.invoke('settings:update', partial),
  },
} satisfies RendererApi);
