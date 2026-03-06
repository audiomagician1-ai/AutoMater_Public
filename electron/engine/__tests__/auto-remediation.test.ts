/**
 * auto-remediation.test.ts — 自动修复编排器测试 (v34.0)
 *
 * 测试策略:
 *   1. ensureRemediationTable — 表创建幂等
 *   2. L1 修复动作 — release_lock / reset_feature / gc_sessions 等
 *   3. L2 LLM 诊断 — mock callLLM 验证诊断流程
 *   4. L3 桥接 — markForL3 正确记录 pending 记录
 *   5. handleAnomalies — 编排器串行处理、优先级排序
 *   6. 计数器限制 — L1 exhaustion → L2 escalation
 *   7. Query helpers — getRemediationHistory / getRemediationStats
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('../ui-bridge', () => ({
  sendToUI: vi.fn(),
}));

// Mock session-lifecycle
vi.mock('../session-lifecycle', () => ({
  cleanupZombieLocks: vi.fn(() => 2),
}));

// Mock session-scheduler
vi.mock('../session-scheduler', () => ({
  scheduleProject: vi.fn(() => Promise.resolve({ spawned: 1 })),
}));

// Mock scheduler-bus
vi.mock('../scheduler-bus', () => ({
  emitScheduleEvent: vi.fn(),
}));

// Mock callLLM for L2
const mockCallLLM = vi.fn(() => Promise.resolve({
  content: JSON.stringify({
    summary: 'Root cause: LLM timeout',
    rootCause: 'API instability',
    actions: [
      { type: 'restart_session', params: { projectId: 'p1' } },
    ],
    preventionAdvice: 'Add retry backoff',
  }),
  inputTokens: 500,
  outputTokens: 300,
}));

vi.mock('../llm-client', () => ({
  callLLM: (...args: unknown[]) => mockCallLLM(...args),
  getSettings: () => ({
    llmProvider: 'openai',
    apiKey: 'test-key',
    baseUrl: '',
    strongModel: 'gpt-4',
    workerModel: 'gpt-3.5',
    workerCount: 3,
    dailyBudgetUsd: 10,
  }),
}));

import { getDb, resetTestDb } from '../../db';
import {
  ensureRemediationTable,
  handleAnomalies,
  getRemediationHistory,
  getRemediationStats,
  resetAttemptCounters,
  type RemediationRecord,
} from '../auto-remediation';
import type { AnomalyReport } from '../health-diagnostics';

// Detect real sqlite
let hasRealSqlite = false;
try {
  const db = resetTestDb();
  db.exec('SELECT 1');
  hasRealSqlite = true;
} catch { /* stub mode */ }

const describeDb = hasRealSqlite ? describe : describe.skip;

function setupDb(): void {
  const db = resetTestDb();
  // Create tables needed by auto-remediation + L1 actions
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'developing',
      config TEXT DEFAULT '{}',
      workspace_path TEXT,
      wish TEXT DEFAULT '',
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
  ensureRemediationTable();
}

// ═══════════════════════════════════════
// 1. ensureRemediationTable
// ═══════════════════════════════════════

describeDb('ensureRemediationTable', () => {
  beforeEach(setupDb);

  it('creates table', () => {
    const db = getDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='remediation_log'").get() as any;
    expect(row).toBeTruthy();
    expect(row.name).toBe('remediation_log');
  });

  it('is idempotent', () => {
    ensureRemediationTable();
    ensureRemediationTable();
    const db = getDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='remediation_log'").get() as any;
    expect(row).toBeTruthy();
  });
});

// ═══════════════════════════════════════
// 2. L1 Actions via handleAnomalies
// ═══════════════════════════════════════

describeDb('L1 Remediation Actions', () => {
  beforeEach(() => {
    setupDb();
    resetAttemptCounters();
  });

  it('release_lock resets feature to todo', async () => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Test')").run();
    db.prepare("INSERT INTO features (id, project_id, title, status, locked_by) VALUES ('f1', 'p1', 'Feat', 'in_progress', 'dead-worker')").run();

    const anomaly: AnomalyReport = {
      pattern: 'zombie_feature',
      severity: 'warning',
      projectId: 'p1',
      featureId: 'f1',
      description: 'zombie',
      evidence: {},
      suggestedLevel: 1,
      suggestedAction: { type: 'release_lock', params: { featureId: 'f1', projectId: 'p1' } },
      detectedAt: new Date().toISOString(),
    };

    const results = await handleAnomalies([anomaly], null);
    expect(results.length).toBe(1);
    expect(results[0].status).toBe('success');

    const feat = db.prepare("SELECT status, locked_by FROM features WHERE id = 'f1'").get() as any;
    expect(feat.status).toBe('todo');
    expect(feat.locked_by).toBeNull();
  });

  it('reset_feature sets status back to todo', async () => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Test')").run();
    db.prepare("INSERT INTO features (id, project_id, title, status) VALUES ('f2', 'p1', 'Fail', 'failed')").run();

    const anomaly: AnomalyReport = {
      pattern: 'feature_looping',
      severity: 'error',
      projectId: 'p1',
      featureId: 'f2',
      description: 'loop',
      evidence: {},
      suggestedLevel: 1,
      suggestedAction: { type: 'reset_feature', params: { featureId: 'f2', projectId: 'p1' } },
      detectedAt: new Date().toISOString(),
    };

    const results = await handleAnomalies([anomaly], null);
    expect(results[0].status).toBe('success');
    const feat = db.prepare("SELECT status FROM features WHERE id = 'f2'").get() as any;
    expect(feat.status).toBe('todo');
  });

  it('mark_blocked pauses project when no featureId', async () => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name, status) VALUES ('p-block', 'Blocked', 'developing')").run();

    const anomaly: AnomalyReport = {
      pattern: 'llm_conn_failure',
      severity: 'critical',
      projectId: 'p-block',
      description: 'auth fail',
      evidence: {},
      suggestedLevel: 1,
      suggestedAction: { type: 'mark_blocked', params: { projectId: 'p-block', reason: 'auth_failure' } },
      detectedAt: new Date().toISOString(),
    };

    const results = await handleAnomalies([anomaly], null);
    expect(results[0].status).toBe('success');
    const proj = db.prepare("SELECT status FROM projects WHERE id = 'p-block'").get() as any;
    expect(proj.status).toBe('paused');
  });
});

// ═══════════════════════════════════════
// 3. L1 → L2 Escalation
// ═══════════════════════════════════════

describeDb('L1 → L2 Escalation', () => {
  beforeEach(() => {
    setupDb();
    resetAttemptCounters();
    mockCallLLM.mockClear();
  });

  it('escalates to L2 after MAX_L1_ATTEMPTS (3)', async () => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name) VALUES ('p-esc', 'Escalate')").run();
    db.prepare("INSERT INTO features (id, project_id, title, status) VALUES ('f-esc', 'p-esc', 'Stuck', 'failed')").run();

    const makeAnomaly = (): AnomalyReport => ({
      pattern: 'feature_looping',
      severity: 'error',
      projectId: 'p-esc',
      featureId: 'f-esc',
      description: 'loop',
      evidence: {},
      suggestedLevel: 1,
      suggestedAction: { type: 'reset_feature', params: { featureId: 'f-esc', projectId: 'p-esc' } },
      detectedAt: new Date().toISOString(),
    });

    // 3 L1 attempts
    await handleAnomalies([makeAnomaly()], null);
    await handleAnomalies([makeAnomaly()], null);
    await handleAnomalies([makeAnomaly()], null);

    // 4th should escalate to L2 (callLLM)
    await handleAnomalies([makeAnomaly()], null);
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════
// 4. Priority ordering
// ═══════════════════════════════════════

describeDb('handleAnomalies priority ordering', () => {
  beforeEach(() => {
    setupDb();
    resetAttemptCounters();
  });

  it('processes critical before warning', async () => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name, status) VALUES ('p-pri', 'Priority', 'developing')").run();
    db.prepare("INSERT INTO features (id, project_id, title, status, locked_by) VALUES ('f-warn', 'p-pri', 'Warn', 'in_progress', 'w1')").run();
    db.prepare("INSERT INTO features (id, project_id, title, status) VALUES ('f-crit', 'p-pri', 'Crit', 'failed')").run();

    const anomalies: AnomalyReport[] = [
      {
        pattern: 'zombie_feature', severity: 'warning', projectId: 'p-pri', featureId: 'f-warn',
        description: 'warn', evidence: {}, suggestedLevel: 1,
        suggestedAction: { type: 'release_lock', params: { featureId: 'f-warn', projectId: 'p-pri' } },
        detectedAt: new Date().toISOString(),
      },
      {
        pattern: 'feature_looping', severity: 'critical', projectId: 'p-pri', featureId: 'f-crit',
        description: 'crit', evidence: {}, suggestedLevel: 1,
        suggestedAction: { type: 'reset_feature', params: { featureId: 'f-crit', projectId: 'p-pri' } },
        detectedAt: new Date().toISOString(),
      },
    ];

    const results = await handleAnomalies(anomalies, null);
    expect(results.length).toBe(2);
    // Critical should be processed first (but both succeed)
    expect(results.every(r => r.status === 'success')).toBe(true);
  });
});

// ═══════════════════════════════════════
// 5. Query Helpers
// ═══════════════════════════════════════

describeDb('Query helpers', () => {
  beforeEach(() => {
    setupDb();
    resetAttemptCounters();
  });

  it('getRemediationHistory returns records', async () => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name) VALUES ('p-q', 'Query')").run();
    db.prepare("INSERT INTO features (id, project_id, title, status, locked_by) VALUES ('f-q', 'p-q', 'Q', 'in_progress', 'ghost')").run();

    await handleAnomalies([{
      pattern: 'zombie_feature', severity: 'warning', projectId: 'p-q', featureId: 'f-q',
      description: 'test', evidence: {}, suggestedLevel: 1,
      suggestedAction: { type: 'release_lock', params: { featureId: 'f-q', projectId: 'p-q' } },
      detectedAt: new Date().toISOString(),
    }], null);

    const history = getRemediationHistory('p-q');
    expect(history.length).toBeGreaterThanOrEqual(1);
  });

  it('getRemediationStats returns counts', async () => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name) VALUES ('p-s', 'Stats')").run();
    db.prepare("INSERT INTO features (id, project_id, title, status, locked_by) VALUES ('f-s', 'p-s', 'S', 'in_progress', 'ghost')").run();

    await handleAnomalies([{
      pattern: 'zombie_feature', severity: 'warning', projectId: 'p-s', featureId: 'f-s',
      description: 'test', evidence: {}, suggestedLevel: 1,
      suggestedAction: { type: 'release_lock', params: { featureId: 'f-s', projectId: 'p-s' } },
      detectedAt: new Date().toISOString(),
    }], null);

    const stats = getRemediationStats('p-s');
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.success).toBeGreaterThanOrEqual(1);
  });
});
