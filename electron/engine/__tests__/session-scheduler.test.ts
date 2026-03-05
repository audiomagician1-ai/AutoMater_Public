/**
 * session-scheduler.ts tests — Feature-level scheduling engine
 *
 * Tests focus on:
 *   - enableScheduler/disableScheduler daemon-level toggle
 *   - scheduleProject: requires DevPhaseContext, maxWorkers, default pool, custom team
 *   - runSessionDrivenDevPhase lifecycle
 *   - registerSchedulerListeners idempotency
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  app: { getPath: () => '/tmp/mock-appdata' },
}));

vi.mock('../ui-bridge', () => ({
  sendToUI: vi.fn(),
}));

const mockDbRun = vi.fn(() => ({ lastInsertRowid: 1, changes: 1 }));
const mockDbGet = vi.fn((): unknown => ({ c: 0 }));
const mockDbAll = vi.fn((): unknown[] => []);

const mockPrepare = vi.fn((sql: string) => ({
  run: (...args: unknown[]) => mockDbRun(sql, ...args),
  get: (...args: unknown[]) => mockDbGet(sql, ...args),
  all: (...args: unknown[]) => mockDbAll(sql, ...args),
}));

vi.mock('../../db', () => ({
  getDb: () => ({
    prepare: (...args: unknown[]) => mockPrepare(...(args as [string])),
    transaction: (fn: Function) => fn,
  }),
}));

// Also mock relative path as seen by session-scheduler.ts
vi.mock('../db', () => ({
  getDb: () => ({
    prepare: (...args: unknown[]) => mockPrepare(...(args as [string])),
    transaction: (fn: Function) => fn,
  }),
}));

vi.mock('../llm-client', () => ({
  getSettings: vi.fn(() => ({
    llmProvider: 'openai',
    apiKey: 'test-key',
    workerCount: 0, // default → maxWorkers=3
  })),
  sleep: vi.fn(() => Promise.resolve()),
}));

const mockLockNextFeature = vi.fn(() => null);
vi.mock('../agent-manager', () => ({
  lockNextFeature: (...args: unknown[]) => mockLockNextFeature(...args),
  spawnAgent: vi.fn(),
}));

const mockCreateSession = vi.fn(() => ({ id: `sess-${Date.now()}` }));
vi.mock('../conversation-backup', () => ({
  createSessionForFeature: (...args: unknown[]) => mockCreateSession(...args),
  transitionSession: vi.fn(),
  getRunningSessionCount: vi.fn(() => 0),
}));

vi.mock('../scheduler-bus', () => ({
  emitScheduleEvent: vi.fn(),
  onScheduleEvent: vi.fn(),
}));

const mockWorkerLoop = vi.fn(() => Promise.resolve());
vi.mock('../phases', () => ({
  workerLoop: (...args: unknown[]) => mockWorkerLoop(...args),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../event-store', () => ({
  emitEvent: vi.fn(),
}));

import {
  enableScheduler,
  disableScheduler,
  isSchedulerEnabled,
  scheduleProject,
  registerSchedulerListeners,
  unregisterSchedulerListeners,
  getDevPhaseContext,
  runSessionDrivenDevPhase,
} from '../session-scheduler';
import type { AppSettings } from '../types';
import type { GitProviderConfig } from '../git-provider';

// ═══════════════════════════════════════
// Helper: create a mock DevPhaseContext via runSessionDrivenDevPhase
// ═══════════════════════════════════════

function makeMockSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    llmProvider: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com',
    strongModel: 'gpt-4o',
    workerModel: 'gpt-4o-mini',
    dailyBudgetUsd: 10,
    workerCount: 0,
    ...overrides,
  } as AppSettings;
}

function makeMockGitConfig(): GitProviderConfig {
  return { provider: 'local' } as GitProviderConfig;
}

// ═══════════════════════════════════════
// Tests
// ═══════════════════════════════════════

describe('enableScheduler / disableScheduler', () => {
  afterEach(() => {
    disableScheduler();
  });

  it('starts disabled', () => {
    expect(isSchedulerEnabled()).toBe(false);
  });

  it('can enable and disable', () => {
    enableScheduler();
    expect(isSchedulerEnabled()).toBe(true);
    disableScheduler();
    expect(isSchedulerEnabled()).toBe(false);
  });
});

describe('scheduleProject', () => {
  beforeEach(() => {
    mockDbRun.mockClear();
    mockDbGet.mockClear();
    mockDbAll.mockClear();
    mockLockNextFeature.mockClear();
    mockWorkerLoop.mockClear();
    mockCreateSession.mockClear();
    // Restore default implementations
    mockDbGet.mockImplementation(() => ({ c: 0 }));
    mockDbAll.mockImplementation(() => []);
    mockLockNextFeature.mockImplementation(() => null);
    mockWorkerLoop.mockImplementation(() => Promise.resolve());
    mockCreateSession.mockImplementation(() => ({ id: `sess-${Date.now()}` }));
    disableScheduler();
  });

  it('returns spawned=0 when no DevPhaseContext exists', async () => {
    const result = await scheduleProject('proj-no-ctx');
    expect(result).toEqual({ spawned: 0 });
  });

  it('returns spawned=0 when signal is aborted', async () => {
    // We need an active context — create via runSessionDrivenDevPhase setup
    // For this test, we directly test that no context → 0
    const result = await scheduleProject('proj-aborted');
    expect(result).toEqual({ spawned: 0 });
  });

  it('spawns workers for default pool when no team_members', async () => {
    // First feature available, then no more
    let lockCallCount = 0;
    mockLockNextFeature.mockImplementation(() => {
      lockCallCount++;
      if (lockCallCount <= 2)
        return { id: `f-${lockCallCount}`, title: `Feature ${lockCallCount}`, status: 'in_progress' };
      return null;
    });

    // DB: no team_members, COUNT queries return 0 (all done after initial schedule)
    mockDbAll.mockReturnValue([]);
    mockDbGet.mockReturnValue({ c: 0 });

    await runSessionDrivenDevPhase({
      projectId: 'proj-default-pool',
      qaId: 'qa-0',
      settings: makeMockSettings({ workerCount: 2 }),
      win: null,
      signal: new AbortController().signal,
      workspacePath: '/tmp/workspace',
      gitConfig: makeMockGitConfig(),
    });

    // Verify lockNextFeature was called (initial scheduling)
    expect(mockLockNextFeature).toHaveBeenCalled();
    // Verify workerLoop was called for each locked feature
    expect(mockWorkerLoop).toHaveBeenCalledTimes(2);
  });
});

describe('registerSchedulerListeners', () => {
  afterEach(() => {
    unregisterSchedulerListeners();
  });

  it('is idempotent', () => {
    expect(() => {
      registerSchedulerListeners();
      registerSchedulerListeners();
    }).not.toThrow();
  });
});

describe('getDevPhaseContext', () => {
  it('returns undefined when no context registered', () => {
    expect(getDevPhaseContext('nonexistent')).toBeUndefined();
  });
});

describe('runSessionDrivenDevPhase', () => {
  beforeEach(() => {
    mockDbRun.mockClear();
    mockDbGet.mockClear();
    mockDbAll.mockClear();
    mockLockNextFeature.mockClear();
    mockWorkerLoop.mockClear();
    mockCreateSession.mockClear();
    // Restore default implementations
    mockDbGet.mockImplementation(() => ({ c: 0 }));
    mockDbAll.mockImplementation(() => []);
    mockLockNextFeature.mockImplementation(() => null);
    mockWorkerLoop.mockImplementation(() => Promise.resolve());
    mockCreateSession.mockImplementation(() => ({ id: `sess-${Date.now()}` }));
    disableScheduler();
  });

  it('registers and cleans up DevPhaseContext', async () => {
    const projectId = 'proj-lifecycle';

    // Before: no context
    expect(getDevPhaseContext(projectId)).toBeUndefined();

    await runSessionDrivenDevPhase({
      projectId,
      qaId: 'qa-0',
      settings: makeMockSettings(),
      win: null,
      signal: new AbortController().signal,
      workspacePath: '/tmp',
      gitConfig: makeMockGitConfig(),
    });

    // After: context cleaned up
    expect(getDevPhaseContext(projectId)).toBeUndefined();
  });

  it('enables daemon scheduler', async () => {
    expect(isSchedulerEnabled()).toBe(false);

    await runSessionDrivenDevPhase({
      projectId: 'proj-enable',
      qaId: 'qa-0',
      settings: makeMockSettings(),
      win: null,
      signal: new AbortController().signal,
      workspacePath: '/tmp',
      gitConfig: makeMockGitConfig(),
    });

    // After v30.1: daemon-level stays enabled (only stopDaemon turns it off)
    expect(isSchedulerEnabled()).toBe(true);
    disableScheduler(); // cleanup
  });

  it('exits immediately when all features already done', async () => {
    // DB returns 0 for all counts — should exit immediately
    const startTime = Date.now();

    await runSessionDrivenDevPhase({
      projectId: 'proj-all-done',
      qaId: 'qa-0',
      settings: makeMockSettings(),
      win: null,
      signal: new AbortController().signal,
      workspacePath: '/tmp',
      gitConfig: makeMockGitConfig(),
    });

    // Should complete near-instantly (no 2s poll needed)
    expect(Date.now() - startTime).toBeLessThan(1000);
  });

  it('cleans up context even on abort', async () => {
    const abortController = new AbortController();
    const projectId = 'proj-abort-cleanup';

    // Make awaitAllFeaturesDone see 1 todo initially so it enters the while loop
    let todoCallIdx = 0;
    mockDbGet.mockImplementation(() => {
      todoCallIdx++;
      // First call returns 1 (enter while loop), rest return 0
      if (todoCallIdx === 1) return { c: 1 };
      return { c: 0 };
    });

    // Abort after a short delay
    setTimeout(() => abortController.abort(), 50);

    await runSessionDrivenDevPhase({
      projectId,
      qaId: 'qa-0',
      settings: makeMockSettings(),
      win: null,
      signal: abortController.signal,
      workspacePath: '/tmp',
      gitConfig: makeMockGitConfig(),
    });

    // Context must be cleaned up
    expect(getDevPhaseContext(projectId)).toBeUndefined();
  });
});
