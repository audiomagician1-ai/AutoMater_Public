/**
 * Probe System Tests — v7.0 导入系统核心逻辑测试
 *
 * 测试覆盖:
 * 1. code-graph.ts: detectCommunities, getHubFiles, buildProjectProfile
 * 2. probe-orchestrator.ts: planProbes, mergeFindings
 * 3. probes/base-probe.ts: extractJSON, extractBlock, grepFiles, getExports
 */

import { describe, it, expect } from 'vitest';
import {
  detectCommunities,
  getHubFiles,
  buildProjectProfile,
  type CodeGraph,
  type CodeGraphNode,
} from '../code-graph';
import { planProbes, mergeFindings } from '../probe-orchestrator';
import { extractJSON, extractBlock, grepFiles, getExports } from '../probes/base-probe';
import type { ScanResult, ProbeReport, Finding } from '../probe-types';

// ═══════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════

function makeNode(file: string, imports: string[] = [], importedBy: string[] = []): CodeGraphNode {
  return { file, imports, importedBy };
}

function makeGraph(nodeList: CodeGraphNode[]): CodeGraph {
  const nodes = new Map<string, CodeGraphNode>();
  let edgeCount = 0;
  for (const n of nodeList) {
    nodes.set(n.file, n);
    edgeCount += n.imports.length;
  }
  return { nodes, buildTimeMs: 1, fileCount: nodeList.length, edgeCount };
}

/** Build a minimal ScanResult for testing planProbes */
function makeScanResult(overrides?: Partial<ScanResult>): ScanResult {
  const graph = makeGraph([
    makeNode('src/main.ts', ['src/app.ts', 'electron/main.ts'], []),
    makeNode('src/app.ts', ['src/pages/home.ts', 'src/store.ts'], ['src/main.ts']),
    makeNode('electron/main.ts', ['electron/ipc.ts', 'electron/db.ts'], ['src/main.ts']),
    makeNode('electron/ipc.ts', ['electron/db.ts', 'electron/engine/core.ts'], ['electron/main.ts']),
    makeNode('electron/db.ts', [], ['electron/main.ts', 'electron/ipc.ts']),
    makeNode('electron/engine/core.ts', ['electron/engine/types.ts'], ['electron/ipc.ts']),
    makeNode('electron/engine/types.ts', [], ['electron/engine/core.ts']),
    makeNode('src/pages/home.ts', ['src/store.ts'], ['src/app.ts']),
    makeNode('src/store.ts', [], ['src/app.ts', 'src/pages/home.ts']),
  ]);

  const communities = detectCommunities(graph);
  const hubFiles = getHubFiles(graph, communities, 10);

  return {
    snapshot: {
      techStack: ['TypeScript', 'Electron'],
      packageFiles: ['package.json'],
      directoryTree: 'src/\nelectron/',
      keyFileContents: '',
      repoMap: '',
      entryFileSnippets: '',
      fileCount: 9,
      totalLOC: 1500,
      locByExtension: { '.ts': 1200, '.tsx': 300 },
    },
    graph,
    repoMap: '',
    profile: buildProjectProfile(
      graph, 9, { '.ts': 1200, '.tsx': 300 },
      communities, hubFiles, true, 1000,
      ['src/main.ts', 'electron/main.ts'],
    ),
    seedFiles: [
      { file: 'src/main.ts', reason: 'entry', importCount: 2, importedByCount: 0 },
      { file: 'electron/main.ts', reason: 'entry', importCount: 2, importedByCount: 1 },
      { file: 'electron/db.ts', reason: 'hub', importCount: 0, importedByCount: 2 },
    ],
    explorationPlan: { probes: [], estimatedTotalTokens: 0, estimatedDurationMs: 0 },
    communities,
    hubFiles,
    allCodeFiles: [...graph.nodes.keys()],
    workspacePath: '/tmp/test-project',
    ...overrides,
  };
}

// ═══════════════════════════════════════
// Tests: detectCommunities
// ═══════════════════════════════════════

describe('detectCommunities', () => {
  it('groups files by directory prefix when no cross-imports', () => {
    const graph = makeGraph([
      makeNode('src/a.ts', [], []),
      makeNode('src/b.ts', [], []),
      makeNode('lib/c.ts', [], []),
      makeNode('lib/d.ts', [], []),
    ]);
    const result = detectCommunities(graph);
    expect(result.count).toBeGreaterThanOrEqual(2);
    // src files should be in one community, lib in another
    expect(result.fileToCommunity.get('src/a.ts'))
      .toBe(result.fileToCommunity.get('src/b.ts'));
    expect(result.fileToCommunity.get('lib/c.ts'))
      .toBe(result.fileToCommunity.get('lib/d.ts'));
  });

  it('merges communities when strong cross-imports exist', () => {
    const graph = makeGraph([
      makeNode('src/a.ts', ['lib/c.ts'], []),
      makeNode('src/b.ts', ['lib/c.ts', 'lib/d.ts'], []),
      makeNode('lib/c.ts', ['src/a.ts'], ['src/a.ts', 'src/b.ts']),
      makeNode('lib/d.ts', ['src/b.ts'], ['src/b.ts']),
    ]);
    const result = detectCommunities(graph);
    // With heavy cross-imports, labels should converge
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.count).toBeLessThanOrEqual(3);
  });

  it('handles empty graph', () => {
    const graph = makeGraph([]);
    const result = detectCommunities(graph);
    expect(result.count).toBe(0);
    expect(result.communities.size).toBe(0);
  });

  it('handles single file', () => {
    const graph = makeGraph([makeNode('src/only.ts')]);
    const result = detectCommunities(graph);
    expect(result.count).toBe(1);
    expect(result.fileToCommunity.get('src/only.ts')).toBeDefined();
  });

  it('assigns root files to _root community', () => {
    const graph = makeGraph([makeNode('main.ts')]);
    const result = detectCommunities(graph);
    expect(result.fileToCommunity.get('main.ts')).toBe('_root');
  });
});

// ═══════════════════════════════════════
// Tests: getHubFiles
// ═══════════════════════════════════════

describe('getHubFiles', () => {
  it('ranks files by centrality (importedBy * 2 + imports)', () => {
    const graph = makeGraph([
      makeNode('core.ts', ['a.ts', 'b.ts'], ['x.ts', 'y.ts', 'z.ts']),
      makeNode('util.ts', ['a.ts'], ['x.ts']),
      makeNode('a.ts', [], ['core.ts', 'util.ts']),
      makeNode('b.ts', [], ['core.ts']),
      makeNode('x.ts', ['core.ts', 'util.ts'], []),
      makeNode('y.ts', ['core.ts'], []),
      makeNode('z.ts', ['core.ts'], []),
    ]);
    const hubs = getHubFiles(graph, undefined, 5);
    expect(hubs.length).toBeGreaterThan(0);
    // core.ts should be top hub: importedBy=3*2 + imports=2 = 8
    expect(hubs[0].file).toBe('core.ts');
    expect(hubs[0].centrality).toBe(8);
  });

  it('filters out isolated files', () => {
    const graph = makeGraph([
      makeNode('isolated.ts', [], []),
      makeNode('connected.ts', ['a.ts'], ['b.ts']),
      makeNode('a.ts', [], ['connected.ts']),
      makeNode('b.ts', ['connected.ts'], []),
    ]);
    const hubs = getHubFiles(graph, undefined, 10);
    // isolated.ts has 0 connections, should not be a hub
    expect(hubs.find(h => h.file === 'isolated.ts')).toBeUndefined();
  });

  it('respects topN limit', () => {
    const nodes: CodeGraphNode[] = [];
    for (let i = 0; i < 20; i++) {
      nodes.push(makeNode(`file${i}.ts`, i > 0 ? [`file${i - 1}.ts`] : [], i < 19 ? [`file${i + 1}.ts`] : []));
    }
    const graph = makeGraph(nodes);
    const hubs = getHubFiles(graph, undefined, 5);
    expect(hubs.length).toBeLessThanOrEqual(5);
  });

  it('includes community label when provided', () => {
    const graph = makeGraph([
      makeNode('src/a.ts', ['src/b.ts'], ['src/b.ts']),
      makeNode('src/b.ts', ['src/a.ts'], ['src/a.ts']),
    ]);
    const communities = detectCommunities(graph);
    const hubs = getHubFiles(graph, communities, 5);
    for (const hub of hubs) {
      expect(hub.community).toBeDefined();
    }
  });
});

// ═══════════════════════════════════════
// Tests: buildProjectProfile
// ═══════════════════════════════════════

describe('buildProjectProfile', () => {
  it('classifies scale correctly', () => {
    const graph = makeGraph([makeNode('a.ts')]);
    const communities = detectCommunities(graph);
    const hubs = getHubFiles(graph);

    const medium = buildProjectProfile(graph, 300, { '.ts': 10000 }, communities, hubs, true, 1000, ['a.ts']);
    expect(medium.scale).toBe('medium');

    const large = buildProjectProfile(graph, 800, { '.ts': 30000 }, communities, hubs, true, 1000, ['a.ts']);
    expect(large.scale).toBe('large');

    const massive = buildProjectProfile(graph, 3000, { '.ts': 100000 }, communities, hubs, true, 1000, ['a.ts']);
    expect(massive.scale).toBe('massive');
  });

  it('detects circular dependencies', () => {
    const graph = makeGraph([
      makeNode('a.ts', ['b.ts'], ['b.ts']),
      makeNode('b.ts', ['a.ts'], ['a.ts']),
    ]);
    const communities = detectCommunities(graph);
    const hubs = getHubFiles(graph);
    const profile = buildProjectProfile(graph, 2, { '.ts': 100 }, communities, hubs, false, 0, []);
    expect(profile.hasCircularDeps).toBe(true);
  });

  it('evaluates README quality', () => {
    const graph = makeGraph([]);
    const communities = detectCommunities(graph);

    const none = buildProjectProfile(graph, 0, {}, communities, [], false, 0, []);
    expect(none.readmeQuality).toBe('none');

    const poor = buildProjectProfile(graph, 0, {}, communities, [], true, 100, []);
    expect(poor.readmeQuality).toBe('poor');

    const good = buildProjectProfile(graph, 0, {}, communities, [], true, 2000, []);
    expect(good.readmeQuality).toBe('good');
  });

  it('counts language families correctly', () => {
    const graph = makeGraph([]);
    const communities = detectCommunities(graph);
    const profile = buildProjectProfile(
      graph, 100,
      { '.ts': 5000, '.tsx': 2000, '.py': 1000, '.go': 500 },
      communities, [], true, 1000, [],
    );
    // .ts and .tsx both map to 'js/ts' family
    expect(profile.languageCount).toBe(3); // js/ts, python, go
  });
});

// ═══════════════════════════════════════
// Tests: planProbes
// ═══════════════════════════════════════

describe('planProbes', () => {
  it('generates at least one probe per type', () => {
    const scan = makeScanResult();
    scan.explorationPlan = planProbes(scan);
    const plan = scan.explorationPlan;

    expect(plan.probes.length).toBeGreaterThanOrEqual(5);

    const types = new Set(plan.probes.map(p => p.type));
    expect(types.has('entry')).toBe(true);
    expect(types.has('api-boundary')).toBe(true);
    expect(types.has('data-model')).toBe(true);
    expect(types.has('config-infra')).toBe(true);
    expect(types.has('smell')).toBe(true);
  });

  it('prioritizes entry probes', () => {
    const scan = makeScanResult();
    const plan = planProbes(scan);

    // Entry should be first (priority 1)
    const entryIdx = plan.probes.findIndex(p => p.type === 'entry');
    const smellIdx = plan.probes.findIndex(p => p.type === 'smell');
    expect(entryIdx).toBeLessThan(smellIdx);
  });

  it('estimates tokens and duration', () => {
    const scan = makeScanResult();
    const plan = planProbes(scan);

    expect(plan.estimatedTotalTokens).toBeGreaterThan(0);
    expect(plan.estimatedDurationMs).toBeGreaterThan(0);
  });

  it('includes module probes based on hub files', () => {
    const scan = makeScanResult();
    const plan = planProbes(scan);

    const moduleProbes = plan.probes.filter(p => p.type === 'module');
    expect(moduleProbes.length).toBeGreaterThanOrEqual(1);

    // Module probes should have seeds
    for (const mp of moduleProbes) {
      expect(mp.seeds.length).toBeGreaterThan(0);
    }
  });

  it('each probe has valid config', () => {
    const scan = makeScanResult();
    const plan = planProbes(scan);

    for (const probe of plan.probes) {
      expect(probe.id).toBeTruthy();
      expect(probe.type).toBeTruthy();
      expect(probe.maxFilesToRead).toBeGreaterThan(0);
      expect(probe.maxRounds).toBeGreaterThanOrEqual(1);
      expect(probe.tokenBudget).toBeGreaterThan(0);
      expect(probe.priority).toBeGreaterThan(0);
      expect(probe.description).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════
// Tests: mergeFindings
// ═══════════════════════════════════════

describe('mergeFindings', () => {
  function makeReport(overrides: Partial<ProbeReport>): ProbeReport {
    return {
      probeId: 'test',
      type: 'entry',
      findings: [],
      markdown: '',
      filesExamined: [],
      dependencies: [],
      issues: [],
      confidence: 0.8,
      tokensUsed: 100,
      durationMs: 1000,
      rounds: 1,
      ...overrides,
    };
  }

  it('collects all findings from multiple reports', () => {
    const reports: ProbeReport[] = [
      makeReport({
        probeId: 'entry-1',
        filesExamined: ['a.ts', 'b.ts'],
        findings: [
          { type: 'module', id: 'mod-a', name: 'Module A', description: 'Does A', files: ['a.ts'], relationships: [] },
        ],
      }),
      makeReport({
        probeId: 'module-1',
        filesExamined: ['c.ts'],
        findings: [
          { type: 'module', id: 'mod-c', name: 'Module C', description: 'Does C', files: ['c.ts'], relationships: [] },
        ],
      }),
    ];

    const result = mergeFindings(reports, 10);
    expect(result.findings.length).toBe(2);
    expect(result.coveragePercent).toBe(30); // 3/10 files
  });

  it('deduplicates findings with same id', () => {
    const reports: ProbeReport[] = [
      makeReport({
        findings: [
          { type: 'module', id: 'same-id', name: 'A', description: 'short', files: ['a.ts'], relationships: [] },
        ],
      }),
      makeReport({
        findings: [
          { type: 'module', id: 'same-id', name: 'A', description: 'different', files: ['a.ts'], relationships: [] },
        ],
      }),
    ];

    const result = mergeFindings(reports, 5);
    expect(result.findings.length).toBe(1);
    expect(result.conflicts.length).toBe(1);
  });

  it('merges overlapping file findings', () => {
    const reports: ProbeReport[] = [
      makeReport({
        findings: [{
          type: 'module', id: 'mod-1', name: 'Core',
          description: 'Core module',
          files: ['core/a.ts', 'core/b.ts'],
          publicAPI: ['funcA'],
          keyTypes: ['TypeA'],
          relationships: [],
        }],
      }),
      makeReport({
        findings: [{
          type: 'module', id: 'mod-2', name: 'Core',
          description: 'Core module with more detail here',
          files: ['core/a.ts', 'core/c.ts'],
          publicAPI: ['funcB'],
          keyTypes: ['TypeB'],
          relationships: [],
        }],
      }),
    ];

    const result = mergeFindings(reports, 5);
    // Should merge because >50% file overlap (core/a.ts)
    expect(result.findings.length).toBe(1);
    const merged = result.findings[0];
    expect(merged.publicAPI).toContain('funcA');
    expect(merged.publicAPI).toContain('funcB');
    expect(merged.keyTypes).toContain('TypeA');
    expect(merged.keyTypes).toContain('TypeB');
    expect(merged.files.length).toBe(3); // core/a.ts, core/b.ts, core/c.ts
  });

  it('handles empty reports', () => {
    const result = mergeFindings([], 100);
    expect(result.findings.length).toBe(0);
    expect(result.coveragePercent).toBe(0);
  });
});

// ═══════════════════════════════════════
// Tests: extractJSON / extractBlock
// ═══════════════════════════════════════

describe('extractJSON', () => {
  it('extracts from labeled code fence', () => {
    const text = 'Some text\n```json\n{"key": "value"}\n```\nMore text';
    const result = extractJSON<{ key: string }>(text, 'json');
    expect(result).toEqual({ key: 'value' });
  });

  it('extracts from generic json fence', () => {
    const text = '```json\n{"a": 1}\n```';
    const result = extractJSON<{ a: number }>(text);
    expect(result).toEqual({ a: 1 });
  });

  it('extracts bare JSON object', () => {
    const text = 'Here is the result: {"findings": []}';
    const result = extractJSON<{ findings: unknown[] }>(text);
    expect(result).toEqual({ findings: [] });
  });

  it('returns null for invalid JSON', () => {
    const text = 'no json here';
    expect(extractJSON(text)).toBeNull();
  });

  it('handles complex nested JSON', () => {
    const text = '```json\n{"findings": [{"id": "f1", "name": "test", "files": ["a.ts"]}]}\n```';
    const result = extractJSON<{ findings: Array<{ id: string }> }>(text);
    expect(result?.findings[0].id).toBe('f1');
  });
});

describe('extractBlock', () => {
  it('extracts labeled code block', () => {
    const text = 'intro\n```architecture\n# Architecture\n## Overview\n```\noutro';
    const result = extractBlock(text, 'architecture');
    expect(result).toBe('# Architecture\n## Overview');
  });

  it('returns empty string for missing block', () => {
    const text = 'no blocks here';
    expect(extractBlock(text, 'missing')).toBe('');
  });
});
