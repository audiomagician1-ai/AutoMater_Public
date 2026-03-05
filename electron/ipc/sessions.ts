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
import { assertProjectId, assertNonEmptyString, assertOptionalNumber } from './ipc-validator';
import { getDb } from '../db';
import {
  createSession,
  switchSession,
  listSessions,
  listAllSessions,
  getActiveSession,
  readSessionBackup,
  getBackupStats,
  cleanupOldBackups,
  getSessionsForFeature,
  getFeaturesForSession,
  listFeatureSessionLinks,
  batchGetFeatureSessionSummaries,
} from '../engine/conversation-backup';
import { createLogger } from '../engine/logger';
const log = createLogger('ipc:sessions');


export function setupSessionHandlers() {
  // ── Session CRUD ──

  /** 创建新 Session */
  ipcMain.handle(
    'session:create',
    (_event, projectId: string | null, agentId: string, agentRole: string, chatMode?: string) => {
      assertNonEmptyString('session:create', 'agentId', agentId);
      assertNonEmptyString('session:create', 'agentRole', agentRole);
      return createSession(projectId, agentId, agentRole, (chatMode as 'work' | 'chat' | 'deep') || 'work');
    },
  );

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
    const _backup = readSessionBackup(sessionId);
    // 尝试从 DB 获取 backup_path
    try {
      const db = getDb();
      const row = db.prepare('SELECT backup_path FROM sessions WHERE id = ?').get(sessionId) as
        | { backup_path: string | null }
        | undefined;
      if (row?.backup_path) {
        const path = await import('path');
        const dir = path.default.dirname(row.backup_path);
        await shell.openPath(dir);
        return { success: true };
      }
    } catch {
      /* fallthrough */
    }
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

  /** v22.0: 更新会话的聊天模式 */
  ipcMain.handle('session:update-chat-mode', (_event, sessionId: string, chatMode: string) => {
    assertNonEmptyString('session:update-chat-mode', 'sessionId', sessionId);
    assertNonEmptyString('session:update-chat-mode', 'chatMode', chatMode);
    const db = getDb();
    db.prepare('UPDATE sessions SET chat_mode = ? WHERE id = ?').run(chatMode, sessionId);
    return { success: true };
  });

  /** v27.0: 切换会话置顶状态 */
  ipcMain.handle('session:toggle-pin', (_event, sessionId: string) => {
    assertNonEmptyString('session:toggle-pin', 'sessionId', sessionId);
    const db = getDb();
    // 翻转 pinned: 0→1, 1→0
    db.prepare('UPDATE sessions SET pinned = CASE WHEN pinned = 1 THEN 0 ELSE 1 END WHERE id = ?').run(sessionId);
    const row = db.prepare('SELECT pinned FROM sessions WHERE id = ?').get(sessionId) as { pinned: number } | undefined;
    return { success: true, pinned: !!row?.pinned };
  });

  /** v27.0: 重命名会话 (自定义标题) */
  ipcMain.handle('session:rename', (_event, sessionId: string, customTitle: string | null) => {
    assertNonEmptyString('session:rename', 'sessionId', sessionId);
    const db = getDb();
    // null 或空字符串 = 清除自定义标题，恢复默认
    const title = customTitle?.trim() || null;
    db.prepare('UPDATE sessions SET custom_title = ? WHERE id = ?').run(title, sessionId);
    return { success: true, customTitle: title };
  });

  /** v27.0: 切换会话隐藏状态 */
  ipcMain.handle('session:toggle-hidden', (_event, sessionId: string) => {
    assertNonEmptyString('session:toggle-hidden', 'sessionId', sessionId);
    const db = getDb();
    db.prepare('UPDATE sessions SET hidden = CASE WHEN hidden = 1 THEN 0 ELSE 1 END WHERE id = ?').run(sessionId);
    const row = db.prepare('SELECT hidden FROM sessions WHERE id = ?').get(sessionId) as { hidden: number } | undefined;
    return { success: true, hidden: !!row?.hidden };
  });
}
