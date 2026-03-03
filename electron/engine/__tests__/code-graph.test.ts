/// <reference types="vitest" />
/**
 * code-graph.ts — 文件级 import/export 依赖图测试
 *
 * 在 temp dir 下创建模拟项目，测试图构建 + BFS 遍历 + 种子推断。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  buildCodeGraph,
  traverseGraph,
  inferSeedFiles,
  graphSummary,
  type CodeGraph,
} from '../code-graph';

describe('code-graph', () => {
  let tmpDir: string;

  /**
   * 创建一个小型模拟 TS 项目:
   *
   *   src/index.ts  →  import './utils'   →  src/utils.ts
   *   src/index.ts  →  import './api/handler' → src/api/handler.ts
   *   src/api/handler.ts → import '../utils'  → src/utils.ts
   *   src/api/handler.ts → import '../db'     → src/db.ts
   *   src/utils.ts  (leaf node — no local imports)
   *   src/db.ts     (leaf node — no local imports)
   *   src/config.ts (isolated — no imports, not imported)
   *
   * Graph:
   *   index → utils
   *   index → api/handler
   *   api/handler → utils
   *   api/handler → db
   */
  function createMockProject(): void {
    const files: Record<string, string> = {
      'src/index.ts': `
import { helper } from './utils';
import { handleRequest } from './api/handler';
console.log(helper, handleRequest);
`,
      'src/utils.ts': `
export function helper() { return 1; }
`,
      'src/api/handler.ts': `
import { helper } from '../utils';
import { getDb } from '../db';
export function handleRequest() { return helper() + getDb(); }
`,
      'src/db.ts': `
export function getDb() { return 'db'; }
`,
      'src/config.ts': `
export const PORT = 3000;
`,
    };

    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf-8');
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-test-'));
    createMockProject();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── buildCodeGraph ──

  describe('buildCodeGraph', () => {
    test('构建成功并返回正确的文件数', async () => {
      const graph = await buildCodeGraph(tmpDir);
      expect(graph.fileCount).toBe(5);
      expect(graph.nodes.size).toBe(5);
      expect(graph.edgeCount).toBeGreaterThan(0);
      expect(graph.buildTimeMs).toBeGreaterThanOrEqual(0);
    });

    test('import 边正确解析', async () => {
      const graph = await buildCodeGraph(tmpDir);
      const indexNode = graph.nodes.get('src/index.ts');
      expect(indexNode).toBeDefined();
      expect(indexNode?.imports).toContain('src/utils.ts');
      expect(indexNode?.imports).toContain('src/api/handler.ts');
    });

    test('反向边正确', async () => {
      const graph = await buildCodeGraph(tmpDir);
      const utilsNode = graph.nodes.get('src/utils.ts');
      expect(utilsNode).toBeDefined();
      // utils 被 index 和 handler 引用
      expect(utilsNode?.importedBy).toContain('src/index.ts');
      expect(utilsNode?.importedBy).toContain('src/api/handler.ts');
    });

    test('孤立文件无边', async () => {
      const graph = await buildCodeGraph(tmpDir);
      const config = graph.nodes.get('src/config.ts');
      expect(config).toBeDefined();
      expect(config?.imports).toHaveLength(0);
      expect(config?.importedBy).toHaveLength(0);
    });

    test('maxFiles 限制', async () => {
      const graph = await buildCodeGraph(tmpDir, 2);
      expect(graph.fileCount).toBeLessThanOrEqual(2);
    });

    test('空目录返回空图', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-empty-'));
      try {
        const graph = await buildCodeGraph(emptyDir);
        expect(graph.fileCount).toBe(0);
        expect(graph.edgeCount).toBe(0);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    test('忽略 node_modules', async () => {
      // 创建 node_modules 下的文件
      const nmDir = path.join(tmpDir, 'node_modules', 'pkg');
      fs.mkdirSync(nmDir, { recursive: true });
      fs.writeFileSync(path.join(nmDir, 'index.ts'), 'export const x = 1;');

      const graph = await buildCodeGraph(tmpDir);
      const allFiles = [...graph.nodes.keys()];
      expect(allFiles.every(f => !f.includes('node_modules'))).toBe(true);
    });
  });

  // ── traverseGraph ──

  describe('traverseGraph', () => {
    let graph: CodeGraph;

    beforeEach(async () => {
      graph = await buildCodeGraph(tmpDir);
    });

    test('从 index.ts 出发 1 跳: 发现 utils 和 handler', () => {
      const results = traverseGraph(graph, ['src/index.ts'], 1);
      const files = results.map(r => r.file);
      expect(files).toContain('src/utils.ts');
      expect(files).toContain('src/api/handler.ts');
    });

    test('从 index.ts 出发 2 跳: 还能发现 db.ts', () => {
      const results = traverseGraph(graph, ['src/index.ts'], 2);
      const files = results.map(r => r.file);
      expect(files).toContain('src/db.ts');
    });

    test('结果不包含种子文件本身', () => {
      const results = traverseGraph(graph, ['src/index.ts'], 2);
      const files = results.map(r => r.file);
      expect(files).not.toContain('src/index.ts');
    });

    test('结果带有 distance 和 direction', () => {
      const results = traverseGraph(graph, ['src/utils.ts'], 2);
      for (const r of results) {
        expect(r.distance).toBeGreaterThan(0);
        expect(['forward', 'backward', 'both']).toContain(r.direction);
      }
    });

    test('maxFiles 限制结果数量', () => {
      const results = traverseGraph(graph, ['src/index.ts'], 10, 1);
      expect(results.length).toBeLessThanOrEqual(1);
    });

    test('不存在的种子文件不崩溃', () => {
      const results = traverseGraph(graph, ['nonexistent.ts'], 2);
      expect(results).toHaveLength(0);
    });
  });

  // ── inferSeedFiles ──

  describe('inferSeedFiles', () => {
    let graph: CodeGraph;

    beforeEach(async () => {
      graph = await buildCodeGraph(tmpDir);
    });

    test('依赖文件直接作为种子', () => {
      const seeds = inferSeedFiles(graph, ['src/utils.ts'], []);
      expect(seeds).toContain('src/utils.ts');
    });

    test('关键词匹配文件名', () => {
      const seeds = inferSeedFiles(graph, [], ['handler']);
      expect(seeds.some(s => s.includes('handler'))).toBe(true);
    });

    test('无匹配时用 hub 文件补充', () => {
      const seeds = inferSeedFiles(graph, [], ['zzz_no_match']);
      // 应该回退到 hub files
      expect(seeds.length).toBeGreaterThan(0);
    });

    test('maxSeeds 限制', () => {
      const seeds = inferSeedFiles(graph, [], ['src'], 2);
      expect(seeds.length).toBeLessThanOrEqual(2);
    });
  });

  // ── graphSummary ──

  describe('graphSummary', () => {
    test('生成非空摘要', async () => {
      const graph = await buildCodeGraph(tmpDir);
      const summary = graphSummary(graph);
      expect(summary).toContain('Code Graph');
      expect(summary).toContain('5 files');
      expect(summary).toContain('edges');
    });

    test('包含 hub files 信息', async () => {
      const graph = await buildCodeGraph(tmpDir);
      const summary = graphSummary(graph);
      // utils.ts 被 2 个文件引用，应该是 hub
      expect(summary).toContain('Hub');
    });
  });

  // ── Python import 解析 (通过构建图间接测试) ──

  describe('Python import 解析', () => {
    let pyDir: string;

    beforeEach(() => {
      pyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-'));
      // app/main.py → import app.utils → app/utils.py
      // app/main.py → from .models import X → app/models.py
      const files: Record<string, string> = {
        'app/main.py': `
from .models import User
import app.utils
`,
        'app/models.py': `
class User: pass
`,
        'app/utils.py': `
def helper(): pass
`,
      };
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(pyDir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf-8');
      }
    });

    afterEach(() => {
      fs.rmSync(pyDir, { recursive: true, force: true });
    });

    test('解析 Python from-import', async () => {
      const graph = await buildCodeGraph(pyDir);
      expect(graph.fileCount).toBe(3);
      const mainNode = graph.nodes.get('app/main.py');
      expect(mainNode).toBeDefined();
      // from .models import → 应解析到 app/models.py
      expect(mainNode?.imports).toContain('app/models.py');
    });
  });
});

