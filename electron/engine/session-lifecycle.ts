/**
 * Session Lifecycle — 僵尸锁清理 + Session GC (v28.0)
 *
 * 两个核心职责:
 *   1. cleanupZombieLocks: 清理 locked_at 超时的 feature 锁
 *   2. gcSessions: 归档过期 session + 清理 DB 和备份文件
 *
 * 由 daemon 定时调用。
 */

import fs from 'fs';
import { getDb } from '../db';
import { createLogger } from './logger';

const log = createLogger('session-lifecycle');

// ═══════════════════════════════════════
// Zombie Lock Cleanup
// ═══════════════════════════════════════

/**
 * 清理僵尸锁 — feature 被 locked_by 但超过 timeoutMinutes 且无对应 running session
 *
 * 场景: worker 进程崩溃后 feature 永远 locked
 * 策略: 如果 features.locked_at 超过阈值且没有对应的 running session，释放锁
 */
export function cleanupZombieLocks(timeoutMinutes: number = 30): number {
  const db = getDb();
  let cleaned = 0;

  try {
    // 查找所有 locked 但可能是僵尸的 feature
    const lockedFeatures = db
      .prepare(
        `
      SELECT f.id, f.project_id, f.locked_by, f.locked_at
      FROM features f
      WHERE f.status = 'in_progress'
        AND f.locked_by IS NOT NULL
        AND (
          f.locked_at IS NULL
          OR f.locked_at < datetime('now', '-' || ? || ' minutes')
        )
    `,
      )
      .all(timeoutMinutes) as Array<{
      id: string;
      project_id: string;
      locked_by: string;
      locked_at: string | null;
    }>;

    for (const f of lockedFeatures) {
      // 检查是否有对应的 running session
      // locked_by 可能是 sessionId (v28.0) 或旧的 workerId (dev-1 等)
      const hasRunningSession = db
        .prepare(
          `
        SELECT 1 FROM sessions
        WHERE (id = ? OR agent_id = ?)
          AND status IN ('running', 'active', 'created')
        LIMIT 1
      `,
        )
        .get(f.locked_by, f.locked_by);

      if (!hasRunningSession) {
        // 确认是僵尸锁 — 释放
        db.prepare(
          "UPDATE features SET status = 'todo', locked_by = NULL, locked_at = NULL WHERE id = ? AND project_id = ?",
        ).run(f.id, f.project_id);
        cleaned++;
        log.info('Zombie lock released', {
          featureId: f.id,
          projectId: f.project_id,
          lockedBy: f.locked_by,
          lockedAt: f.locked_at,
        });
      }
    }
  } catch (err) {
    log.error('Zombie lock cleanup failed', err);
  }

  return cleaned;
}

// ═══════════════════════════════════════
// Session GC
// ═══════════════════════════════════════

export interface GCConfig {
  /** completed/failed 后多少天归档 (默认 7) */
  archiveAfterDays: number;
  /** archived 后多少天删除 DB + 备份文件 (默认 90) */
  deleteAfterDays: number;
}

const DEFAULT_GC_CONFIG: GCConfig = {
  archiveAfterDays: 7,
  deleteAfterDays: 90,
};

/**
 * Session GC — 归档过期 session + 清理 DB 和备份文件
 *
 * Phase 1: completed/failed 超过 archiveAfterDays → 标记 archived
 * Phase 2: archived 超过 deleteAfterDays → 删除 DB 记录 + 备份文件
 */
export function gcSessions(config: Partial<GCConfig> = {}): { archived: number; deleted: number } {
  const cfg = { ...DEFAULT_GC_CONFIG, ...config };
  const db = getDb();
  let archived = 0;
  let deleted = 0;

  try {
    // Phase 1: 归档
    const archiveResult = db
      .prepare(
        `
      UPDATE sessions SET status = 'archived'
      WHERE status IN ('completed', 'failed')
        AND completed_at IS NOT NULL
        AND completed_at < datetime('now', '-' || ? || ' days')
    `,
      )
      .run(cfg.archiveAfterDays);
    archived = archiveResult.changes;

    // Phase 2: 删除过期 archived sessions
    const toDelete = db
      .prepare(
        `
      SELECT id, backup_path FROM sessions
      WHERE status = 'archived'
        AND completed_at IS NOT NULL
        AND completed_at < datetime('now', '-' || ? || ' days')
    `,
      )
      .all(cfg.deleteAfterDays) as Array<{ id: string; backup_path: string | null }>;

    for (const session of toDelete) {
      // 删除备份文件
      if (session.backup_path) {
        try {
          if (fs.existsSync(session.backup_path)) {
            fs.unlinkSync(session.backup_path);
          }
        } catch {
          /* non-critical: 文件可能已被手动删除 */
        }
      }

      // 删除关联的 feature_sessions 记录
      db.prepare('DELETE FROM feature_sessions WHERE session_id = ?').run(session.id);

      // 删除 session 记录
      db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);

      deleted++;
    }
  } catch (err) {
    log.error('Session GC failed', err);
  }

  if (archived > 0 || deleted > 0) {
    log.info('Session GC completed', { archived, deleted });
  }

  return { archived, deleted };
}
