/**
 * Sessions IPC — Session 管理 + 备份查看 + Feature-Session 关联
 *
 * v8.0: 初始创建
 *   - Session CRUD (create/switch/list)
 *   - Backup 读取 + 统计
 *   - 支持前端 Session 切换器 UI
 * v8.1: Feature-Session 关联查询
 *   - 按 Feature 查关联 Sessions
 *   - 按 Session 查关联 Features
 *   - 批量获取项目所有 Feature 的 Session 摘要
 */

import { ipcMain, shell } from 'electron';
import { assertProjectId, assertNonEmptyString, assertOptionalString, assertOptionalNumber } from './ipc-validator';
import {
  createSession, switchSession, listSessions, listAllSessions,
  getActiveSession, readSessionBackup, getBackupStats, cleanupOldBackups,
  getSessionsForFeature, getFeaturesForSession, listFeatureSessionLinks,
  batchGetFeatureSessionSummaries,
  type SessionInfo,
} from '../engine/conversation-backup';

export function setupSessionHandlers() {

  // ── Session CRUD ──

  /** 创建新 Session */
  ipcMain.handle('session:create', (_event, projectId: string | null, agentId: string, agentRole: string) => {
    assertNonEmptyString('session:create', 'agentId', agentId);
    assertNonEmptyString('session:create', 'agentRole', agentRole);
    return createSession(projectId, agentId, agentRole);
  });

  /** 切换到指定 Session */
  ipcMain.handle('session:switch', (_event, sessionId: string) => {
    assertNonEmptyString('session:switch', 'sessionId', sessionId);
    return switchSession(sessionId);
  });

  /** 获取某个 Agent 的活跃 Session */
  ipcMain.handle('session:get-active', (_event, projectId: string | null, agentId: string) => {
    assertNonEmptyString('session:get-active', 'agentId', agentId);
    return getActiveSession(projectId, agentId);
  });

  /** 列出某个项目/Agent 的所有 Session */
  ipcMain.handle('session:list', (_event, projectId: string | null, agentId?: string) => {
    return listSessions(projectId, agentId);
  });

  /** 列出所有 Session (全局) */
  ipcMain.handle('session:list-all', (_event, limit?: number) => {
    assertOptionalNumber('session:list-all', 'limit', limit);
    return listAllSessions(limit);
  });

  // ── Backup 读取 ──

  /** 读取 Session 对应的备份内容 */
  ipcMain.handle('session:read-backup', (_event, sessionId: string) => {
    assertNonEmptyString('session:read-backup', 'sessionId', sessionId);
    return readSessionBackup(sessionId);
  });

  // ── 统计与清理 ──

  /** 打开 Session 备份文件夹 (资源管理器) */
  ipcMain.handle('session:open-backup-folder', async (_event, sessionId: string) => {
    assertNonEmptyString('session:open-backup-folder', 'sessionId', sessionId);
    const backup = readSessionBackup(sessionId);
    // 尝试从 DB 获取 backup_path
    try {
      const { getDb } = await import('../db');
      const db = getDb();
      const row = db.prepare('SELECT backup_path FROM sessions WHERE id = ?').get(sessionId) as { backup_path: string | null } | undefined;
      if (row?.backup_path) {
        const path = await import('path');
        const dir = path.default.dirname(row.backup_path);
        await shell.openPath(dir);
        return { success: true };
      }
    } catch { /* fallthrough */ }
    return { success: false, error: 'No backup path found' };
  });

  /** 获取备份统计 */
  ipcMain.handle('session:backup-stats', () => {
    return getBackupStats();
  });

  /** 清理旧备份 */
  ipcMain.handle('session:cleanup', (_event, keepDays?: number) => {
    assertOptionalNumber('session:cleanup', 'keepDays', keepDays);
    const deleted = cleanupOldBackups(keepDays);
    return { success: true, deletedFolders: deleted };
  });

  // ── Feature-Session 关联查询 (v8.1) ──

  /** 获取某个 Feature 关联的所有 Sessions (含 Session 详情) */
  ipcMain.handle('session:feature-sessions', (_event, projectId: string, featureId: string) => {
    assertProjectId('session:feature-sessions', projectId);
    assertNonEmptyString('session:feature-sessions', 'featureId', featureId);
    return getSessionsForFeature(projectId, featureId);
  });

  /** 获取某个 Session 关联的所有 Features */
  ipcMain.handle('session:session-features', (_event, sessionId: string) => {
    assertNonEmptyString('session:session-features', 'sessionId', sessionId);
    return getFeaturesForSession(sessionId);
  });

  /** 获取项目下所有 Feature-Session 关联 */
  ipcMain.handle('session:feature-session-links', (_event, projectId: string, limit?: number) => {
    assertProjectId('session:feature-session-links', projectId);
    assertOptionalNumber('session:feature-session-links', 'limit', limit);
    return listFeatureSessionLinks(projectId, limit);
  });

  /** 批量获取项目所有 Feature 的 Session 摘要 (看板用) */
  ipcMain.handle('session:batch-feature-summaries', (_event, projectId: string) => {
    assertProjectId('session:batch-feature-summaries', projectId);
    const map = batchGetFeatureSessionSummaries(projectId);
    // Map → plain object (IPC 序列化)
    const obj: Record<string, any> = {};
    for (const [k, v] of map.entries()) {
      obj[k] = v;
    }
    return obj;
  });
}
