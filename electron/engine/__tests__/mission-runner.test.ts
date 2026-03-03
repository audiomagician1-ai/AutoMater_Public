/**
 * mission-runner.ts tests — CRUD + type exports + extractPatches (via getMissionPatches)
 *
 * All DB operations are mocked. Tests cover:
 *   - createMission / getMission / listMissions / getMissionTasks
 *   - cancelMission / cleanupMission / deleteMission
 *   - MissionType / MissionStatus type assignments
 *   - getMissionPatches (file-system backed)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  Notification: { isSupported: () => false },
}));

vi.mock('../ui-bridge', () => ({
  sendToUI: vi.fn(),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Stateful in-memory DB mock for missions & tasks
let missions: Record<string, { id: string; project_id: string; type: string; status: string; config: string; result: string | null; created_at: string; completed_at: string | null; workspace_path?: string }> = {};
let missionTasks: Array<{
  id: string; mission_id: string; title: string; status: string;
  agent_id: string; prompt: string; output: string | null;
  created_at: string; completed_at: string | null;
}> = [];

const mockPrepare = vi.fn((sql: string) => ({
  run: vi.fn((...args: unknown[]) => {
    if (sql.includes('INSERT INTO missions')) {
      const [id, projectId, type, config] = args as string[];
      missions[id] = {
        id, project_id: projectId, type, status: 'pending',
        config, result: null,
        created_at: new Date().toISOString(), completed_at: null,
      };
      return { lastInsertRowid: 1, changes: 1 };
    }
    if (sql.includes('UPDATE missions SET status')) {
      // cancelMission
      for (const m of Object.values(missions)) {
        if (args[0] && m.id === args[0]) m.status = 'cancelled';
      }
      return { changes: 1 };
    }
    if (sql.includes('DELETE FROM mission_tasks')) {
      const mid = args[0] as string;
      missionTasks = missionTasks.filter(t => t.mission_id !== mid);
      return { changes: 1 };
    }
    if (sql.includes('DELETE FROM missions')) {
      const mid = args[0] as string;
      delete missions[mid];
      return { changes: 1 };
    }
    return { changes: 0 };
  }),
  get: vi.fn((...args: unknown[]) => {
    if (sql.includes('FROM missions')) {
      return missions[args[0] as string] || undefined;
    }
    if (sql.includes('workspace_path')) {
      return undefined;
    }
    return undefined;
  }),
  all: vi.fn((...args: unknown[]) => {
    if (sql.includes('FROM missions')) {
      const pid = args[0] as string;
      return Object.values(missions).filter(m => m.project_id === pid);
    }
    if (sql.includes('FROM mission_tasks')) {
      const mid = args[0] as string;
      return missionTasks.filter(t => t.mission_id === mid);
    }
    return [];
  }),
}));

vi.mock('../../db', () => ({
  getDb: () => ({
    prepare: mockPrepare,
    transaction: (fn: Function) => fn,
    exec: vi.fn(),
  }),
}));

vi.mock('../llm-client', () => ({
  callLLM: vi.fn(() => '{}'),
  getSettings: vi.fn(() => ({
    llmProvider: 'openai', apiKey: 'k', baseUrl: 'u',
    strongModel: 'gpt-4o', workerModel: 'gpt-4o-mini', dailyBudgetUsd: 5,
  })),
}));

import {
  createMission,
  getMission,
  listMissions,
  getMissionTasks,
  cancelMission,
  cleanupMission,
  deleteMission,
  getMissionPatches,
  type MissionType,
  type MissionStatus,
  type MissionConfig,
  type MissionTask,
  type MissionResult,
} from '../mission-runner';

// ═══════════════════════════════════════
// Type shape
// ═══════════════════════════════════════

describe('MissionType / MissionStatus type checks', () => {
  it('all valid MissionType values compile', () => {
    const types: MissionType[] = [
      'regression_test', 'code_review', 'retrospective',
      'security_audit', 'perf_benchmark', 'custom',
    ];
    expect(types).toHaveLength(6);
  });

  it('all valid MissionStatus values compile', () => {
    const statuses: MissionStatus[] = [
      'pending', 'planning', 'executing', 'judging',
      'completed', 'failed', 'cancelled',
    ];
    expect(statuses).toHaveLength(7);
  });

  it('MissionConfig is valid with optional fields', () => {
    const cfg: MissionConfig = {};
    expect(cfg.scope).toBeUndefined();
    const cfg2: MissionConfig = { scope: 'src/**', maxTokens: 5000 };
    expect(cfg2.scope).toBe('src/**');
  });

  it('MissionTask interface shape', () => {
    const task: MissionTask = {
      id: 't1', title: 'Test', status: 'pending',
      agentId: 'dev-1', prompt: 'prompt', output: null,
    };
    expect(task.id).toBe('t1');
  });

  it('MissionResult interface shape', () => {
    const result: MissionResult = {
      summary: 'ok', passed: true, score: 85,
      findings: [], patches: [],
    };
    expect(result.passed).toBe(true);
  });
});

// ═══════════════════════════════════════
// CRUD Operations
// ═══════════════════════════════════════

describe('createMission', () => {
  beforeEach(() => {
    missions = {};
    missionTasks = [];
  });

  it('returns a non-empty mission ID', () => {
    const id = createMission('proj-1', 'code_review');
    expect(id).toBeTruthy();
    expect(id.startsWith('mission-')).toBe(true);
  });

  it('creates with default config', () => {
    const id = createMission('proj-1', 'security_audit');
    expect(id).toBeTruthy();
  });

  it('creates with custom config', () => {
    const id = createMission('proj-1', 'custom', { scope: 'src/**' });
    expect(id).toBeTruthy();
  });
});

describe('getMission', () => {
  beforeEach(() => { missions = {}; });

  it('returns undefined for non-existent mission', () => {
    const m = getMission('nonexistent');
    expect(m).toBeUndefined();
  });
});

describe('listMissions', () => {
  beforeEach(() => { missions = {}; });

  it('returns empty array when no missions', () => {
    const list = listMissions('proj-1');
    expect(list).toEqual([]);
  });
});

describe('getMissionTasks', () => {
  beforeEach(() => { missionTasks = []; });

  it('returns empty array when no tasks', () => {
    const tasks = getMissionTasks('m-1');
    expect(tasks).toEqual([]);
  });
});

// ═══════════════════════════════════════
// State transitions
// ═══════════════════════════════════════

describe('cancelMission', () => {
  it('does not throw for non-existent mission', () => {
    expect(() => cancelMission('nope')).not.toThrow();
  });
});

describe('cleanupMission', () => {
  it('does not throw for non-existent mission', () => {
    expect(() => cleanupMission('nope')).not.toThrow();
  });
});

describe('deleteMission', () => {
  it('does not throw for non-existent mission', () => {
    expect(() => deleteMission('nope')).not.toThrow();
  });
});

// ═══════════════════════════════════════
// getMissionPatches — file-based
// ═══════════════════════════════════════

describe('getMissionPatches', () => {
  it('returns empty array for non-existent mission', () => {
    expect(getMissionPatches('nope')).toEqual([]);
  });

  it('returns empty for mission with no workspace (default mock)', () => {
    // Default mock: getMission returns undefined → early return []
    expect(getMissionPatches('mission-xyz')).toEqual([]);
  });
});
