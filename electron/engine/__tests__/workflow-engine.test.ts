/**
 * WorkflowEngine 单元测试
 * 测试 DAG transition 解析和阶段执行流程
 */

import { describe, it, expect, vi } from 'vitest';
import { WorkflowEngine, type PhaseExecutor } from '../workflow-engine';
import { makePhaseResult } from '../types';
import type { WorkflowStage, PhaseResult, WorkflowStageId } from '../types';

// ── Helpers ──

function mockExecutor(overrides: Record<string, Partial<PhaseResult>> = {}): PhaseExecutor {
  return async (stageId: WorkflowStageId) => {
    const override = overrides[stageId];
    return makePhaseResult(
      stageId,
      override?.status ?? 'success',
      override?.summary ?? `${stageId} done`,
      Date.now() - 10,
      { costUsd: override?.costUsd ?? 0 },
    );
  };
}

const linearStages: WorkflowStage[] = [
  { id: 'pm_analysis', label: 'PM', icon: '📋', color: '#3B82F6' },
  { id: 'architect', label: 'Arch', icon: '🏗️', color: '#8B5CF6' },
  { id: 'dev_implement', label: 'Dev', icon: '⚡', color: '#F59E0B' },
  { id: 'finalize', label: 'Done', icon: '🎯', color: '#6B7280' },
];

// ═══════════════════════════════════════
// Tests
// ═══════════════════════════════════════

describe('WorkflowEngine', () => {
  it('executes linear stages in order (all success)', async () => {
    const ctrl = new AbortController();
    const engine = new WorkflowEngine(linearStages, ctrl.signal);
    const result = await engine.run(mockExecutor());

    expect(result.completed).toBe(true);
    expect(result.results).toHaveLength(4);
    expect(result.results.map(r => r.stageId)).toEqual([
      'pm_analysis', 'architect', 'dev_implement', 'finalize',
    ]);
  });

  it('stops on failure without transitions', async () => {
    const ctrl = new AbortController();
    const engine = new WorkflowEngine(linearStages, ctrl.signal);
    const result = await engine.run(mockExecutor({
      architect: { status: 'failure', summary: 'arch failed' },
    }));

    expect(result.completed).toBe(false);
    expect(result.terminationReason).toBe('stage_failed');
    expect(result.results).toHaveLength(2); // pm + architect
    expect(result.results[1].status).toBe('failure');
  });

  it('handles skipped stages as success', async () => {
    const ctrl = new AbortController();
    const engine = new WorkflowEngine(linearStages, ctrl.signal);
    const result = await engine.run(mockExecutor({
      architect: { status: 'skipped', summary: 'skipped' },
    }));

    expect(result.completed).toBe(true);
    expect(result.results).toHaveLength(4);
    expect(result.results[1].status).toBe('skipped');
  });

  it('handles partial as success (continues)', async () => {
    const ctrl = new AbortController();
    const engine = new WorkflowEngine(linearStages, ctrl.signal);
    const result = await engine.run(mockExecutor({
      dev_implement: { status: 'partial', summary: '2/3 features done' },
    }));

    expect(result.completed).toBe(true);
    expect(result.results).toHaveLength(4);
  });

  it('supports failure → retry via transitions', async () => {
    const stages: WorkflowStage[] = [
      { id: 'pm_analysis', label: 'PM', icon: '📋', color: '#3B82F6' },
      {
        id: 'dev_implement', label: 'Dev', icon: '⚡', color: '#F59E0B',
        transitions: [
          { target: 'finalize', condition: 'success' },
          { target: 'dev_implement', condition: 'failure', maxRetries: 2 },
        ],
      },
      { id: 'finalize', label: 'Done', icon: '🎯', color: '#6B7280' },
    ];

    let devCallCount = 0;
    const ctrl = new AbortController();
    const engine = new WorkflowEngine(stages, ctrl.signal);

    const result = await engine.run(async (stageId) => {
      if (stageId === 'dev_implement') {
        devCallCount++;
        // Fail first 2 times, succeed on 3rd
        const status = devCallCount <= 2 ? 'failure' : 'success';
        return makePhaseResult(stageId, status, `dev attempt ${devCallCount}`, Date.now() - 10);
      }
      return makePhaseResult(stageId, 'success', `${stageId} done`, Date.now() - 10);
    });

    expect(result.completed).toBe(true);
    expect(devCallCount).toBe(3); // 2 failures + 1 success
    expect(result.results).toHaveLength(5); // pm + dev(fail) + dev(fail) + dev(success) + finalize
  });

  it('terminates when maxRetries exceeded', async () => {
    const stages: WorkflowStage[] = [
      {
        id: 'dev_implement', label: 'Dev', icon: '⚡', color: '#F59E0B',
        transitions: [
          { target: 'finalize', condition: 'success' },
          { target: 'dev_implement', condition: 'failure', maxRetries: 1 },
        ],
      },
      { id: 'finalize', label: 'Done', icon: '🎯', color: '#6B7280' },
    ];

    const ctrl = new AbortController();
    const engine = new WorkflowEngine(stages, ctrl.signal);

    // Always fails
    const result = await engine.run(async (stageId) => {
      return makePhaseResult(stageId, 'failure', 'always fails', Date.now() - 10);
    });

    expect(result.completed).toBe(false);
    expect(result.terminationReason).toBe('max_retries_exceeded');
    expect(result.results).toHaveLength(2); // dev(fail) + dev(fail)
  });

  it('stops on abort signal', async () => {
    const ctrl = new AbortController();
    const engine = new WorkflowEngine(linearStages, ctrl.signal);

    const result = await engine.run(async (stageId) => {
      if (stageId === 'architect') {
        ctrl.abort(); // abort during execution
        return null; // simulate aborted result
      }
      return makePhaseResult(stageId, 'success', `${stageId} done`, Date.now() - 10);
    });

    expect(result.completed).toBe(false);
    expect(result.terminationReason).toBe('aborted');
    expect(result.results).toHaveLength(1); // only pm_analysis
  });

  it('abort between stages', async () => {
    const ctrl = new AbortController();
    const engine = new WorkflowEngine(linearStages, ctrl.signal);

    let stageCount = 0;
    const result = await engine.run(async (stageId) => {
      stageCount++;
      const r = makePhaseResult(stageId, 'success', `${stageId} done`, Date.now() - 10);
      if (stageCount === 2) ctrl.abort(); // abort after architect completes
      return r;
    });

    expect(result.completed).toBe(false);
    expect(result.terminationReason).toBe('aborted');
    expect(result.results).toHaveLength(2); // pm + architect
  });

  it('calls onStageComplete callback', async () => {
    const ctrl = new AbortController();
    const engine = new WorkflowEngine(linearStages, ctrl.signal);
    const callbacks: Array<{ stageId: string; next: string | null }> = [];

    await engine.run(mockExecutor(), (result, next) => {
      callbacks.push({ stageId: result.stageId, next });
    });

    expect(callbacks).toHaveLength(4);
    expect(callbacks[0]).toEqual({ stageId: 'pm_analysis', next: 'architect' });
    expect(callbacks[1]).toEqual({ stageId: 'architect', next: 'dev_implement' });
    expect(callbacks[2]).toEqual({ stageId: 'dev_implement', next: 'finalize' });
    expect(callbacks[3]).toEqual({ stageId: 'finalize', next: null });
  });

  it('supports always condition transitions', async () => {
    const stages: WorkflowStage[] = [
      {
        id: 'dev_implement', label: 'Dev', icon: '⚡', color: '#F59E0B',
        transitions: [
          { target: 'finalize', condition: 'always' },
        ],
      },
      { id: 'finalize', label: 'Done', icon: '🎯', color: '#6B7280' },
    ];

    const ctrl = new AbortController();
    const engine = new WorkflowEngine(stages, ctrl.signal);

    // Even on failure, always → finalize
    const result = await engine.run(mockExecutor({
      dev_implement: { status: 'failure', summary: 'failed but always continues' },
    }));

    expect(result.completed).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].status).toBe('failure');
    expect(result.results[1].stageId).toBe('finalize');
  });

  it('handles empty stages array', async () => {
    const ctrl = new AbortController();
    const engine = new WorkflowEngine([], ctrl.signal);
    const result = await engine.run(mockExecutor());

    expect(result.completed).toBe(true);
    expect(result.results).toHaveLength(0);
  });

  it('getStages returns stage list', () => {
    const ctrl = new AbortController();
    const engine = new WorkflowEngine(linearStages, ctrl.signal);
    expect(engine.getStages()).toEqual(linearStages);
  });
});
