/**
 * health-diagnostics.test.ts — 健康诊断引擎测试 (v34.0)
 *
 * 测试策略:
 *   1. 内存健康追踪 (recordFeatureFailure / recordQAReject / recordFeatureSuccess)
 *   2. 7种异常模式检测 (依赖 DB 的使用 in-memory SQLite)
 *   3. formatAnomalySummary 输出格式
 *   4. runDiagnostics / runProjectDiagnostics 整合
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { getDb, resetTestDb } from '../../db';
import {
  runDiagnostics,
  runProjectDiagnostics,
  recordFeatureFailure,
  recordFeatureSuccess,
  recordQAReject,
  getFeatureHealth,
  resetHealthTracking,
  formatAnomalySummary,
  type AnomalyReport,
  type DiagnosticThresholds,
} from '../health-diagnostics';

// Detect if we have real sqlite or stub
let hasRealSqlite = false;
try {
  const db = resetTestDb();
  db.exec('SELECT 1');
  hasRealSqlite = true;
} catch { /* stub mode */ }

// ═══════════════════════════════════════
// 1. In-memory health tracking (no DB needed)
// ═══════════════════════════════════════

describe('Health Tracking (in-memory)', () => {
  beforeEach(() => {
    resetHealthTracking();
  });

  it('recordFeatureFailure increments counter', () => {
    recordFeatureFailure('proj-1', 'feat-1');
    recordFeatureFailure('proj-1', 'feat-1');
    recordFeatureFailure('proj-1', 'feat-1');
    const entry = getFeatureHealth('feat-1');
    expect(entry).toBeDefined();
    expect(entry!.consecutiveFailures).toBe(3);
    expect(entry!.projectId).toBe('proj-1');
  });

  it('recordQAReject increments qa counter', () => {
    recordQAReject('proj-1', 'feat-2');
    recordQAReject('proj-1', 'feat-2');
    const entry = getFeatureHealth('feat-2');
    expect(entry!.qaRejectCycles).toBe(2);
  });

  it('recordFeatureSuccess clears counters', () => {
    recordFeatureFailure('proj-1', 'feat-3');
    recordFeatureFailure('proj-1', 'feat-3');
    recordFeatureSuccess('feat-3');
    const entry = getFeatureHealth('feat-3');
    expect(entry).toBeUndefined();
  });

  it('independent tracking per feature', () => {
    recordFeatureFailure('proj-1', 'feat-a');
    recordFeatureFailure('proj-1', 'feat-a');
    recordFeatureFailure('proj-1', 'feat-b');
    expect(getFeatureHealth('feat-a')!.consecutiveFailures).toBe(2);
    expect(getFeatureHealth('feat-b')!.consecutiveFailures).toBe(1);
  });

  it('sets lastFailTime and lastRejectTime', () => {
    recordFeatureFailure('proj-1', 'feat-t');
    recordQAReject('proj-1', 'feat-t');
    const entry = getFeatureHealth('feat-t');
    expect(entry!.lastFailTime).toBeDefined();
    expect(entry!.lastRejectTime).toBeDefined();
  });
});

// ═══════════════════════════════════════
// 2. Pattern Detection: Feature Looping (in-memory)
// ═══════════════════════════════════════

describe('Pattern Detection: Feature Looping (in-memory)', () => {
  beforeEach(() => {
    resetHealthTracking();
  });

  it('detects feature looping at threshold (default 3)', () => {
    recordFeatureFailure('proj-1', 'feat-loop');
    recordFeatureFailure('proj-1', 'feat-loop');
    recordFeatureFailure('proj-1', 'feat-loop');

    // runDiagnostics reads in-memory counters + DB
    // In-memory detection should fire even without DB
    const anomalies = runDiagnostics({ featureFailCount: 3 });
    const looping = anomalies.filter(a => a.pattern === 'feature_looping' && a.featureId === 'feat-loop');
    expect(looping.length).toBeGreaterThanOrEqual(1);
    expect(looping[0].severity).toBe('error');
    expect(looping[0].suggestedLevel).toBe(1);
  });

  it('escalates to critical at 2x threshold', () => {
    for (let i = 0; i < 6; i++) {
      recordFeatureFailure('proj-1', 'feat-critical');
    }
    const anomalies = runDiagnostics({ featureFailCount: 3 });
    const critical = anomalies.find(a => a.featureId === 'feat-critical');
    expect(critical).toBeDefined();
    expect(critical!.severity).toBe('critical');
    expect(critical!.suggestedLevel).toBe(2); // escalated to L2
  });

  it('no anomaly below threshold', () => {
    recordFeatureFailure('proj-1', 'feat-ok');
    recordFeatureFailure('proj-1', 'feat-ok');
    const anomalies = runDiagnostics({ featureFailCount: 3 });
    const found = anomalies.find(a => a.featureId === 'feat-ok');
    expect(found).toBeUndefined();
  });
});

// ═══════════════════════════════════════
// 3. Pattern Detection: QA Reject Loop (in-memory)
// ═══════════════════════════════════════

describe('Pattern Detection: QA Reject Loop (in-memory)', () => {
  beforeEach(() => {
    resetHealthTracking();
  });

  it('detects QA reject loop at threshold (default 4)', () => {
    for (let i = 0; i < 4; i++) {
      recordQAReject('proj-1', 'feat-qa');
    }
    const anomalies = runDiagnostics({ qaRejectCount: 4 });
    const qa = anomalies.filter(a => a.pattern === 'qa_reject_loop' && a.featureId === 'feat-qa');
    expect(qa.length).toBeGreaterThanOrEqual(1);
    expect(qa[0].severity).toBe('error');
  });
});

// ═══════════════════════════════════════
// 4. formatAnomalySummary
// ═══════════════════════════════════════

describe('formatAnomalySummary', () => {
  it('returns OK for empty list', () => {
    const summary = formatAnomalySummary([]);
    expect(summary).toContain('✅');
    expect(summary).toContain('正常');
  });

  it('formats anomalies with icons', () => {
    const anomalies: AnomalyReport[] = [
      {
        pattern: 'feature_looping',
        severity: 'critical',
        projectId: 'proj-1',
        featureId: 'feat-1',
        description: 'test critical',
        evidence: {},
        suggestedLevel: 2,
        detectedAt: new Date().toISOString(),
      },
      {
        pattern: 'zombie_feature',
        severity: 'warning',
        projectId: 'proj-1',
        featureId: 'feat-2',
        description: 'test warning',
        evidence: {},
        suggestedLevel: 1,
        detectedAt: new Date().toISOString(),
      },
    ];
    const summary = formatAnomalySummary(anomalies);
    expect(summary).toContain('2 个异常');
    expect(summary).toContain('🔴'); // critical
    expect(summary).toContain('🟡'); // warning
    expect(summary).toContain('proj-1');
  });

  it('groups by project', () => {
    const anomalies: AnomalyReport[] = [
      {
        pattern: 'project_stall', severity: 'error', projectId: 'proj-a',
        description: 'stalled', evidence: {}, suggestedLevel: 1,
        detectedAt: new Date().toISOString(),
      },
      {
        pattern: 'project_stall', severity: 'error', projectId: 'proj-b',
        description: 'stalled', evidence: {}, suggestedLevel: 1,
        detectedAt: new Date().toISOString(),
      },
    ];
    const summary = formatAnomalySummary(anomalies);
    expect(summary).toContain('proj-a');
    expect(summary).toContain('proj-b');
  });
});

// ═══════════════════════════════════════
// 5. DB-dependent Pattern Detection
// ═══════════════════════════════════════

const describeDb = hasRealSqlite ? describe : describe.skip;

describeDb('Pattern Detection (with in-memory SQLite)', () => {
  beforeEach(() => {
    resetHealthTracking();
    const db = resetTestDb();
    // Create minimal schema for diagnostics
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        wish TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'developing',
        workspace_path TEXT,
        config TEXT DEFAULT '{}',
        git_mode TEXT DEFAULT 'local',
        github_repo TEXT,
        github_token TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS features (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        category TEXT DEFAULT '',
        priority INTEGER DEFAULT 0,
        group_name TEXT,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        summary TEXT,
        depends_on TEXT DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'todo',
        locked_by TEXT,
        locked_at TEXT,
        acceptance_criteria TEXT DEFAULT '[]',
        affected_files TEXT DEFAULT '[]',
        notes TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        requirement_doc_ver INTEGER DEFAULT 0,
        test_spec_doc_ver INTEGER DEFAULT 0,
        pm_verdict TEXT,
        pm_verdict_score REAL,
        pm_verdict_feedback TEXT,
        github_issue_number INTEGER,
        github_pr_number INTEGER,
        github_branch TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        agent_role TEXT DEFAULT 'developer',
        agent_seq INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'created',
        backup_path TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        message_count INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        total_cost REAL DEFAULT 0,
        chat_mode TEXT DEFAULT '',
        member_id TEXT,
        feature_id TEXT,
        started_at TEXT,
        suspended_at TEXT,
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        agent_id TEXT DEFAULT '',
        feature_id TEXT,
        type TEXT NOT NULL,
        data TEXT DEFAULT '{}',
        duration_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cost_usd REAL,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  });

  it('detects zombie features', () => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name, status) VALUES (?, ?, ?)").run('p1', 'Test', 'developing');
    // Feature locked 60 min ago with no active session
    db.prepare(`
      INSERT INTO features (id, project_id, title, status, locked_by, locked_at)
      VALUES (?, ?, ?, 'in_progress', 'dead-worker', datetime('now', '-60 minutes'))
    `).run('f1', 'p1', 'Zombie Feature');

    const anomalies = runDiagnostics({ zombieTimeoutMin: 30 });
    const zombies = anomalies.filter(a => a.pattern === 'zombie_feature');
    expect(zombies.length).toBeGreaterThanOrEqual(1);
    expect(zombies[0].featureId).toBe('f1');
    expect(zombies[0].suggestedAction?.type).toBe('release_lock');
  });

  it('detects project stall', () => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name, status, updated_at) VALUES (?, ?, ?, datetime('now', '-120 minutes'))").run('p-stall', 'Stalled', 'developing');
    db.prepare("INSERT INTO features (id, project_id, title, status) VALUES (?, ?, ?, 'todo')").run('f-todo', 'p-stall', 'Waiting');

    const anomalies = runDiagnostics({ projectStallMin: 60 });
    const stalls = anomalies.filter(a => a.pattern === 'project_stall');
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    expect(stalls[0].projectId).toBe('p-stall');
  });

  it('detects worker mass death', () => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name, status) VALUES (?, ?, ?)").run('p-death', 'Deaths', 'developing');
    // Insert 5 failed sessions in last 10 minutes
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO sessions (id, project_id, agent_id, status, error_message, completed_at)
        VALUES (?, ?, ?, 'failed', 'LLM timeout', datetime('now', '-${i} minutes'))
      `).run(`s-dead-${i}`, 'p-death', `worker-${i}`);
    }

    const anomalies = runDiagnostics({ massDeathCount: 3, massDeathWindowMin: 10 });
    const deaths = anomalies.filter(a => a.pattern === 'worker_mass_death');
    expect(deaths.length).toBeGreaterThanOrEqual(1);
    expect(deaths[0].evidence).toHaveProperty('commonCause', true);
  });

  it('detects resource exhaustion (deadlock)', () => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name, status, config) VALUES (?, ?, ?, '{}')").run('p-lock', 'Locked', 'developing');
    // 2 features locked, 0 active sessions, 0 todo
    db.prepare("INSERT INTO features (id, project_id, title, status, locked_by) VALUES (?, ?, ?, 'in_progress', 'w1')").run('f-l1', 'p-lock', 'Feat 1');
    db.prepare("INSERT INTO features (id, project_id, title, status, locked_by) VALUES (?, ?, ?, 'in_progress', 'w2')").run('f-l2', 'p-lock', 'Feat 2');

    const anomalies = runDiagnostics();
    const exhaust = anomalies.filter(a => a.pattern === 'resource_exhaust' && a.projectId === 'p-lock');
    expect(exhaust.length).toBeGreaterThanOrEqual(1);
    expect(exhaust[0].evidence).toHaveProperty('type', 'deadlock');
  });

  it('no false positives on healthy project', () => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name, status) VALUES (?, ?, ?)").run('p-ok', 'Healthy', 'developing');
    db.prepare("INSERT INTO features (id, project_id, title, status) VALUES (?, ?, ?, 'passed')").run('f-done', 'p-ok', 'Done');
    // Active session
    db.prepare("INSERT INTO sessions (id, project_id, agent_id, status) VALUES (?, ?, ?, 'running')").run('s-ok', 'p-ok', 'dev-1');
    // Recent event
    db.prepare("INSERT INTO events (project_id, type) VALUES (?, 'react:iteration')").run('p-ok');

    const anomalies = runDiagnostics();
    const forProject = anomalies.filter(a => a.projectId === 'p-ok');
    expect(forProject.length).toBe(0);
  });

  it('runProjectDiagnostics filters by project', () => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name, status) VALUES (?, ?, 'developing')").run('p-x', 'ProjX');
    db.prepare("INSERT INTO projects (id, name, status) VALUES (?, ?, 'developing')").run('p-y', 'ProjY');
    db.prepare("INSERT INTO features (id, project_id, title, status, locked_by, locked_at) VALUES (?, ?, ?, 'in_progress', 'ghost', datetime('now', '-120 minutes'))").run('f-ghost', 'p-x', 'Ghost');

    const all = runDiagnostics({ zombieTimeoutMin: 30 });
    const filtered = runProjectDiagnostics('p-x', { zombieTimeoutMin: 30 });
    expect(filtered.every(a => a.projectId === 'p-x')).toBe(true);
    expect(filtered.length).toBeLessThanOrEqual(all.length);
  });
});
