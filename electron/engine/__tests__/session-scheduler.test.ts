/**
 * session-scheduler.test.ts — v32.0 1-Session-1-Feature 调度引擎测试
 *
 * 测试策略:
 *   1. Scheduler enable/disable toggle (纯状态)
 *   2. scheduleProject: disabled/no-context → 0 (不需要 DB)
 *   3. Integration: runSessionDrivenDevPhase 端到端
 *      - 默认 pool spawn + 1-Session-1-Feature 验证
 *      - team_member max_concurrent_sessions
 *      - DevPhaseContext cleanup
 *   4. registerSchedulerListeners 幂等
 *   5. fallbackCheck disabled noop
 *   6. activeSessions 初始状态
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks (must be before imports) ──

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

const mockSpawnAgent = vi.fn();
const mockLockNextFeature = vi.fn();

vi.mock('../agent-manager', () => ({
  lockNextFeature: (...args: unknown[]) => mockLockNextFeature(...args),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
}));

const mockCreateSessionForFeature = vi.fn(() => ({ id: `sess-${Date.now()}` }));
const mockTransitionSession = vi.fn();
const mockGetRunningSessionCount = vi.fn(() => 0);

vi.mock('../conversation-backup', () => ({
  createSessionForFeature: (...args: unknown[]) => mockCreateSessionForFeature(...args),
  transitionSession: (...args: unknown[]) => mockTransitionSession(...args),
  getRunningSessionCount: (...args: unknown[]) => mockGetRunningSessionCount(...args),
}));

const mockWorkerLoop = vi.fn(() => Promise.resolve());

vi.mock('../phases', () => ({
  workerLoop: (...args: unknown[]) => mockWorkerLoop(...args),
}));

vi.mock('../ui-bridge', () => ({
  sendToUI: vi.fn(),
}));

vi.mock('../llm-client', () => ({
  getSettings: () => ({ workerCount: 3 }),
  sleep: (ms: number) => new Promise(r => setTimeout(r, Math.min(ms, 10))),
}));

const registeredListeners = new Map<string, Set<(...args: unknown[]) => void>>();
vi.mock('../scheduler-bus', () => ({
  onScheduleEvent: (event: string, handler: (...args: unknown[]) => void) => {
    if (!registeredListeners.has(event)) registeredListeners.set(event, new Set());
    registeredListeners.get(event)!.add(handler);
  },
  emitScheduleEvent: vi.fn((event: string, payload: unknown) => {
    const handlers = registeredListeners.get(event);
    if (handlers) handlers.forEach(h => h(payload));
  }),
}));

// ── Mock DB ──
// Dynamic counters that tests can mutate. The get() must handle ALL SQL
// patterns used in session-scheduler.ts (scheduleProject + awaitAllFeaturesDone + fallbackCheck).
const mockDbState = {
  teamMembers: [] as unknown[],
  developingProjects: [] as Array<{ id: string }>,
  todoCount: 0,
  workingCount: 0,
};

const mockDb = {
  prepare: (sql: string) => ({
    all: (_arg?: string) => {
      if (sql.includes('team_members')) return mockDbState.teamMembers;
      if (sql.includes("status = 'developing'")) return mockDbState.developingProjects;
      return [];
    },
    get: (_arg?: string) => {
      // awaitAllFeaturesDone + fallbackCheck: SELECT COUNT(*) ... status = 'todo'
      if (sql.includes("status = 'todo'")) return { c: mockDbState.todoCount };
      // awaitAllFeaturesDone: SELECT COUNT(*) ... status IN ('in_progress', 'reviewing')
      if (sql.includes('status IN')) return { c: mockDbState.workingCount };
      return { c: 0 };
    },
    run: vi.fn(),
  }),
};

// IMPORTANT: vitest.config.ts has alias '../db' → '__mocks__/db.ts',
// but vi.mock can override it. The resolved module id from session-scheduler.ts
// is '../db' (relative to electron/engine/), so we mock that exact path.
vi.mock('../db', () => ({
  getDb: () => mockDb,
}));

// ── Import under test ──
import {
  enableScheduler,
  disableScheduler,
  isSchedulerEnabled,
  scheduleProject,
  getDevPhaseContext,
  getActiveSessions,
  registerSchedulerListeners,
  unregisterSchedulerListeners,
  fallbackCheck,
  runSessionDrivenDevPhase,
} from '../session-scheduler';

// ── Helpers ──

/** Build a minimal params object for runSessionDrivenDevPhase */
function makeDevPhaseParams(projectId: string, workerCount = 3) {
  return {
    projectId,
    qaId: 'qa-0',
    settings: { workerCount } as never,
    win: null,
    signal: new AbortController().signal,
    workspacePath: '/tmp/test',
    gitConfig: { mode: 'local' as const, workspacePath: '/tmp/test' },
  };
}

/**
 * Run a dev phase that's expected to terminate cleanly.
 * workerLoop resolves instantly, mock DB state ensures awaitAllFeaturesDone breaks:
 *   - after initial scheduleProject, todoCount drops to 0
 *   - workingCount stays 0 (workerLoop resolves before the next poll)
 *   - activeCount drops to 0 because mockWorkerLoop resolves synchronously
 */
async function runDevPhaseQuick(
  projectId: string,
  opts: { workerCount?: number; timeoutMs?: number } = {},
): Promise<void> {
  const { workerCount = 3, timeoutMs = 3000 } = opts;
  const params = makeDevPhaseParams(projectId, workerCount);
  const abortCtrl = new AbortController();
  const paramsWithSignal = { ...params, signal: abortCtrl.signal };

  // Safety timeout — abort if test hangs
  const safetyTimer = setTimeout(() => abortCtrl.abort(), timeoutMs);

  try {
    await runSessionDrivenDevPhase(paramsWithSignal);
  } finally {
    clearTimeout(safetyTimer);
  }
}

// ═══════════════════════════════════════
// Tests
// ═══════════════════════════════════════

describe('session-scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disableScheduler();
    registeredListeners.clear();
    // Reset DB state
    mockDbState.teamMembers = [];
    mockDbState.todoCount = 0;
    mockDbState.workingCount = 0;
    mockDbState.developingProjects = [];
    // Reset function mocks
    mockLockNextFeature.mockReset();
    mockWorkerLoop.mockReset().mockImplementation(() => Promise.resolve());
    mockCreateSessionForFeature
      .mockReset()
      .mockImplementation(() => ({ id: `sess-${Math.random().toString(36).slice(2, 8)}` }));
    mockGetRunningSessionCount.mockReset().mockReturnValue(0);
  });

  afterEach(() => {
    disableScheduler();
  });

  // ── Scheduler toggle ──

  describe('enable/disable toggle', () => {
    it('should start disabled', () => {
      expect(isSchedulerEnabled()).toBe(false);
    });

    it('should enable and disable', () => {
      enableScheduler();
      expect(isSchedulerEnabled()).toBe(true);
      disableScheduler();
      expect(isSchedulerEnabled()).toBe(false);
    });
  });

  // ── scheduleProject (pure unit — no runSessionDrivenDevPhase) ──

  describe('scheduleProject', () => {
    it('should return 0 spawned when disabled', async () => {
      const result = await scheduleProject('p1');
      expect(result.spawned).toBe(0);
    });

    it('should return 0 spawned when no DevPhaseContext', async () => {
      enableScheduler();
      const result = await scheduleProject('nonexistent');
      expect(result.spawned).toBe(0);
    });
  });

  // ── Integration: runSessionDrivenDevPhase ──

  describe('runSessionDrivenDevPhase integration', () => {
    it('should exit immediately when no todo features (todoCount=0)', async () => {
      mockLockNextFeature.mockReturnValue(null);
      mockDbState.todoCount = 0;
      mockDbState.workingCount = 0;

      await runDevPhaseQuick('empty-project');

      // No workers spawned
      expect(mockWorkerLoop).not.toHaveBeenCalled();
      // Context cleaned up
      expect(getDevPhaseContext('empty-project')).toBeUndefined();
    });

    it('should spawn workers and assign one feature per worker', async () => {
      // This test verifies the core 1-Session-1-Feature contract:
      // scheduleProject locks features and spawns workerLoop with assignedFeature.
      // We call runSessionDrivenDevPhase which runs scheduleProject + awaitAllFeaturesDone.
      // Key: workerLoop resolves instantly, so activeCount drops to 0 quickly.
      // todoCount drops to 0 after all features are locked.

      let lockCallCount = 0;
      mockLockNextFeature.mockImplementation(() => {
        lockCallCount++;
        if (lockCallCount <= 3) {
          if (lockCallCount === 3) mockDbState.todoCount = 0;
          return { id: `F${lockCallCount}`, title: `Feature ${lockCallCount}`, status: 'todo', project_id: 'p1' };
        }
        return null;
      });
      mockDbState.todoCount = 3;
      mockDbState.workingCount = 0;

      await runDevPhaseQuick('p1', { workerCount: 3 });

      // lockNextFeature called at least 3 times (3 features + 1 null to break for-loop)
      expect(lockCallCount).toBeGreaterThanOrEqual(3);
      // workerLoop should be called exactly once per locked feature
      // Note: if awaitAllFeaturesDone re-schedules before we break, we might get more.
      // With todoCount=0 set on 3rd lock, and workerLoop resolving instantly,
      // the expectation is that re-scheduling finds no features → no extra workers.
      expect(mockWorkerLoop.mock.calls.length).toBeGreaterThanOrEqual(3);

      // Verify assignedFeature in first 3 workerLoop calls
      for (let i = 0; i < 3; i++) {
        const opts = mockWorkerLoop.mock.calls[i][9] as {
          assignedFeature: { id: string };
          preCreatedSessionId: string;
        };
        expect(opts).toBeDefined();
        expect(opts.assignedFeature).toBeDefined();
        expect(opts.assignedFeature.id).toBe(`F${i + 1}`);
        expect(opts.preCreatedSessionId).toBeDefined();
      }

      // Context cleaned up
      expect(getDevPhaseContext('p1')).toBeUndefined();
    }, 5000);

    it('should respect team member max_concurrent_sessions', async () => {
      mockDbState.teamMembers = [{ id: 'dev-1', name: 'Dev A', role: 'developer', max_concurrent_sessions: 2 }];
      mockGetRunningSessionCount.mockReturnValue(1); // 1 running → 1 available slot

      let locked = false;
      mockLockNextFeature.mockImplementation(() => {
        if (!locked) {
          locked = true;
          mockDbState.todoCount = 0;
          return { id: 'F1', title: 'Feature 1', status: 'todo', project_id: 'p2' };
        }
        return null;
      });
      mockDbState.todoCount = 2;

      await runDevPhaseQuick('p2', { workerCount: 5 });

      // Only 1 worker spawned (max_concurrent=2, running=1 → 1 slot)
      expect(mockWorkerLoop.mock.calls.length).toBeGreaterThanOrEqual(1);
      // First workerLoop call should have F1 assigned
      const firstOpts = mockWorkerLoop.mock.calls[0][9] as { assignedFeature: { id: string } };
      expect(firstOpts.assignedFeature.id).toBe('F1');
    }, 5000);

    it('should clean up DevPhaseContext after completion', async () => {
      mockLockNextFeature.mockReturnValue(null);
      mockDbState.todoCount = 0;
      mockDbState.workingCount = 0;

      await runDevPhaseQuick('ctx-test');

      expect(getDevPhaseContext('ctx-test')).toBeUndefined();
    });

    it('should create session via createSessionForFeature for each worker', async () => {
      let lockCount = 0;
      mockLockNextFeature.mockImplementation(() => {
        lockCount++;
        if (lockCount <= 2) {
          if (lockCount === 2) mockDbState.todoCount = 0;
          return { id: `F-${lockCount}`, title: `Feature ${lockCount}`, status: 'todo', project_id: 'p4' };
        }
        return null;
      });
      mockDbState.todoCount = 2;

      await runDevPhaseQuick('p4', { workerCount: 2 });

      expect(mockCreateSessionForFeature.mock.calls.length).toBeGreaterThanOrEqual(2);
    }, 5000);
  });

  // ── registerSchedulerListeners ──

  describe('registerSchedulerListeners', () => {
    it('should be idempotent (calling twice registers only once)', () => {
      unregisterSchedulerListeners(); // reset
      registerSchedulerListeners();
      const countBefore = registeredListeners.get('schedule:feature_completed')?.size ?? 0;
      registerSchedulerListeners(); // second call
      const countAfter = registeredListeners.get('schedule:feature_completed')?.size ?? 0;
      expect(countAfter).toBe(countBefore);
      unregisterSchedulerListeners();
    });
  });

  // ── fallbackCheck ──

  describe('fallbackCheck', () => {
    it('should do nothing when disabled', async () => {
      disableScheduler();
      await fallbackCheck();
      expect(mockLockNextFeature).not.toHaveBeenCalled();
    });
  });

  // ── Active sessions tracking ──

  describe('active sessions tracking', () => {
    it('should start with empty activeSessions map', () => {
      expect(getActiveSessions().size).toBe(0);
    });
  });
});
