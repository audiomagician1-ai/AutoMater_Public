/**
 * Project Importer — 大型已有项目分析 & 文档自动填充
 *
 * 核心思想：分治 + 摘要金字塔 + 增量缓存
 *
 * Phase 0: 零成本静态扫描（无 LLM 调用）
 *   → skeleton.json（项目骨架：目录结构、技术栈、LOC、依赖图统计）
 *
 * Phase 1: 分层模块摘要（worker 模型，按强连通分量分组）
 *   → .agentforge/analysis/modules/<module-id>.summary.md
 *
 * Phase 2: 架构合成（strong 模型，单次调用）
 *   → ARCHITECTURE.md + architecture-diagram.mermaid
 *
 * Phase 3: 文档框架填充（worker 模型，批量）
 *   → 自动填充 design.md / 子需求文档 / 测试规格
 *
 * Phase 4（增量）: 后续代码变更仅更新 diff 涉及的模块摘要
 *
 * 对标：
 *  - Codified Context (arXiv 2602.20478) — Hot/Warm/Cold memory
 *  - Anthropic Context Engineering (2025.09) — 最小化高信号 token
 *  - Aider repo-map + code-graph — 确定性依赖追踪
 *
 * @module project-importer
 */

import fs from 'fs';
import path from 'path';
import { buildCodeGraph, graphSummary, type CodeGraph, type CodeGraphNode } from './code-graph';
import { generateRepoMap } from './repo-map';
import { callLLM, getSettings, type LLMResult } from './llm-client';
import { selectModelTier, resolveModel } from './model-selector';
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
const MAX_FILES_PER_MODULE_BATCH = 15;          // 每次 LLM 调用最多读取的文件数
const MAX_CHARS_PER_BATCH = 15000;               // ~10K tokens
const MAX_MODULES_PER_ARCH_CALL = 60;            // 架构合成时最多放入的模块摘要数
const MODULE_BATCH_SIZE = 4;                      // Phase 3 文档生成批次大小
const MAX_SCAN_FILES = 5000;                      // Phase 0 最大扫描文件数保护

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
// Phase 0: 零成本静态扫描
// ═══════════════════════════════════════

/** 让出主线程（避免 Electron UI 冻结） */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * 扫描项目目录，生成项目骨架（无 LLM 调用）
 * v5.6: async化 + 消除重复IO + 进度回调 + 文件数上限
 */
export async function scanProjectSkeleton(
  workspacePath: string,
  onProgress?: ImportProgressCallback,
): Promise<ProjectSkeleton> {
  const t0 = Date.now();
  log.info('Phase 0: Starting static scan', { workspacePath });
  onProgress?.(0, '检测技术栈...', 0.05);

  // 1. 检测技术栈
  const techStack: string[] = [];
  const packageFiles: string[] = [];
  for (const det of TECH_DETECTORS) {
    const fp = path.join(workspacePath, det.file);
    if (fs.existsSync(fp)) {
      techStack.push(det.tech);
      packageFiles.push(det.file);
    }
  }

  await yieldToEventLoop();
  onProgress?.(0, '扫描文件结构...', 0.1);

  // 2. 收集代码文件 + LOC 统计（一次读取同时收集 LOC）
  const allFiles: string[] = [];
  const locByExt: Record<string, number> = {};
  const fileLOCMap = new Map<string, number>(); // 文件 → 行数（供 detectModules 复用）
  let totalLOC = 0;
  collectCodeFilesRecursive(workspacePath, '', allFiles, locByExt, fileLOCMap, MAX_SCAN_FILES);
  for (const v of Object.values(locByExt)) totalLOC += v;

  if (allFiles.length >= MAX_SCAN_FILES) {
    log.warn('Phase 0: File count hit limit', { limit: MAX_SCAN_FILES, truncated: true });
  }

  await yieldToEventLoop();
  onProgress?.(0, `已扫描 ${allFiles.length} 文件 (${totalLOC} LOC)，构建目录树...`, 0.3);

  // 3. 目录结构概要 (depth ≤ 3)
  const dirTree = buildDirectoryTree(workspacePath, '', 0, 3);

  await yieldToEventLoop();
  onProgress?.(0, '构建代码依赖图...', 0.4);

  // 4. Code Graph
  const graph = buildCodeGraph(workspacePath, 2000);

  await yieldToEventLoop();
  onProgress?.(0, '推断入口文件...', 0.7);

  // 5. 入口文件推断
  const entryFiles = inferEntryFiles(workspacePath, allFiles);

  onProgress?.(0, '检测模块边界...', 0.8);

  // 6. 模块检测（按目录分组 + 依赖关系，复用 fileLOCMap 避免重复 IO）
  const modules = detectModules(workspacePath, allFiles, graph, fileLOCMap);

  await yieldToEventLoop();

  const skeleton: ProjectSkeleton = {
    name: path.basename(workspacePath),
    techStack,
    packageFiles,
    fileCount: allFiles.length,
    totalLOC: totalLOC,
    locByExtension: locByExt,
    directoryTree: dirTree,
    graphStats: {
      nodeCount: graph.fileCount,
      edgeCount: graph.edgeCount,
      buildTimeMs: graph.buildTimeMs,
    },
    entryFiles,
    modules,
    timestamp: Date.now(),
  };

  // 缓存
  const analysisDir = path.join(workspacePath, ANALYSIS_DIR);
  fs.mkdirSync(analysisDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, SKELETON_FILE),
    JSON.stringify(skeleton, null, 2),
    'utf-8',
  );

  onProgress?.(0, `扫描完成: ${allFiles.length} 文件, ${modules.length} 模块, ${totalLOC} LOC`, 1.0);
  log.info('Phase 0: Complete', {
    files: allFiles.length,
    loc: totalLOC,
    modules: modules.length,
    ms: Date.now() - t0,
  });

  return skeleton;
}

// ═══════════════════════════════════════
// Phase 1: 分层模块摘要
// ═══════════════════════════════════════

/**
 * 对每个模块调用 worker 模型生成摘要
 * 按拓扑序处理（叶子模块 → 上层模块），让上层模块可以引用下层摘要
 */
export async function summarizeModules(
  workspacePath: string,
  skeleton: ProjectSkeleton,
  signal?: AbortSignal,
  onProgress?: ImportProgressCallback,
): Promise<ModuleSummary[]> {
  const settings = getSettings();
  if (!settings) throw new Error('No LLM settings configured');

  // v5.4: 项目分析是高价值低频任务,统一用 strongModel 确保兼容性和质量
  const model = settings.strongModel;

  log.info('Phase 1: Starting module summarization', {
    moduleCount: skeleton.modules.length,
    model,
  });

  const modulesDir = path.join(workspacePath, MODULES_DIR);
  fs.mkdirSync(modulesDir, { recursive: true });

  // 拓扑排序（叶子优先 = 反向拓扑）
  const sorted = topologicalSort(skeleton.modules);
  const summaries: ModuleSummary[] = [];
  const summaryMap = new Map<string, ModuleSummary>();

  for (let i = 0; i < sorted.length; i++) {
    if (signal?.aborted) throw new Error('Import aborted');

    const mod = sorted[i];
    onProgress?.(1, `摘要模块: ${mod.rootPath} (${i + 1}/${sorted.length})`, (i + 1) / sorted.length);

    // 检查缓存
    const cacheFile = path.join(modulesDir, `${mod.id}.summary.json`);
    if (fs.existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as ModuleSummary;
        summaries.push(cached);
        summaryMap.set(mod.id, cached);
        log.debug('Phase 1: Cache hit', { moduleId: mod.id });
        continue;
      } catch { /* re-generate */ }
    }

    // 读取模块文件内容（受 token 预算限制）
    const fileContents = readModuleFiles(workspacePath, mod.files, MAX_CHARS_PER_BATCH);

    // 构建 prompt，引用已完成的下层模块摘要
    const depSummaries = mod.dependsOn
      .map(depId => summaryMap.get(depId))
      .filter(Boolean)
      .map(s => `- ${s!.moduleId}: ${s!.responsibility}`)
      .join('\n');

    const prompt = buildModuleSummaryPrompt(mod, fileContents, depSummaries);

    const result = await callLLM(settings, model, [
      { role: 'system', content: 'You are a senior software architect. Analyze the given code module and produce a structured summary. Respond in Chinese.' },
      { role: 'user', content: prompt },
    ], signal, 4096);

    const summary = parseModuleSummary(mod, result);
    summaries.push(summary);
    summaryMap.set(mod.id, summary);

    // 缓存
    fs.writeFileSync(cacheFile, JSON.stringify(summary, null, 2), 'utf-8');
    log.debug('Phase 1: Summarized', { moduleId: mod.id, tokens: summary.tokensUsed });
  }

  log.info('Phase 1: Complete', {
    modules: summaries.length,
    totalTokens: summaries.reduce((s, m) => s + m.tokensUsed, 0),
  });

  return summaries;
}

// ═══════════════════════════════════════
// Phase 2: 架构合成
// ═══════════════════════════════════════

/**
 * 将所有模块摘要合成为系统级架构文档
 * 使用 strong 模型，单次调用
 */
export async function synthesizeArchitecture(
  workspacePath: string,
  skeleton: ProjectSkeleton,
  summaries: ModuleSummary[],
  signal?: AbortSignal,
  onProgress?: ImportProgressCallback,
): Promise<{ architectureMd: string; mermaidDiagram: string }> {
  const settings = getSettings();
  if (!settings) throw new Error('No LLM settings configured');

  const model = resolveModel(
    selectModelTier({ type: 'architecture' }).tier,
    settings,
  );

  onProgress?.(2, '正在合成系统架构文档...', 0.1);
  log.info('Phase 2: Synthesizing architecture', { model, summaryCount: summaries.length });

  // 构建摘要索引（控制 token 总量）
  const summaryIndex = summaries
    .slice(0, MAX_MODULES_PER_ARCH_CALL)
    .map(s => [
      `### 模块: ${s.rootPath}`,
      `职责: ${s.responsibility}`,
      `公开API: ${s.publicAPI.slice(0, 8).join(', ')}`,
      `关键类型: ${s.keyTypes.slice(0, 5).join(', ')}`,
      `依赖: ${s.dependencies}`,
    ].join('\n'))
    .join('\n\n');

  const skeletonBrief = [
    `项目: ${skeleton.name}`,
    `技术栈: ${skeleton.techStack.join(', ')}`,
    `文件数: ${skeleton.fileCount}, 代码行: ${skeleton.totalLOC}`,
    `模块数: ${skeleton.modules.length}`,
    `入口文件: ${skeleton.entryFiles.join(', ')}`,
    '',
    '目录结构:',
    skeleton.directoryTree,
  ].join('\n');

  const prompt = `你是一位资深软件架构师。根据以下项目骨架和各模块摘要，生成两份产出：

## 项目概况
${skeletonBrief}

## 各模块摘要
${summaryIndex}

---

请生成：

### 产出1: ARCHITECTURE.md
完整的系统架构文档，包含：
1. 项目概述（一段话）
2. 技术栈与基础设施
3. 系统架构（分层/模块划分）
4. 核心模块职责与交互
5. 数据流描述
6. 关键设计决策
7. 扩展点和限制

### 产出2: Mermaid 架构图
使用 mermaid graph TD 语法，展示模块间依赖关系。

请用以下格式返回：
\`\`\`architecture
（ARCHITECTURE.md 内容）
\`\`\`

\`\`\`mermaid
（Mermaid 图内容）
\`\`\``;

  const result = await callLLM(settings, model, [
    { role: 'system', content: 'You are a senior software architect. Generate comprehensive architecture documentation in Chinese.' },
    { role: 'user', content: prompt },
  ], signal, 8192);

  // 解析结果
  const archMatch = result.content.match(/```architecture\n([\s\S]*?)```/);
  const mermaidMatch = result.content.match(/```mermaid\n([\s\S]*?)```/);

  const architectureMd = archMatch?.[1]?.trim() || result.content;
  const mermaidDiagram = mermaidMatch?.[1]?.trim() || '';

  // 写入文件
  const docsDir = path.join(workspacePath, '.agentforge/docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'ARCHITECTURE.md'), architectureMd, 'utf-8');
  if (mermaidDiagram) {
    fs.writeFileSync(
      path.join(workspacePath, '.agentforge/analysis/architecture-diagram.mermaid'),
      mermaidDiagram,
      'utf-8',
    );
  }

  onProgress?.(2, '架构文档合成完成', 1.0);
  log.info('Phase 2: Complete', {
    archLength: architectureMd.length,
    hasMermaid: !!mermaidDiagram,
  });

  return { architectureMd, mermaidDiagram };
}

// ═══════════════════════════════════════
// Phase 3: 文档框架填充
// ═══════════════════════════════════════

/**
 * 根据模块摘要和架构文档，自动生成 AgentForge 标准文档框架
 * 填充到 DocsPage 的 5 级文档树中
 */
export async function populateDocuments(
  workspacePath: string,
  projectId: string,
  skeleton: ProjectSkeleton,
  summaries: ModuleSummary[],
  architectureMd: string,
  signal?: AbortSignal,
  onProgress?: ImportProgressCallback,
): Promise<{ docsGenerated: number }> {
  const settings = getSettings();
  if (!settings) throw new Error('No LLM settings configured');

  // v5.4: 统一用 strongModel
  const model = settings.strongModel;

  log.info('Phase 3: Populating documents', { moduleCount: summaries.length, model });

  let docsGenerated = 0;

  // 3a. 总览设计文档 (design.md) — 从架构文档提炼
  onProgress?.(3, '生成总览设计文档...', 0.1);
  const designPrompt = `基于以下系统架构文档，生成一份面向产品经理和开发者的总览设计文档。
要求：项目背景、核心功能模块、用户场景、技术选型理由、系统约束。
用 Markdown 格式。

架构文档:
${architectureMd.slice(0, 8000)}`;

  const designResult = await callLLM(settings, model, [
    { role: 'system', content: '你是一位资深产品架构师，擅长将技术架构翻译为产品设计文档。' },
    { role: 'user', content: designPrompt },
  ], signal, 4096);

  writeDoc(workspacePath, 'design', designResult.content, 'project-importer', '项目导入自动生成总览设计文档', 'design-overview');
  docsGenerated++;

  // 3b. 批量生成功能级文档 (子需求 + 测试规格)
  const batches = chunkArray(summaries, MODULE_BATCH_SIZE);
  for (let bi = 0; bi < batches.length; bi++) {
    if (signal?.aborted) throw new Error('Import aborted');
    const batch = batches[bi];
    const progress = 0.2 + (bi / batches.length) * 0.8;
    onProgress?.(3, `生成功能文档 (${bi + 1}/${batches.length})...`, progress);

    const batchContext = batch.map(s =>
      `## ${s.moduleId} (${s.rootPath})\n${s.responsibility}\nAPI: ${s.publicAPI.slice(0, 5).join(', ')}\n类型: ${s.keyTypes.slice(0, 3).join(', ')}`,
    ).join('\n\n');

    const reqPrompt = `为以下 ${batch.length} 个功能模块各生成一份子需求文档。
每份包含：功能描述、输入/输出、验收标准(3-5条)、依赖说明。
用 Markdown 格式，每个模块用 ## 分隔。

${batchContext}`;

    const reqResult = await callLLM(settings, model, [
      { role: 'system', content: '你是一位需求分析师，擅长从代码模块反推产品需求。用中文回复。' },
      { role: 'user', content: reqPrompt },
    ], signal, 4096);

    // 解析并写入各个子需求文档
    const reqSections = splitByH2(reqResult.content);
    for (let si = 0; si < batch.length && si < reqSections.length; si++) {
      const docId = `REQ-${batch[si].moduleId}`;
      writeDoc(workspacePath, 'requirement', reqSections[si], 'project-importer', `导入模块 ${batch[si].moduleId} 子需求`, docId);
      docsGenerated++;
    }

    // 测试规格
    const testPrompt = `为以下 ${batch.length} 个功能模块各生成一份测试规格文档。
每份包含：测试目标、测试用例列表(5-8条，含输入/预期输出/优先级)、边界条件。
用 Markdown 格式，每个模块用 ## 分隔。

${batchContext}`;

    const testResult = await callLLM(settings, model, [
      { role: 'system', content: '你是一位QA工程师，擅长为功能模块设计测试方案。用中文回复。' },
      { role: 'user', content: testPrompt },
    ], signal, 4096);

    const testSections = splitByH2(testResult.content);
    for (let si = 0; si < batch.length && si < testSections.length; si++) {
      const docId = `TEST-${batch[si].moduleId}`;
      writeDoc(workspacePath, 'test_spec', testSections[si], 'project-importer', `导入模块 ${batch[si].moduleId} 测试规格`, docId);
      docsGenerated++;
    }
  }

  onProgress?.(3, '文档填充完成', 1.0);
  log.info('Phase 3: Complete', { docsGenerated });
  return { docsGenerated };
}

// ═══════════════════════════════════════
// Phase 4: 增量更新（基于 git diff）
// ═══════════════════════════════════════

/**
 * 增量更新：仅重新分析有变更的模块
 * 适用于用户修改代码后刷新分析结果
 */
export async function incrementalUpdate(
  workspacePath: string,
  changedFiles: string[],
  skeleton: ProjectSkeleton,
  signal?: AbortSignal,
  onProgress?: ImportProgressCallback,
): Promise<{ updatedModules: string[] }> {
  log.info('Phase 4: Incremental update', { changedFileCount: changedFiles.length });

  // 找出受影响的模块
  const affectedModuleIds = new Set<string>();
  for (const file of changedFiles) {
    const normalized = file.replace(/\\/g, '/');
    for (const mod of skeleton.modules) {
      if (mod.files.some(f => f === normalized || normalized.startsWith(mod.rootPath + '/'))) {
        affectedModuleIds.add(mod.id);
        // 也更新依赖此模块的上层模块
        for (const depBy of mod.dependedBy) {
          affectedModuleIds.add(depBy);
        }
      }
    }
  }

  if (affectedModuleIds.size === 0) {
    log.info('Phase 4: No modules affected');
    return { updatedModules: [] };
  }

  // 删除受影响模块的摘要缓存
  const modulesDir = path.join(workspacePath, MODULES_DIR);
  for (const id of affectedModuleIds) {
    const cacheFile = path.join(modulesDir, `${id}.summary.json`);
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
  }

  // 重新运行 Phase 1 (会自动跳过有缓存的模块)
  const summaries = await summarizeModules(workspacePath, skeleton, signal, onProgress);

  // 重新合成架构（可选，仅在大量模块变更时才重新合成）
  if (affectedModuleIds.size > skeleton.modules.length * 0.3) {
    await synthesizeArchitecture(workspacePath, skeleton, summaries, signal, onProgress);
  }

  log.info('Phase 4: Complete', { updatedModules: [...affectedModuleIds] });
  return { updatedModules: [...affectedModuleIds] };
}

// ═══════════════════════════════════════
// 主入口: 完整导入流程
// ═══════════════════════════════════════

/**
 * 完整的项目导入流程（Phase 0 → 3）
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
  log.info('=== Project Import Start ===', { workspacePath, projectId });

  // Phase 0: 静态扫描 (async, 带进度回调)
  const skeleton = await scanProjectSkeleton(workspacePath, onProgress);

  // Phase 1: 模块摘要
  const summaries = await summarizeModules(workspacePath, skeleton, signal, onProgress);

  // Phase 2: 架构合成
  const { architectureMd } = await synthesizeArchitecture(
    workspacePath, skeleton, summaries, signal, onProgress,
  );

  // Phase 3: 文档填充
  const { docsGenerated } = await populateDocuments(
    workspacePath, projectId, skeleton, summaries, architectureMd, signal, onProgress,
  );

  log.info('=== Project Import Complete ===', {
    files: skeleton.fileCount,
    modules: skeleton.modules.length,
    docs: docsGenerated,
  });

  return { skeleton, summaries, architectureMd, docsGenerated };
}

// ═══════════════════════════════════════
// Internal Helpers
// ═══════════════════════════════════════

/** 递归收集代码文件并统计 LOC（同时填充 fileLOCMap 供后续复用） */
function collectCodeFilesRecursive(
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
  } catch { return; }

  for (const entry of entries) {
    if (result.length >= maxFiles) return;
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;
    const rel = relative ? `${relative}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        collectCodeFilesRecursive(basePath, rel, result, locByExt, fileLOCMap, maxFiles);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (CODE_EXTS.has(ext)) {
        result.push(rel);
        try {
          const content = fs.readFileSync(path.join(basePath, rel), 'utf-8');
          const lines = content.split('\n').length;
          locByExt[ext] = (locByExt[ext] || 0) + lines;
          fileLOCMap.set(rel, lines);
        } catch { /* skip unreadable */ }
      }
    }
  }
}

/** 构建目录树（限制深度） */
function buildDirectoryTree(basePath: string, relative: string, depth: number, maxDepth: number): string {
  if (depth >= maxDepth) return '';
  const fullPath = path.join(basePath, relative);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(fullPath, { withFileTypes: true });
  } catch { return ''; }

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

  // 仅在最深层列出文件
  if (depth === maxDepth - 1 && files.length > 0) {
    const shown = files.slice(0, 10).map(f => `${indent}  ${f.name}`);
    lines.push(...shown);
    if (files.length > 10) lines.push(`${indent}  ... +${files.length - 10} files`);
  }

  return lines.join('\n');
}

/** 推断入口文件 */
function inferEntryFiles(workspacePath: string, allFiles: string[]): string[] {
  const candidates = [
    'src/index.ts', 'src/index.tsx', 'src/main.ts', 'src/main.tsx',
    'src/App.tsx', 'src/App.ts', 'src/app.ts',
    'index.ts', 'index.js', 'main.ts', 'main.js',
    'app.ts', 'app.js', 'server.ts', 'server.js',
    'electron/main.ts', 'electron/main.js',
    'src/lib/index.ts', 'lib/index.ts',
    'cmd/main.go', 'main.go',
    'src/main.rs', 'main.py', 'app.py', 'manage.py',
  ];
  const found: string[] = [];
  for (const c of candidates) {
    if (allFiles.includes(c)) found.push(c);
  }
  return found.length > 0 ? found : allFiles.slice(0, 3);
}

/** 按目录分组检测模块（复用 fileLOCMap 避免重复 IO） */
function detectModules(
  workspacePath: string,
  allFiles: string[],
  graph: CodeGraph,
  fileLOCMap?: Map<string, number>,
): ModuleInfo[] {
  // 按一级目录 (或二级目录) 分组
  const groups = new Map<string, string[]>();
  for (const file of allFiles) {
    const parts = file.split('/');
    // 使用前两级目录作为模块路径
    let moduleRoot: string;
    if (parts.length >= 3 && (parts[0] === 'src' || parts[0] === 'lib' || parts[0] === 'app' || parts[0] === 'packages')) {
      moduleRoot = `${parts[0]}/${parts[1]}`;
    } else if (parts.length >= 2) {
      moduleRoot = parts[0];
    } else {
      moduleRoot = '.'; // 根目录文件
    }

    if (!groups.has(moduleRoot)) groups.set(moduleRoot, []);
    groups.get(moduleRoot)!.push(file);
  }

  // 过滤太小的分组（< 2 文件）合并到 "misc"
  const misc: string[] = [];
  const validGroups = new Map<string, string[]>();
  for (const [root, files] of groups) {
    if (files.length < 2 || root === '.') {
      misc.push(...files);
    } else {
      validGroups.set(root, files);
    }
  }
  if (misc.length > 0) validGroups.set('misc', misc);

  // 构建模块及其依赖（LOC 复用 fileLOCMap，无需再读文件）
  const modules: ModuleInfo[] = [];
  const moduleByFile = new Map<string, string>(); // file → moduleId

  for (const [root, files] of validGroups) {
    const id = root.replace(/[\/\\]/g, '-');
    for (const f of files) moduleByFile.set(f, id);
    let loc: number;
    if (fileLOCMap) {
      // 复用已收集的 LOC 数据（零 IO）
      loc = files.reduce((sum, f) => sum + (fileLOCMap.get(f) || 0), 0);
    } else {
      // 回退：无缓存时仍读文件（兼容增量更新等场景）
      loc = files.reduce((sum, f) => {
        try {
          return sum + fs.readFileSync(path.join(workspacePath, f), 'utf-8').split('\n').length;
        } catch { return sum; }
      }, 0);
    }
    modules.push({
      id,
      rootPath: root,
      files,
      loc,
      dependsOn: [],
      dependedBy: [],
    });
  }

  // 从 code graph 推断模块间依赖
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

  // 反向依赖
  for (const mod of modules) {
    for (const dep of mod.dependsOn) {
      const target = modules.find(m => m.id === dep);
      if (target && !target.dependedBy.includes(mod.id)) {
        target.dependedBy.push(mod.id);
      }
    }
  }

  return modules;
}

/** 拓扑排序（叶子优先 = 无出边的先处理） */
function topologicalSort(modules: ModuleInfo[]): ModuleInfo[] {
  const visited = new Set<string>();
  const result: ModuleInfo[] = [];
  const modMap = new Map(modules.map(m => [m.id, m]));

  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const mod = modMap.get(id);
    if (!mod) return;
    // 先访问依赖的模块
    for (const dep of mod.dependsOn) {
      visit(dep);
    }
    result.push(mod);
  }

  for (const mod of modules) visit(mod.id);
  return result;
}

/** 读取模块文件内容（控制总字符数） */
function readModuleFiles(
  workspacePath: string,
  files: string[],
  maxChars: number,
): string {
  const sections: string[] = [];
  let totalChars = 0;

  // 按重要性排序：index > main > 其他
  const sorted = [...files].sort((a, b) => {
    const importance = (f: string) => {
      const name = path.basename(f).toLowerCase();
      if (name.startsWith('index')) return 0;
      if (name.startsWith('main')) return 1;
      if (name.includes('types') || name.includes('interface')) return 2;
      return 3;
    };
    return importance(a) - importance(b);
  });

  for (const file of sorted.slice(0, MAX_FILES_PER_MODULE_BATCH)) {
    if (totalChars >= maxChars) {
      sections.push(`\n... [已截断, 剩余 ${sorted.length - sections.length} 文件未读取]`);
      break;
    }
    try {
      let content = fs.readFileSync(path.join(workspacePath, file), 'utf-8');
      const remaining = maxChars - totalChars;
      if (content.length > remaining) {
        content = content.slice(0, remaining) + '\n... [文件已截断]';
      }
      sections.push(`\n### 文件: ${file}\n\`\`\`\n${content}\n\`\`\``);
      totalChars += content.length;
    } catch { /* skip */ }
  }

  return sections.join('\n');
}

/** 构建模块摘要 prompt */
function buildModuleSummaryPrompt(
  mod: ModuleInfo,
  fileContents: string,
  depSummaries: string,
): string {
  return `分析以下代码模块并生成结构化摘要。

## 模块信息
- 路径: ${mod.rootPath}
- 文件数: ${mod.files.length}
- 代码行: ${mod.loc}
- 依赖模块: ${mod.dependsOn.join(', ') || '无'}

${depSummaries ? `## 依赖模块摘要\n${depSummaries}\n` : ''}

## 模块源码
${fileContents}

---

请返回以下格式（严格遵循）：

**职责**: （一句话描述该模块的核心职责）

**公开API**:
- func1(): description
- func2(): description

**关键类型**:
- TypeA: description
- TypeB: description

**依赖关系**: （描述此模块如何与其他模块交互）

**摘要**: （2-3段话的完整模块分析）`;
}

/** 解析模块摘要 LLM 输出 */
function parseModuleSummary(mod: ModuleInfo, result: LLMResult): ModuleSummary {
  const content = result.content;

  const responsibility = content.match(/\*\*职责\*\*[:：]\s*(.+)/)?.[1]?.trim() || '未知';

  const apiMatch = content.match(/\*\*公开API\*\*[:：]?\n([\s\S]*?)(?=\n\*\*关键|$)/);
  const publicAPI = apiMatch?.[1]
    ?.split('\n')
    .filter(l => l.trim().startsWith('-'))
    .map(l => l.trim().replace(/^-\s*/, ''))
    .slice(0, 15) || [];

  const typesMatch = content.match(/\*\*关键类型\*\*[:：]?\n([\s\S]*?)(?=\n\*\*依赖|$)/);
  const keyTypes = typesMatch?.[1]
    ?.split('\n')
    .filter(l => l.trim().startsWith('-'))
    .map(l => l.trim().replace(/^-\s*/, ''))
    .slice(0, 10) || [];

  const depMatch = content.match(/\*\*依赖关系\*\*[:：]\s*([\s\S]*?)(?=\n\*\*摘要|$)/);
  const dependencies = depMatch?.[1]?.trim() || '';

  return {
    moduleId: mod.id,
    rootPath: mod.rootPath,
    responsibility,
    publicAPI,
    keyTypes,
    dependencies,
    fullText: content,
    tokensUsed: result.inputTokens + result.outputTokens,
  };
}

/** 按 ## 标题分割文档 */
function splitByH2(text: string): string[] {
  const sections = text.split(/\n(?=## )/);
  return sections.filter(s => s.trim().length > 0);
}

/** 数组分块 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
