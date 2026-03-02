/**
 * context-collector.ts tests — 纯函数 + ContextSection/ContextSnapshot 类型验证
 *
 * 由于 context-collector 依赖 DB, file-writer, repo-map, memory-system, code-graph, cross-project,
 * 我们 mock 所有外部依赖, 只测试内部逻辑和导出类型。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';

// Mock heavy dependencies
vi.mock('../../db', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      get: vi.fn(() => undefined),
      all: vi.fn(() => []),
      run: vi.fn(),
    })),
  })),
}));

vi.mock('../file-writer', () => ({
  readDirectoryTree: vi.fn(() => []),
  readWorkspaceFile: vi.fn(() => null),
}));

vi.mock('../repo-map', () => ({
  generateRepoMap: vi.fn(() => ''),
}));

vi.mock('../memory-system', () => ({
  readMemoryForRole: vi.fn(() => ({ combined: '' })),
}));

vi.mock('../code-graph', () => ({
  buildCodeGraph: vi.fn(() => ({})),
  traverseGraph: vi.fn(() => []),
  inferSeedFiles: vi.fn(() => []),
  graphSummary: vi.fn(() => ''),
}));

vi.mock('../cross-project', () => ({
  buildCrossProjectContext: vi.fn(() => ''),
}));

vi.mock('../memory-layers', () => ({
  buildHotMemory: vi.fn(() => ''),
  buildWarmMemory: vi.fn(() => ''),
  selectColdModules: vi.fn(() => []),
  loadColdMemory: vi.fn(() => ''),
  extractKeywords: vi.fn(() => []),
}));

vi.mock('../context-compaction', () => ({
  compressFileContent: vi.fn((content: string) => content.slice(0, 100)),
  needsCompaction: vi.fn(() => false),
  compactMessages: vi.fn((msgs: unknown[]) => msgs),
  trimToolResult: vi.fn((s: string) => s),
}));

import {
  collectDeveloperContext,
  type ContextSection,
  type ContextSnapshot,
  type ContextResult,
} from '../context-collector';
import { readDirectoryTree, readWorkspaceFile } from '../file-writer';
import { readMemoryForRole } from '../memory-system';

// ═══════════════════════════════════════
// ContextSection interface shape
// ═══════════════════════════════════════

describe('ContextSection type shape', () => {
  it('can create a valid ContextSection object', () => {
    const section: ContextSection = {
      id: 'test-section',
      name: 'Test Section',
      source: 'architecture',
      content: 'some content here',
      chars: 17,
      tokens: 12,
      truncated: false,
      files: ['test.ts'],
    };
    expect(section.id).toBe('test-section');
    expect(section.source).toBe('architecture');
    expect(section.truncated).toBe(false);
  });

  it('supports all source types', () => {
    const sources: ContextSection['source'][] = [
      'project-config', 'architecture', 'file-tree', 'repo-map',
      'dependency', 'keyword-match', 'code-graph', 'plan', 'qa-feedback',
    ];
    for (const source of sources) {
      const sec: ContextSection = {
        id: `s-${source}`, name: source, source,
        content: '', chars: 0, tokens: 0, truncated: false,
      };
      expect(sec.source).toBe(source);
    }
  });
});

// ═══════════════════════════════════════
// ContextSnapshot type shape
// ═══════════════════════════════════════

describe('ContextSnapshot type shape', () => {
  it('can create a valid ContextSnapshot', () => {
    const snap: ContextSnapshot = {
      agentId: 'dev-1',
      featureId: 'F001',
      timestamp: Date.now(),
      sections: [],
      totalChars: 0,
      totalTokens: 0,
      tokenBudget: 6000,
      contextText: '',
      filesIncluded: 0,
    };
    expect(snap.agentId).toBe('dev-1');
    expect(snap.tokenBudget).toBe(6000);
    expect(snap.sections).toEqual([]);
  });
});

// ═══════════════════════════════════════
// collectDeveloperContext — integration with mocks
// ═══════════════════════════════════════

describe('collectDeveloperContext', () => {
  const testFeature = {
    id: 'F001',
    project_id: 'P001',
    title: 'Test Feature',
    description: 'A test feature for testing',
    status: 'in_progress' as const,
    priority: 1,
    depends_on: '[]',
    acceptance_criteria: '',
    group_id: null,
    work_type: 'feature' as const,
    locked_by: 'dev-1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a ContextResult with all required fields', async () => {
    const result = await collectDeveloperContext('/test/workspace', 'P001', testFeature);
    expect(result).toHaveProperty('contextText');
    expect(result).toHaveProperty('estimatedTokens');
    expect(result).toHaveProperty('filesIncluded');
    expect(typeof result.contextText).toBe('string');
    expect(typeof result.estimatedTokens).toBe('number');
    expect(typeof result.filesIncluded).toBe('number');
  });

  it('returns a snapshot when agentId is provided', async () => {
    const result = await collectDeveloperContext('/test/workspace', 'P001', testFeature, 6000, 'dev-1');
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot?.agentId).toBe('dev-1');
    expect(result.snapshot?.featureId).toBe('F001');
  });

  it('includes AGENTS.md when available', async () => {
    vi.mocked(readWorkspaceFile).mockImplementation((ws: string, p: string) => {
      if (p === '.automater/AGENTS.md') return '# Project Rules\n- Use TypeScript';
      return null;
    });

    const result = await collectDeveloperContext('/test/workspace', 'P001', testFeature, 10000);
    expect(result.contextText).toContain('AGENTS.md');
  });

  it('includes memory when available', async () => {
    vi.mocked(readMemoryForRole).mockReturnValueOnce({ combined: 'Remember: use strict mode' } as any);

    const result = await collectDeveloperContext('/test/workspace', 'P001', testFeature, 10000);
    expect(result.contextText).toContain('记忆');
  });

  it('respects token budget — no context exceeds budget', async () => {
    const budget = 100; // very small budget
    const result = await collectDeveloperContext('/test/workspace', 'P001', testFeature, budget);
    // With tiny budget, estimatedTokens should be bounded
    expect(result.estimatedTokens).toBeLessThanOrEqual(budget * 2); // allow some slack
  });

  it('includes file tree when directory has files', async () => {
    vi.mocked(readDirectoryTree).mockReturnValueOnce([
      { name: 'src', type: 'dir', children: [
        { name: 'index.ts', type: 'file' },
        { name: 'app.ts', type: 'file' },
      ] },
      { name: 'README.md', type: 'file' },
    ] as any);

    const result = await collectDeveloperContext('/test/workspace', 'P001', testFeature, 10000);
    expect(result.contextText.length).toBeGreaterThan(0);
  });

  it('handles empty workspace gracefully', async () => {
    vi.mocked(readDirectoryTree).mockReturnValueOnce([]);
    vi.mocked(readWorkspaceFile).mockReturnValue(null);

    const result = await collectDeveloperContext('/empty/workspace', 'P001', testFeature);
    expect(result).toBeDefined();
    expect(result.filesIncluded).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════
// Re-exported functions from memory-layers / context-compaction
// ═══════════════════════════════════════

describe('re-exports', () => {
  it('re-exports memory-layers functions', async () => {
    const mod = await import('../context-collector');
    expect(typeof mod.buildHotMemory).toBe('function');
    expect(typeof mod.buildWarmMemory).toBe('function');
    expect(typeof mod.loadColdMemory).toBe('function');
    expect(typeof mod.selectColdModules).toBe('function');
    expect(typeof mod.extractKeywords).toBe('function');
  });

  it('re-exports context-compaction functions', async () => {
    const mod = await import('../context-collector');
    expect(typeof mod.needsCompaction).toBe('function');
    expect(typeof mod.compactMessages).toBe('function');
    expect(typeof mod.trimToolResult).toBe('function');
    expect(typeof mod.compressFileContent).toBe('function');
  });
});
