/**
 * File Lock — 进程内文件级写锁 (构想A)
 *
 * 将 decision-log.ts 的"声明式君子协定"升级为"强制互斥锁"。
 * 当一个 Worker 持有某文件的锁时，其他 Worker 的 write_file/edit_file 将返回工具错误，
 * 让 ReAct 循环自动重试或选择其他文件。
 *
 * 设计约束:
 *   - 进程内内存 Map（无需跨进程，符合 ADR-003/004 单体架构）
 *   - 零额外 LLM 调用（仅内存查询）
 *   - 超时自动释放（防僵尸锁）
 *   - 单 Worker 模式 (workerCount=1) 下行为不变（锁无竞争）
 */

import path from 'path';
import { createLogger } from './logger';

const log = createLogger('file-lock');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface FileLockEntry {
  workerId: string;
  featureId: string;
  lockedAt: number;
}

export interface AcquireResult {
  acquired: boolean;
  /** 锁已被其他 Worker 持有时，返回持有者信息 */
  holder?: { workerId: string; featureId: string };
}

// ═══════════════════════════════════════
// In-Memory Lock Table
// ═══════════════════════════════════════

/** 文件路径 → 锁信息。路径统一为正斜杠小写 normalize 后的 key。 */
const fileLocks = new Map<string, FileLockEntry>();

/** 路径归一化: resolve + 统一为正斜杠 */
function normalizePath(workspacePath: string, filePath: string): string {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(workspacePath, filePath);
  return abs.replace(/\\/g, '/').toLowerCase();
}

// ═══════════════════════════════════════
// Public API
// ═══════════════════════════════════════

/**
 * 尝试获取文件写锁。
 *
 * - 同一 Worker 重入安全（同 workerId 可重复 acquire 同一文件）
 * - 不同 Worker 冲突时返回 acquired=false + holder 信息
 */
export function acquireFileLock(
  workspacePath: string,
  filePath: string,
  workerId: string,
  featureId: string,
): AcquireResult {
  const key = normalizePath(workspacePath, filePath);
  const existing = fileLocks.get(key);

  if (existing && existing.workerId !== workerId) {
    // 已被其他 Worker 持有
    return { acquired: false, holder: { workerId: existing.workerId, featureId: existing.featureId } };
  }

  // 无锁 或 同 Worker 重入 → 成功
  fileLocks.set(key, { workerId, featureId, lockedAt: Date.now() });
  return { acquired: true };
}

/**
 * 释放指定 Worker + Feature 的所有文件锁。
 * 在 workerLoop 完成一个 Feature（pass 或 fail）后调用。
 */
export function releaseFeatureLocks(workerId: string, featureId: string): number {
  let released = 0;
  for (const [key, lock] of fileLocks) {
    if (lock.workerId === workerId && lock.featureId === featureId) {
      fileLocks.delete(key);
      released++;
    }
  }
  if (released > 0) {
    log.debug(`Released ${released} file locks for ${workerId}/${featureId}`);
  }
  return released;
}

/**
 * 释放指定 Worker 的所有文件锁（不限 Feature）。
 * 用于 Worker 退出或异常清理。
 */
export function releaseWorkerLocks(workerId: string): number {
  let released = 0;
  for (const [key, lock] of fileLocks) {
    if (lock.workerId === workerId) {
      fileLocks.delete(key);
      released++;
    }
  }
  return released;
}

/**
 * 清理超时的僵尸锁。
 * 默认 5 分钟 (300_000ms)。建议在 orchestrator 定期调用。
 */
export function cleanExpiredLocks(maxAgeMs: number = 300_000): number {
  const cutoff = Date.now() - maxAgeMs;
  let cleaned = 0;
  for (const [key, lock] of fileLocks) {
    if (lock.lockedAt < cutoff) {
      log.warn(`Cleaning expired lock: ${key} (held by ${lock.workerId} for ${((Date.now() - lock.lockedAt) / 1000).toFixed(0)}s)`);
      fileLocks.delete(key);
      cleaned++;
    }
  }
  return cleaned;
}

/**
 * 获取当前活跃的锁数量（诊断用）。
 */
export function getActiveLockCount(): number {
  return fileLocks.size;
}

/**
 * 获取所有活跃锁的摘要（UI 日志用）。
 */
export function getLocksSummary(): string {
  if (fileLocks.size === 0) return '';
  const byWorker = new Map<string, string[]>();
  for (const [key, lock] of fileLocks) {
    const wk = lock.workerId;
    if (!byWorker.has(wk)) byWorker.set(wk, []);
    // 只取文件名部分，避免日志过长
    const shortPath = key.split('/').slice(-2).join('/');
    byWorker.get(wk)?.push(shortPath);
  }
  const lines: string[] = [];
  for (const [wk, files] of byWorker) {
    lines.push(`  ${wk}: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` +${files.length - 5}` : ''}`);
  }
  return `Active file locks (${fileLocks.size}):\n${lines.join('\n')}`;
}
