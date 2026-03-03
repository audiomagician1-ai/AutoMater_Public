/**
 * orchestrator.ts tests — Hot-Join events + ensureHotJoinListener + runOrchestrator guards
 *
 * Heavy Electron/DB dependencies are fully mocked.
 * Tests focus on:
 *   - emitMemberAdded / ensureHotJoinListener event bus behavior
 *   - runOrchestrator early-exit guards (duplicate run, missing settings, missing project)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  Notification: { isSupported: () => false },
  app: { getPath: () => '/tmp/mock-appdata' },
}));

vi.mock('../ui-bridge', () => ({
  sendToUI: vi.fn(),
  notify: vi.fn(),
}));

const mockDbRun = vi.fn(() => ({ lastInsertRowid: 1, changes: 1 }));
const mockDbGet = vi.fn(() => undefined);
const mockDbAll = vi.fn(() => []);
const mockDbExec = vi.fn();

vi.mock('../../db', () => ({
  getDb: () => ({
    prepare: () => ({
      run: mockDbRun,
      get: mockDbGet,
      all: mockDbAll,
    }),
    transaction: (fn: Function) => fn,
    exec: mockDbExec,
  }),
}));

vi.mock('../llm-client', () => ({
  getSettings: vi.fn(() => ({
    llmProvider: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com',
    strongModel: 'gpt-4o',
    workerModel: 'gpt-4o-mini',
    dailyBudgetUsd: 10,
    workerCount: 2,
  })),
  sleep: vi.fn(),
  validateModel: vi.fn(() => null), // no error
  callLLM: vi.fn(() => '{}'),
}));

vi.mock('../agent-manager', () => ({
  registerOrchestrator: vi.fn(() => true),
  unregisterOrchestrator: vi.fn(),
  isOrchestratorRunning: vi.fn(() => false),
  stopOrchestrator: vi.fn(),
  spawnAgent: vi.fn(),
  getTeamMemberLLMConfig: vi.fn((_pid: string, role: string) => ({
    provider: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com',
    model: role === 'architect' ? 'gpt-4o' : 'gpt-4o-mini',
  })),
}));

vi.mock('../guards', () => ({
  gateArchitectToDeveloper: vi.fn(() => ({ passed: true })),
}));

vi.mock('../workspace-git', () => ({
  commitWorkspace: vi.fn(),
}));

vi.mock('../memory-system', () => ({
  ensureGlobalMemory: vi.fn(),
  ensureProjectMemory: vi.fn(),
}));

vi.mock('../experience-library', () => ({
  injectGlobalExperience: vi.fn(() => 0),
}));

vi.mock('../event-store', () => ({
  emitEvent: vi.fn(),
}));

vi.mock('../decision-log', () => ({
  cleanupDecisionLog: vi.fn(),
}));

vi.mock('../file-lock', () => ({
  cleanExpiredLocks: vi.fn(),
}));

vi.mock('../change-manager', () => ({
  detectImplicitChanges: vi.fn(() => null),
  runChangeRequest: vi.fn(() => ({ success: true })),
}));

vi.mock('../phases', () => ({
  phasePMAnalysis: vi.fn(() => [{ id: 'F1', title: 'Test' }]),
  phaseIncrementalPM: vi.fn(() => []),
  phasePMAcceptance: vi.fn(),
  phaseArchitect: vi.fn(),
  phaseReqsAndTestSpecs: vi.fn(),
  phaseIncrementalDocSync: vi.fn(),
  workerLoop: vi.fn(() => Promise.resolve()),
  phaseDeployPipeline: vi.fn(),
  phaseFinalize: vi.fn(),
  phaseEnvironmentBootstrap: vi.fn(),
}));

vi.mock('../react-loop', () => ({
  getAgentReactStates: vi.fn(() => ({})),
  getContextSnapshots: vi.fn(() => ({})),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../cross-project', () => ({
  inferTags: vi.fn(() => ['typescript']),
}));

import {
  emitMemberAdded,
  ensureHotJoinListener,
  runOrchestrator,
} from '../orchestrator';
import { isOrchestratorRunning } from '../agent-manager';
import { getSettings } from '../llm-client';
import { sendToUI } from '../ui-bridge';

// ═══════════════════════════════════════
// emitMemberAdded & ensureHotJoinListener
// ═══════════════════════════════════════

describe('emitMemberAdded', () => {
  it('does not throw when called with valid payload', () => {
    expect(() =>
      emitMemberAdded({ projectId: 'p1', memberId: 'm1', role: 'developer', name: 'Dev 1' })
    ).not.toThrow();
  });

  it('does not throw for non-developer role', () => {
    expect(() =>
      emitMemberAdded({ projectId: 'p1', memberId: 'm1', role: 'architect', name: 'Arch' })
    ).not.toThrow();
  });
});

describe('ensureHotJoinListener', () => {
  it('is idempotent — calling twice does not throw', () => {
    expect(() => {
      ensureHotJoinListener();
      ensureHotJoinListener();
    }).not.toThrow();
  });

  it('after registration, emitMemberAdded for developer does not throw', () => {
    ensureHotJoinListener();
    expect(() =>
      emitMemberAdded({ projectId: 'p1', memberId: 'm1', role: 'developer', name: 'Dev' })
    ).not.toThrow();
  });

  it('after registration, emitMemberAdded for non-developer does not throw', () => {
    ensureHotJoinListener();
    expect(() =>
      emitMemberAdded({ projectId: 'p1', memberId: 'm2', role: 'qa', name: 'QA' })
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════
// runOrchestrator — guard paths
// ═══════════════════════════════════════

describe('runOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbGet.mockReturnValue(undefined);
    mockDbAll.mockReturnValue([]);
  });

  it('rejects duplicate run when already running', async () => {
    vi.mocked(isOrchestratorRunning).mockReturnValueOnce(true);
    await runOrchestrator('proj-dup', null);
    expect(sendToUI).toHaveBeenCalledWith(null, 'agent:log', expect.objectContaining({
      content: expect.stringContaining('忽略重复启动'),
    }));
  });

  it('rejects when settings missing apiKey', async () => {
    vi.mocked(getSettings).mockReturnValueOnce({ llmProvider: 'openai', apiKey: '' } as ReturnType<typeof getSettings>);
    await runOrchestrator('proj-nokey', null);
    expect(sendToUI).toHaveBeenCalledWith(null, 'agent:error', expect.objectContaining({
      error: expect.stringContaining('API Key'),
    }));
  });

  it('rejects when project not found in DB', async () => {
    // validateModel returns null (OK), but project is undefined
    mockDbGet.mockReturnValue(undefined);
    await runOrchestrator('proj-missing', null);
    expect(sendToUI).toHaveBeenCalledWith(null, 'agent:error', expect.objectContaining({
      error: expect.stringContaining('项目不存在'),
    }));
  });

  it('handles model validation failure', async () => {
    const { validateModel } = await import('../llm-client');
    vi.mocked(validateModel).mockResolvedValueOnce('Model not available: gpt-4o');
    await runOrchestrator('proj-model-fail', null);
    expect(sendToUI).toHaveBeenCalledWith(null, 'agent:error', expect.objectContaining({
      error: expect.stringContaining('模型预检失败'),
    }));
  });
});
