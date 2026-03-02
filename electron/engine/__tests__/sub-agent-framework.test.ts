/**
 * Tests for sub-agent-framework.ts — PRESETS data + active agent tracking
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock heavy dependencies to isolate the pure data / tracking functions
vi.mock('../llm-client', () => ({ callLLMWithTools: vi.fn(), calcCost: () => 0, NonRetryableError: class extends Error {} }));
vi.mock('../tool-executor', () => ({ executeTool: vi.fn(), executeToolAsync: vi.fn() }));
vi.mock('../model-selector', () => ({ resolveModel: () => 'test-model' }));
vi.mock('../file-lock', () => ({ acquireFileLock: () => true, releaseWorkerLocks: () => {} }));
vi.mock('../ui-bridge', () => ({ sendToUI: () => {}, addLog: () => {} }));

import {
  getActiveSubAgents,
  cancelSubAgent,
  getPresetNames,
  getPresetInfo,
  type SubAgentPresetId,
} from '../sub-agent-framework';

// ═══════════════════════════════════════
// getPresetNames
// ═══════════════════════════════════════

describe('getPresetNames', () => {
  it('returns all 6 preset IDs', () => {
    const names = getPresetNames();
    expect(names).toContain('researcher');
    expect(names).toContain('coder');
    expect(names).toContain('reviewer');
    expect(names).toContain('tester');
    expect(names).toContain('doc_writer');
    expect(names).toContain('deployer');
    expect(names.length).toBe(6);
  });
});

// ═══════════════════════════════════════
// getPresetInfo
// ═══════════════════════════════════════

describe('getPresetInfo', () => {
  const presets: SubAgentPresetId[] = ['researcher', 'coder', 'reviewer', 'tester', 'doc_writer', 'deployer'];

  for (const preset of presets) {
    it(`returns info for ${preset}`, () => {
      const info = getPresetInfo(preset);
      expect(info).toBeDefined();
      expect(typeof info.name).toBe('string');
      expect(info.name.length).toBeGreaterThan(0);
      expect(typeof info.canWrite).toBe('boolean');
    });
  }

  it('researcher cannot write', () => {
    expect(getPresetInfo('researcher').canWrite).toBe(false);
  });

  it('reviewer cannot write', () => {
    expect(getPresetInfo('reviewer').canWrite).toBe(false);
  });

  it('coder can write', () => {
    expect(getPresetInfo('coder').canWrite).toBe(true);
  });

  it('tester can write', () => {
    expect(getPresetInfo('tester').canWrite).toBe(true);
  });
});

// ═══════════════════════════════════════
// getActiveSubAgents / cancelSubAgent
// ═══════════════════════════════════════

describe('getActiveSubAgents', () => {
  it('returns empty array when no agents running', () => {
    const agents = getActiveSubAgents();
    expect(agents).toEqual([]);
  });
});

describe('cancelSubAgent', () => {
  it('returns false for non-existent agent', () => {
    expect(cancelSubAgent('non-existent')).toBe(false);
  });
});
