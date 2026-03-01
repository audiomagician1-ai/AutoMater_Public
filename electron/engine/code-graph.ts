/**
 * Code Graph — 文件级 import/export 依赖图
 *
 * 解析工作区所有代码文件的 import 语句，构建一个有向图：
 *   A imports B  →  edge A → B
 *
 * 用途:
 * - 从一组「种子文件」出发，沿 import 链做 N 跳 (multi-hop) 遍历，
 *   收集所有与当前 Feature 相关的文件，替代朴素的 keyword matching。
 * - 提供「反向依赖」查询 — 谁 import 了这个文件？
 * - 比 vector search 更确定性、更精准、零 LLM 成本。
 *
 * 对标: Factory Droids 的 language-aware code graph + Aider 的 repo-map
 *
 * v1.3.0: 初始实现
 *   - 支持: TypeScript/JavaScript (import/require/export from)
 *   - 支持: Python (import/from ... import)
 *   - 支持: Go (import), Rust (use/mod)
 *   - 不依赖 AST 库 (纯正则), 与 repo-map.ts 一致的轻量策略
 */

import fs from 'fs';
import path from 'path';

// ═══════════════════════════════════════
// Public Types
// ═══════════════════════════════════════

export interface CodeGraphNode {
  /** 相对路径 (forward-slash) */
  file: string;
  /** 该文件 import 的文件列表 (resolved 相对路径) */
  imports: string[];
  /** import 该文件的文件列表 (反向边) */
  importedBy: string[];
}

export interface CodeGraph {
  /** file → node */
  nodes: Map<string, CodeGraphNode>;
  /** 构建耗时 ms */
  buildTimeMs: number;
  /** 扫描文件总数 */
  fileCount: number;
  /** 边总数 (import 关系) */
  edgeCount: number;
}

// ═══════════════════════════════════════
// Graph Construction
// ═══════════════════════════════════════

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '__pycache__', 'dist', 'build', '.next',
  'coverage', '.cache', 'target', 'vendor', '.agentforge', '.venv', 'venv',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py',
  '.go',
  '.rs',
]);

/** 让出主线程 — 避免 Electron UI 冻结 */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/** 每处理 YIELD_BATCH 个文件后让出一次事件循环 */
const YIELD_BATCH = 50;

/**
 * 为工作区构建完整的 Code Graph（async — 不阻塞主线程）
 * v5.7: 改为 async，内部文件读取循环定期 yield，解决 Electron 主进程冻结问题
 */
export async function buildCodeGraph(workspacePath: string, maxFiles: number = 500): Promise<CodeGraph> {
  const t0 = Date.now();
  const files = collectFiles(workspacePath, '', maxFiles);
  const nodes = new Map<string, CodeGraphNode>();

  // 初始化所有 node
  for (const file of files) {
    nodes.set(file, { file, imports: [], importedBy: [] });
  }

  // 解析每个文件的 imports（定期 yield 避免阻塞）
  let edgeCount = 0;
  const fileSet = new Set(files);

  for (let i = 0; i < files.length; i++) {
    // 每 YIELD_BATCH 个文件让出一次事件循环
    if (i > 0 && i % YIELD_BATCH === 0) await yieldToEventLoop();

    const file = files[i];
    const absPath = path.join(workspacePath, file.replace(/\//g, path.sep));
    let content: string;
    try {
      const stat = fs.statSync(absPath);
      if (stat.size > 256 * 1024) continue; // 跳过大文件
      content = fs.readFileSync(absPath, 'utf-8');
    } catch { continue; }

    const ext = path.extname(file).toLowerCase();
    const rawImports = parseImports(content, ext);

    // Resolve raw imports to actual files in the workspace
    const resolvedImports = rawImports
      .map(raw => resolveImport(file, raw, fileSet, ext))
      .filter((r): r is string => r !== null);

    const node = nodes.get(file)!;
    node.imports = [...new Set(resolvedImports)];
    edgeCount += node.imports.length;

    // 建立反向边
    for (const imp of node.imports) {
      const target = nodes.get(imp);
      if (target) {
        target.importedBy.push(file);
      }
    }
  }

  return {
    nodes,
    buildTimeMs: Date.now() - t0,
    fileCount: files.length,
    edgeCount,
  };
}

/**
 * 从「种子文件」出发，沿 import 链 multi-hop 遍历，收集相关文件。
 * 同时向前 (imports) 和向后 (importedBy) 遍历。
 *
 * @param graph 已构建的 CodeGraph
 * @param seedFiles 种子文件列表 (相对路径)
 * @param maxHops 最大跳数 (默认 2)
 * @param maxFiles 最大返回文件数 (默认 20)
 * @returns 按距离排序的相关文件列表 (不含种子本身)
 */
export function traverseGraph(
  graph: CodeGraph,
  seedFiles: string[],
  maxHops: number = 2,
  maxFiles: number = 20,
): Array<{ file: string; distance: number; direction: 'forward' | 'backward' | 'both' }> {
  const visited = new Map<string, { distance: number; direction: Set<string> }>();
  const seedSet = new Set(seedFiles);

  // BFS
  interface QueueItem { file: string; distance: number; dir: 'forward' | 'backward' }
  const queue: QueueItem[] = [];

  for (const seed of seedFiles) {
    if (graph.nodes.has(seed)) {
      visited.set(seed, { distance: 0, direction: new Set(['seed']) });
      // Forward: files this seed imports
      for (const imp of graph.nodes.get(seed)!.imports) {
        queue.push({ file: imp, distance: 1, dir: 'forward' });
      }
      // Backward: files that import this seed
      for (const dep of graph.nodes.get(seed)!.importedBy) {
        queue.push({ file: dep, distance: 1, dir: 'backward' });
      }
    }
  }

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.distance > maxHops) continue;

    const existing = visited.get(item.file);
    if (existing) {
      // 已访问 — 更新方向信息
      existing.direction.add(item.dir);
      if (item.distance < existing.distance) {
        existing.distance = item.distance;
      }
      continue;
    }

    visited.set(item.file, { distance: item.distance, direction: new Set([item.dir]) });

    const node = graph.nodes.get(item.file);
    if (!node || item.distance >= maxHops) continue;

    // Continue BFS in the same direction
    if (item.dir === 'forward') {
      for (const imp of node.imports) {
        if (!visited.has(imp)) {
          queue.push({ file: imp, distance: item.distance + 1, dir: 'forward' });
        }
      }
    } else {
      for (const dep of node.importedBy) {
        if (!visited.has(dep)) {
          queue.push({ file: dep, distance: item.distance + 1, dir: 'backward' });
        }
      }
    }
  }

  // 生成结果: 排除种子文件本身
  const results: Array<{ file: string; distance: number; direction: 'forward' | 'backward' | 'both' }> = [];
  for (const [file, info] of visited) {
    if (seedSet.has(file)) continue;
    const dirs = info.direction;
    const direction = dirs.has('forward') && dirs.has('backward')
      ? 'both'
      : dirs.has('forward') ? 'forward' : 'backward';
    results.push({ file, distance: info.distance, direction });
  }

  // 排序: 距离近优先, forward 优先 (直接依赖比反向依赖更重要)
  results.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    const dirPrio = { both: 0, forward: 1, backward: 2 };
    return dirPrio[a.direction] - dirPrio[b.direction];
  });

  return results.slice(0, maxFiles);
}

/**
 * 从特征关键词 + 文件树推断种子文件
 * 结合关键词匹配和已有依赖文件作为种子
 */
export function inferSeedFiles(
  graph: CodeGraph,
  depFiles: string[],
  featureKeywords: string[],
  maxSeeds: number = 5,
): string[] {
  const seeds = new Set<string>();

  // 1. 已知的依赖文件直接作为种子
  for (const f of depFiles) {
    if (graph.nodes.has(f)) seeds.add(f);
    if (seeds.size >= maxSeeds) return [...seeds];
  }

  // 2. 按关键词匹配文件名
  const allFiles = [...graph.nodes.keys()];
  for (const kw of featureKeywords) {
    if (kw.length < 3) continue;
    const kwLower = kw.toLowerCase();
    for (const f of allFiles) {
      if (seeds.has(f)) continue;
      const basename = f.split('/').pop()?.toLowerCase() || '';
      if (basename.includes(kwLower)) {
        seeds.add(f);
        if (seeds.size >= maxSeeds) return [...seeds];
      }
    }
  }

  // 3. Hub 文件 (importedBy 最多的) 作为补充种子
  if (seeds.size < 2) {
    const byImportedBy = allFiles
      .filter(f => !seeds.has(f))
      .sort((a, b) => {
        const nodeA = graph.nodes.get(a)!;
        const nodeB = graph.nodes.get(b)!;
        return nodeB.importedBy.length - nodeA.importedBy.length;
      });

    for (const f of byImportedBy) {
      seeds.add(f);
      if (seeds.size >= maxSeeds) break;
    }
  }

  return [...seeds];
}

/**
 * 生成图的统计摘要 (用于日志/调试)
 */
export function graphSummary(graph: CodeGraph): string {
  const lines: string[] = [
    `Code Graph: ${graph.fileCount} files, ${graph.edgeCount} edges (${graph.buildTimeMs}ms)`,
  ];

  // Top 5 hub files (most importedBy)
  const hubs = [...graph.nodes.entries()]
    .sort((a, b) => b[1].importedBy.length - a[1].importedBy.length)
    .slice(0, 5);

  if (hubs.length > 0 && hubs[0][1].importedBy.length > 0) {
    lines.push('Hub files:');
    for (const [file, node] of hubs) {
      if (node.importedBy.length === 0) break;
      lines.push(`  ${file} (imported by ${node.importedBy.length} files)`);
    }
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════
// Internal — File Collection
// ═══════════════════════════════════════

function collectFiles(workspacePath: string, relative: string, maxFiles: number): string[] {
  const result: string[] = [];
  const absDir = path.join(workspacePath, relative);
  if (!fs.existsSync(absDir)) return result;

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return result; }

  for (const entry of entries) {
    if (result.length >= maxFiles) break;
    if (IGNORE_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;

    const rel = relative ? `${relative}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      result.push(...collectFiles(workspacePath, rel, maxFiles - result.length));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (CODE_EXTENSIONS.has(ext)) {
        result.push(rel);
      }
    }
  }

  return result;
}

// ═══════════════════════════════════════
// Internal — Import Parsing
// ═══════════════════════════════════════

/**
 * 从文件内容中提取原始 import 路径
 */
function parseImports(content: string, ext: string): string[] {
  const imports: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    switch (ext) {
      case '.ts': case '.tsx': case '.js': case '.jsx': case '.mjs': case '.cjs': {
        // ES6 import: import X from 'path'
        const esMatch = trimmed.match(/^import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/);
        if (esMatch) { imports.push(esMatch[1]); continue; }

        // Dynamic import: import('path')
        const dynMatch = trimmed.match(/import\(\s*['"]([^'"]+)['"]\s*\)/);
        if (dynMatch) { imports.push(dynMatch[1]); continue; }

        // require: require('path')
        const reqMatch = trimmed.match(/require\(\s*['"]([^'"]+)['"]\s*\)/);
        if (reqMatch) { imports.push(reqMatch[1]); continue; }

        // export ... from 'path'
        const reexport = trimmed.match(/^export\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/);
        if (reexport) { imports.push(reexport[1]); continue; }
        break;
      }

      case '.py': {
        // from module import ...
        const fromMatch = trimmed.match(/^from\s+(\S+)\s+import\s+/);
        if (fromMatch) { imports.push(fromMatch[1]); continue; }

        // import module
        const impMatch = trimmed.match(/^import\s+(\S+)/);
        if (impMatch) { imports.push(impMatch[1].replace(/,.*$/, '')); continue; }
        break;
      }

      case '.go': {
        // import "path" or import ( "path" )
        const goMatch = trimmed.match(/^(?:import\s+)?["']([^"']+)["']/);
        if (goMatch && !trimmed.startsWith('//')) {
          imports.push(goMatch[1]);
        }
        break;
      }

      case '.rs': {
        // use crate::module  /  mod module
        const useMatch = trimmed.match(/^(?:pub\s+)?use\s+(?:crate::)?(\S+)/);
        if (useMatch) { imports.push(useMatch[1].replace(/;$/, '').replace(/::\{.*$/, '')); }
        const modMatch = trimmed.match(/^(?:pub\s+)?mod\s+(\w+)/);
        if (modMatch) { imports.push(modMatch[1]); }
        break;
      }
    }
  }

  return imports;
}

/**
 * 将原始 import 路径解析为工作区中的实际文件路径
 * 只解析相对路径的本地 import，跳过 npm 包/标准库
 */
function resolveImport(
  fromFile: string,
  rawImport: string,
  fileSet: Set<string>,
  ext: string,
): string | null {
  // ── TypeScript / JavaScript ──
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    // 跳过非相对路径 (npm 包)
    if (!rawImport.startsWith('.') && !rawImport.startsWith('/')) return null;

    const fromDir = path.posix.dirname(fromFile);
    const resolved = path.posix.normalize(path.posix.join(fromDir, rawImport));

    // 尝试各种扩展名解析
    const candidates = [
      resolved,
      resolved + '.ts',
      resolved + '.tsx',
      resolved + '.js',
      resolved + '.jsx',
      resolved + '/index.ts',
      resolved + '/index.tsx',
      resolved + '/index.js',
      resolved + '/index.jsx',
    ];

    for (const c of candidates) {
      if (fileSet.has(c)) return c;
    }
    return null;
  }

  // ── Python ──
  if (ext === '.py') {
    // 相对 import (带 .)
    if (rawImport.startsWith('.')) {
      const fromDir = path.posix.dirname(fromFile);
      const dots = rawImport.match(/^\.+/)?.[0].length || 1;
      let base = fromDir;
      for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
      const modulePath = rawImport.slice(dots).replace(/\./g, '/');
      const candidates = [
        path.posix.join(base, modulePath + '.py'),
        path.posix.join(base, modulePath, '__init__.py'),
      ];
      for (const c of candidates) {
        if (fileSet.has(c)) return c;
      }
    }
    // 顶级 import — 尝试解析为项目内文件
    const modulePath = rawImport.replace(/\./g, '/');
    const candidates = [
      modulePath + '.py',
      modulePath + '/__init__.py',
      'src/' + modulePath + '.py',
    ];
    for (const c of candidates) {
      if (fileSet.has(c)) return c;
    }
    return null;
  }

  // ── Go / Rust — 暂不做高精度解析，回退 null ──
  return null;
}
