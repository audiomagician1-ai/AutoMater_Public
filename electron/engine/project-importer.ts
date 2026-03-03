/**
 * Project Importer — v7.0 多探针并行探索 + 结构化拼图
 *
 * 三阶段流水线:
 *
 * Phase 0: 骨架扫描 (零 LLM, ~1-2s)
 *   - 目录树 + 技术栈检测 + 文件统计
 *   - Code Graph 构建 (import/export 依赖图)
 *   - Repo Map (符号索引)
 *   - 项目特征画像 (ProjectProfile)
 *   - 社区检测 + Hub 文件识别 + 种子文件推断
 *   → 产出: ScanResult + ExplorationPlan
 *
 * Phase 1: 并行探测 (N 个探针, 每个 1-3 轮 LLM, fast 模型)
 *   - 6 类探针: Entry / Module / API Boundary / Data Model / Config / Smell
 *   - 每个探针独立 context, 自主探索 1-3 轮
 *   → 产出: ProbeReport[] + 写入 .automater/analysis/probes/
 *
 * Phase 2: 拼图合成 (strong 模型, 1 次调用)
 *   - 综合所有探针报告 + 骨架数据
 *   → 产出: module-graph.json + ARCHITECTURE.md + known-issues.md
 *
 * @module project-importer
 */

import fs from 'fs';
import path from 'path';
import { buildCodeGraph, type CodeGraph, detectCommunities, getHubFiles, buildProjectProfile } from './code-graph';
import { generateRepoMap } from './repo-map';
import { callLLM, getSettings } from './llm-client';
// import { writeDoc } from './doc-manager';  // TODO: re-enable when needed
import { createLogger } from './logger';
import { planProbes, executeProbes, mergeFindings } from './probe-orchestrator';
import { checkProbeCache, updateProbeCache } from './probe-cache';
import type {
  ScanResult,
  SeedFile,
  ProbeReport,
  FuseOutput,
  ModuleGraph,
  ArchTree,
  ArchNode,
  ArchEdge,
  ImportStats,
  ImportProgressEvent,
  ProbeProgress,
  MergedFindings,
  ImportLogCallback,
} from './probe-types';

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

const ANALYSIS_DIR = '.automater/analysis';
const PROBES_DIR = '.automater/analysis/probes';
// const MODULES_DIR = '.automater/analysis/modules';  // reserved for future use
const SKELETON_FILE = '.automater/analysis/skeleton.json';
const MODULE_GRAPH_FILE = '.automater/analysis/module-graph.json';
const ARCH_TREE_FILE = '.automater/analysis/architecture-tree.json';
const KNOWN_ISSUES_FILE = '.automater/docs/KNOWN-ISSUES.md';
const MAX_SCAN_FILES = 5000;

/** 默认导入预算 $5 — 足够覆盖大型项目的完整探测 + Phase 2 合成 */
const DEFAULT_IMPORT_BUDGET_USD = 5.0;

/**
 * 解析导入预算:
 *   1. 优先使用用户在设置中配置的 importBudgetUsd
 *   2. 如果未配置或为 0，使用默认值 $5
 *   3. 不再与 dailyBudgetUsd 取 min — 导入是一次性操作，不应受日常预算约束
 */
function resolveImportBudget(settings: { importBudgetUsd?: number; dailyBudgetUsd?: number }): number {
  if (settings.importBudgetUsd && settings.importBudgetUsd > 0) {
    return settings.importBudgetUsd;
  }
  return DEFAULT_IMPORT_BUDGET_USD;
}

// 忽略的目录
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
  'target',
  'vendor',
  '.automater',
  '.venv',
  'venv',
  '.turbo',
  '.output',
  '.nuxt',
  '.svelte-kit',
]);

// 代码文件扩展名
const CODE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.cs',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.swift',
  '.vue',
  '.svelte',
  '.rb',
  '.php',
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
  'package.json',
  'README.md',
  'README',
  'readme.md',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'next.config.js',
  'next.config.mjs',
  'nuxt.config.ts',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json',
  'Dockerfile',
  'docker-compose.yml',
  'electron-builder.yml',
  '.env.example',
  'Makefile',
  'CMakeLists.txt',
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
    } catch {
      /* skip */
    }
  }

  // 4. Repo Map — 符号索引 (读文件但只提取签名，限制 100 文件)
  const repoMap = generateRepoMap(workspacePath, 100, 15, 300);

  // 5. 入口文件前 200 行
  const entrySnippets: string[] = [];
  const entryCandidates = [
    'src/index.ts',
    'src/index.tsx',
    'src/main.ts',
    'src/main.tsx',
    'src/App.tsx',
    'src/App.ts',
    'index.ts',
    'index.js',
    'main.ts',
    'main.js',
    'app.ts',
    'app.js',
    'electron/main.ts',
    'server.ts',
    'server.js',
    'main.py',
    'app.py',
    'cmd/main.go',
    'main.go',
    'src/main.rs',
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
      const snippet =
        lines.length > MAX_ENTRY_CHARS - entryChars
          ? lines.slice(0, MAX_ENTRY_CHARS - entryChars) + '\n... [truncated]'
          : lines;
      entrySnippets.push(`### ${ef} (first 200 lines)\n\`\`\`\n${snippet}\n\`\`\``);
      entryChars += snippet.length;
    } catch {
      /* skip */
    }
  }

  // 6. 快速文件数 + LOC 统计 (用 stat.size 估算行数，不读内容)
  const { fileCount, totalLOC, locByExtension } = quickFileStats(workspacePath);

  log.info(`Step 1 snapshot collected in ${Date.now() - t0}ms`, {
    fileCount,
    totalLOC,
    techStack: techStack.join(','),
  });

  return {
    techStack,
    packageFiles,
    directoryTree,
    keyFileContents,
    repoMap,
    entryFileSnippets: entrySnippets.join('\n\n'),
    fileCount,
    totalLOC,
    locByExtension,
  };
}

/** 快速统计文件数和 LOC (不读文件内容，用 stat.size 估算行数) */
function quickFileStats(
  workspacePath: string,
  maxFiles = 5000,
): {
  fileCount: number;
  totalLOC: number;
  locByExtension: Record<string, number>;
} {
  let fileCount = 0;
  let totalLOC = 0;
  const locByExt: Record<string, number> = {};

  function walk(dir: string) {
    if (fileCount >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
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
          } catch {
            /* skip */
          }
        }
      }
    }
  }
  walk(workspacePath);
  return { fileCount, totalLOC, locByExtension: locByExt };
}

// ═══════════════════════════════════════
// Phase 0: Enhanced Scan (zero LLM, ~1-2s)
// ═══════════════════════════════════════

/**
 * Phase 0: 骨架扫描 — 收集项目快照 + Code Graph + 社区检测 + 种子推断。
 * 零 LLM 调用，通常 1-2 秒。
 */
async function phase0Scan(
  workspacePath: string,
  onProgress?: (event: ImportProgressEvent) => void,
): Promise<ScanResult> {
  const t0 = Date.now();
  onProgress?.({ phase: 'scan', step: '收集项目信息...', progress: 0.1 });

  // 1. Collect basic snapshot (reuse v6.0 logic)
  const snapshot = await collectProjectSnapshot(workspacePath);

  onProgress?.({ phase: 'scan', step: '构建代码依赖图...', progress: 0.3 });

  // 2. Build code graph
  const graph = await buildCodeGraph(workspacePath, 2000);

  onProgress?.({ phase: 'scan', step: '分析项目结构...', progress: 0.5 });

  // 3. Collect all code files
  const allCodeFiles: string[] = [];
  const locByExt: Record<string, number> = {};
  const fileLOCMap = new Map<string, number>();
  collectCodeFilesSync(workspacePath, '', allCodeFiles, locByExt, fileLOCMap, MAX_SCAN_FILES);

  // 4. Community detection
  const communities = detectCommunities(graph);

  // 5. Hub files
  const hubFiles = getHubFiles(graph, communities, 20);

  // 6. Entry files
  const entryFiles = inferEntryFiles(workspacePath, allCodeFiles);

  // 7. Seed files for probes
  const seedFiles = buildSeedFiles(entryFiles, hubFiles, allCodeFiles, fileLOCMap);

  onProgress?.({ phase: 'scan', step: '生成探针计划...', progress: 0.8 });

  // 8. README check for project profile
  let readmeExists = false;
  let readmeLength = 0;
  for (const name of ['README.md', 'README', 'readme.md']) {
    const fp = path.join(workspacePath, name);
    if (fs.existsSync(fp)) {
      readmeExists = true;
      try {
        readmeLength = fs.statSync(fp).size;
      } catch {
        /* skip */
      }
      break;
    }
  }

  // 9. Build project profile
  const profile = buildProjectProfile(
    graph,
    snapshot.fileCount,
    snapshot.locByExtension,
    communities,
    hubFiles,
    readmeExists,
    readmeLength,
    entryFiles,
  );

  // 10. Build repo map
  const repoMap = snapshot.repoMap;

  // 11. Create ScanResult (without explorationPlan — planProbes fills that)
  const scanResult: ScanResult = {
    snapshot,
    graph,
    repoMap,
    profile,
    seedFiles,
    explorationPlan: { probes: [], estimatedTotalTokens: 0, estimatedDurationMs: 0 },
    communities,
    hubFiles,
    allCodeFiles,
    workspacePath,
  };

  // 12. Generate exploration plan
  scanResult.explorationPlan = planProbes(scanResult);

  const scanMs = Date.now() - t0;
  log.info(`Phase 0 complete in ${scanMs}ms`, {
    files: snapshot.fileCount,
    graphNodes: graph.fileCount,
    graphEdges: graph.edgeCount,
    communities: communities.count,
    hubs: hubFiles.length,
    probes: scanResult.explorationPlan.probes.length,
    profile: JSON.stringify(profile),
  });

  onProgress?.({
    phase: 'scan',
    step: `骨架完成: ${snapshot.fileCount} 文件, ${snapshot.totalLOC} LOC, ${snapshot.techStack.join('+')}, ${communities.count} 模块, ${scanResult.explorationPlan.probes.length} 探针`,
    progress: 1.0,
  });

  return scanResult;
}

/**
 * Build seed files from entry files, hubs, and largest files.
 */
function buildSeedFiles(
  entryFiles: string[],
  hubFiles: Array<{ file: string; importedByCount: number; importCount: number }>,
  allCodeFiles: string[],
  fileLOCMap: Map<string, number>,
): SeedFile[] {
  const seeds: SeedFile[] = [];
  const seen = new Set<string>();

  // Entry files
  for (const file of entryFiles) {
    if (seen.has(file)) continue;
    seen.add(file);
    seeds.push({ file, reason: 'entry', importCount: 0, importedByCount: 0 });
  }

  // Hub files
  for (const hub of hubFiles.slice(0, 10)) {
    if (seen.has(hub.file)) continue;
    seen.add(hub.file);
    seeds.push({
      file: hub.file,
      reason: 'hub',
      importCount: hub.importCount,
      importedByCount: hub.importedByCount,
    });
  }

  // Largest files by LOC
  const byLOC = allCodeFiles
    .filter(f => !seen.has(f))
    .sort((a, b) => (fileLOCMap.get(b) || 0) - (fileLOCMap.get(a) || 0));
  for (const file of byLOC.slice(0, 5)) {
    seeds.push({ file, reason: 'largest', importCount: 0, importedByCount: 0 });
  }

  return seeds;
}

// ═══════════════════════════════════════
// Phase 1: Parallel Probing (fast LLM, ~30s-3min)
// ═══════════════════════════════════════

/**
 * Phase 1: 并行探测 — 执行所有探针，收集 ProbeReport[]
 * v7.0+: 支持缓存命中跳过、增量探测
 */
async function phase1Probe(
  scan: ScanResult,
  signal?: AbortSignal,
  onProgress?: (event: ImportProgressEvent) => void,
  onLog?: ImportLogCallback,
): Promise<ProbeReport[]> {
  const settings = getSettings();
  if (!settings) throw new Error('未配置 LLM 设置，请先在设置页面配置 API');

  const probeStatuses = new Map<string, ProbeProgress>();
  const allConfigs = scan.explorationPlan.probes;

  // ── v7.0 D1+D2: Cache check — skip probes whose files haven't changed ──
  const cacheCheck = checkProbeCache(scan.workspacePath, allConfigs);
  const cachedReports: ProbeReport[] = cacheCheck.hits.map(h => h.cachedReport);
  const configsToRun = cacheCheck.misses;

  if (cacheCheck.hits.length > 0) {
    log.info(`Cache: ${cacheCheck.hits.length} probes reused, ${configsToRun.length} probes to run`);
    onProgress?.({
      phase: 'probe',
      step: `缓存命中 ${cacheCheck.hits.length}/${allConfigs.length} 个探针，需要重新运行 ${configsToRun.length} 个`,
      progress: 0.0,
    });
  }

  // Mark cached probes as completed in status
  for (const hit of cacheCheck.hits) {
    probeStatuses.set(hit.config.id, {
      probeId: hit.config.id,
      type: hit.config.type,
      status: 'completed',
      description: `(缓存) ${hit.cachedReport.findings.length} 发现`,
      progress: 1.0,
    });
  }

  // Initialize probes-to-run as queued
  for (const config of configsToRun) {
    probeStatuses.set(config.id, {
      probeId: config.id,
      type: config.type,
      status: 'queued',
      description: config.description,
      progress: 0,
    });
  }

  const broadcastProgress = (step: string, overallProgress: number) => {
    onProgress?.({
      phase: 'probe',
      step,
      progress: overallProgress,
      probes: [...probeStatuses.values()],
    });
  };

  let freshReports: ProbeReport[] = [];

  if (configsToRun.length > 0) {
    broadcastProgress(`启动 ${configsToRun.length} 个探针 (${cacheCheck.hits.length} 缓存命中)...`, 0.0);

    // Build a modified exploration plan with only the probes that need running
    const runPlan = { ...scan.explorationPlan, probes: configsToRun };

    freshReports = await executeProbes(scan, runPlan, {
      concurrency: Math.min(settings.workerCount || 3, 4),
      signal,
      budgetUsd: resolveImportBudget(settings),
      settings,
      onLog,
      probeTimeoutMs: 300_000, // 5 min per probe
      onProbeComplete: report => {
        probeStatuses.set(report.probeId, {
          probeId: report.probeId,
          type: report.type,
          status: report.findings.length > 0 ? 'completed' : 'failed',
          description: `${report.findings.length} 发现, ${report.filesExamined.length} 文件`,
          progress: 1.0,
        });
        const completed = [...probeStatuses.values()].filter(
          p => p.status === 'completed' || p.status === 'failed',
        ).length;
        const total = probeStatuses.size;
        broadcastProgress(`探针 ${completed}/${total} 完成`, completed / total);
      },
      onProgress: (probeId, status, progress) => {
        const existing = probeStatuses.get(probeId);
        if (existing) {
          existing.status = 'running';
          existing.description = status;
          existing.progress = progress;
        }
      },
    });

    // ── Update cache with fresh results ──
    updateProbeCache(scan.workspacePath, configsToRun, freshReports);
  } else {
    broadcastProgress('所有探针结果从缓存恢复 ✅', 1.0);
  }

  const allReports = [...cachedReports, ...freshReports];

  // Save probe reports to disk
  const probesDir = path.join(scan.workspacePath, PROBES_DIR);
  fs.mkdirSync(probesDir, { recursive: true });
  for (const report of allReports) {
    const reportPath = path.join(probesDir, `${report.probeId}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    // Also save markdown version
    const mdPath = path.join(probesDir, `${report.probeId}.md`);
    fs.writeFileSync(mdPath, report.markdown, 'utf-8');
  }

  log.info(`Phase 1 complete`, {
    probes: allReports.length,
    fromCache: cachedReports.length,
    fresh: freshReports.length,
    totalFindings: allReports.reduce((s, r) => s + r.findings.length, 0),
    totalTokens: freshReports.reduce((s, r) => s + r.tokensUsed, 0),
  });

  return allReports;
}

// ═══════════════════════════════════════
// Phase 2: Fuse — Split into Step A (structure) + Step B (docs)
// ═══════════════════════════════════════

/**
 * Compress a probe report into a concise summary for the fuse prompt.
 * Extracts structured data (findings, issues, files) instead of raw markdown.
 */
function _compressProbeReport(report: ProbeReport): string {
  const lines: string[] = [];
  lines.push(
    `### ${report.probeId} (置信度: ${report.confidence}, 文件: ${report.filesExamined.length}, ${report.tokensUsed} tok)`,
  );

  // Key findings (max 8)
  if (report.findings.length > 0) {
    lines.push('发现:');
    for (const f of report.findings.slice(0, 8)) {
      const apis = f.publicAPI?.slice(0, 5).join(', ') || '';
      const types = f.keyTypes?.slice(0, 5).join(', ') || '';
      lines.push(
        `- [${f.type}] ${f.id}: ${f.description.slice(0, 120)}${apis ? ` | API: ${apis}` : ''}${types ? ` | Types: ${types}` : ''}`,
      );
    }
    if (report.findings.length > 8) lines.push(`  (+${report.findings.length - 8} more)`);
  }

  // Issues (max 5)
  if (report.issues.length > 0) {
    lines.push('问题: ' + report.issues.slice(0, 5).join('; '));
  }

  // Dependencies (max 8)
  if (report.dependencies.length > 0) {
    lines.push(
      '依赖: ' +
        report.dependencies
          .slice(0, 8)
          .map(d => `${d.source}→${d.target}(${d.type})`)
          .join(', '),
    );
  }

  // Files examined (max 10)
  if (report.filesExamined.length > 0) {
    lines.push(
      '文件: ' +
        report.filesExamined.slice(0, 10).join(', ') +
        (report.filesExamined.length > 10 ? ` (+${report.filesExamined.length - 10})` : ''),
    );
  }

  return lines.join('\n');
}

/**
 * Attempt to parse JSON from LLM output with repair strategies.
 */
function parseJsonRobust<T>(raw: string, label: string): T | null {
  try {
    return JSON.parse(raw);
  } catch (e1) {
    log.warn(`${label} JSON parse failed, attempting repair...`, { error: String(e1) });
    try {
      const repaired = raw
        .replace(/,\s*([}\]])/g, '$1') // trailing commas
        .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":') // unquoted keys
        .replace(/\n/g, '\\n') // escaped newlines in strings
        .replace(/\\n/g, '\n'); // revert — only fix those in values
      return JSON.parse(repaired);
    } catch {
      log.error(`${label} JSON repair also failed`);
      return null;
    }
  }
}

// ═══════════════════════════════════════
// Prompt builders for Phase 2 fuse
// ═══════════════════════════════════════

/**
 * Build prompt for Step A: structured architecture data (architecture-tree + module-graph JSON)
 */
function buildStructurePrompt(
  projectName: string,
  scan: ScanResult,
  probesByType: Map<string, ProbeReport[]>,
  merged: MergedFindings,
): string {
  const findings = merged.findings
    .slice(0, 60)
    .map(f => `- [${f.type}] ${f.id}: ${f.description} (${f.files.slice(0, 3).join(', ')})`)
    .join('\n');

  const probesSummary = Array.from(probesByType.entries())
    .map(
      ([type, reports]) =>
        `${type}: ${reports.length} 个探针, 共 ${reports.reduce((s, r) => s + r.findings.length, 0)} 条发现`,
    )
    .join('\n');

  return `项目: ${projectName}
文件数: ${scan.snapshot.fileCount}, 技术栈: ${scan.snapshot.techStack.join(', ')}
入口文件: ${scan.seedFiles
    .slice(0, 10)
    .map(f => f.file)
    .join(', ')}

探针分析汇总:
${probesSummary}

关键发现 (前60条):
${findings}

请根据以上信息生成两个 JSON 代码块:

1. \`\`\`architecture-tree
一个 ArchTree JSON: { nodes: ArchNode[], edges: ArchEdge[] }
- ArchNode: { id, label, type ("domain"|"module"|"component"|"entry-point"|"api-layer"|"data-layer"|"config"|"utility"|"business-logic"), parentId (null for top-level), description, files: string[], loc, publicAPI: string[] }
- ArchEdge: { source, target, type ("contains"|"depends"|"calls"|"imports"|"dataflow"), label? }
- 层级: domain (顶层分组) → module (功能模块) → component (具体组件/文件)
- 每个 domain 的 parentId = null, module 的 parentId = domain.id, component 的 parentId = module.id
\`\`\`

2. \`\`\`module-graph
一个 ModuleGraph JSON: { nodes: ModuleGraphNode[], edges: ModuleGraphEdge[] }
- ModuleGraphNode: { id, type ("module"|"entry-point"|"api-layer"|"data-layer"|"config"|"utility"), path, responsibility, publicAPI: string[], keyTypes: string[], patterns: string[], issues: string[], fileCount, loc }
- ModuleGraphEdge: { source, target, type ("import"|"dataflow"|"event"|"config"|"ipc"), weight }
\`\`\`

只输出这两个代码块，不要多余解释。`;
}

/**
 * Build prompt for Step B: documentation (ARCHITECTURE.md + KNOWN-ISSUES.md)
 */
function buildDocsPrompt(
  projectName: string,
  scan: ScanResult,
  probesByType: Map<string, ProbeReport[]>,
  merged: MergedFindings,
  archTree: ArchTree,
  moduleGraph: ModuleGraph,
): string {
  const archSummary =
    archTree.nodes.length > 0
      ? `架构树: ${archTree.nodes.filter(n => !n.parentId).length} 个域, ${archTree.nodes.length} 个节点总计`
      : '(未生成架构树)';

  const mgSummary =
    moduleGraph.nodes.length > 0
      ? `模块图: ${moduleGraph.nodes.length} 个模块, ${moduleGraph.edges.length} 条依赖`
      : '(未生成模块图)';

  const topDomains =
    archTree.nodes
      .filter(n => !n.parentId)
      .map(
        n =>
          `- ${n.name}: ${n.responsibility || n.type} (${archTree.nodes.filter(c => c.parentId === n.id).length} 子模块)`,
      )
      .join('\n') || '(无)';

  const issues =
    merged.findings
      .filter(f => f.type === 'anti-pattern' || f.type === 'dependency')
      .slice(0, 30)
      .map(f => `- [${f.type}] ${f.description} (${f.files.slice(0, 2).join(', ')})`)
      .join('\n') || '(无显著问题)';

  const probesSummary = Array.from(probesByType.entries())
    .map(
      ([type, reports]) =>
        `${type}: ${reports.length} 个, ${reports.reduce((s, r) => s + r.findings.length, 0)} 条发现`,
    )
    .join(', ');

  return `项目: ${projectName}
技术栈: ${scan.snapshot.techStack.join(', ')}
${archSummary}
${mgSummary}
顶层架构域:
${topDomains}

探针: ${probesSummary}

已知问题/技术债:
${issues}

请输出两个 Markdown 代码块:

1. \`\`\`architecture-doc
完整的 ARCHITECTURE.md 文档:
- 项目概述 (一段话)
- 架构总览 (层级描述)
- 各模块详述 (每个主要模块的职责、接口、依赖)
- 数据流 (关键数据如何在模块间流转)
- 技术栈说明
\`\`\`

2. \`\`\`known-issues
完整的 KNOWN-ISSUES.md 文档:
- 按严重度分组列出所有已识别问题
- 包含问题描述、影响范围、涉及文件、建议修复方向
\`\`\`

只输出这两个代码块。`;
}

/**
 * Phase 2: 拼图合成 — 拆分为两步 LLM 调用:
 *   Step A: 结构化输出 (architecture-tree + module-graph JSON)
 *   Step B: 文档生成 (ARCHITECTURE.md + known-issues.md)
 */
async function phase2Fuse(
  scan: ScanResult,
  reports: ProbeReport[],
  signal?: AbortSignal,
  onProgress?: (event: ImportProgressEvent) => void,
  onLog?: ImportLogCallback,
): Promise<FuseOutput> {
  const settings = getSettings();
  if (!settings) throw new Error('未配置 LLM 设置');

  const model = settings.strongModel;
  const projectName = path.basename(scan.workspacePath);
  const probesByType = groupProbesByType(reports);
  const merged = mergeFindings(reports, scan.snapshot.fileCount);

  // Stream helper
  const streamLog = (chunk: string) => {
    onLog?.({ agentId: 'probe:fuse', content: chunk, type: 'stream' });
  };

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // ── Step A: 结构化输出 (architecture-tree + module-graph) ──
  onProgress?.({ phase: 'fuse', step: '综合所有探针报告...', progress: 0.05 });
  onLog?.({
    agentId: 'probe:fuse',
    content: `🧩 Phase 2A: 使用 ${model} 生成结构化架构数据 (${reports.length} 个探针)...`,
    type: 'info',
  });

  const structurePrompt = buildStructurePrompt(projectName, scan, probesByType, merged);
  onProgress?.({ phase: 'fuse', step: `调用 ${model} 生成架构结构...`, progress: 0.15 });

  const structResult = await callLLM(
    settings,
    model,
    [
      {
        role: 'system',
        content:
          '你是一位资深软件架构分析师。根据探针分析报告生成结构化的项目架构数据(JSON)。只输出要求的代码块，不要多余解释。全部用中文。',
      },
      { role: 'user', content: structurePrompt },
    ],
    signal,
    8192,
    2,
    streamLog,
  );
  totalInputTokens += structResult.inputTokens || 0;
  totalOutputTokens += structResult.outputTokens || 0;

  if (signal?.aborted) throw new Error('Import aborted');

  // Parse Step A outputs
  onProgress?.({ phase: 'fuse', step: '解析结构化数据...', progress: 0.4 });

  const archTreeMatch = structResult.content.match(/```architecture-tree\n([\s\S]*?)```/);
  const moduleGraphMatch =
    structResult.content.match(/```module-graph\n([\s\S]*?)```/) ||
    structResult.content.match(/```json\n([\s\S]*?"edges"[\s\S]*?)```/);

  let archTree: ArchTree = { nodes: [], edges: [] };
  if (archTreeMatch?.[1]) {
    const parsed = parseJsonRobust<ArchTree>(archTreeMatch[1].trim(), 'architecture-tree');
    if (parsed) archTree = parsed;
    if (!Array.isArray(archTree.nodes)) archTree.nodes = [];
    if (!Array.isArray(archTree.edges)) archTree.edges = [];
    log.info(`Step A: architecture-tree: ${archTree.nodes.length} nodes, ${archTree.edges.length} edges`);
  }

  let moduleGraph: ModuleGraph = { nodes: [], edges: [] };
  if (moduleGraphMatch?.[1]) {
    const parsed = parseJsonRobust<ModuleGraph>(moduleGraphMatch[1].trim(), 'module-graph');
    if (parsed) moduleGraph = parsed;
    if (!Array.isArray(moduleGraph.nodes)) moduleGraph.nodes = [];
    if (!Array.isArray(moduleGraph.edges)) moduleGraph.edges = [];
    log.info(`Step A: module-graph: ${moduleGraph.nodes.length} nodes, ${moduleGraph.edges.length} edges`);
  }

  // Save raw Step A output for debugging
  try {
    const debugPath = path.join(scan.workspacePath, ANALYSIS_DIR, 'fuse-step-a-raw.txt');
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    fs.writeFileSync(debugPath, structResult.content, 'utf-8');
  } catch {
    /* best effort */
  }

  // ── Step B: 文档生成 (ARCHITECTURE.md + known-issues.md) ──
  onProgress?.({ phase: 'fuse', step: `调用 ${model} 生成架构文档...`, progress: 0.5 });
  onLog?.({ agentId: 'probe:fuse', content: `📝 Phase 2B: 使用 ${model} 生成架构文档...`, type: 'info' });

  const docsPrompt = buildDocsPrompt(projectName, scan, probesByType, merged, archTree, moduleGraph);

  const docsResult = await callLLM(
    settings,
    model,
    [
      {
        role: 'system',
        content:
          '你是一位技术文档专家。根据项目分析数据生成清晰准确的架构文档和已知问题文档。只输出要求的代码块。全部用中文。',
      },
      { role: 'user', content: docsPrompt },
    ],
    signal,
    8192,
    2,
    streamLog,
  );
  totalInputTokens += docsResult.inputTokens || 0;
  totalOutputTokens += docsResult.outputTokens || 0;

  if (signal?.aborted) throw new Error('Import aborted');

  // Parse Step B outputs
  onProgress?.({ phase: 'fuse', step: '解析文档输出...', progress: 0.8 });

  const archDocMatch =
    docsResult.content.match(/```architecture\n([\s\S]*?)```/) ||
    docsResult.content.match(/```markdown\n([\s\S]*?)```/);
  const issuesMatch =
    docsResult.content.match(/```known-issues\n([\s\S]*?)```/) ||
    docsResult.content.match(/```known.issues\n([\s\S]*?)```/);

  const architectureMd = archDocMatch?.[1]?.trim() || docsResult.content;
  const knownIssuesMd = issuesMatch?.[1]?.trim() || '';

  // Build enriched skeleton
  const modules = detectModules(scan.workspacePath, scan.allCodeFiles, scan.graph);
  const enrichedSkeleton: ProjectSkeleton = {
    name: projectName,
    techStack: scan.snapshot.techStack,
    packageFiles: scan.snapshot.packageFiles,
    fileCount: scan.snapshot.fileCount,
    totalLOC: scan.snapshot.totalLOC,
    locByExtension: scan.snapshot.locByExtension,
    directoryTree: scan.snapshot.directoryTree,
    graphStats: {
      nodeCount: scan.graph.fileCount,
      edgeCount: scan.graph.edgeCount,
      buildTimeMs: scan.graph.buildTimeMs,
    },
    entryFiles: scan.seedFiles.filter(s => s.reason === 'entry').map(s => s.file),
    modules,
    timestamp: Date.now(),
  };

  // Fallback — derive archTree from moduleGraph if LLM didn't produce architecture-tree
  if (archTree.nodes.length === 0 && moduleGraph.nodes.length > 0) {
    archTree = deriveArchTreeFromModuleGraph(moduleGraph, modules);
    log.info(
      `Derived architecture-tree from module-graph: ${archTree.nodes.length} nodes, ${archTree.edges.length} edges`,
    );
  }

  // Calculate stats
  const stats: ImportStats = {
    totalProbes: reports.length,
    totalFilesRead: new Set(reports.flatMap(r => r.filesExamined)).size,
    totalTokensUsed: reports.reduce((s, r) => s + r.tokensUsed, 0) + totalInputTokens + totalOutputTokens,
    totalCostUsd: 0,
    totalDurationMs: 0, // Set by caller
    coveragePercent: merged.coveragePercent,
  };
  stats.totalCostUsd = (stats.totalTokensUsed / 1_000_000) * 0.5;

  return { moduleGraph, archTree, architectureMd, knownIssuesMd, enrichedSkeleton, stats };
}

/**
 * Group probe reports by type.
 */
function groupProbesByType(reports: ProbeReport[]): Map<string, ProbeReport[]> {
  const groups = new Map<string, ProbeReport[]>();
  for (const report of reports) {
    if (!groups.has(report.type)) groups.set(report.type, []);
    groups.get(report.type)!.push(report);
  }
  return groups;
}

// ═══════════════════════════════════════
// Fallback: Derive ArchTree from flat ModuleGraph
// ═══════════════════════════════════════

/**
 * 当 LLM 未生成 architecture-tree 时，从 module-graph + detectModules 自动推导层级树。
 * 策略: 按 module-graph node.type 分组为 domain, 每个 node 变为 module, 文件按目录拆分为 component。
 */
export function deriveArchTreeFromModuleGraph(mg: ModuleGraph, detectedModules: ModuleInfo[]): ArchTree {
  const TYPE_TO_DOMAIN: Record<string, string> = {
    'entry-point': '入口层',
    'api-layer': 'API 层',
    'data-layer': '数据层',
    config: '配置/基础设施',
    utility: '工具层',
    module: '业务逻辑层',
  };

  const TYPE_TO_ARCH: Record<string, ArchNode['type']> = {
    'entry-point': 'entry-point',
    'api-layer': 'api-layer',
    'data-layer': 'data-layer',
    config: 'config',
    utility: 'utility',
    module: 'business-logic',
  };

  // Group moduleGraph nodes by type → domain
  const domainGroups = new Map<string, typeof mg.nodes>();
  for (const node of mg.nodes) {
    const domainKey = TYPE_TO_DOMAIN[node.type] || '业务逻辑层';
    if (!domainGroups.has(domainKey)) domainGroups.set(domainKey, []);
    domainGroups.get(domainKey)!.push(node);
  }

  const archNodes: ArchNode[] = [];
  const archEdges: ArchEdge[] = [];
  let domainIdx = 0;

  // Map from moduleGraph node.id → archTree module.id (for edge mapping)
  const mgIdToArchId = new Map<string, string>();

  for (const [domainName, mgNodes] of domainGroups) {
    domainIdx++;
    const domainId = `D${String(domainIdx).padStart(2, '0')}`;

    // Domain node
    const domainFiles = mgNodes.flatMap(n => {
      const dm = detectedModules.find(m => m.rootPath === n.path || m.id === n.id);
      return dm?.files || [];
    });
    archNodes.push({
      id: domainId,
      parentId: null,
      level: 'domain',
      name: domainName,
      responsibility: `${domainName}相关的所有模块`,
      type: TYPE_TO_ARCH[mgNodes[0]?.type || 'module'] || 'business-logic',
      files: [...new Set(domainFiles)],
      publicAPI: [],
      keyTypes: [],
      patterns: [],
      issues: [],
      loc: mgNodes.reduce((s, n) => s + (n.loc || 0), 0),
      fileCount: mgNodes.reduce((s, n) => s + (n.fileCount || 0), 0),
    });

    // Module nodes
    for (let mi = 0; mi < mgNodes.length; mi++) {
      const mgNode = mgNodes[mi];
      const moduleId = `${domainId}-M${String(mi + 1).padStart(2, '0')}`;
      mgIdToArchId.set(mgNode.id, moduleId);

      const dm = detectedModules.find(m => m.rootPath === mgNode.path || m.id === mgNode.id);
      const moduleFiles = dm?.files || [];

      archNodes.push({
        id: moduleId,
        parentId: domainId,
        level: 'module',
        name: mgNode.id,
        responsibility: mgNode.responsibility,
        type: TYPE_TO_ARCH[mgNode.type] || 'business-logic',
        files: moduleFiles,
        publicAPI: mgNode.publicAPI || [],
        keyTypes: mgNode.keyTypes || [],
        patterns: mgNode.patterns || [],
        issues: mgNode.issues || [],
        loc: mgNode.loc || 0,
        fileCount: mgNode.fileCount || 0,
      });

      // Component nodes — split module files into sub-groups by immediate subdirectory
      const subDirs = new Map<string, string[]>();
      for (const file of moduleFiles) {
        const parts = file.split('/');
        // Use the first differing path segment as sub-group key
        const baseParts = mgNode.path ? mgNode.path.split('/') : [];
        const subDir = parts.length > baseParts.length + 1 ? parts.slice(0, baseParts.length + 1).join('/') : file;
        if (!subDirs.has(subDir)) subDirs.set(subDir, []);
        subDirs.get(subDir)!.push(file);
      }

      let ci = 0;
      for (const [subDir, files] of subDirs) {
        ci++;
        const compId = `${moduleId}-C${String(ci).padStart(2, '0')}`;
        const compName = subDir.split('/').pop() || subDir;
        archNodes.push({
          id: compId,
          parentId: moduleId,
          level: 'component',
          name: compName,
          responsibility: `${mgNode.responsibility} — ${compName}`,
          type: TYPE_TO_ARCH[mgNode.type] || 'business-logic',
          files,
          publicAPI: [],
          keyTypes: [],
          patterns: [],
          issues: [],
          loc: Math.round(((mgNode.loc || 0) * files.length) / Math.max(moduleFiles.length, 1)),
          fileCount: files.length,
        });
      }
    }
  }

  // Map edges
  for (const edge of mg.edges) {
    const source = mgIdToArchId.get(edge.source);
    const target = mgIdToArchId.get(edge.target);
    if (source && target && source !== target) {
      archEdges.push({
        source,
        target,
        type: edge.type as ArchEdge['type'],
        weight: edge.weight,
      });
    }
  }

  return { nodes: archNodes, edges: archEdges };
}

// ═══════════════════════════════════════
// 主入口: importProject (v7.0 — 三阶段流水线)
// ═══════════════════════════════════════

/**
 * v7.0: 三阶段项目导入
 *
 * Phase 0: 骨架扫描 (~1-2s, 零 LLM)
 * Phase 1: 并行探测 (~30s-3min, fast 模型)
 * Phase 2: 拼图合成 (~10-30s, strong 模型)
 */
export async function importProject(
  workspacePath: string,
  projectId: string,
  signal?: AbortSignal,
  onProgress?: ImportProgressCallback,
  onLog?: ImportLogCallback,
): Promise<{
  skeleton: ProjectSkeleton;
  summaries: ModuleSummary[];
  architectureMd: string;
  docsGenerated: number;
  stats: ImportStats;
}> {
  const t0 = Date.now();
  const _projectName = path.basename(workspacePath);
  log.info(`=== Import Start (v7.0) ===`, { workspacePath, projectId });

  // v7.2: Check if Phase 2 outputs already exist — avoid re-running the entire pipeline
  const existingArchDoc = path.join(workspacePath, '.automater/docs/ARCHITECTURE.md');
  const existingModuleGraph = path.join(workspacePath, MODULE_GRAPH_FILE);
  const existingSkeleton = path.join(workspacePath, SKELETON_FILE);
  if (fs.existsSync(existingArchDoc) && fs.existsSync(existingModuleGraph) && fs.existsSync(existingSkeleton)) {
    log.info('Import artifacts already exist — returning cached results without re-running pipeline');
    onProgress?.(2, '✅ 分析结果已存在，跳过重复分析', 1.0);
    try {
      const skeleton: ProjectSkeleton = JSON.parse(fs.readFileSync(existingSkeleton, 'utf-8'));
      const moduleGraph: ModuleGraph = JSON.parse(fs.readFileSync(existingModuleGraph, 'utf-8'));
      const architectureMd = fs.readFileSync(existingArchDoc, 'utf-8');
      const summaries: ModuleSummary[] = moduleGraph.nodes.map(node => ({
        moduleId: node.id,
        rootPath: node.path,
        responsibility: node.responsibility,
        publicAPI: node.publicAPI,
        keyTypes: node.keyTypes,
        dependencies: '',
        fullText: node.responsibility,
        tokensUsed: 0,
      }));
      // 尝试加载已有 stats
      const statsPath = path.join(workspacePath, ANALYSIS_DIR, 'import-stats.json');
      let cachedStats: ImportStats = {
        totalProbes: 0,
        totalFilesRead: 0,
        totalTokensUsed: 0,
        totalCostUsd: 0,
        totalDurationMs: 0,
        coveragePercent: 0,
      };
      try {
        if (fs.existsSync(statsPath)) cachedStats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
      } catch {
        /* silent: stats parse */
      }
      return { skeleton, summaries, architectureMd, docsGenerated: 2, stats: cachedStats };
    } catch (err) {
      log.warn('Failed to load existing import artifacts, proceeding with fresh import', { error: String(err) });
    }
  }

  // Wrap legacy callback into v7.0 format
  const emitProgress = (event: ImportProgressEvent) => {
    const phaseNum = event.phase === 'scan' ? 0 : event.phase === 'probe' ? 1 : 2;
    onProgress?.(phaseNum, event.step, event.progress);
  };

  // ── Phase 0: Scan ──
  const scan = await phase0Scan(workspacePath, emitProgress);
  if (signal?.aborted) throw new Error('Import aborted');

  // ── Phase 1: Probe ──
  const reports = await phase1Probe(scan, signal, emitProgress, onLog);
  if (signal?.aborted) throw new Error('Import aborted');

  // ── Phase 2: Fuse ──
  const fuse = await phase2Fuse(scan, reports, signal, emitProgress, onLog);
  const totalMs = Date.now() - t0;
  fuse.stats.totalDurationMs = totalMs;

  // ── Write outputs ──
  emitProgress({ phase: 'fuse', step: '正在保存分析结果...', progress: 0.95 });

  const analysisDir = path.join(workspacePath, ANALYSIS_DIR);
  const docsDir = path.join(workspacePath, '.automater/docs');
  fs.mkdirSync(analysisDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });

  // skeleton.json
  fs.writeFileSync(path.join(workspacePath, SKELETON_FILE), JSON.stringify(fuse.enrichedSkeleton, null, 2), 'utf-8');

  // module-graph.json
  fs.writeFileSync(path.join(workspacePath, MODULE_GRAPH_FILE), JSON.stringify(fuse.moduleGraph, null, 2), 'utf-8');

  // v10.0: architecture-tree.json
  fs.writeFileSync(path.join(workspacePath, ARCH_TREE_FILE), JSON.stringify(fuse.archTree, null, 2), 'utf-8');

  // ARCHITECTURE.md
  fs.writeFileSync(path.join(docsDir, 'ARCHITECTURE.md'), fuse.architectureMd, 'utf-8');

  // KNOWN-ISSUES.md
  let docsGenerated = 0;
  if (fuse.knownIssuesMd) {
    fs.writeFileSync(path.join(workspacePath, KNOWN_ISSUES_FILE), fuse.knownIssuesMd, 'utf-8');
    docsGenerated++;
  }
  if (fuse.architectureMd) docsGenerated++;

  // Import stats
  fs.writeFileSync(path.join(analysisDir, 'import-stats.json'), JSON.stringify(fuse.stats, null, 2), 'utf-8');

  // Module summaries (for backward compat with orchestrator)
  const summaries: ModuleSummary[] = fuse.moduleGraph.nodes.map(node => ({
    moduleId: node.id,
    rootPath: node.path,
    responsibility: node.responsibility,
    publicAPI: node.publicAPI,
    keyTypes: node.keyTypes,
    dependencies: '',
    fullText: node.responsibility,
    tokensUsed: 0,
  }));

  log.info(`=== Import Complete (v10.0) ===`, {
    totalMs,
    probes: reports.length,
    findings: reports.reduce((s, r) => s + r.findings.length, 0),
    coverage: `${fuse.stats.coveragePercent}%`,
    tokens: fuse.stats.totalTokensUsed,
    cost: `$${fuse.stats.totalCostUsd.toFixed(4)}`,
    docs: docsGenerated,
    moduleGraphNodes: fuse.moduleGraph.nodes.length,
    moduleGraphEdges: fuse.moduleGraph.edges.length,
    archTreeNodes: fuse.archTree.nodes.length,
    archTreeEdges: fuse.archTree.edges.length,
  });

  const archDomains = fuse.archTree.nodes.filter(n => n.level === 'domain').length;
  const archModules = fuse.archTree.nodes.filter(n => n.level === 'module').length;
  const archComponents = fuse.archTree.nodes.filter(n => n.level === 'component').length;

  emitProgress({
    phase: 'fuse',
    step: `✅ 分析完成! ${scan.snapshot.fileCount} 文件, ${archDomains} 域/${archModules} 模块/${archComponents} 组件, ${fuse.stats.coveragePercent}% 覆盖率, $${fuse.stats.totalCostUsd.toFixed(2)}`,
    progress: 1.0,
    done: true,
    coveragePercent: fuse.stats.coveragePercent,
    costUsd: fuse.stats.totalCostUsd,
  });

  return {
    skeleton: fuse.enrichedSkeleton,
    summaries,
    architectureMd: fuse.architectureMd,
    docsGenerated,
    stats: fuse.stats,
  };
}

// ═══════════════════════════════════════
// Legacy: scanProjectSkeleton (保留给 orchestrator 增量更新用)
// ═══════════════════════════════════════

export async function scanProjectSkeleton(
  workspacePath: string,
  _onProgress?: ImportProgressCallback,
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
    techStack,
    packageFiles,
    fileCount: allFiles.length,
    totalLOC,
    locByExtension: locByExt,
    directoryTree: dirTree,
    graphStats: { nodeCount: graph.fileCount, edgeCount: graph.edgeCount, buildTimeMs: graph.buildTimeMs },
    entryFiles,
    modules,
    timestamp: Date.now(),
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
  _signal?: AbortSignal,
  _onProgress?: ImportProgressCallback,
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
  basePath: string,
  relative: string,
  result: string[],
  locByExt: Record<string, number>,
  fileLOCMap: Map<string, number>,
  maxFiles: number,
): void {
  if (result.length >= maxFiles) return;
  const fullPath = path.join(basePath, relative);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(fullPath, { withFileTypes: true });
  } catch {
    return;
  }
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
        } catch {
          /* skip */
        }
      }
    }
  }
}

function buildDirectoryTree(basePath: string, relative: string, depth: number, maxDepth: number): string {
  if (depth >= maxDepth) return '';
  const fullPath = path.join(basePath, relative);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(fullPath, { withFileTypes: true });
  } catch {
    return '';
  }
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
    'src/index.ts',
    'src/index.tsx',
    'src/main.ts',
    'src/main.tsx',
    'src/App.tsx',
    'src/App.ts',
    'src/app.ts',
    'index.ts',
    'index.js',
    'main.ts',
    'main.js',
    'app.ts',
    'app.js',
    'server.ts',
    'server.js',
    'electron/main.ts',
    'electron/main.js',
    'src/lib/index.ts',
    'lib/index.ts',
    'cmd/main.go',
    'main.go',
    'src/main.rs',
    'main.py',
    'app.py',
    'manage.py',
  ];
  return candidates.filter(c => allFiles.includes(c)).slice(0, 5) || allFiles.slice(0, 3);
}

function detectModules(
  workspacePath: string,
  allFiles: string[],
  graph: CodeGraph,
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
      : files.reduce((s, f) => {
          try {
            return s + fs.readFileSync(path.join(workspacePath, f), 'utf-8').split('\n').length;
          } catch {
            return s;
          }
        }, 0);
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
