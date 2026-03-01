/**
 * Workspace IPC — 读取项目工作区的文件树和内容
 */

import { ipcMain } from 'electron';
import { getDb } from '../db';
import { readDirectoryTree, readWorkspaceFile } from '../engine/file-writer';

function getWorkspacePath(projectId: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT workspace_path FROM projects WHERE id = ?').get(projectId) as { workspace_path?: string } | undefined;
  return row?.workspace_path ?? null;
}

export function setupWorkspaceHandlers() {

  // ── 获取文件树 ──
  ipcMain.handle('workspace:tree', (_event, projectId: string) => {
    const wsPath = getWorkspacePath(projectId);
    if (!wsPath) return { success: false, tree: [] };
    return { success: true, tree: readDirectoryTree(wsPath) };
  });

  // ── 读取文件内容 ──
  ipcMain.handle('workspace:read-file', (_event, projectId: string, relativePath: string) => {
    const wsPath = getWorkspacePath(projectId);
    if (!wsPath) return { success: false, content: '' };
    const content = readWorkspaceFile(wsPath, relativePath);
    if (content === null) return { success: false, content: '' };
    return { success: true, content };
  });

  // ── 获取工作区路径 ──
  ipcMain.handle('workspace:get-path', (_event, projectId: string) => {
    return getWorkspacePath(projectId);
  });
}
