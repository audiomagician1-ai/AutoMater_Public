import { app, BrowserWindow, session } from 'electron';
import path from 'path';
import { setupLLMHandlers } from './ipc/llm';
import { setupProjectHandlers } from './ipc/project';
import { setupSettingsHandlers, initSearchConfigFromDb } from './ipc/settings';
import { setupWorkspaceHandlers } from './ipc/workspace';
import { setupEventHandlers } from './ipc/events';
import { setupMcpHandlers, initMcpAndSkills, shutdownMcpAndSkills } from './ipc/mcp';
import { setupMetaAgentHandlers } from './ipc/meta-agent';
import { startDaemon, stopDaemon } from './engine/meta-agent-daemon';
import { setupMissionHandlers } from './ipc/missions';
import { setupSessionHandlers } from './ipc/sessions';
import { setupMonitorHandlers } from './ipc/monitor';
import { registerWorkflowHandlers } from './ipc/workflow';
import { setupSelfEvolutionHandlers } from './ipc/self-evolution';
import { initDatabase } from './db';

let mainWindow: BrowserWindow | null = null;

/* ── 单实例锁 ──
 * 阻止用户多次双击启动多个进程。
 * 第二个实例启动时会自动退出, 并把焦点切回已有窗口。
 */
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // 已有实例在运行 → 立即退出
  app.quit();
} else {
  app.on('second-instance', () => {
    // 第二个实例尝试启动时, 把已有窗口拉到前台
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

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
    title: '智械母机 AutoMater',
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
  // ── Content Security Policy ──
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self';" +
            " script-src 'self' 'unsafe-inline' 'unsafe-eval';" +
            " style-src 'self' 'unsafe-inline';" +
            " img-src 'self' data: https:;" +
            " connect-src 'self' https: http: ws: wss:;" +
            " font-src 'self' data:;" +
            " object-src 'none';" +
            " base-uri 'self'",
        ],
      },
    });
  });

  // ── 先创建窗口，确保用户能看到界面 ──
  createWindow();

  try {
    // 初始化数据库
    await initDatabase();

    // 注册 IPC 处理器
    setupSettingsHandlers();
    initSearchConfigFromDb(); // v24.0: 搜索引擎 key 从 DB 加载到 search-provider
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
    setupSelfEvolutionHandlers();

    // 自动连接 MCP 服务器 + 加载技能目录 (不阻塞窗口创建)
    initMcpAndSkills().catch(() => {
      /* 启动时失败不阻塞 */
    });

    // v7.0: 启动管家守护进程 (心跳/事件钩子/定时任务)
    startDaemon();
  } catch (err) {
    // 初始化失败时显示错误对话框，而不是静默卡死
    const { dialog } = await import('electron');
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[FATAL] Startup initialization failed:', msg);
    dialog.showErrorBox(
      '启动失败 — 智械母机 AutoMater',
      `应用初始化时发生错误，请截图反馈：\n\n${msg}\n\n` +
        '可尝试的修复方式：\n' +
        '1. 完全退出后重新打开\n' +
        '2. 删除 %APPDATA%/automater/data/automater.db 后重试（会丢失历史数据）',
    );
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopDaemon();
  shutdownMcpAndSkills().catch(() => {});
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
