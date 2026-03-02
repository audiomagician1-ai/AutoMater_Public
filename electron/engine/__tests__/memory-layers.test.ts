/**
 * Tests for memory-layers.ts — Hot/Warm/Cold 分层上下文
 *
 * Uses vi.mock for fs and file-writer to control filesystem.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Setup mock filesystem state ---
const mockFiles: Record<string, string> = {};
const mockDirs: Record<string, string[]> = {};

function resetMockFs() {
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  for (const k of Object.keys(mockDirs)) delete mockDirs[k];
}
function setFile(p: string, content: string) { mockFiles[p] = content; }
function setDir(p: string, entries: string[]) { mockDirs[p] = entries; }

// Mock 'fs' module
vi.mock('fs', () => ({
  default: {
    existsSync: (p: string) => p in mockFiles || p in mockDirs,
    readFileSync: (p: string) => {
      if (p in mockFiles) return mockFiles[p];
      throw new Error(`ENOENT: ${p}`);
    },
    readdirSync: (p: string) => {
      if (p in mockDirs) return mockDirs[p];
      throw new Error(`ENOENT: ${p}`);
    },
    writeFileSync: () => {},
    mkdirSync: () => {},
  },
  existsSync: (p: string) => p in mockFiles || p in mockDirs,
  readFileSync: (p: string) => {
    if (p in mockFiles) return mockFiles[p];
    throw new Error(`ENOENT: ${p}`);
  },
  readdirSync: (p: string) => {
    if (p in mockDirs) return mockDirs[p];
    throw new Error(`ENOENT: ${p}`);
  },
  writeFileSync: () => {},
  mkdirSync: () => {},
}));

// Mock 'path' — pass through (needed by memory-layers)
vi.mock('path', async () => {
  return {
    default: {
      join: (...parts: string[]) => parts.join('/'),
      resolve: (...parts: string[]) => parts.join('/'),
      dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
      basename: (p: string) => p.split('/').pop() || '',
    },
    join: (...parts: string[]) => parts.join('/'),
    resolve: (...parts: string[]) => parts.join('/'),
    dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
    basename: (p: string) => p.split('/').pop() || '',
  };
});

// Mock file-writer dependency
vi.mock('../file-writer', () => ({
  readWorkspaceFile: (base: string, rel: string) => {
    const p = `${base}/${rel}`;
    return (p in mockFiles) ? mockFiles[p] : null;
  },
  readDirectoryTree: () => ({ name: 'root', type: 'directory', children: [] }),
}));

import { extractKeywords, buildHotMemory, buildWarmMemory, loadColdMemory, selectColdModules } from '../memory-layers';

beforeEach(() => {
  resetMockFs();
});

// ═══════════════════════════════════════
// extractKeywords
// ═══════════════════════════════════════

describe('extractKeywords', () => {
  it('extracts meaningful words', () => {
    const kws = extractKeywords('Implement user authentication module');
    expect(kws).toContain('implement');
    expect(kws).toContain('user');
    expect(kws).toContain('authentication');
    expect(kws).toContain('module');
  });

  it('removes stop words', () => {
    const kws = extractKeywords('use this for the implementation');
    expect(kws).not.toContain('use');
    expect(kws).not.toContain('this');
    expect(kws).not.toContain('for');
    expect(kws).not.toContain('the');
    expect(kws).toContain('implementation');
  });

  it('removes Chinese stop words', () => {
    const kws = extractKeywords('实现 API 功能 需要 用户认证');
    expect(kws).not.toContain('实现');
    expect(kws).not.toContain('功能');
    expect(kws).not.toContain('需要');
    expect(kws).toContain('api');
    expect(kws).toContain('用户认证');
  });

  it('filters short words (<=2 chars)', () => {
    const kws = extractKeywords('a an do it is ok no go me');
    expect(kws.length).toBe(0);
  });

  it('splits on various delimiters', () => {
    const kws = extractKeywords('file-writer.ts: read/write (content) [array]');
    expect(kws).toContain('file');
    expect(kws).toContain('writer');
    expect(kws).toContain('read');
    expect(kws).toContain('write');
    expect(kws).toContain('content');
    expect(kws).toContain('array');
  });

  it('lowercases everything', () => {
    const kws = extractKeywords('TypeScript React NodeJS');
    expect(kws).toContain('typescript');
    expect(kws).toContain('react');
    expect(kws).toContain('nodejs');
  });
});

// ═══════════════════════════════════════
// buildHotMemory
// ═══════════════════════════════════════

describe('buildHotMemory', () => {
  it('returns empty hot memory when no files exist', () => {
    const layer = buildHotMemory('/workspace');
    expect(layer.tier).toBe('hot');
    expect(layer.content).toBe('');
    expect(layer.tokens).toBe(0);
  });

  it('includes skeleton data when available', () => {
    setFile('/workspace/.automater/analysis/skeleton.json', JSON.stringify({
      name: 'MyProject',
      techStack: ['TypeScript', 'React'],
      fileCount: 42,
      totalLOC: 5000,
      modules: [{ id: 'mod1' }, { id: 'mod2' }],
      entryFiles: ['src/main.ts'],
    }));
    const layer = buildHotMemory('/workspace');
    expect(layer.content).toContain('MyProject');
    expect(layer.content).toContain('TypeScript, React');
    expect(layer.content).toContain('42 文件');
    expect(layer.content).toContain('5000 行代码');
    expect(layer.tokens).toBeGreaterThan(0);
  });

  it('includes architecture doc when available', () => {
    setFile('/workspace/.automater/docs/ARCHITECTURE.md', '# Architecture\nThis is the arch doc.');
    const layer = buildHotMemory('/workspace');
    expect(layer.content).toContain('架构概要');
    expect(layer.content).toContain('Architecture');
  });

  it('truncates long architecture doc', () => {
    setFile('/workspace/.automater/docs/ARCHITECTURE.md', 'x'.repeat(5000));
    const layer = buildHotMemory('/workspace');
    expect(layer.content).toContain('已截断');
  });

  it('includes AGENTS.md when available', () => {
    setFile('/workspace/.automater/AGENTS.md', '# Agents\nDo things right.');
    const layer = buildHotMemory('/workspace');
    expect(layer.content).toContain('项目规范');
    expect(layer.content).toContain('Agents');
  });
});

// ═══════════════════════════════════════
// buildWarmMemory
// ═══════════════════════════════════════

describe('buildWarmMemory', () => {
  it('returns empty when no modules dir', () => {
    const layer = buildWarmMemory('/workspace');
    expect(layer.tier).toBe('warm');
    expect(layer.content).toBe('');
    expect(layer.tokens).toBe(0);
  });

  it('builds module index from summary files', () => {
    const modulesDir = '/workspace/.automater/analysis/modules';
    setDir(modulesDir, ['auth.summary.json', 'api.summary.json', 'readme.txt']);
    setFile(`${modulesDir}/auth.summary.json`, JSON.stringify({
      moduleId: 'auth', rootPath: 'src/auth', responsibility: 'User authentication',
    }));
    setFile(`${modulesDir}/api.summary.json`, JSON.stringify({
      moduleId: 'api', rootPath: 'src/api', responsibility: 'REST endpoints',
    }));

    const layer = buildWarmMemory('/workspace');
    expect(layer.content).toContain('**auth**');
    expect(layer.content).toContain('User authentication');
    expect(layer.content).toContain('**api**');
    expect(layer.content).toContain('REST endpoints');
    expect(layer.tokens).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════
// loadColdMemory
// ═══════════════════════════════════════

describe('loadColdMemory', () => {
  it('returns empty when module not found', () => {
    const layer = loadColdMemory('/workspace', 'unknown-module');
    expect(layer.tier).toBe('cold');
    expect(layer.moduleId).toBe('unknown-module');
    expect(layer.content).toBe('');
    expect(layer.tokens).toBe(0);
  });

  it('loads module summary', () => {
    const cacheFile = '/workspace/.automater/analysis/modules/auth.summary.json';
    setFile(cacheFile, JSON.stringify({
      moduleId: 'auth',
      fullText: 'Detailed auth module description with code snippets...',
    }));
    const layer = loadColdMemory('/workspace', 'auth');
    expect(layer.content).toContain('Detailed auth module');
    expect(layer.moduleId).toBe('auth');
    expect(layer.tokens).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════
// selectColdModules
// ═══════════════════════════════════════

describe('selectColdModules', () => {
  it('returns empty when no modules dir', () => {
    const modules = selectColdModules('/workspace', { title: 'test', description: 'test' } as any);
    expect(modules).toEqual([]);
  });

  it('selects modules matching feature keywords', () => {
    const modulesDir = '/workspace/.automater/analysis/modules';
    setDir(modulesDir, ['auth.summary.json', 'api.summary.json', 'logger.summary.json']);
    setFile(`${modulesDir}/auth.summary.json`, JSON.stringify({
      moduleId: 'auth', rootPath: 'src/auth', responsibility: 'User authentication and login',
      publicAPI: ['login', 'logout', 'validateToken'],
    }));
    setFile(`${modulesDir}/api.summary.json`, JSON.stringify({
      moduleId: 'api', rootPath: 'src/api', responsibility: 'REST API routes',
      publicAPI: ['createUser', 'getUser'],
    }));
    setFile(`${modulesDir}/logger.summary.json`, JSON.stringify({
      moduleId: 'logger', rootPath: 'src/logger', responsibility: 'Logging utilities',
      publicAPI: ['info', 'error'],
    }));

    const feature = {
      title: 'Fix login authentication bug',
      description: 'Users cannot login with valid tokens',
      depends_on: '[]',
      affected_files: '[]',
    } as any;

    const modules = selectColdModules('/workspace', feature);
    expect(modules[0]).toBe('auth'); // Should rank highest
    expect(modules.length).toBeLessThanOrEqual(5);
  });

  it('boosts modules matching affected files', () => {
    const modulesDir = '/workspace/.automater/analysis/modules';
    setDir(modulesDir, ['auth.summary.json', 'api.summary.json']);
    setFile(`${modulesDir}/auth.summary.json`, JSON.stringify({
      moduleId: 'auth', rootPath: 'src/auth', responsibility: 'Auth',
    }));
    setFile(`${modulesDir}/api.summary.json`, JSON.stringify({
      moduleId: 'api', rootPath: 'src/api', responsibility: 'API',
    }));

    const feature = {
      title: 'unrelated feature',
      description: 'something else',
      depends_on: '[]',
      affected_files: '["src/api/routes.ts"]',
    } as any;

    const modules = selectColdModules('/workspace', feature);
    expect(modules).toContain('api');
  });

  it('respects maxModules limit', () => {
    const modulesDir = '/workspace/.automater/analysis/modules';
    const entries: string[] = [];
    for (let i = 0; i < 20; i++) {
      const name = `mod${i}.summary.json`;
      entries.push(name);
      setFile(`${modulesDir}/${name}`, JSON.stringify({
        moduleId: `mod${i}`, rootPath: `src/mod${i}`, responsibility: `Auth login module ${i}`,
      }));
    }
    setDir(modulesDir, entries);

    const feature = { title: 'auth login', description: 'login feature', depends_on: '[]', affected_files: '[]' } as any;
    const modules = selectColdModules('/workspace', feature, 3);
    expect(modules.length).toBeLessThanOrEqual(3);
  });
});

