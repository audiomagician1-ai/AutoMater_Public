import { app, BrowserWindow, ipcMain, globalShortcut } from 'electron';
import path from 'path';
import { setupLLMHandlers } from './ipc/llm';
import { setupProjectHandlers } from './ipc/project';
import { setupSettingsHandlers } from './ipc/settings';
import { setupWorkspaceHandlers } from './ipc/workspace';
import { setupEventHandlers } from './ipc/events';
import { setupMcpHandlers, initMcpAndSkills, shutdownMcpAndSkills } from './ipc/mcp';
import { setupMetaAgentHandlers } from './ipc/meta-agent';
import { setupMissionHandlers } from './ipc/missions';
import { setupSessionHandlers } from './ipc/sessions';
import { setupMonitorHandlers } from './ipc/monitor';
import { registerWorkflowHandlers } from './ipc/workflow';
import { initDatabase } from './db';

let mainWindow: BrowserWindow | null = null;

/** 允许的缩放倍率 (50%~300%) */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.1;

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

  // ── 注册缩放快捷键 ──
  setupZoomShortcuts();
}

/**
 * 注册 Ctrl+= / Ctrl+- / Ctrl+0 缩放快捷键。
 * 通过 webContents 事件监听 (before-input-event) 实现，
 * 避免使用 globalShortcut (仅在窗口聚焦时生效且可能覆盖系统快捷键)。
 */
function setupZoomShortcuts() {
  if (!mainWindow) return;

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!input.control && !input.meta) return;
    if (input.type !== 'keyDown') return;

    const win = mainWindow;
    if (!win) return;

    switch (input.key) {
      case '=':
      case '+': {
        // Ctrl+= 放大
        const current = win.webContents.getZoomFactor();
        const next = Math.min(ZOOM_MAX, current + ZOOM_STEP);
        win.webContents.setZoomFactor(next);
        win.webContents.send('zoom:changed', next);
        event.preventDefault();
        break;
      }
      case '-': {
        // Ctrl+- 缩小
        const current = win.webContents.getZoomFactor();
        const next = Math.max(ZOOM_MIN, current - ZOOM_STEP);
        win.webContents.setZoomFactor(next);
        win.webContents.send('zoom:changed', next);
        event.preventDefault();
        break;
      }
      case '0': {
        // Ctrl+0 重置为默认 (从设置读取, 或 1.5)
        const defaultZoom = 1.5;
        win.webContents.setZoomFactor(defaultZoom);
        win.webContents.send('zoom:changed', defaultZoom);
        event.preventDefault();
        break;
      }
    }
  });
}

app.whenReady().then(async () => {
  // 初始化数据库
  await initDatabase();

  // 注册 IPC 处理器
  setupSettingsHandlers();
  setupLLMHandlers();
  setupProjectHandlers();
  setupWorkspaceHandlers();
  setupEventHandlers();
  setupMcpHandlers();
  setupMetaAgentHandlers();
  setupMissionHandlers();
  setupSessionHandlers();
  setupMonitorHandlers();
  registerWorkflowHandlers();

  // 自动连接 MCP 服务器 + 加载技能目录 (不阻塞窗口创建)
  initMcpAndSkills().catch(() => { /* 启动时失败不阻塞 */ });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  shutdownMcpAndSkills().catch(() => {});
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
