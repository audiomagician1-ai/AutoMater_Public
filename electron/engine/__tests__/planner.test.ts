/**
 * Tests for planner.ts — 任务规划器 (parsePlanFromLLM, advancePlan, failCurrentStep, getPlanSummary)
 */
import { describe, it, expect } from 'vitest';
import {
  parsePlanFromLLM,
  advancePlan,
  failCurrentStep,
  getPlanSummary,
  type FeaturePlan,
  type PlanStep,
} from '../planner';

// ═══════════════════════════════════════
// parsePlanFromLLM
// ═══════════════════════════════════════

describe('parsePlanFromLLM', () => {
  it('parses valid JSON array of steps', () => {
    const raw = JSON.stringify([
      { description: 'Read project structure', tool: 'list_files' },
      { description: 'Implement feature', tool: 'write_file' },
      { description: 'Run tests', tool: 'run_command' },
    ]);
    const plan = parsePlanFromLLM(raw, 'F-001', 'Add login page');
    expect(plan.featureId).toBe('F-001');
    expect(plan.goal).toBe('Add login page');
    expect(plan.steps.length).toBe(3);
    expect(plan.steps[0].id).toBe('F-001-S01');
    expect(plan.steps[0].description).toBe('Read project structure');
    expect(plan.steps[0].tool).toBe('list_files');
    expect(plan.steps[0].status).toBe('pending');
    expect(plan.steps[0].retries).toBe(0);
    expect(plan.currentStepIndex).toBe(0);
    expect(plan.maxRetries).toBe(3);
  });

  it('falls back to default plan on invalid JSON', () => {
    const plan = parsePlanFromLLM('not valid json at all', 'F-002', 'Goal');
    expect(plan.steps.length).toBe(4);
    expect(plan.steps[0].description).toContain('分析');
    expect(plan.steps[3].tool).toBe('task_complete');
  });

  it('falls back to default plan on empty array', () => {
    const plan = parsePlanFromLLM('[]', 'F-003', 'Goal');
    expect(plan.steps.length).toBe(4); // default steps
  });

  it('handles JSON wrapped in markdown code block (via output-parser)', () => {
    const raw = '```json\n[{"description":"Step 1","tool":"read_file"}]\n```';
    const plan = parsePlanFromLLM(raw, 'F-004', 'Goal');
    // output-parser should strip the markdown wrapper
    expect(plan.steps.length).toBeGreaterThanOrEqual(1);
  });

  it('generates sequential step IDs', () => {
    const raw = JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({ description: `Step ${i}` })),
    );
    const plan = parsePlanFromLLM(raw, 'F-005', 'Goal');
    expect(plan.steps.map(s => s.id)).toEqual([
      'F-005-S01', 'F-005-S02', 'F-005-S03', 'F-005-S04', 'F-005-S05',
    ]);
  });

  it('handles steps without tool property', () => {
    const raw = JSON.stringify([{ description: 'Think about it' }]);
    const plan = parsePlanFromLLM(raw, 'F-006', 'Goal');
    expect(plan.steps[0].tool).toBeUndefined();
  });
});

// ═══════════════════════════════════════
// advancePlan
// ═══════════════════════════════════════

describe('advancePlan', () => {
  function makePlan(stepCount: number = 3): FeaturePlan {
    return {
      featureId: 'F-test',
      goal: 'Test goal',
      steps: Array.from({ length: stepCount }, (_, i) => ({
        id: `S${i}`,
        description: `Step ${i}`,
        status: 'pending' as const,
        retries: 0,
      })),
      currentStepIndex: 0,
      maxRetries: 3,
      totalRetries: 0,
    };
  }

  it('marks current step done and returns next step', () => {
    const plan = makePlan(3);
    const next = advancePlan(plan, 'completed first');
    expect(plan.steps[0].status).toBe('done');
    expect(plan.steps[0].result).toBe('completed first');
    expect(next).not.toBeNull();
    expect(next!.id).toBe('S1');
    expect(next!.status).toBe('in_progress');
    expect(plan.currentStepIndex).toBe(1);
  });

  it('returns null when all steps done', () => {
    const plan = makePlan(2);
    advancePlan(plan, 'done 0');
    const last = advancePlan(plan, 'done 1');
    expect(last).toBeNull();
    expect(plan.currentStepIndex).toBe(2);
  });

  it('returns null on already-exhausted plan', () => {
    const plan = makePlan(1);
    plan.currentStepIndex = 1; // already past end
    expect(advancePlan(plan, 'result')).toBeNull();
  });
});

// ═══════════════════════════════════════
// failCurrentStep
// ═══════════════════════════════════════

describe('failCurrentStep', () => {
  function makePlan(): FeaturePlan {
    return {
      featureId: 'F-fail',
      goal: 'Test',
      steps: [
        { id: 'S0', description: 'Step 0', status: 'in_progress', retries: 0 },
        { id: 'S1', description: 'Step 1', status: 'pending', retries: 0 },
      ],
      currentStepIndex: 0,
      maxRetries: 3,
      totalRetries: 0,
    };
  }

  it('increments retry count and returns true (can retry)', () => {
    const plan = makePlan();
    expect(failCurrentStep(plan, 'Error 1')).toBe(true);
    expect(plan.steps[0].retries).toBe(1);
    expect(plan.totalRetries).toBe(1);
    expect(plan.steps[0].result).toContain('失败(1/3)');
  });

  it('marks step as failed after maxRetries', () => {
    const plan = makePlan();
    failCurrentStep(plan, 'Error 1');
    failCurrentStep(plan, 'Error 2');
    const canRetry = failCurrentStep(plan, 'Error 3');
    expect(canRetry).toBe(false);
    expect(plan.steps[0].status).toBe('failed');
    expect(plan.steps[0].retries).toBe(3);
    expect(plan.totalRetries).toBe(3);
  });

  it('returns false for exhausted plan', () => {
    const plan = makePlan();
    plan.currentStepIndex = 2; // past end
    expect(failCurrentStep(plan, 'Error')).toBe(false);
  });
});

// ═══════════════════════════════════════
// getPlanSummary
// ═══════════════════════════════════════

describe('getPlanSummary', () => {
  it('generates readable summary with icons', () => {
    const plan: FeaturePlan = {
      featureId: 'F-sum',
      goal: 'Build API',
      steps: [
        { id: 'S0', description: 'Setup', status: 'done', result: 'Created project structure and installed deps', retries: 0 },
        { id: 'S1', description: 'Implement', status: 'in_progress', retries: 0 },
        { id: 'S2', description: 'Test', status: 'pending', retries: 0 },
        { id: 'S3', description: 'Deploy', status: 'failed', result: 'timeout', retries: 3 },
      ],
      currentStepIndex: 1,
      maxRetries: 3,
      totalRetries: 3,
    };
    const summary = getPlanSummary(plan);
    expect(summary).toContain('Build API');
    expect(summary).toContain('✅');
    expect(summary).toContain('🔨');
    expect(summary).toContain('⬜');
    expect(summary).toContain('❌');
    expect(summary).toContain('1/4 步完成');
  });

  it('compresses long results', () => {
    const plan: FeaturePlan = {
      featureId: 'F-long',
      goal: 'Goal',
      steps: [
        { id: 'S0', description: 'Step', status: 'done', result: 'x'.repeat(200), retries: 0 },
      ],
      currentStepIndex: 1,
      maxRetries: 3,
      totalRetries: 0,
    };
    const summary = getPlanSummary(plan);
    expect(summary).toContain('...');
    expect(summary.length).toBeLessThan(300);
  });
});
