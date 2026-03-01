/**
 * 项目 IPC — 创建项目、启动 Agent 编排
 */

import { ipcMain, BrowserWindow } from 'electron';
import { getDb } from '../db';
import { v4 as uuid } from 'crypto';
import { runOrchestrator } from '../engine/orchestrator';

function generateId(): string {
  // 简易 UUID
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function setupProjectHandlers() {

  // ── 创建项目 ──
  ipcMain.handle('project:create', async (_event, wish: string) => {
    const db = getDb();
    const id = generateId();
    const name = wish.length > 30 ? wish.slice(0, 30) + '...' : wish;

    db.prepare(`
      INSERT INTO projects (id, name, wish, status, config)
      VALUES (?, ?, ?, 'initializing', '{}')
    `).run(id, name, wish);

    return { success: true, projectId: id, name };
  });

  // ── 列出项目 ──
  ipcMain.handle('project:list', () => {
    const db = getDb();
    return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  });

  // ── 获取单个项目 ──
  ipcMain.handle('project:get', (_event, id: string) => {
    const db = getDb();
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  });

  // ── 获取项目的 features ──
  ipcMain.handle('project:get-features', (_event, projectId: string) => {
    const db = getDb();
    return db.prepare('SELECT * FROM features WHERE project_id = ? ORDER BY priority ASC, id ASC').all(projectId);
  });

  // ── 获取项目的 agents ──
  ipcMain.handle('project:get-agents', (_event, projectId: string) => {
    const db = getDb();
    return db.prepare('SELECT * FROM agents WHERE project_id = ? ORDER BY created_at ASC').all(projectId);
  });

  // ── 启动项目 (开始 Agent 编排) ──
  ipcMain.handle('project:start', async (_event, projectId: string) => {
    const win = BrowserWindow.getFocusedWindow();
    // 异步启动编排器，不阻塞 UI
    runOrchestrator(projectId, win).catch(err => {
      console.error('[Orchestrator] Fatal error:', err);
      win?.webContents.send('agent:error', { projectId, error: err.message });
    });
    return { success: true };
  });

  // ── 停止项目 ──
  ipcMain.handle('project:stop', (_event, projectId: string) => {
    const db = getDb();
    db.prepare("UPDATE projects SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(projectId);
    // TODO: 实际停止 orchestrator
    return { success: true };
  });
}
