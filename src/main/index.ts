import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { AppService } from './app-service';
import { createRealModelAdapter } from './model-transport';
import { registerIpcHandlers } from './ipc';

// Single instance — cross-instance write protection (see write-lock.ts).
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// 未处理异常一律可见（绝不静默：定位「思考中…」等挂起问题）
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});

const service = new AppService(() => createRealModelAdapter());

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: '故事工坊',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '../../renderer/index.html'));
}

app.whenReady().then(() => {
  registerIpcHandlers(service);
  ipcMain.handle('get-app-version', () => app.getVersion());
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
