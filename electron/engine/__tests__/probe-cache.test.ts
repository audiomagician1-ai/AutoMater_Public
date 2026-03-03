/**
 * Tests for probe-cache.ts — v7.0 Phase D
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProbeConfig, ProbeReport, ModuleGraph } from '../probe-types';

// Shared mock store
const store = new Map<string, string>();
const statStore = new Map<string, { mtimeMs: number }>();

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn((p: string) => {
      const content = store.get(p);
      if (!content) throw new Error(`ENOENT: ${p}`);
      return content;
    }),
    writeFileSync: vi.fn((p: string, content: string) => { store.set(p, content); }),
    existsSync: vi.fn((p: string) => store.has(p)),
    mkdirSync: vi.fn(),
    statSync: vi.fn((p: string) => {
      const s = statStore.get(p);
      if (!s) throw new Error(`ENOENT: ${p}`);
      return s;
    }),
    readdirSync: vi.fn(() => []),
  },
}));

vi.mock('path', () => ({
  default: {
    join: (...args: string[]) => args.join('/'),
    dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
    basename: (p: string) => p.split('/').pop() || '',
  },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

import {
  loadProbeCache, saveProbeCache,
  checkProbeCache, updateProbeCache,
  detectIncrementalChanges,
  applyUserCorrection, getUserCorrections,
} from '../probe-cache';

// ─── Fixtures ───

function makeProbeConfig(overrides?: Partial<ProbeConfig>): ProbeConfig {
  return {
    id: 'entry-main', type: 'entry', seeds: ['src/main.ts'],
    maxFilesToRead: 20, maxRounds: 2, tokenBudget: 8000, priority: 1,
    description: 'Trace from main entry', ...overrides,
  };
}

function makeProbeReport(overrides?: Partial<ProbeReport>): ProbeReport {
  return {
    probeId: 'entry-main', type: 'entry',
    findings: [{ type: 'entry-flow', id: 'main', name: 'Main Entry', description: 'App starts here', files: ['src/main.ts'], relationships: [] }],
    markdown: '# Entry Probe Report',
    filesExamined: ['src/main.ts', 'src/app.ts'],
    dependencies: [], issues: [], confidence: 0.85,
    tokensUsed: 3000, durationMs: 5000, rounds: 2,
    ...overrides,
  };
}

function makeModuleGraph(): ModuleGraph {
  return {
    nodes: [
      { id: 'engine', type: 'module', path: 'engine/', responsibility: 'Core engine', publicAPI: ['run', 'stop'], keyTypes: ['Config'], patterns: ['singleton'], issues: ['too large'], fileCount: 10, loc: 3000 },
      { id: 'api', type: 'api-layer', path: 'api/', responsibility: 'HTTP API layer', publicAPI: ['handleRequest'], keyTypes: ['Request', 'Response'], patterns: ['middleware'], issues: [], fileCount: 5, loc: 1000 },
    ],
    edges: [{ source: 'api', target: 'engine', type: 'import', weight: 5 }],
  };
}

// ─── Tests ───

describe('probe-cache', () => {
  beforeEach(() => {
    store.clear();
    statStore.clear();
  });

  describe('loadProbeCache / saveProbeCache', () => {
    it('returns null when no cache file exists', () => {
      expect(loadProbeCache('/workspace')).toBeNull();
    });

    it('saves and loads cache correctly', () => {
      const cache = { version: 1, projectPath: '/workspace', cachedAt: Date.now(), probes: [], userCorrections: [] };
      saveProbeCache('/workspace', cache);
      const loaded = loadProbeCache('/workspace');
      expect(loaded).toBeDefined();
      expect(loaded?.version).toBe(1);
    });

    it('returns null for wrong version', () => {
      store.set('/workspace/.automater/analysis/probe-cache.json', JSON.stringify({ version: 99, probes: [], userCorrections: [] }));
      expect(loadProbeCache('/workspace')).toBeNull();
    });
  });

  describe('checkProbeCache', () => {
    it('reports all misses when no cache exists', () => {
      const result = checkProbeCache('/workspace', [makeProbeConfig()]);
      expect(result.hits).toHaveLength(0);
      expect(result.misses).toHaveLength(1);
      expect(result.missReasons.get('entry-main')).toBe('no-cache');
    });

    it('detects cache hit when files unchanged', () => {
      const config = makeProbeConfig();
      const report = makeProbeReport();
      for (const f of report.filesExamined) {
        store.set(`/workspace/${f}`, 'file content');
        statStore.set(`/workspace/${f}`, { mtimeMs: Date.now() });
      }
      updateProbeCache('/workspace', [config], [report]);
      const result = checkProbeCache('/workspace', [config]);
      expect(result.hits.length + result.misses.length).toBe(1);
    });
  });

  describe('updateProbeCache', () => {
    it('creates cache when none exists', () => {
      const config = makeProbeConfig();
      const report = makeProbeReport();
      for (const f of report.filesExamined) store.set(`/workspace/${f}`, 'content');
      updateProbeCache('/workspace', [config], [report]);
      const cache = loadProbeCache('/workspace');
      expect(cache).toBeDefined();
      expect(cache?.probes).toHaveLength(1);
    });

    it('merges new results with existing cache', () => {
      const config1 = makeProbeConfig();
      const config2 = makeProbeConfig({ id: 'module-core', type: 'module', seeds: ['src/core/'] });
      const report1 = makeProbeReport();
      const report2 = makeProbeReport({ probeId: 'module-core', type: 'module', filesExamined: ['src/core/index.ts'] });
      for (const f of [...report1.filesExamined, ...report2.filesExamined]) store.set(`/workspace/${f}`, 'content');
      updateProbeCache('/workspace', [config1], [report1]);
      updateProbeCache('/workspace', [config2], [report2]);
      const cache = loadProbeCache('/workspace');
      expect(cache?.probes.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('detectIncrementalChanges', () => {
    it('returns needsFullReprobe when no cache exists', () => {
      const result = detectIncrementalChanges('/workspace');
      expect(result.needsFullReprobe).toBe(true);
    });
  });

  describe('applyUserCorrection', () => {
    it('updates module responsibility', () => {
      store.set('/workspace/.automater/analysis/module-graph.json', JSON.stringify(makeModuleGraph()));
      const result = applyUserCorrection('/workspace', {
        moduleId: 'engine', field: 'responsibility',
        oldValue: 'Core engine', newValue: 'Orchestrator engine',
      });
      expect(result).toBeDefined();
      expect(result?.nodes.find(n => n.id === 'engine')?.responsibility).toBe('Orchestrator engine');
    });

    it('merges two modules', () => {
      store.set('/workspace/.automater/analysis/module-graph.json', JSON.stringify(makeModuleGraph()));
      const result = applyUserCorrection('/workspace', {
        moduleId: 'api', field: 'merge', oldValue: 'api', newValue: 'engine',
      });
      expect(result).toBeDefined();
      expect(result?.nodes).toHaveLength(1);
      expect(result?.nodes[0].publicAPI).toContain('handleRequest');
    });

    it('records correction in cache', () => {
      store.set('/workspace/.automater/analysis/module-graph.json', JSON.stringify(makeModuleGraph()));
      applyUserCorrection('/workspace', {
        moduleId: 'engine', field: 'responsibility', oldValue: 'old', newValue: 'new',
      });
      const corrections = getUserCorrections('/workspace');
      expect(corrections).toHaveLength(1);
      expect(corrections[0].moduleId).toBe('engine');
    });

    it('returns null for non-existent module', () => {
      store.set('/workspace/.automater/analysis/module-graph.json', JSON.stringify(makeModuleGraph()));
      const result = applyUserCorrection('/workspace', {
        moduleId: 'nonexistent', field: 'responsibility', oldValue: '', newValue: 'test',
      });
      expect(result).toBeNull();
    });
  });

  describe('getUserCorrections', () => {
    it('returns empty array when no cache', () => {
      expect(getUserCorrections('/workspace')).toEqual([]);
    });
  });
});
