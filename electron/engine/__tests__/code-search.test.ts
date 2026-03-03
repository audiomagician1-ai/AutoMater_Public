/**
 * code-search.ts 集成测试
 *
 * 测试 ripgrep 搜索、文件搜索、批量读取、流式大文件读取、repo-map、code-graph 包装
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  codeSearch,
  formatSearchResult,
  codeSearchFiles,
  readManyFiles,
  formatReadManyResult,
  streamReadFile,
  getRepoMap,
  queryCodeGraph,
} from '../code-search';

// 使用 AgentForge 项目自身作为测试工作区
const WORKSPACE = path.resolve(__dirname, '../../..');

describe('codeSearch (ripgrep)', () => {
  it('应搜索到已知字符串', () => {
    const result = codeSearch(WORKSPACE, 'TOOL_DEFINITIONS', {
      include: ['*.ts'],
      maxResults: 10,
    });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.engine).toBe('ripgrep');
    expect(result.durationMs).toBeLessThan(5000);
    // 至少应该在 tool-registry.ts 中找到
    const files = result.matches.map(m => m.file);
    expect(files.some(f => f.includes('tool-registry'))).toBe(true);
  });

  it('支持大小写不敏感搜索', () => {
    const result = codeSearch(WORKSPACE, 'tool_definitions', {
      include: ['*.ts'],
      caseSensitive: false,
      maxResults: 5,
    });
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('无匹配时返回空', () => {
    // 使用动态生成的字符串避免在测试文件自身中被搜到
    const nonExistent = ['ZZZ', 'QQQ', 'NEVER', 'EXISTS', String(Date.now())].join('_');
    const result = codeSearch(WORKSPACE, nonExistent, { maxResults: 10 });
    expect(result.matches.length).toBe(0);
    expect(result.totalMatches).toBe(0);
  });

  it('格式化输出可读', () => {
    const result = codeSearch(WORKSPACE, 'export function codeSearch', {
      include: ['*.ts'],
      maxResults: 5,
    });
    const formatted = formatSearchResult(result);
    expect(formatted).toContain('📄');
    expect(formatted).toContain('匹配');
  });
});

describe('codeSearchFiles', () => {
  it('应找到 .ts 文件', () => {
    const result = codeSearchFiles(WORKSPACE, '*.ts', { maxResults: 20 });
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.every(f => f.endsWith('.ts'))).toBe(true);
  });

  it('应找到特定文件名', () => {
    const result = codeSearchFiles(WORKSPACE, '*code-search*', { maxResults: 10 });
    expect(result.files.some(f => f.includes('code-search'))).toBe(true);
  });
});

describe('readManyFiles', () => {
  it('应批量读取多文件', () => {
    const result = readManyFiles(WORKSPACE, ['electron/engine/code-search.ts'], {
      maxFiles: 5,
      maxLinesPerFile: 50,
    });
    expect(result.files.length).toBe(1);
    expect(result.files[0].path).toContain('code-search');
    expect(result.totalLines).toBeGreaterThan(0);
  });

  it('格式化输出包含文件头', () => {
    const result = readManyFiles(WORKSPACE, ['package.json'], { maxFiles: 1, maxLinesPerFile: 10 });
    const formatted = formatReadManyResult(result);
    expect(formatted).toContain('📄');
    expect(formatted).toContain('package.json');
  });

  it('限制生效', () => {
    const result = readManyFiles(WORKSPACE, ['**/*.ts'], {
      maxFiles: 3,
      maxLinesPerFile: 10,
    });
    expect(result.files.length).toBeLessThanOrEqual(3);
  });
});

describe('streamReadFile', () => {
  it('应读取已知文件', async () => {
    const testFile = path.join(WORKSPACE, 'package.json');
    const result = await streamReadFile(testFile, 1, 10);
    expect(result.content).toContain('|');  // 行号格式
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBeLessThanOrEqual(10);
    expect(result.fileSize).toBeGreaterThan(0);
  });

  it('offset 跳行正确', async () => {
    const testFile = path.join(WORKSPACE, 'package.json');
    const result = await streamReadFile(testFile, 5, 3);
    expect(result.startLine).toBe(5);
    expect(result.endLine).toBe(7);
    // 第一行应该包含行号 5
    expect(result.content.split('\n')[0]).toMatch(/^\s*5\|/);
  });

  it('不存在的文件抛错', async () => {
    await expect(streamReadFile('/nonexistent/file.txt')).rejects.toThrow('文件不存在');
  });
});

describe('getRepoMap', () => {
  it('应生成非空结构索引', () => {
    const map = getRepoMap(WORKSPACE, { maxFiles: 20, maxTotalLines: 50 });
    expect(map.length).toBeGreaterThan(0);
    expect(map).toContain('Repository Map');
  });
});

describe('queryCodeGraph', () => {
  it('summary 应返回图概要', async () => {
    const result = await queryCodeGraph(WORKSPACE, { type: 'summary' });
    expect(result.length).toBeGreaterThan(0);
    // 应包含文件数和边数
    expect(result).toMatch(/文件|file|节点|node|边|edge/i);
  });

  it('depends_on 应返回依赖列表', async () => {
    const result = await queryCodeGraph(WORKSPACE, {
      type: 'depends_on',
      file: 'electron/engine/code-search.ts',
    });
    // code-search.ts imports repo-map 和 code-graph
    expect(result).toContain('依赖');
  });
}, 30000);
