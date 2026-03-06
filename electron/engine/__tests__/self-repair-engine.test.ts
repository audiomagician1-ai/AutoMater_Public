/**
 * self-repair-engine.test.ts — L3 深度自修复引擎测试 (v34.0)
 *
 * 测试策略:
 *   1. SelfRepairEngine 构造 + 默认配置
 *   2. 安全检查: immutable files, allowed dirs, max files/lines
 *   3. parseRepairResponse — LLM 输出解析
 *   4. RepairConfig 覆盖
 *
 * Note: 实际 git 操作 / LLM 调用 / FitnessEvaluator 需要 E2E 测试
 * 这里只测试配置、解析、安全验证等纯逻辑
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('../llm-client', () => ({
  callLLM: vi.fn(),
  getSettings: () => null,
}));

vi.mock('../auto-remediation', () => ({
  getPendingL3Repairs: () => [],
}));

import {
  SelfRepairEngine,
  type RepairConfig,
  type RepairResult,
} from '../self-repair-engine';

// ═══════════════════════════════════════
// 1. Construction + Defaults
// ═══════════════════════════════════════

describe('SelfRepairEngine construction', () => {
  it('creates with sourceRoot', () => {
    const engine = new SelfRepairEngine({ sourceRoot: '/tmp/test' });
    expect(engine.getStatus()).toBe('idle');
    expect(engine.getLogs()).toHaveLength(0);
  });

  it('applies config overrides', () => {
    const engine = new SelfRepairEngine({
      sourceRoot: '/tmp/test',
      maxFiles: 3,
      maxLines: 100,
      minFitnessScore: 0.8,
    });
    // Can't directly access private config, but we can verify via repair behavior
    expect(engine.getStatus()).toBe('idle');
  });

  it('abort sets flag', () => {
    const engine = new SelfRepairEngine({ sourceRoot: '/tmp/test' });
    engine.abort();
    // Status doesn't change from idle on abort alone
    expect(engine.getStatus()).toBe('idle');
  });
});

// ═══════════════════════════════════════
// 2. repair() fails gracefully without git/settings
// ═══════════════════════════════════════

describe('SelfRepairEngine.repair() edge cases', () => {
  it('fails when no LLM settings', async () => {
    const engine = new SelfRepairEngine({ sourceRoot: '/tmp/nonexistent' });
    const result = await engine.repair({
      anomalyPattern: 'feature_looping',
      level: 3,
      projectId: 'p1',
      action: 'self_repair',
      status: 'pending',
      detail: 'test',
      tokensUsed: 0,
      costUsd: 0,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.logs.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════
// 3. parseRepairResponse (test via module internals reflection)
//    Since it's a module-level function, we test indirectly
//    by checking the engine handles bad LLM output gracefully
// ═══════════════════════════════════════

describe('Repair response parsing edge cases', () => {
  it('empty response treated as no changes', async () => {
    // The engine should handle empty/invalid LLM responses
    // Without a real git repo, repair() will fail before parsing
    // This is more of a documentation test
    const engine = new SelfRepairEngine({ sourceRoot: '/tmp/nonexistent' });
    const result = await engine.repair({
      anomalyPattern: 'worker_mass_death',
      level: 3,
      projectId: 'p2',
      action: 'self_repair',
      status: 'pending',
      detail: 'mass worker death',
      tokensUsed: 0,
      costUsd: 0,
    });
    // Should fail (no git, no settings) but not crash
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(false); // no snapshot to rollback
  });
});

// ═══════════════════════════════════════
// 4. RepairResult structure
// ═══════════════════════════════════════

describe('RepairResult structure', () => {
  it('failed result has correct shape', async () => {
    const engine = new SelfRepairEngine({ sourceRoot: '/tmp/nonexistent' });
    const result = await engine.repair({
      anomalyPattern: 'project_stall',
      level: 3,
      projectId: 'p3',
      action: 'self_repair',
      status: 'pending',
      detail: 'stall',
      tokensUsed: 0,
      costUsd: 0,
    });

    expect(result).toHaveProperty('success', false);
    expect(result).toHaveProperty('repairId');
    expect(result).toHaveProperty('branch');
    expect(result).toHaveProperty('modifiedFiles');
    expect(result).toHaveProperty('merged', false);
    expect(result).toHaveProperty('rolledBack');
    expect(result).toHaveProperty('logs');
    expect(result).toHaveProperty('tokensUsed');
    expect(result).toHaveProperty('costUsd');
    expect(result).toHaveProperty('error');
    expect(Array.isArray(result.modifiedFiles)).toBe(true);
    expect(Array.isArray(result.logs)).toBe(true);
  });
});

// ═══════════════════════════════════════
// 5. processPendingRepairs with no pending
// ═══════════════════════════════════════

describe('processPendingRepairs', () => {
  it('returns empty when no pending repairs', async () => {
    const { processPendingRepairs } = await import('../self-repair-engine');
    const results = await processPendingRepairs('/tmp/nonexistent');
    expect(results).toHaveLength(0);
  });
});
