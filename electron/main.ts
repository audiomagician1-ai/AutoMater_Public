import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { setupLLMHandlers } from './ipc/llm';
import { setupProjectHandlers } from './ipc/project';
import { setupSettingsHandlers } from './ipc/settings';
import { initDatabase } from './db';

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'AgentForge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    frame: true,
    backgroundColor: '#0f172a',
  });

  // Dev 模式加载 Vite dev server, 生产模式加载打包后的文件
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // 初始化数据库
  await initDatabase();

  // 注册 IPC 处理器
  setupSettingsHandlers();
  setupLLMHandlers();
  setupProjectHandlers();

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
