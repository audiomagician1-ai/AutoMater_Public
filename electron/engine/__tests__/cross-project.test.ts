/**
 * Tests for cross-project.ts — 跨项目经验池
 *
 * inferTags / inferProjectTags are pure functions.
 * contributeKnowledge / queryKnowledge / buildCrossProjectContext need FS+Electron mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock filesystem state ──
const mockFiles: Record<string, string> = {};
function resetMockFs() { for (const k of Object.keys(mockFiles)) delete mockFiles[k]; }

vi.mock('fs', () => ({
  default: {
    existsSync: (p: string) => p in mockFiles,
    readFileSync: (p: string) => { if (p in mockFiles) return mockFiles[p]; throw new Error(`ENOENT: ${p}`); },
    writeFileSync: (p: string, c: string) => { mockFiles[p] = c; },
    mkdirSync: () => {},
  },
  existsSync: (p: string) => p in mockFiles,
  readFileSync: (p: string) => { if (p in mockFiles) return mockFiles[p]; throw new Error(`ENOENT: ${p}`); },
  writeFileSync: (p: string, c: string) => { mockFiles[p] = c; },
  mkdirSync: () => {},
}));

vi.mock('path', () => ({
  default: { join: (...p: string[]) => p.join('/'), dirname: (p: string) => p.split('/').slice(0, -1).join('/') },
  join: (...p: string[]) => p.join('/'),
  dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
}));

// Mock electron app — make knowledge dir deterministic
vi.mock('electron', () => ({
  app: { getPath: () => '/mock-user-data' },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: class { webContents = { send() {} }; loadURL() {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  Notification: class { show() {} static isSupported() { return false; } },
}));

import {
  inferTags,
  inferProjectTags,
  contributeKnowledge,
  queryKnowledge,
  buildCrossProjectContext,
  getKnowledgeStats,
} from '../cross-project';

beforeEach(() => {
  resetMockFs();
});

// ═══════════════════════════════════════
// inferTags — pure function
// ═══════════════════════════════════════

describe('inferTags', () => {
  it('detects TypeScript', () => {
    expect(inferTags('We use TypeScript and tsconfig.json')).toContain('typescript');
  });

  it('detects React', () => {
    expect(inferTags('Build a React frontend with Vite')).toContain('react');
  });

  it('detects Python', () => {
    const tags = inferTags('Django REST API with pytest');
    expect(tags).toContain('python');
  });

  it('detects multiple tags', () => {
    const tags = inferTags('TypeScript React app with PostgreSQL database, Docker deployment');
    expect(tags).toContain('typescript');
    expect(tags).toContain('react');
    expect(tags).toContain('database');
    expect(tags).toContain('docker');
  });

  it('returns ["general"] when nothing matches', () => {
    expect(inferTags('some random text about cooking')).toEqual(['general']);
  });

  it('detects Rust', () => {
    expect(inferTags('cargo build --release for .rs files')).toContain('rust');
  });

  it('detects testing', () => {
    expect(inferTags('Write vitest unit tests')).toContain('testing');
  });

  it('detects git', () => {
    expect(inferTags('push to github main branch')).toContain('git');
  });

  it('detects security', () => {
    expect(inferTags('Fix CORS and XSS vulnerabilities')).toContain('security');
  });

  it('detects Electron', () => {
    expect(inferTags('Electron desktop app')).toContain('electron');
  });
});

// ═══════════════════════════════════════
// inferProjectTags
// ═══════════════════════════════════════

describe('inferProjectTags', () => {
  it('combines wish + archContent', () => {
    const tags = inferProjectTags('Build a REST API', 'Uses Django + PostgreSQL');
    expect(tags).toContain('api');
    expect(tags).toContain('python');
    expect(tags).toContain('database');
  });

  it('works with wish only', () => {
    const tags = inferProjectTags('React TypeScript app');
    expect(tags).toContain('react');
    expect(tags).toContain('typescript');
  });
});

// ═══════════════════════════════════════
// contributeKnowledge + queryKnowledge
// ═══════════════════════════════════════

describe('contributeKnowledge', () => {
  it('returns 0 for empty entries', () => {
    expect(contributeKnowledge('Project1', [])).toBe(0);
  });

  it('adds entries and updates index', () => {
    const count = contributeKnowledge('Project1', [
      { summary: 'Always run tsc before commit', content: 'TypeScript projects should have a pre-commit hook running tsc --noEmit' },
      { summary: 'Use vitest for unit tests', content: 'Vitest is faster than jest for TypeScript projects' },
    ]);
    expect(count).toBe(2);

    // Index should be saved
    const indexPath = '/mock-user-data/knowledge/_index.json';
    expect(mockFiles[indexPath]).toBeDefined();
    const index = JSON.parse(mockFiles[indexPath]);
    expect(index.entries.length).toBe(2);
    expect(index.entries[0].sourceProject).toBe('Project1');
    expect(index.entries[0].tags).toContain('typescript');
  });

  it('deduplicates by summary', () => {
    contributeKnowledge('P1', [{ summary: 'Tip A', content: 'Content A' }]);
    const count = contributeKnowledge('P2', [{ summary: 'Tip A', content: 'Different content' }]);
    expect(count).toBe(0);
  });

  it('writes category markdown files', () => {
    contributeKnowledge('P1', [
      { summary: 'TypeScript tip', content: 'TypeScript tsconfig strict mode', tags: ['typescript'] },
    ]);
    const tsFile = '/mock-user-data/knowledge/typescript.md';
    expect(mockFiles[tsFile]).toBeDefined();
    expect(mockFiles[tsFile]).toContain('TypeScript tip');
  });
});

describe('queryKnowledge', () => {
  beforeEach(() => {
    resetMockFs();
    contributeKnowledge('P1', [
      { summary: 'TS tip', content: 'TypeScript strict', tags: ['typescript'] },
      { summary: 'React tip', content: 'React hooks best practice', tags: ['react'] },
      { summary: 'DB tip', content: 'PostgreSQL indexing', tags: ['database'] },
    ]);
  });

  it('returns entries matching tags', () => {
    const results = queryKnowledge(['typescript']);
    expect(results.length).toBe(1);
    expect(results[0].summary).toBe('TS tip');
  });

  it('returns multiple matches', () => {
    const results = queryKnowledge(['typescript', 'react']);
    expect(results.length).toBe(2);
  });

  it('returns empty for unmatched tags', () => {
    expect(queryKnowledge(['rust'])).toEqual([]);
  });

  it('respects maxEntries', () => {
    const results = queryKnowledge(['typescript', 'react', 'database'], 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

// ═══════════════════════════════════════
// buildCrossProjectContext
// ═══════════════════════════════════════

describe('buildCrossProjectContext', () => {
  it('returns empty when no matching knowledge', () => {
    expect(buildCrossProjectContext('cooking recipes')).toBe('');
  });

  it('builds context from matching entries', () => {
    contributeKnowledge('P1', [
      { summary: 'TypeScript strict mode', content: 'Always enable strict in tsconfig', tags: ['typescript'] },
    ]);
    const ctx = buildCrossProjectContext('Build a TypeScript CLI tool');
    expect(ctx).toContain('跨项目经验');
    expect(ctx).toContain('TypeScript strict mode');
    expect(ctx).toContain('P1');
  });
});

// ═══════════════════════════════════════
// getKnowledgeStats
// ═══════════════════════════════════════

describe('getKnowledgeStats', () => {
  it('returns zero stats when empty', () => {
    const stats = getKnowledgeStats();
    expect(stats.totalEntries).toBe(0);
    expect(Object.keys(stats.byTag).length).toBe(0);
    expect(stats.topUsed.length).toBe(0);
  });

  it('aggregates stats correctly', () => {
    contributeKnowledge('P1', [
      { summary: 'A', content: 'TypeScript React', tags: ['typescript', 'react'] },
      { summary: 'B', content: 'Python Flask', tags: ['python'] },
    ]);
    const stats = getKnowledgeStats();
    expect(stats.totalEntries).toBe(2);
    expect(stats.byTag['typescript']).toBe(1);
    expect(stats.byTag['react']).toBe(1);
    expect(stats.byTag['python']).toBe(1);
  });
});
