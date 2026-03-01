/**
 * Project Importer — 快速项目理解
 *
 * v6.0: 重写 — 从 4-phase 重量级流水线简化为 2-step 快速理解：
 *
 * Step 1: 轻量收集 (~1s)
 *   - 目录树 (depth ≤ 4)
 *   - 关键配置文件内容 (package.json, README, tsconfig, etc.)
 *   - Repo Map 符号索引 (函数签名、类、export)
 *   - 入口文件前 200 行
 *   → 所有信息拼成一个紧凑的项目快照 (~5-15K tokens)
 *
 * Step 2: 单次 LLM 调用 (~10-30s)
 *   - 将项目快照发给 strong 模型
 *   - 生成: ARCHITECTURE.md + 模块列表 + skeleton.json
 *   - 直接写入 .agentforge/ 目录
 *
 * 设计理念: 模拟开发者"把项目丢给大模型"的自然工作流
 *           秒级完成，不做无谓的全量文件读取
 *
 * @module project-importer
 */

import fs from 'fs';
import path from 'path';
import { buildCodeGraph, type CodeGraph } from './code-graph';
import { generateRepoMap } from './repo-map';
import { callLLM, getSettings } from './llm-client';
// model-selector no longer needed for import (v6.0 uses settings.strongModel directly)
import { writeDoc } from './doc-manager';
import { createLogger } from './logger';

const log = createLogger('project-importer');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

/** 静态扫描产出的项目骨架 */
export interface ProjectSkeleton {
  /** 项目名 (目录名) */
  name: string;
  /** 推断的技术栈 */
  techStack: string[];
  /** 包管理文件 */
  packageFiles: string[];
  /** 代码文件总数 */
  fileCount: number;
  /** 总代码行数 */
  totalLOC: number;
  /** 按语言/扩展名分组的 LOC */
  locByExtension: Record<string, number>;
  /** 目录结构概要 (depth ≤ 3) */
  directoryTree: string;
  /** Code Graph 统计 */
  graphStats: { nodeCount: number; edgeCount: number; buildTimeMs: number };
  /** 入口文件 */
  entryFiles: string[];
  /** 检测到的模块（按目录分组） */
  modules: ModuleInfo[];
  /** 生成时间 */
  timestamp: number;
}

/** 模块信息 */
export interface ModuleInfo {
  id: string;
  /** 模块根路径 (相对) */
  rootPath: string;
  /** 包含的文件 */
  files: string[];
  /** LOC */
  loc: number;
  /** 导入的其他模块 */
  dependsOn: string[];
  /** 被哪些模块依赖 */
  dependedBy: string[];
}

/** 模块摘要 */
export interface ModuleSummary {
  moduleId: string;
  rootPath: string;
  /** 一句话职责 */
  responsibility: string;
  /** 公开 API / 导出列表 */
  publicAPI: string[];
  /** 关键数据结构 */
  keyTypes: string[];
  /** 依赖关系描述 */
  dependencies: string;
  /** 完整摘要文本 */
  fullText: string;
  /** 使用的 token 数 */
  tokensUsed: number;
}

/** 导入进度回调 */
export type ImportProgressCallback = (phase: number, step: string, progress: number) => void;

// ═══════════════════════════════════════
// Constants
// ═══════════════════════════════════════

const ANALYSIS_DIR = '.agentforge/analysis';
const MODULES_DIR = '.agentforge/analysis/modules';
const SKELETON_FILE = '.agentforge/analysis/skeleton.json';
const MAX_SCAN_FILES = 5000;

// 忽略的目录
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '__pycache__', 'dist', 'build', '.next',
  'coverage', '.cache', 'target', 'vendor', '.agentforge', '.venv',
  'venv', '.turbo', '.output', '.nuxt', '.svelte-kit',
]);

// 代码文件扩展名
const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.cs',
  '.c', '.cpp', '.h', '.hpp', '.swift',
  '.vue', '.svelte', '.rb', '.php',
]);

// 技术栈检测规则
const TECH_DETECTORS: Array<{ file: string; tech: string }> = [
  { file: 'package.json', tech: 'Node.js' },
  { file: 'tsconfig.json', tech: 'TypeScript' },
  { file: 'Cargo.toml', tech: 'Rust' },
  { file: 'go.mod', tech: 'Go' },
  { file: 'requirements.txt', tech: 'Python' },
  { file: 'pyproject.toml', tech: 'Python' },
  { file: 'pom.xml', tech: 'Java (Maven)' },
  { file: 'build.gradle', tech: 'Java/Kotlin (Gradle)' },
  { file: 'Gemfile', tech: 'Ruby' },
  { file: 'composer.json', tech: 'PHP' },
  { file: 'Package.swift', tech: 'Swift' },
  { file: 'CMakeLists.txt', tech: 'C/C++ (CMake)' },
  { file: '.csproj', tech: 'C# (.NET)' },
  { file: 'next.config.js', tech: 'Next.js' },
  { file: 'next.config.mjs', tech: 'Next.js' },
  { file: 'nuxt.config.ts', tech: 'Nuxt' },
  { file: 'vite.config.ts', tech: 'Vite' },
  { file: 'electron-builder.yml', tech: 'Electron' },
  { file: 'Dockerfile', tech: 'Docker' },
  { file: 'docker-compose.yml', tech: 'Docker Compose' },
];


// ═══════════════════════════════════════
// Step 1: 轻量级项目快照收集 (<2s, 零 LLM)
// ═══════════════════════════════════════

/** 关键配置 / 文档文件 (优先读取，内容直接进 LLM prompt) */
const KEY_FILES = [
  'package.json', 'README.md', 'README', 'readme.md',
  'tsconfig.json', 'vite.config.ts', 'vite.config.js',
  'next.config.js', 'next.config.mjs', 'nuxt.config.ts',
  'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt',
  'pom.xml', 'build.gradle', 'Gemfile', 'composer.json',
  'Dockerfile', 'docker-compose.yml',
  'electron-builder.yml', '.env.example',
  'Makefile', 'CMakeLists.txt',
];

/** 收集项目快照 — 轻量、快速、不读全部文件 */
async function collectProjectSnapshot(workspacePath: string): Promise<{
  techStack: string[];
  packageFiles: string[];
  directoryTree: string;
  keyFileContents: string;
  repoMap: string;
  entryFileSnippets: string;
  fileCount: number;
  totalLOC: number;
  locByExtension: Record<string, number>;
}> {
  const t0 = Date.now();

  // 1. 技术栈检测 (instant)
  const techStack: string[] = [];
  const packageFiles: string[] = [];
  for (const det of TECH_DETECTORS) {
    const fp = path.join(workspacePath, det.file);
    if (fs.existsSync(fp)) {
      techStack.push(det.tech);
      packageFiles.push(det.file);
    }
  }

  // 2. 目录树 (depth <= 4, instant)
  const directoryTree = buildDirectoryTree(workspacePath, '', 0, 4);

  // 3. 关键文件内容 (仅读配置/文档，<= 20KB 总量)
  let keyFileContents = '';
  let keyChars = 0;
  const MAX_KEY_CHARS = 20000;
  for (const kf of KEY_FILES) {
    if (keyChars >= MAX_KEY_CHARS) break;
    const fp = path.join(workspacePath, kf);
    if (!fs.existsSync(fp)) continue;
    try {
      const stat = fs.statSync(fp);
      if (stat.size > 50000) continue;
      let content = fs.readFileSync(fp, 'utf-8');
      const remaining = MAX_KEY_CHARS - keyChars;
      if (content.length > remaining) content = content.slice(0, remaining) + '\n... [truncated]';
      keyFileContents += `\n### ${kf}\n\`\`\`\n${content}\n\`\`\`\n`;
      keyChars += content.length;
    } catch { /* skip */ }
  }

  // 4. Repo Map — 符号索引 (读文件但只提取签名，限制 100 文件)
  const repoMap = generateRepoMap(workspacePath, 100, 15, 300);

  // 5. 入口文件前 200 行
  const entrySnippets: string[] = [];
  const entryCandidates = [
    'src/index.ts', 'src/index.tsx', 'src/main.ts', 'src/main.tsx',
    'src/App.tsx', 'src/App.ts', 'index.ts', 'index.js',
    'main.ts', 'main.js', 'app.ts', 'app.js',
    'electron/main.ts', 'server.ts', 'server.js',
    'main.py', 'app.py', 'cmd/main.go', 'main.go', 'src/main.rs',
  ];
  let entryChars = 0;
  const MAX_ENTRY_CHARS = 10000;
  for (const ef of entryCandidates) {
    if (entryChars >= MAX_ENTRY_CHARS) break;
    const fp = path.join(workspacePath, ef);
    if (!fs.existsSync(fp)) continue;
    try {
      const content = fs.readFileSync(fp, 'utf-8');
      const lines = content.split('\n').slice(0, 200).join('\n');
      const snippet = lines.length > MAX_ENTRY_CHARS - entryChars
        ? lines.slice(0, MAX_ENTRY_CHARS - entryChars) + '\n... [truncated]'
        : lines;
      entrySnippets.push(`### ${ef} (first 200 lines)\n\`\`\`\n${snippet}\n\`\`\``);
      entryChars += snippet.length;
    } catch { /* skip */ }
  }

  // 6. 快速文件数 + LOC 统计 (用 stat.size 估算行数，不读内容)
  const { fileCount, totalLOC, locByExtension } = quickFileStats(workspacePath);

  console.log(`[IMPORT] Step 1 snapshot collected in ${Date.now() - t0}ms — ${fileCount} files, ${totalLOC} LOC, ${techStack.join(',')}`);

  return {
    techStack, packageFiles, directoryTree, keyFileContents,
    repoMap, entryFileSnippets: entrySnippets.join('\n\n'),
    fileCount, totalLOC, locByExtension,
  };
}

/** 快速统计文件数和 LOC (不读文件内容，用 stat.size 估算行数) */
function quickFileStats(workspacePath: string, maxFiles = 5000): {
  fileCount: number; totalLOC: number; locByExtension: Record<string, number>;
} {
  let fileCount = 0;
  let totalLOC = 0;
  const locByExt: Record<string, number> = {};

  function walk(dir: string) {
    if (fileCount >= maxFiles) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (fileCount >= maxFiles) return;
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) walk(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (CODE_EXTS.has(ext)) {
          fileCount++;
          try {
            const stat = fs.statSync(full);
            const estimatedLines = Math.ceil(stat.size / 40);
            totalLOC += estimatedLines;
            locByExt[ext] = (locByExt[ext] || 0) + estimatedLines;
          } catch { /* skip */ }
        }
      }
    }
  }
  walk(workspacePath);
  return { fileCount, totalLOC, locByExtension: locByExt };
}

// ═══════════════════════════════════════
// Step 2: 单次 LLM 调用 — 项目理解 + 架构文档生成
// ═══════════════════════════════════════

interface ImportLLMResult {
  architectureMd: string;
  modules: Array<{ id: string; rootPath: string; responsibility: string }>;
  designMd: string;
}

async function analyzeWithLLM(
  snapshot: Awaited<ReturnType<typeof collectProjectSnapshot>>,
  projectName: string,
  signal?: AbortSignal,
  onProgress?: ImportProgressCallback,
): Promise<ImportLLMResult> {
  const settings = getSettings();
  if (!settings) throw new Error('未配置 LLM 设置，请先在设置页面配置 API');
  if (!settings.strongModel?.trim()) throw new Error('未配置 Strong 模型，请先在设置页面配置');

  const model = settings.strongModel;
  console.log(`[IMPORT] Step 2: Calling LLM (model=${model})`);
  onProgress?.(1, `正在调用大模型分析项目... (${model})`, 0.1);

  const prompt = `你是一位资深全栈架构师。我将给你一个项目的完整快照，请分析并生成结构化输出。

## 项目名称
${projectName}

## 技术栈
${snapshot.techStack.join(', ') || '未检测到'}

## 目录结构
\`\`\`
${snapshot.directoryTree}
\`\`\`

## 关键配置文件
${snapshot.keyFileContents || '(无)'}

## 代码结构索引 (函数/类/export 符号)
${snapshot.repoMap || '(无)'}

## 入口文件代码片段
${snapshot.entryFileSnippets || '(无)'}

## 统计信息
- 代码文件数: ${snapshot.fileCount}
- 预估代码行数: ${snapshot.totalLOC}
- 语言分布: ${Object.entries(snapshot.locByExtension).map(([k, v]) => `${k}: ~${v}`).join(', ')}

---

请严格按以下格式输出三个部分:

\`\`\`architecture
# ${projectName} — 系统架构文档

## 1. 项目概述
(一段话说清楚这个项目是什么、解决什么问题、面向谁)

## 2. 技术栈
(列出核心技术、框架、运行时)

## 3. 系统架构
(分层或分模块描述整体架构)

## 4. 核心模块
(每个核心模块的职责、交互关系)

## 5. 数据流
(描述主要数据流向)

## 6. 关键设计决策
(架构上的重要选择和理由)

## 7. 扩展点与限制
(如何扩展、当前局限)
\`\`\`

\`\`\`modules
- id: 模块ID | path: 相对路径 | 职责: 一句话描述
- id: 模块ID | path: 相对路径 | 职责: 一句话描述
(列出所有识别到的功能模块，每行一个)
\`\`\`

\`\`\`design
# ${projectName} — 总览设计文档

## 项目背景
(项目要解决的问题)

## 核心功能
(主要功能模块列表)

## 用户场景
(典型使用场景)

## 技术选型
(为什么选择这些技术)
\`\`\``;

  const result = await callLLM(settings, model, [
    { role: 'system', content: '你是一位资深软件架构师，擅长快速理解代码项目并生成清晰的技术文档。全部用中文回复。' },
    { role: 'user', content: prompt },
  ], signal, 8192);

  onProgress?.(1, '大模型分析完成，正在解析结果...', 0.9);
  console.log(`[IMPORT] Step 2: LLM responded — ${result.inputTokens} in, ${result.outputTokens} out`);

  // 解析三个代码块
  const archMatch = result.content.match(/```architecture\n([\s\S]*?)```/);
  const modulesMatch = result.content.match(/```modules\n([\s\S]*?)```/);
  const designMatch = result.content.match(/```design\n([\s\S]*?)```/);

  const architectureMd = archMatch?.[1]?.trim() || result.content;
  const designMd = designMatch?.[1]?.trim() || '';

  // 解析模块列表
  const modules: ImportLLMResult['modules'] = [];
  if (modulesMatch?.[1]) {
    const lines = modulesMatch[1].trim().split('\n');
    for (const line of lines) {
      const m = line.match(/id:\s*(.+?)\s*\|\s*path:\s*(.+?)\s*\|\s*职责:\s*(.+)/);
      if (m) {
        modules.push({ id: m[1].trim(), rootPath: m[2].trim(), responsibility: m[3].trim() });
      } else {
        const simple = line.match(/^-\s*(.+?)[:：]\s*(.+)/);
        if (simple) {
          const id = simple[1].trim().replace(/[\/\\\s]/g, '-').toLowerCase();
          modules.push({ id, rootPath: simple[1].trim(), responsibility: simple[2].trim() });
        }
      }
    }
  }

  return { architectureMd, modules, designMd };
}

// ═══════════════════════════════════════
// 主入口: importProject (v6.0 — 2步快速理解)
// ═══════════════════════════════════════

/**
 * v6.0: 重写的项目导入 — 2步完成，通常 <30s
 *
 * Step 1: 轻量收集项目快照 (~1s)
 * Step 2: 单次 LLM 调用生成架构文档 (~10-30s)
 */
export async function importProject(
  workspacePath: string,
  projectId: string,
  signal?: AbortSignal,
  onProgress?: ImportProgressCallback,
): Promise<{
  skeleton: ProjectSkeleton;
  summaries: ModuleSummary[];
  architectureMd: string;
  docsGenerated: number;
}> {
  const t0 = Date.now();
  const projectName = path.basename(workspacePath);
  console.log(`[IMPORT] === Import Start (v6.0) === path=${workspacePath}, id=${projectId}`);
  log.info('=== Import Start (v6.0) ===', { workspacePath, projectId });

  // ── Step 1: 收集项目快照 ──
  onProgress?.(0, '正在收集项目信息...', 0.1);
  const snapshot = await collectProjectSnapshot(workspacePath);
  const step1Ms = Date.now() - t0;
  console.log(`[IMPORT] Step 1 done in ${step1Ms}ms`);
  onProgress?.(0, `已收集项目快照 (${snapshot.fileCount} 文件, ${snapshot.techStack.join(', ')})`, 1.0);

  if (signal?.aborted) throw new Error('Import aborted');

  // ── Step 2: LLM 分析 ──
  const llmResult = await analyzeWithLLM(snapshot, projectName, signal, onProgress);
  const step2Ms = Date.now() - t0;
  console.log(`[IMPORT] Step 2 done in ${step2Ms}ms — ${llmResult.modules.length} modules detected`);

  if (signal?.aborted) throw new Error('Import aborted');

  // ── 写入结果 ──
  onProgress?.(1, '正在保存分析结果...', 0.95);

  const modules: ModuleInfo[] = llmResult.modules.map(m => ({
    id: m.id,
    rootPath: m.rootPath,
    files: [],
    loc: 0,
    dependsOn: [],
    dependedBy: [],
  }));

  const skeleton: ProjectSkeleton = {
    name: projectName,
    techStack: snapshot.techStack,
    packageFiles: snapshot.packageFiles,
    fileCount: snapshot.fileCount,
    totalLOC: snapshot.totalLOC,
    locByExtension: snapshot.locByExtension,
    directoryTree: snapshot.directoryTree,
    graphStats: { nodeCount: 0, edgeCount: 0, buildTimeMs: 0 },
    entryFiles: [],
    modules,
    timestamp: Date.now(),
  };

  const summaries: ModuleSummary[] = llmResult.modules.map(m => ({
    moduleId: m.id,
    rootPath: m.rootPath,
    responsibility: m.responsibility,
    publicAPI: [],
    keyTypes: [],
    dependencies: '',
    fullText: m.responsibility,
    tokensUsed: 0,
  }));

  // 写入 skeleton.json
  const analysisDir = path.join(workspacePath, ANALYSIS_DIR);
  fs.mkdirSync(analysisDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, SKELETON_FILE),
    JSON.stringify(skeleton, null, 2), 'utf-8',
  );

  // 写入 ARCHITECTURE.md
  const docsDir = path.join(workspacePath, '.agentforge/docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'ARCHITECTURE.md'), llmResult.architectureMd, 'utf-8');

  // 写入设计文档
  let docsGenerated = 0;
  if (llmResult.designMd) {
    writeDoc(workspacePath, 'design', llmResult.designMd, 'project-importer', '项目导入自动生成总览设计文档', 'design-overview');
    docsGenerated++;
  }
  if (llmResult.architectureMd) docsGenerated++;

  const totalMs = Date.now() - t0;
  console.log(`[IMPORT] === Import Complete === ${totalMs}ms, ${docsGenerated} docs, ${modules.length} modules`);
  log.info('=== Import Complete (v6.0) ===', { ms: totalMs, files: skeleton.fileCount, modules: modules.length, docs: docsGenerated });
  onProgress?.(1, `分析完成! ${skeleton.fileCount} 文件, ${modules.length} 模块, ${docsGenerated} 文档`, 1.0);

  return { skeleton, summaries, architectureMd: llmResult.architectureMd, docsGenerated };
}

// ═══════════════════════════════════════
// Legacy: scanProjectSkeleton (保留给 orchestrator 增量更新用)
// ═══════════════════════════════════════

export async function scanProjectSkeleton(
  workspacePath: string,
  onProgress?: ImportProgressCallback,
): Promise<ProjectSkeleton> {
  const t0 = Date.now();
  log.info('scanProjectSkeleton: Starting', { workspacePath });

  const techStack: string[] = [];
  const packageFiles: string[] = [];
  for (const det of TECH_DETECTORS) {
    if (fs.existsSync(path.join(workspacePath, det.file))) {
      techStack.push(det.tech);
      packageFiles.push(det.file);
    }
  }

  const allFiles: string[] = [];
  const locByExt: Record<string, number> = {};
  const fileLOCMap = new Map<string, number>();
  collectCodeFilesSync(workspacePath, '', allFiles, locByExt, fileLOCMap, MAX_SCAN_FILES);
  let totalLOC = 0;
  for (const v of Object.values(locByExt)) totalLOC += v;

  const dirTree = buildDirectoryTree(workspacePath, '', 0, 3);
  const graph = await buildCodeGraph(workspacePath, 2000);
  const entryFiles = inferEntryFiles(workspacePath, allFiles);
  const modules = detectModules(workspacePath, allFiles, graph, fileLOCMap);

  const skeleton: ProjectSkeleton = {
    name: path.basename(workspacePath),
    techStack, packageFiles, fileCount: allFiles.length,
    totalLOC, locByExtension: locByExt, directoryTree: dirTree,
    graphStats: { nodeCount: graph.fileCount, edgeCount: graph.edgeCount, buildTimeMs: graph.buildTimeMs },
    entryFiles, modules, timestamp: Date.now(),
  };

  const analysisDir = path.join(workspacePath, ANALYSIS_DIR);
  fs.mkdirSync(analysisDir, { recursive: true });
  fs.writeFileSync(path.join(workspacePath, SKELETON_FILE), JSON.stringify(skeleton, null, 2), 'utf-8');

  log.info('scanProjectSkeleton: Done', { files: allFiles.length, ms: Date.now() - t0 });
  return skeleton;
}

// ═══════════════════════════════════════
// Legacy: incrementalUpdate (保留给 orchestrator 用)
// ═══════════════════════════════════════

export async function incrementalUpdate(
  workspacePath: string,
  changedFiles: string[],
  skeleton: ProjectSkeleton,
  signal?: AbortSignal,
  onProgress?: ImportProgressCallback,
): Promise<{ updatedModules: string[] }> {
  log.info('incrementalUpdate', { changedFileCount: changedFiles.length });

  const affectedModuleIds = new Set<string>();
  for (const file of changedFiles) {
    const normalized = file.replace(/\\/g, '/');
    for (const mod of skeleton.modules) {
      if (mod.files.some(f => f === normalized || normalized.startsWith(mod.rootPath + '/'))) {
        affectedModuleIds.add(mod.id);
        for (const depBy of mod.dependedBy) affectedModuleIds.add(depBy);
      }
    }
  }

  if (affectedModuleIds.size === 0) {
    log.info('incrementalUpdate: No modules affected');
    return { updatedModules: [] };
  }

  log.info('incrementalUpdate: Complete', { updatedModules: [...affectedModuleIds] });
  return { updatedModules: [...affectedModuleIds] };
}

// ═══════════════════════════════════════
// Internal Helpers
// ═══════════════════════════════════════

function collectCodeFilesSync(
  basePath: string, relative: string, result: string[],
  locByExt: Record<string, number>, fileLOCMap: Map<string, number>, maxFiles: number,
): void {
  if (result.length >= maxFiles) return;
  const fullPath = path.join(basePath, relative);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(fullPath, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (result.length >= maxFiles) return;
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) collectCodeFilesSync(basePath, rel, result, locByExt, fileLOCMap, maxFiles);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (CODE_EXTS.has(ext)) {
        result.push(rel);
        try {
          const content = fs.readFileSync(path.join(basePath, rel), 'utf-8');
          const lines = content.split('\n').length;
          locByExt[ext] = (locByExt[ext] || 0) + lines;
          fileLOCMap.set(rel, lines);
        } catch { /* skip */ }
      }
    }
  }
}

function buildDirectoryTree(basePath: string, relative: string, depth: number, maxDepth: number): string {
  if (depth >= maxDepth) return '';
  const fullPath = path.join(basePath, relative);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(fullPath, { withFileTypes: true }); } catch { return ''; }
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !IGNORE_DIRS.has(e.name));
  const files = entries.filter(e => e.isFile() && !e.name.startsWith('.'));
  for (const d of dirs.slice(0, 30)) {
    const rel = relative ? `${relative}/${d.name}` : d.name;
    lines.push(`${indent}${d.name}/`);
    const subtree = buildDirectoryTree(basePath, rel, depth + 1, maxDepth);
    if (subtree) lines.push(subtree);
  }
  if (depth === maxDepth - 1 && files.length > 0) {
    const shown = files.slice(0, 10).map(f => `${indent}  ${f.name}`);
    lines.push(...shown);
    if (files.length > 10) lines.push(`${indent}  ... +${files.length - 10} files`);
  }
  return lines.join('\n');
}

function inferEntryFiles(workspacePath: string, allFiles: string[]): string[] {
  const candidates = [
    'src/index.ts', 'src/index.tsx', 'src/main.ts', 'src/main.tsx',
    'src/App.tsx', 'src/App.ts', 'src/app.ts',
    'index.ts', 'index.js', 'main.ts', 'main.js',
    'app.ts', 'app.js', 'server.ts', 'server.js',
    'electron/main.ts', 'electron/main.js',
    'src/lib/index.ts', 'lib/index.ts',
    'cmd/main.go', 'main.go', 'src/main.rs', 'main.py', 'app.py', 'manage.py',
  ];
  return candidates.filter(c => allFiles.includes(c)).slice(0, 5) || allFiles.slice(0, 3);
}

function detectModules(
  workspacePath: string, allFiles: string[], graph: CodeGraph,
  fileLOCMap?: Map<string, number>,
): ModuleInfo[] {
  const groups = new Map<string, string[]>();
  for (const file of allFiles) {
    const parts = file.split('/');
    let moduleRoot: string;
    if (parts.length >= 3 && ['src', 'lib', 'app', 'packages'].includes(parts[0])) {
      moduleRoot = `${parts[0]}/${parts[1]}`;
    } else if (parts.length >= 2) {
      moduleRoot = parts[0];
    } else {
      moduleRoot = '.';
    }
    if (!groups.has(moduleRoot)) groups.set(moduleRoot, []);
    groups.get(moduleRoot)!.push(file);
  }

  const misc: string[] = [];
  const validGroups = new Map<string, string[]>();
  for (const [root, files] of groups) {
    if (files.length < 2 || root === '.') misc.push(...files);
    else validGroups.set(root, files);
  }
  if (misc.length > 0) validGroups.set('misc', misc);

  const modules: ModuleInfo[] = [];
  const moduleByFile = new Map<string, string>();
  for (const [root, files] of validGroups) {
    const id = root.replace(/[\/\\]/g, '-');
    for (const f of files) moduleByFile.set(f, id);
    const loc = fileLOCMap
      ? files.reduce((s, f) => s + (fileLOCMap.get(f) || 0), 0)
      : files.reduce((s, f) => { try { return s + fs.readFileSync(path.join(workspacePath, f), 'utf-8').split('\n').length; } catch { return s; } }, 0);
    modules.push({ id, rootPath: root, files, loc, dependsOn: [], dependedBy: [] });
  }

  for (const mod of modules) {
    const deps = new Set<string>();
    for (const file of mod.files) {
      const node = graph.nodes.get(file);
      if (!node) continue;
      for (const imp of node.imports) {
        const targetMod = moduleByFile.get(imp);
        if (targetMod && targetMod !== mod.id) deps.add(targetMod);
      }
    }
    mod.dependsOn = [...deps];
  }
  for (const mod of modules) {
    for (const dep of mod.dependsOn) {
      const target = modules.find(m => m.id === dep);
      if (target && !target.dependedBy.includes(mod.id)) target.dependedBy.push(mod.id);
    }
  }
  return modules;
}
