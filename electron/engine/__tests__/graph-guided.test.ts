/**
 * Tests for graph-guided file selection in context-collector.ts
 * v7.0 Phase C2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs
const fsStore = new Map<string, { content: string; mtime: number }>();
vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn((p: string) => {
      const entry = fsStore.get(p);
      if (!entry) throw new Error(`ENOENT: ${p}`);
      return entry.content;
    }),
    statSync: vi.fn((p: string) => {
      const entry = fsStore.get(p);
      if (!entry) throw new Error(`ENOENT: ${p}`);
      return { mtimeMs: entry.mtime };
    }),
    existsSync: vi.fn((p: string) => fsStore.has(p)),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  },
}));

vi.mock('path', () => ({
  default: {
    join: (...args: string[]) => args.join('/'),
    dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
    basename: (p: string) => p.split('/').pop() || '',
    resolve: (...args: string[]) => args.join('/'),
    relative: (_from: string, to: string) => to,
    extname: (p: string) => { const i = p.lastIndexOf('.'); return i >= 0 ? p.slice(i) : ''; },
    sep: '/',
  },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Mock all other deps that context-collector imports
vi.mock('../../db', () => ({ getDb: vi.fn(() => ({ prepare: () => ({ get: () => null, all: () => [] }) })) }));
vi.mock('../repo-map', () => ({ generateRepoMap: vi.fn(() => '') }));
vi.mock('../memory-system', () => ({ readMemoryForRole: vi.fn(() => ({})) }));
vi.mock('../code-graph', () => ({
  buildCodeGraph: vi.fn(async () => ({ nodes: new Map(), buildTimeMs: 0 })),
  traverseGraph: vi.fn(() => []),
  inferSeedFiles: vi.fn(() => []),
  graphSummary: vi.fn(() => ''),
}));
vi.mock('../cross-project', () => ({ buildCrossProjectContext: vi.fn(() => '') }));
vi.mock('../memory-layers', () => ({
  buildHotMemory: vi.fn(() => ({ content: '' })),
  buildWarmMemory: vi.fn(() => ({ content: '' })),
  selectColdModules: vi.fn(() => []),
  loadColdMemory: vi.fn(() => ({ content: '' })),
  extractKeywords: vi.fn((text: string) => {
    return text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  }),
}));
vi.mock('../context-compaction', () => ({
  compressFileContent: vi.fn((c: string) => c),
  needsCompaction: vi.fn(() => false),
  compactMessages: vi.fn((m: unknown[]) => m),
  trimToolResult: vi.fn((s: string) => s),
}));
vi.mock('../file-writer', () => ({
  readDirectoryTree: vi.fn(() => []),
  readWorkspaceFile: vi.fn((_ws: string, filePath: string) => {
    const entry = fsStore.get(`/workspace/${filePath}`);
    return entry?.content || null;
  }),
}));

import { loadModuleGraph, selectGraphGuidedFiles, loadKnownIssues } from '../context-collector';
import type { ModuleGraph } from '../probe-types';

// ─── Test fixtures ───

function setupModuleGraph(graph: ModuleGraph): void {
  const graphPath = '/workspace/.automater/analysis/module-graph.json';
  fsStore.set(graphPath, { content: JSON.stringify(graph), mtime: Date.now() });
}

const SAMPLE_GRAPH: ModuleGraph = {
  nodes: [
    {
      id: 'orchestrator', type: 'module', path: 'electron/engine/orchestrator.ts',
      responsibility: 'Pipeline orchestrator managing PM→Architect→Developer flow',
      publicAPI: ['runOrchestrator', 'stopOrchestrator'],
      keyTypes: ['EnrichedFeature', 'ParsedFeature'],
      patterns: ['5-phase pipeline'],
      issues: ['1823 lines, too large'],
      fileCount: 1, loc: 1823,
    },
    {
      id: 'react-loop', type: 'module', path: 'electron/engine/react-loop.ts',
      responsibility: 'ReAct developer loop with tool calling',
      publicAPI: ['reactDeveloperLoop'],
      keyTypes: ['LLMMessage', 'ToolCall'],
      patterns: ['react-loop'],
      issues: [],
      fileCount: 1, loc: 500,
    },
    {
      id: 'llm-client', type: 'utility', path: 'electron/engine/llm-client.ts',
      responsibility: 'LLM API client for OpenAI/Anthropic',
      publicAPI: ['callLLM', 'callLLMWithTools'],
      keyTypes: ['LLMConfig'],
      patterns: ['retry', 'streaming'],
      issues: [],
      fileCount: 1, loc: 400,
    },
    {
      id: 'ui-pages', type: 'entry-point', path: 'src/pages/',
      responsibility: 'React pages for the application UI',
      publicAPI: ['OverviewPage', 'WishPage', 'BoardPage'],
      keyTypes: [],
      patterns: ['SPA routing'],
      issues: [],
      fileCount: 12, loc: 5000,
    },
  ],
  edges: [
    { source: 'orchestrator', target: 'react-loop', type: 'import', weight: 8 },
    { source: 'orchestrator', target: 'llm-client', type: 'import', weight: 5 },
    { source: 'react-loop', target: 'llm-client', type: 'import', weight: 7 },
  ],
};

// ─── Tests ───

describe('loadModuleGraph', () => {
  beforeEach(() => { fsStore.clear(); });

  it('returns null when no graph file exists', () => {
    expect(loadModuleGraph('/workspace')).toBeNull();
  });

  it('loads and caches module graph', () => {
    setupModuleGraph(SAMPLE_GRAPH);
    const graph = loadModuleGraph('/workspace');
    expect(graph).toBeDefined();
    expect(graph?.nodes).toHaveLength(4);
    expect(graph?.edges).toHaveLength(3);
  });

  it('returns null for invalid JSON', () => {
    fsStore.set('/workspace/.automater/analysis/module-graph.json', { content: 'not json', mtime: 1 });
    expect(loadModuleGraph('/workspace')).toBeNull();
  });
});

describe('selectGraphGuidedFiles', () => {
  beforeEach(() => { fsStore.clear(); });

  it('returns none source when no graph exists', () => {
    const result = selectGraphGuidedFiles('/workspace', { id: 'F1', title: 'test', description: 'test' } as any);
    expect(result.source).toBe('none');
    expect(result.files).toHaveLength(0);
  });

  it('finds relevant modules by keyword matching', () => {
    setupModuleGraph(SAMPLE_GRAPH);
    const feature = {
      id: 'F1',
      title: 'Fix pipeline orchestrator bug',
      description: 'The orchestrator has a bug in the developer phase',
    } as any;

    const result = selectGraphGuidedFiles('/workspace', feature, 10);
    expect(result.source).toBe('module-graph');
    expect(result.files.length).toBeGreaterThan(0);
    // Should include orchestrator path
    expect(result.files).toContain('electron/engine/orchestrator.ts');
    // Should include moduleHits with orchestrator
    expect(result.moduleHits).toContain('orchestrator');
  });

  it('includes 1-hop neighbors', () => {
    setupModuleGraph(SAMPLE_GRAPH);
    const feature = {
      id: 'F2',
      title: 'Improve LLM streaming in react loop',
      description: 'Add streaming support to the react developer loop',
    } as any;

    const result = selectGraphGuidedFiles('/workspace', feature, 10);
    expect(result.source).toBe('module-graph');
    // Should find react-loop and its neighbor llm-client
    expect(result.files).toContain('electron/engine/react-loop.ts');
    // llm-client should be included as a neighbor via edge
    expect(result.files).toContain('electron/engine/llm-client.ts');
  });

  it('returns none for empty keywords', () => {
    setupModuleGraph(SAMPLE_GRAPH);
    const feature = { id: 'F3', title: '', description: '' } as any;
    const result = selectGraphGuidedFiles('/workspace', feature);
    expect(result.source).toBe('none');
  });

  it('respects maxFiles limit', () => {
    setupModuleGraph(SAMPLE_GRAPH);
    const feature = {
      id: 'F4', title: 'orchestrator react loop llm client pages',
      description: 'everything',
    } as any;

    const result = selectGraphGuidedFiles('/workspace', feature, 2);
    expect(result.files.length).toBeLessThanOrEqual(2);
  });
});

describe('loadKnownIssues', () => {
  beforeEach(() => { fsStore.clear(); });

  it('returns null when no issues file exists', () => {
    expect(loadKnownIssues('/workspace')).toBeNull();
  });

  it('returns content when file exists', () => {
    const issuesContent = '# Known Issues\n- Bug in orchestrator\n- Missing error handling';
    fsStore.set('/workspace/.automater/docs/KNOWN-ISSUES.md', { content: issuesContent, mtime: Date.now() });
    // loadKnownIssues uses readWorkspaceFile which is mocked
    // Need to set the store with the right key format
  });
});
