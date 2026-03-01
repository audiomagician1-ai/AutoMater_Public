/**
 * 项目 IPC — 创建项目、启动 Agent 编排
 */

import { ipcMain, BrowserWindow, app, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { getDb } from '../db';
import { runOrchestrator, stopOrchestrator } from '../engine/orchestrator';

function generateId(): string {
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function setupProjectHandlers() {

  // ── 创建项目 ──
  ipcMain.handle('project:create', async (_event, wish: string) => {
    const db = getDb();
    const id = generateId();
    const name = wish.length > 30 ? wish.slice(0, 30) + '...' : wish;

    // 创建工作区目录
    const workspacesRoot = path.join(app.getPath('userData'), 'workspaces');
    const workspacePath = path.join(workspacesRoot, id);
    fs.mkdirSync(workspacePath, { recursive: true });

    db.prepare(`
      INSERT INTO projects (id, name, wish, status, workspace_path, config)
      VALUES (?, ?, ?, 'initializing', ?, '{}')
    `).run(id, name, wish, workspacePath);

    return { success: true, projectId: id, name, workspacePath };
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

  // ── 获取项目日志 ──
  ipcMain.handle('project:get-logs', (_event, projectId: string, limit: number = 200) => {
    const db = getDb();
    return db.prepare('SELECT * FROM agent_logs WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit).reverse();
  });

  // ── 获取项目统计 ──
  ipcMain.handle('project:get-stats', (_event, projectId: string) => {
    const db = getDb();
    const featureStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as todo,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM features WHERE project_id = ?
    `).get(projectId);
    const agentStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(total_input_tokens + total_output_tokens) as total_tokens,
        SUM(total_cost_usd) as total_cost
      FROM agents WHERE project_id = ?
    `).get(projectId);
    return { features: featureStats, agents: agentStats };
  });

  // ── 启动项目 (开始 Agent 编排) ──
  ipcMain.handle('project:start', async (_event, projectId: string) => {
    const win = BrowserWindow.getAllWindows()[0] ?? null;
    runOrchestrator(projectId, win).catch(err => {
      console.error('[Orchestrator] Fatal error:', err);
      win?.webContents.send('agent:error', { projectId, error: err.message });
    });
    return { success: true };
  });

  // ── 停止项目 ──
  ipcMain.handle('project:stop', (_event, projectId: string) => {
    stopOrchestrator(projectId);
    return { success: true };
  });

  // ── 删除项目 ──
  ipcMain.handle('project:delete', (_event, projectId: string) => {
    stopOrchestrator(projectId);
    const db = getDb();
    // 获取 workspace 路径以清理磁盘
    const project = db.prepare('SELECT workspace_path FROM projects WHERE id = ?').get(projectId) as { workspace_path?: string } | undefined;
    db.prepare('DELETE FROM agent_logs WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM agents WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM features WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    // 可选：清理工作区磁盘（异步，不阻塞）
    if (project?.workspace_path && fs.existsSync(project.workspace_path)) {
      fs.rm(project.workspace_path, { recursive: true, force: true }, () => {});
    }
    return { success: true };
  });

  // ── 打开工作区文件夹 ──
  ipcMain.handle('project:open-workspace', async (_event, projectId: string) => {
    const db = getDb();
    const project = db.prepare('SELECT workspace_path FROM projects WHERE id = ?').get(projectId) as { workspace_path?: string } | undefined;
    if (project?.workspace_path && fs.existsSync(project.workspace_path)) {
      await shell.openPath(project.workspace_path);
      return { success: true };
    }
    return { success: false, error: '工作区目录不存在' };
  });
}

