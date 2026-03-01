/**
 * Sessions IPC — Session 管理 + 备份查看
 *
 * v8.0: 初始创建
 *   - Session CRUD (create/switch/list)
 *   - Backup 读取 + 统计
 *   - 支持前端 Session 切换器 UI
 */

import { ipcMain } from 'electron';
import {
  createSession, switchSession, listSessions, listAllSessions,
  getActiveSession, readSessionBackup, getBackupStats, cleanupOldBackups,
  type SessionInfo,
} from '../engine/conversation-backup';

export function setupSessionHandlers() {

  // ── Session CRUD ──

  /** 创建新 Session */
  ipcMain.handle('session:create', (_event, projectId: string | null, agentId: string, agentRole: string) => {
    return createSession(projectId, agentId, agentRole);
  });

  /** 切换到指定 Session */
  ipcMain.handle('session:switch', (_event, sessionId: string) => {
    return switchSession(sessionId);
  });

  /** 获取某个 Agent 的活跃 Session */
  ipcMain.handle('session:get-active', (_event, projectId: string | null, agentId: string) => {
    return getActiveSession(projectId, agentId);
  });

  /** 列出某个项目/Agent 的所有 Session */
  ipcMain.handle('session:list', (_event, projectId: string | null, agentId?: string) => {
    return listSessions(projectId, agentId);
  });

  /** 列出所有 Session (全局) */
  ipcMain.handle('session:list-all', (_event, limit?: number) => {
    return listAllSessions(limit);
  });

  // ── Backup 读取 ──

  /** 读取 Session 对应的备份内容 */
  ipcMain.handle('session:read-backup', (_event, sessionId: string) => {
    return readSessionBackup(sessionId);
  });

  // ── 统计与清理 ──

  /** 获取备份统计 */
  ipcMain.handle('session:backup-stats', () => {
    return getBackupStats();
  });

  /** 清理旧备份 */
  ipcMain.handle('session:cleanup', (_event, keepDays?: number) => {
    const deleted = cleanupOldBackups(keepDays);
    return { success: true, deletedFolders: deleted };
  });
}
