/**
 * file-writer.ts — 文件解析 + 写入测试
 *
 * parseFileBlocks: 纯逻辑，直接测试
 * writeFileBlocks / readDirectoryTree / readWorkspaceFile: 需要真实 FS (用 temp dir)
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  parseFileBlocks,
  writeFileBlocks,
  readDirectoryTree,
  readWorkspaceFile,
} from '../file-writer';

describe('file-writer', () => {
  // ── parseFileBlocks (纯逻辑) ──

  describe('parseFileBlocks', () => {
    test('解析单个 FILE 块', () => {
      const raw = '<<<FILE:src/index.ts>>>\nconsole.log("hello");\n<<<END>>>';
      const blocks = parseFileBlocks(raw);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].path).toBe('src/index.ts');
      expect(blocks[0].content).toContain('console.log("hello");');
    });

    test('解析多个 FILE 块', () => {
      const raw = `Some preamble text
<<<FILE:a.ts>>>
const a = 1;
<<<END>>>
Middle text
<<<FILE:b.ts>>>
const b = 2;
<<<END>>>
Trailing text`;
      const blocks = parseFileBlocks(raw);
      expect(blocks).toHaveLength(2);
      expect(blocks[0].path).toBe('a.ts');
      expect(blocks[1].path).toBe('b.ts');
    });

    test('无 FILE 块返回空数组', () => {
      expect(parseFileBlocks('plain text')).toHaveLength(0);
      expect(parseFileBlocks('')).toHaveLength(0);
    });

    test('路径中的空格被 trim', () => {
      const raw = '<<<FILE:  src/app.ts  >>>\ncode\n<<<END>>>';
      const blocks = parseFileBlocks(raw);
      expect(blocks[0].path).toBe('src/app.ts');
    });

    test('内容尾部多余空行被清理', () => {
      const raw = '<<<FILE:test.ts>>>\nline1\n\n\n\n<<<END>>>';
      const blocks = parseFileBlocks(raw);
      expect(blocks[0].content).toBe('line1\n');
    });
  });

  // ── writeFileBlocks (需要真实 FS) ──

  describe('writeFileBlocks', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('写入文件并创建子目录', () => {
      const blocks = [{ path: 'src/utils/helper.ts', content: 'export const x = 1;\n' }];
      const written = writeFileBlocks(tmpDir, blocks);
      expect(written).toHaveLength(1);
      expect(written[0].relativePath).toBe('src/utils/helper.ts');
      expect(written[0].size).toBeGreaterThan(0);
      // 验证文件真实存在
      expect(fs.existsSync(written[0].absolutePath)).toBe(true);
      expect(fs.readFileSync(written[0].absolutePath, 'utf-8')).toBe('export const x = 1;\n');
    });

    test('跳过 .. 路径穿越', () => {
      const blocks = [{ path: '../../../etc/passwd', content: 'hacked' }];
      const written = writeFileBlocks(tmpDir, blocks);
      expect(written).toHaveLength(0);
    });

    test('跳过绝对路径', () => {
      const blocks = [{ path: '/etc/passwd', content: 'hacked' }];
      const written = writeFileBlocks(tmpDir, blocks);
      expect(written).toHaveLength(0);
    });

    test('写入多个文件', () => {
      const blocks = [
        { path: 'a.ts', content: 'a' },
        { path: 'b.ts', content: 'b' },
        { path: 'sub/c.ts', content: 'c' },
      ];
      const written = writeFileBlocks(tmpDir, blocks);
      expect(written).toHaveLength(3);
    });
  });

  // ── readDirectoryTree ──

  describe('readDirectoryTree', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-test-'));
      // 创建测试文件结构
      fs.mkdirSync(path.join(tmpDir, 'src'));
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'code');
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Hello');
      fs.mkdirSync(path.join(tmpDir, 'node_modules')); // 应被忽略
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('返回正确的文件树', () => {
      const tree = readDirectoryTree(tmpDir);
      expect(tree.length).toBeGreaterThanOrEqual(2);
      const names = tree.map(n => n.name);
      expect(names).toContain('src');
      expect(names).toContain('README.md');
      expect(names).not.toContain('node_modules');
    });

    test('目录排在文件前面', () => {
      const tree = readDirectoryTree(tmpDir);
      const dirIdx = tree.findIndex(n => n.type === 'dir');
      const fileIdx = tree.findIndex(n => n.type === 'file');
      if (dirIdx >= 0 && fileIdx >= 0) {
        expect(dirIdx).toBeLessThan(fileIdx);
      }
    });

    test('maxDepth=0 返回空', () => {
      expect(readDirectoryTree(tmpDir, '', 0, 0)).toHaveLength(0);
    });

    test('不存在的目录返回空', () => {
      expect(readDirectoryTree('/nonexistent/path')).toHaveLength(0);
    });
  });

  // ── readWorkspaceFile ──

  describe('readWorkspaceFile', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
      fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'hello world');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('读取存在的文件', () => {
      expect(readWorkspaceFile(tmpDir, 'test.txt')).toBe('hello world');
    });

    test('不存在的文件返回 null', () => {
      expect(readWorkspaceFile(tmpDir, 'missing.txt')).toBeNull();
    });

    test('路径穿越返回 null', () => {
      expect(readWorkspaceFile(tmpDir, '../../../etc/passwd')).toBeNull();
    });

    test('绝对路径返回 null', () => {
      expect(readWorkspaceFile(tmpDir, '/etc/passwd')).toBeNull();
    });
  });
});
