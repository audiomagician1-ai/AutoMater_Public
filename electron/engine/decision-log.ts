/**
 * Decision Log — 并行 Worker 共享决策日志 (v5.5)
 *
 * 解决并行 Worker 同时修改同一文件导致冲突的问题。
 * 每个 Worker 在开始 Feature 前声明 "我计划修改哪些文件"，
 * 其他 Worker 在开始前检查有无交叉，若有则等待或标记冲突。
 *
 * 存储: .agentforge/decision-log.jsonl (JSON Lines, 追加写入)
 * 机制: 乐观锁 + 文件级声明 + 冲突检测
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';

const log = createLogger('decision-log');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface DecisionEntry {
  /** Feature ID being worked on */
  featureId: string;
  /** Worker agent ID */
  workerId: string;
  /** Files this worker plans to modify */
  plannedFiles: string[];
  /** Timestamp */
  timestamp: string;
  /** Action: claim (start), release (done), conflict (detected) */
  action: 'claim' | 'release' | 'conflict';
  /** Optional note */
  note?: string;
}

export interface ConflictInfo {
  /** The other worker that has claimed overlapping files */
  otherWorkerId: string;
  otherFeatureId: string;
  /** Overlapping file paths */
  overlappingFiles: string[];
}

// ═══════════════════════════════════════
// Log File Management
// ═══════════════════════════════════════

function getLogPath(workspacePath: string): string {
  return path.join(workspacePath, '.agentforge', 'decision-log.jsonl');
}

function ensureLogDir(workspacePath: string): void {
  const dir = path.join(workspacePath, '.agentforge');
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Append a decision entry to the log file.
 */
function appendEntry(workspacePath: string, entry: DecisionEntry): void {
  ensureLogDir(workspacePath);
  const logPath = getLogPath(workspacePath);
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(logPath, line, 'utf-8');
}

/**
 * Read all entries from the decision log.
 */
function readEntries(workspacePath: string): DecisionEntry[] {
  const logPath = getLogPath(workspacePath);
  if (!fs.existsSync(logPath)) return [];

  const content = fs.readFileSync(logPath, 'utf-8');
  const entries: DecisionEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      log.warn('Failed to parse decision log line:', { preview: trimmed.slice(0, 100) });
    }
  }
  return entries;
}

// ═══════════════════════════════════════
// Active Claims (computed from log)
// ═══════════════════════════════════════

/**
 * Get currently active file claims (claimed but not yet released).
 * Returns a map: filePath → { workerId, featureId }
 */
export function getActiveClaims(workspacePath: string): Map<string, { workerId: string; featureId: string }> {
  const entries = readEntries(workspacePath);
  const claims = new Map<string, { workerId: string; featureId: string }>();

  // Track which features have been released
  const releasedFeatures = new Set<string>();
  for (const e of entries) {
    if (e.action === 'release') {
      releasedFeatures.add(`${e.workerId}:${e.featureId}`);
    }
  }

  // Build active claims (claimed but not released)
  for (const e of entries) {
    if (e.action === 'claim' && !releasedFeatures.has(`${e.workerId}:${e.featureId}`)) {
      for (const f of e.plannedFiles) {
        const normalized = f.replace(/\\/g, '/');
        claims.set(normalized, { workerId: e.workerId, featureId: e.featureId });
      }
    }
  }

  return claims;
}

// ═══════════════════════════════════════
// Public API
// ═══════════════════════════════════════

/**
 * Claim files before starting work on a feature.
 * Returns conflicts if any files are already claimed by other workers.
 */
export function claimFiles(
  workspacePath: string,
  workerId: string,
  featureId: string,
  plannedFiles: string[],
): ConflictInfo[] {
  const normalizedFiles = plannedFiles.map(f => f.replace(/\\/g, '/'));
  const activeClaims = getActiveClaims(workspacePath);
  const conflicts: ConflictInfo[] = [];

  // Check for overlaps with other workers
  const conflictMap = new Map<string, string[]>(); // otherKey → overlapping files
  for (const file of normalizedFiles) {
    const claim = activeClaims.get(file);
    if (claim && claim.workerId !== workerId) {
      const key = `${claim.workerId}:${claim.featureId}`;
      if (!conflictMap.has(key)) conflictMap.set(key, []);
      conflictMap.get(key)!.push(file);
    }
  }

  for (const [key, files] of conflictMap) {
    const [otherWorkerId, otherFeatureId] = key.split(':');
    conflicts.push({ otherWorkerId, otherFeatureId, overlappingFiles: files });
  }

  // Record the claim regardless (we log conflicts too)
  appendEntry(workspacePath, {
    featureId, workerId, plannedFiles: normalizedFiles,
    timestamp: new Date().toISOString(),
    action: 'claim',
  });

  if (conflicts.length > 0) {
    appendEntry(workspacePath, {
      featureId, workerId,
      plannedFiles: conflicts.flatMap(c => c.overlappingFiles),
      timestamp: new Date().toISOString(),
      action: 'conflict',
      note: conflicts.map(c => `${c.otherWorkerId} (${c.otherFeatureId}): ${c.overlappingFiles.join(', ')}`).join('; '),
    });
    log.warn(`File conflicts detected for ${workerId}/${featureId}:`, { conflicts: conflicts.map(c => `${c.otherWorkerId}(${c.otherFeatureId})`) });
  }

  return conflicts;
}

/**
 * Release file claims when a feature is completed or failed.
 */
export function releaseFiles(
  workspacePath: string,
  workerId: string,
  featureId: string,
): void {
  appendEntry(workspacePath, {
    featureId, workerId, plannedFiles: [],
    timestamp: new Date().toISOString(),
    action: 'release',
  });
}

/**
 * Get a summary of active claims for UI display or context injection.
 * Returns a human-readable string that can be injected into a worker's context.
 */
export function getClaimsSummary(workspacePath: string, excludeWorkerId?: string): string {
  const claims = getActiveClaims(workspacePath);
  if (claims.size === 0) return '';

  // Group by worker
  const byWorker = new Map<string, { featureId: string; files: string[] }>();
  for (const [file, { workerId, featureId }] of claims) {
    if (excludeWorkerId && workerId === excludeWorkerId) continue;
    const key = `${workerId}:${featureId}`;
    if (!byWorker.has(key)) byWorker.set(key, { featureId, files: [] });
    byWorker.get(key)!.files.push(file);
  }

  if (byWorker.size === 0) return '';

  const lines = ['## 其他 Worker 正在修改的文件 (避免冲突)'];
  for (const [key, { featureId, files }] of byWorker) {
    const workerId = key.split(':')[0];
    lines.push(`- **${workerId}** (${featureId}): ${files.slice(0, 10).join(', ')}${files.length > 10 ? ` ...+${files.length - 10}` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Predict which files a feature will likely modify, based on feature metadata.
 * This is a heuristic — uses affected_files from feature, or falls back to category-based guess.
 */
export function predictAffectedFiles(feature: any): string[] {
  // Try parsing affected_files from feature
  if (feature.affected_files) {
    try {
      const files = JSON.parse(feature.affected_files);
      if (Array.isArray(files) && files.length > 0) return files;
    } catch { /* fallback */ }
  }

  // Heuristic: use category + title to guess directory patterns
  const category = (feature.category || '').toLowerCase();
  const title = (feature.title || '').toLowerCase();
  const patterns: string[] = [];

  if (category.includes('api') || title.includes('api')) patterns.push('src/api/**');
  if (category.includes('ui') || title.includes('组件') || title.includes('页面')) patterns.push('src/components/**', 'src/pages/**');
  if (category.includes('db') || title.includes('数据库') || title.includes('schema')) patterns.push('src/db/**', 'migrations/**');
  if (category.includes('auth') || title.includes('认证') || title.includes('登录')) patterns.push('src/auth/**');

  return patterns;
}

/**
 * Clean up decision log — remove entries older than 24 hours.
 * Call periodically or at project start.
 */
export function cleanupDecisionLog(workspacePath: string): void {
  const entries = readEntries(workspacePath);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recent = entries.filter(e => e.timestamp > cutoff);

  if (recent.length < entries.length) {
    ensureLogDir(workspacePath);
    const logPath = getLogPath(workspacePath);
    fs.writeFileSync(logPath, recent.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
    log.info(`Decision log cleanup: ${entries.length} → ${recent.length} entries`);
  }
}
