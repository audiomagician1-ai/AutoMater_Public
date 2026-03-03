/**
 * agent-manager.ts tests — 编排器注册表(纯Map操作) + DB-dependent 函数 smoke tests
 *
 * NOTE: vi.mock factory runs in isolated scope, so we can't dynamically control
 * DB return values per-test. Tests for DB functions verify no-crash behavior
 * and default fallback paths. Full DB testing requires real SQLite (integration tests).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  Notification: { isSupported: () => false },
}));

// Mock ui-bridge
vi.mock('../ui-bridge', () => ({
  sendToUI: vi.fn(),
}));

// DB mock — default: get() returns undefined, all() returns []
vi.mock('../../db', () => ({
  getDb: () => ({
    prepare: () => ({
      run: (..._args: any[]) => ({ lastInsertRowid: 1, changes: 1 }),
      get: () => undefined,
      all: () => [],
    }),
    transaction: (fn: Function) => fn,
    exec: () => {},
  }),
}));

import {
  getRunningOrchestrators,
  registerOrchestrator,
  isOrchestratorRunning,
  unregisterOrchestrator,
  stopOrchestrator,
  spawnAgent,
  updateAgentStats,
  checkBudget,
  getTeamPrompt,
  getTeamMemberLLMConfig,
  getTeamMemberMcpServers,
  getTeamMemberSkills,
  getFeatureGroupSummary,
} from '../agent-manager';
import type { AppSettings } from '../types';

const defaultSettings: AppSettings = {
  llmProvider: 'openai',
  apiKey: 'test-key',
  baseUrl: 'https://api.openai.com',
  strongModel: 'gpt-4o',
  workerModel: 'gpt-4o-mini',
  dailyBudgetUsd: 10,
};

// ═══════════════════════════════════════
// Orchestrator registry — pure Map operations (no DB)
// ═══════════════════════════════════════

describe('Orchestrator registry (pure Map operations)', () => {
  beforeEach(() => {
    const map = getRunningOrchestrators();
    map.clear();
  });

  it('registers a new orchestrator and returns true', () => {
    const ctrl = new AbortController();
    const isNew = registerOrchestrator('proj-1', ctrl);
    expect(isNew).toBe(true);
    expect(isOrchestratorRunning('proj-1')).toBe(true);
  });

  it('replaces existing orchestrator and aborts old one', () => {
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    registerOrchestrator('proj-1', ctrl1);
    const isNew = registerOrchestrator('proj-1', ctrl2);
    expect(isNew).toBe(false);
    expect(ctrl1.signal.aborted).toBe(true);
    expect(isOrchestratorRunning('proj-1')).toBe(true);
  });

  it('unregister removes orchestrator', () => {
    const ctrl = new AbortController();
    registerOrchestrator('proj-1', ctrl);
    unregisterOrchestrator('proj-1');
    expect(isOrchestratorRunning('proj-1')).toBe(false);
  });

  it('isOrchestratorRunning returns false for unknown project', () => {
    expect(isOrchestratorRunning('nonexistent')).toBe(false);
  });

  it('getRunningOrchestrators returns the internal Map', () => {
    const map = getRunningOrchestrators();
    expect(map).toBeInstanceOf(Map);
  });

  it('handles multiple projects independently', () => {
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    registerOrchestrator('proj-1', ctrl1);
    registerOrchestrator('proj-2', ctrl2);
    expect(isOrchestratorRunning('proj-1')).toBe(true);
    expect(isOrchestratorRunning('proj-2')).toBe(true);
    unregisterOrchestrator('proj-1');
    expect(isOrchestratorRunning('proj-1')).toBe(false);
    expect(isOrchestratorRunning('proj-2')).toBe(true);
  });
});

// ═══════════════════════════════════════
// stopOrchestrator
// ═══════════════════════════════════════

describe('stopOrchestrator', () => {
  beforeEach(() => getRunningOrchestrators().clear());

  it('aborts the controller and removes from registry', () => {
    const ctrl = new AbortController();
    registerOrchestrator('proj-1', ctrl);
    stopOrchestrator('proj-1');
    expect(ctrl.signal.aborted).toBe(true);
    expect(isOrchestratorRunning('proj-1')).toBe(false);
  });

  it('handles stop on non-running project gracefully', () => {
    expect(() => stopOrchestrator('nonexistent')).not.toThrow();
  });
});

// ═══════════════════════════════════════
// DB-dependent functions — smoke tests (default mock returns empty/undefined)
// ═══════════════════════════════════════

describe('spawnAgent', () => {
  it('does not throw', () => {
    expect(() => spawnAgent('proj-1', 'dev-1', 'developer', null)).not.toThrow();
  });
});

describe('updateAgentStats', () => {
  it('does not throw', () => {
    expect(() => updateAgentStats('dev-1', 'proj-1', 1000, 500, 0.05)).not.toThrow();
  });
});

describe('checkBudget', () => {
  it('returns ok=true when budget=0 (unlimited)', () => {
    const result = checkBudget('proj-1', { ...defaultSettings, dailyBudgetUsd: 0 });
    expect(result.ok).toBe(true);
    expect(result.budget).toBe(0);
  });

  it('returns ok=true and spent=0 when DB returns undefined (no agents)', () => {
    const result = checkBudget('proj-1', defaultSettings);
    expect(result.ok).toBe(true);
    expect(result.spent).toBe(0);
  });

  it('returns correct budget value', () => {
    const result = checkBudget('proj-1', { ...defaultSettings, dailyBudgetUsd: 25 });
    expect(result.budget).toBe(25);
  });
});

describe('getTeamPrompt', () => {
  it('returns null when no team members found (default DB returns [])', () => {
    expect(getTeamPrompt('proj-1', 'developer')).toBeNull();
  });

  it('returns null for any agentIndex when no members', () => {
    expect(getTeamPrompt('proj-1', 'developer', 5)).toBeNull();
  });

  it('does not throw for architect role', () => {
    expect(() => getTeamPrompt('proj-1', 'architect')).not.toThrow();
  });
});

describe('getTeamMemberLLMConfig', () => {
  it('returns global fallback when no team members (developer)', () => {
    const config = getTeamMemberLLMConfig('proj-1', 'developer', 0, defaultSettings);
    expect(config.provider).toBe('openai');
    expect(config.apiKey).toBe('test-key');
    expect(config.baseUrl).toBe('https://api.openai.com');
    expect(config.model).toBe('gpt-4o-mini'); // workerModel for developer
  });

  it('returns workerModel for devops role', () => {
    const config = getTeamMemberLLMConfig('proj-1', 'devops', 0, defaultSettings);
    expect(config.model).toBe('gpt-4o-mini');
  });

  it('returns strongModel for architect role', () => {
    const config = getTeamMemberLLMConfig('proj-1', 'architect', 0, defaultSettings);
    expect(config.model).toBe('gpt-4o');
  });

  it('returns strongModel for pm role', () => {
    const config = getTeamMemberLLMConfig('proj-1', 'pm', 0, defaultSettings);
    expect(config.model).toBe('gpt-4o');
  });

  it('returns strongModel for researcher role', () => {
    const config = getTeamMemberLLMConfig('proj-1', 'researcher', 0, defaultSettings);
    expect(config.model).toBe('gpt-4o');
  });

  it('preserves all global settings fields', () => {
    const customSettings: AppSettings = {
      llmProvider: 'anthropic',
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.anthropic.com',
      strongModel: 'claude-3-5-sonnet-20241022',
      workerModel: 'claude-3-5-haiku-20241022',
      dailyBudgetUsd: 50,
    };
    const config = getTeamMemberLLMConfig('proj-1', 'developer', 0, customSettings);
    expect(config.provider).toBe('anthropic');
    expect(config.apiKey).toBe('sk-ant-test');
    expect(config.baseUrl).toBe('https://api.anthropic.com');
    expect(config.model).toBe('claude-3-5-haiku-20241022');
  });
});

describe('getTeamMemberMcpServers', () => {
  it('returns empty array when no members (default)', () => {
    expect(getTeamMemberMcpServers('proj-1', 'developer')).toEqual([]);
  });
});

describe('getTeamMemberSkills', () => {
  it('returns empty array when no members (default)', () => {
    expect(getTeamMemberSkills('proj-1', 'developer')).toEqual([]);
  });
});

describe('getFeatureGroupSummary', () => {
  it('returns empty array when no features (default)', () => {
    expect(getFeatureGroupSummary('proj-1')).toEqual([]);
  });
});
