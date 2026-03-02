/**
 * Context Collector — 为 Developer Agent 收集项目上下文
 *
 * 在每个 Feature 开发前，自动收集：
 * 1. AGENTS.md（项目级 agent 指令）(v1.0)
 * 2. Repository Map（代码结构索引）(v1.0)
 * 3. ARCHITECTURE.md（架构文档）
 * 4. 已有文件目录树摘要
 * 5. 当前 Feature 依赖的已完成 Feature 产出的文件内容
 * 6. 与当前 Feature 可能相关的文件（按关键词匹配）
 *
 * 控制总上下文大小不超过指定 token 预算（粗略按字符数估算）
 * v0.8: 新增分层压缩
 * v1.0: 新增 repo-map + AGENTS.md 集成
 * v1.1: 结构化 ContextSection + ContextSnapshot（可视化上下文管理器）
 */

import fs from 'fs';
import path from 'path';
import { readDirectoryTree, readWorkspaceFile, type FileNode } from './file-writer';
import { getDb } from '../db';
import { generateRepoMap } from './repo-map';
import { readMemoryForRole } from './memory-system';
import { buildCodeGraph, traverseGraph, inferSeedFiles, graphSummary, type CodeGraph } from './code-graph';
import { buildCrossProjectContext } from './cross-project';
import type { FeatureRow } from './types';
import { buildHotMemory, buildWarmMemory, selectColdModules, loadColdMemory, extractKeywords } from './memory-layers';

// Re-export extracted memory-layers for backwards compatibility
export { buildHotMemory, buildWarmMemory, loadColdMemory, selectColdModules, extractKeywords, type MemoryLayer } from './memory-layers';

// Re-export extracted context-compaction for backwards compatibility
import { compressFileContent } from './context-compaction';
export { needsCompaction, compactMessages, trimToolResult, compressFileContent, type CompactionResult } from './context-compaction';

// 粗略估算 token 数（中英文混合约 1.5 字符/token）
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.5);
}

// ═══════════════════════════════════════
// v1.1: 结构化上下文数据类型
// ═══════════════════════════════════════

/** 单个上下文模块 */
export interface ContextSection {
  /** 模块唯一 ID (如 'agents-md', 'architecture', 'file-tree') */
  id: string;
  /** 人类可读名称 */
  name: string;
  /** 来源类型标签 */
  source: 'project-config' | 'architecture' | 'file-tree' | 'repo-map' | 'dependency' | 'keyword-match' | 'code-graph' | 'plan' | 'qa-feedback';
  /** 内容文本 */
  content: string;
  /** 字符数 */
  chars: number;
  /** 估算 token 数 */
  tokens: number;
  /** 是否被截断 */
  truncated: boolean;
  /** 包含的文件路径（如适用） */
  files?: string[];
  /** token 预算占比 (0-1) */
  budgetRatio?: number;
}

/** 完整上下文快照 */
export interface ContextSnapshot {
  /** 关联的 Agent ID */
  agentId: string;
  /** 关联的 Feature ID */
  featureId: string;
  /** 快照时间 */
  timestamp: number;
  /** 各模块 */
  sections: ContextSection[];
  /** 汇总 */
  totalChars: number;
  totalTokens: number;
  tokenBudget: number;
  /** 拼接后的完整文本 */
  contextText: string;
  /** 包含的文件总数 */
  filesIncluded: number;
}

/**
 * 将文件树平铺为路径列表
 */
function flattenTree(nodes: FileNode[], prefix: string = ''): string[] {
  const result: string[] = [];
  for (const n of nodes) {
    const p = prefix ? `${prefix}/${n.name}` : n.name;
    if (n.type === 'file') {
      result.push(p);
    } else if (n.children) {
      result.push(p + '/');
      result.push(...flattenTree(n.children, p));
    }
  }
  return result;
}

/**
 * 格式化文件树为紧凑的文本
 */
function formatTreeCompact(nodes: FileNode[], indent: string = ''): string {
  const lines: string[] = [];
  for (const n of nodes) {
    if (n.type === 'dir') {
      lines.push(`${indent}${n.name}/`);
      if (n.children) {
        lines.push(formatTreeCompact(n.children, indent + '  '));
      }
    } else {
      lines.push(`${indent}${n.name}`);
    }
  }
  return lines.join('\n');
}

// 兼容旧接口
export interface ContextResult {
  /** 拼接好的上下文文本，可直接放入 LLM prompt */
  contextText: string;
  /** 估算的 token 数 */
  estimatedTokens: number;
  /** 包含的文件数 */
  filesIncluded: number;
  /** v1.1: 结构化快照 (可选, 向后兼容) */
  snapshot?: ContextSnapshot;
}

/**
 * 为某个 Feature 收集开发上下文
 * v1.1: 内部使用 ContextSection[] 结构化构建, 同时返回 ContextSnapshot
 */
export async function collectDeveloperContext(
  workspacePath: string,
  projectId: string,
  feature: FeatureRow,
  tokenBudget: number = 6000,
  agentId?: string
): Promise<ContextResult> {
  const sectionList: ContextSection[] = [];
  let totalChars = 0;
  let filesIncluded = 0;
  const charBudget = tokenBudget * 1.5; // 粗略转换

  /** 辅助: 添加一个 section */
  function addSection(sec: Omit<ContextSection, 'chars' | 'tokens'>) {
    const chars = sec.content.length;
    const tokens = estimateTokens(sec.content);
    sectionList.push({ ...sec, chars, tokens });
    totalChars += chars;
    filesIncluded += sec.files?.length ?? 0;
  }

  // ─── 0. AGENTS.md 项目指令 (v1.0, 最高优先) ───
  const agentsMd = readWorkspaceFile(workspacePath, '.automater/AGENTS.md');
  if (agentsMd) {
    const agentsContent = `## 项目规范 (AGENTS.md)\n${agentsMd}`;
    if (agentsContent.length < charBudget * 0.15) {
      addSection({
        id: 'agents-md', name: 'AGENTS.md 项目指令', source: 'project-config',
        content: agentsContent, truncated: false, files: ['.automater/AGENTS.md'],
      });
    }
  }

  // ─── 0.5. 3-layer Memory (v1.2) ───
  const memory = readMemoryForRole(workspacePath, 'developer');
  if (memory.combined) {
    const memContent = `## Agent 记忆\n${memory.combined}`;
    if (memContent.length < charBudget * 0.12) {
      addSection({
        id: 'memory', name: '3-layer Memory (全局+项目+角色)', source: 'project-config',
        content: memContent, truncated: false,
        files: ['.automater/project-memory.md', '.automater/memories/developer.md'],
      });
    } else if (memContent.length > 100) {
      // 截断
      const maxLen = Math.floor(charBudget * 0.1);
      addSection({
        id: 'memory', name: '3-layer Memory (截断)', source: 'project-config',
        content: memContent.slice(0, maxLen) + '\n... [记忆已截断]', truncated: true,
        files: ['.automater/project-memory.md', '.automater/memories/developer.md'],
      });
    }
  }

  // ─── 1. 架构文档 (最高优先) ───
  const archContent = readWorkspaceFile(workspacePath, 'ARCHITECTURE.md');
  if (archContent) {
    const archFull = `## 项目架构文档\n${archContent}`;
    if (totalChars + archFull.length < charBudget * 0.4) {
      addSection({
        id: 'architecture', name: '架构文档 ARCHITECTURE.md', source: 'architecture',
        content: archFull, truncated: false, files: ['ARCHITECTURE.md'],
      });
    } else {
      const maxLen = Math.floor(charBudget * 0.3);
      addSection({
        id: 'architecture', name: '架构文档 ARCHITECTURE.md (截断)', source: 'architecture',
        content: `## 项目架构文档 (已截断)\n${archContent.slice(0, maxLen)}\n... [截断]`,
        truncated: true, files: ['ARCHITECTURE.md'],
      });
    }
  }

  // ─── 2. 文件树摘要 ───
  const tree = readDirectoryTree(workspacePath, '', 4);
  if (tree.length > 0) {
    const treeText = `## 当前文件结构\n\`\`\`\n${formatTreeCompact(tree)}\n\`\`\``;
    if (totalChars + treeText.length < charBudget) {
      addSection({
        id: 'file-tree', name: '文件目录树', source: 'file-tree',
        content: treeText, truncated: false,
      });
    }
  }

  // ─── 2.5. Repository Map — 代码结构索引 (v1.0) ───
  if (totalChars < charBudget * 0.5) {
    const repoMap = generateRepoMap(workspacePath, 60, 15, 120);
    if (repoMap) {
      if (totalChars + repoMap.length < charBudget * 0.55) {
        addSection({
          id: 'repo-map', name: 'Repository Map (代码符号索引)', source: 'repo-map',
          content: repoMap, truncated: false,
        });
      } else {
        const maxLen = Math.floor(charBudget * 0.15);
        addSection({
          id: 'repo-map', name: 'Repository Map (截断)', source: 'repo-map',
          content: repoMap.slice(0, maxLen) + '\n... [repo-map 已截断]', truncated: true,
        });
      }
    }
  }

  // ─── 3. 依赖 Feature 的产出文件 ───
  let depFiles: string[] = [];
  try {
    const deps: string[] = JSON.parse(feature.depends_on || '[]');
    if (deps.length > 0) {
      const db = getDb();
      for (const depId of deps) {
        const depFeature = db.prepare(
          "SELECT affected_files FROM features WHERE id = ? AND project_id = ? AND status = 'passed'"
        ).get(depId, projectId) as { affected_files: string } | undefined;
        if (depFeature) {
          try {
            depFiles.push(...JSON.parse(depFeature.affected_files || '[]'));
          } catch { /* */ }
        }
      }
    }
  } catch { /* */ }

  depFiles = [...new Set(depFiles)];

  if (depFiles.length > 0) {
    const depContentParts: string[] = ['## 依赖的已有文件'];
    const depFileList: string[] = [];
    let depTruncated = false;
    for (const f of depFiles) {
      if (totalChars >= charBudget * 0.85) { depTruncated = true; break; }
      const content = readWorkspaceFile(workspacePath, f);
      if (content) {
        const fileBlock = `### ${f}\n\`\`\`\n${content}\n\`\`\``;
        if (totalChars + fileBlock.length < charBudget * 0.85) {
          depContentParts.push(fileBlock);
          totalChars += fileBlock.length;
          depFileList.push(f);
        } else {
          const remaining = Math.floor(charBudget * 0.85 - totalChars - 50);
          if (remaining > 200) {
            depContentParts.push(`### ${f} (已截断)\n\`\`\`\n${content.slice(0, remaining)}\n... [截断]\n\`\`\``);
            totalChars += remaining;
            depFileList.push(f);
            depTruncated = true;
          }
          break;
        }
      }
    }
    if (depContentParts.length > 1) {
      // totalChars already updated inline; add section without double-counting
      const depText = depContentParts.join('\n');
      sectionList.push({
        id: 'dep-files', name: '依赖 Feature 产出文件', source: 'dependency',
        content: depText, chars: depText.length, tokens: estimateTokens(depText),
        truncated: depTruncated, files: depFileList,
      });
      filesIncluded += depFileList.length;
    }
  }

  // ─── 4. Code Graph 相关文件 (v1.3: 替代关键词匹配) ───
  if (totalChars < charBudget * 0.7 && tree.length > 0) {
    const depSet = new Set(depFiles);
    let graphRelatedFiles: string[] = [];

    try {
      // 构建 Code Graph 并用 multi-hop 遍历查找相关文件
      const graph = await buildCodeGraph(workspacePath, 300);
      const keywords = extractKeywords(feature.title + ' ' + feature.description);
      const seeds = inferSeedFiles(graph, depFiles, keywords, 5);

      if (seeds.length > 0) {
        const traversed = traverseGraph(graph, seeds, 2, 10);
        graphRelatedFiles = traversed
          .map(t => t.file)
          .filter(f => !depSet.has(f) && f !== 'ARCHITECTURE.md');
      }
    } catch {
      // Code Graph 失败时 fallback 到关键词匹配
    }

    // Fallback: 如果 Code Graph 没找到结果，用旧的关键词匹配
    if (graphRelatedFiles.length === 0) {
      const allFiles = flattenTree(tree).filter(p => !p.endsWith('/'));
      const keywords = extractKeywords(feature.title + ' ' + feature.description);
      graphRelatedFiles = allFiles
        .filter(f => !depSet.has(f) && f !== 'ARCHITECTURE.md')
        .filter(f => keywords.some(kw => f.toLowerCase().includes(kw)))
        .slice(0, 5);
    }

    if (graphRelatedFiles.length > 0) {
      const relContentParts: string[] = ['## 代码依赖图相关文件'];
      const relFileList: string[] = [];
      for (const f of graphRelatedFiles.slice(0, 8)) {
        if (totalChars >= charBudget * 0.95) break;
        const content = readWorkspaceFile(workspacePath, f);
        if (content) {
          const fileBlock = `### ${f}\n\`\`\`\n${content}\n\`\`\``;
          if (totalChars + fileBlock.length < charBudget * 0.95) {
            relContentParts.push(fileBlock);
            totalChars += fileBlock.length;
            relFileList.push(f);
          }
        }
      }
      if (relContentParts.length > 1) {
        const relText = relContentParts.join('\n');
        sectionList.push({
          id: 'code-graph-files', name: 'Code Graph 关联文件', source: 'dependency',
          content: relText, chars: relText.length, tokens: estimateTokens(relText),
          truncated: false, files: relFileList,
        });
        filesIncluded += relFileList.length;
      }
    }
  }

  // ─── 5. 跨项目经验 (v2.0) ───
  if (totalChars < charBudget * 0.9) {
    try {
      const archForCross = readWorkspaceFile(workspacePath, 'ARCHITECTURE.md') || '';
      const wish = feature.description || '';
      const remainingBudget = Math.max(500, Math.floor((charBudget - totalChars) / 1.5));
      const crossCtx = buildCrossProjectContext(wish, archForCross, remainingBudget);
      if (crossCtx) {
        addSection({
          id: 'cross-project', name: '跨项目经验', source: 'project-config',
          content: crossCtx, truncated: false,
        });
      }
    } catch { /* non-fatal */ }
  }

  // 构建完整上下文文本
  const contextText = sectionList.map(s => s.content).join('\n\n');
  const totalTokens = estimateTokens(contextText);

  // 计算每个 section 的预算占比
  for (const sec of sectionList) {
    sec.budgetRatio = totalTokens > 0 ? sec.tokens / tokenBudget : 0;
  }

  const snapshot: ContextSnapshot = {
    agentId: agentId || 'unknown',
    featureId: feature.id || 'unknown',
    timestamp: Date.now(),
    sections: sectionList,
    totalChars,
    totalTokens,
    tokenBudget,
    contextText,
    filesIncluded,
  };

  return {
    contextText,
    estimatedTokens: totalTokens,
    filesIncluded,
    snapshot,
  };
}

/**
 * 构建三层上下文（Hot + Warm + 选中的 Cold 模块）
 * 这是 collectDeveloperContext 的增强版本
 */
export function collectLayeredContext(
  workspacePath: string,
  projectId: string,
  feature: FeatureRow,
  tokenBudget: number = 6000,
  agentId?: string,
): ContextResult {
  const sectionList: ContextSection[] = [];
  let totalChars = 0;
  let filesIncluded = 0;
  const charBudget = tokenBudget * 1.5;

  function addSection(sec: Omit<ContextSection, 'chars' | 'tokens'>) {
    const chars = sec.content.length;
    const tokens = estimateTokens(sec.content);
    sectionList.push({ ...sec, chars, tokens });
    totalChars += chars;
    filesIncluded += sec.files?.length ?? 0;
  }

  // ─── Hot Memory (始终加载, ≤15% 预算) ───
  const hot = buildHotMemory(workspacePath);
  if (hot.content && hot.content.length < charBudget * 0.2) {
    addSection({
      id: 'hot-memory', name: 'Hot Memory (项目概况+架构)', source: 'architecture',
      content: hot.content, truncated: false,
    });
  }

  // ─── Warm Memory (模块索引, ≤10% 预算) ───
  const warm = buildWarmMemory(workspacePath);
  if (warm.content && totalChars + warm.content.length < charBudget * 0.3) {
    addSection({
      id: 'warm-memory', name: 'Warm Memory (模块索引)', source: 'repo-map',
      content: warm.content, truncated: false,
    });
  }

  // ─── Cold Memory (按需加载, ≤20% 预算) ───
  const coldModuleIds = selectColdModules(workspacePath, feature, 5);
  if (coldModuleIds.length > 0) {
    const coldParts: string[] = ['## 相关模块详情 (Cold Memory)'];
    for (const modId of coldModuleIds) {
      if (totalChars >= charBudget * 0.5) break;
      const cold = loadColdMemory(workspacePath, modId);
      if (cold.content) {
        const maxModChars = Math.floor((charBudget * 0.5 - totalChars) / Math.max(1, coldModuleIds.length));
        const trimmed = cold.content.length > maxModChars
          ? cold.content.slice(0, maxModChars) + '\n... [模块摘要已截断]'
          : cold.content;
        coldParts.push(`### ${modId}\n${trimmed}`);
        totalChars += trimmed.length;
      }
    }
    if (coldParts.length > 1) {
      const coldText = coldParts.join('\n\n');
      sectionList.push({
        id: 'cold-memory', name: 'Cold Memory (相关模块详情)', source: 'dependency',
        content: coldText, chars: coldText.length, tokens: estimateTokens(coldText),
        truncated: false,
      });
    }
  }

  // ─── 传统上下文补充（Repo Map、Code Graph 等）───
  // 仅在分层记忆不足时补充
  if (totalChars < charBudget * 0.5) {
    // Repo Map
    const repoMap = generateRepoMap(workspacePath, 40, 10, 80);
    if (repoMap && totalChars + repoMap.length < charBudget * 0.6) {
      addSection({
        id: 'repo-map', name: 'Repository Map', source: 'repo-map',
        content: repoMap, truncated: false,
      });
    }
  }

  // ─── 依赖 Feature 产出文件 ───
  if (totalChars < charBudget * 0.75) {
    let depFiles: string[] = [];
    try {
      const deps: string[] = JSON.parse(feature.depends_on || '[]');
      if (deps.length > 0) {
        const db = getDb();
        for (const depId of deps) {
          const depFeature = db.prepare(
            "SELECT affected_files FROM features WHERE id = ? AND project_id = ? AND status = 'passed'",
          ).get(depId, projectId) as { affected_files: string } | undefined;
          if (depFeature) {
            try { depFiles.push(...JSON.parse(depFeature.affected_files || '[]')); } catch { /**/ }
          }
        }
      }
    } catch { /**/ }

    depFiles = [...new Set(depFiles)];
    if (depFiles.length > 0) {
      const depParts: string[] = ['## 依赖文件'];
      const depFileList: string[] = [];
      for (const f of depFiles.slice(0, 6)) {
        if (totalChars >= charBudget * 0.9) break;
        const content = readWorkspaceFile(workspacePath, f);
        if (content) {
          const maxLen = Math.floor((charBudget * 0.9 - totalChars) / Math.max(1, depFiles.length));
          const trimmed = content.length > maxLen
            ? content.slice(0, maxLen) + '\n... [截断]'
            : content;
          depParts.push(`### ${f}\n\`\`\`\n${trimmed}\n\`\`\``);
          totalChars += trimmed.length;
          depFileList.push(f);
        }
      }
      if (depParts.length > 1) {
        const depText = depParts.join('\n');
        sectionList.push({
          id: 'dep-files', name: '依赖 Feature 产出文件', source: 'dependency',
          content: depText, chars: depText.length, tokens: estimateTokens(depText),
          truncated: false, files: depFileList,
        });
        filesIncluded += depFileList.length;
      }
    }
  }

  // 构建快照
  const contextText = sectionList.map(s => s.content).join('\n\n');
  const totalTokens = estimateTokens(contextText);
  for (const sec of sectionList) {
    sec.budgetRatio = totalTokens > 0 ? sec.tokens / tokenBudget : 0;
  }

  const snapshot: ContextSnapshot = {
    agentId: agentId || 'unknown',
    featureId: feature.id || 'unknown',
    timestamp: Date.now(),
    sections: sectionList,
    totalChars,
    totalTokens,
    tokenBudget,
    contextText,
    filesIncluded,
  };

  return { contextText, estimatedTokens: totalTokens, filesIncluded, snapshot };
}

export function collectLightContext(
  workspacePath: string,
  projectId: string,
  feature: FeatureRow,
  planSummary?: string,
  tokenBudget: number = 3000,
  agentId?: string
): ContextResult {
  const sectionList: ContextSection[] = [];
  let totalChars = 0;
  let filesIncluded = 0;
  const charBudget = tokenBudget * 1.5;

  function addSection(sec: Omit<ContextSection, 'chars' | 'tokens'>) {
    const chars = sec.content.length;
    const tokens = estimateTokens(sec.content);
    sectionList.push({ ...sec, chars, tokens });
    totalChars += chars;
    filesIncluded += sec.files?.length ?? 0;
  }

  // 1. 计划进度 (最高优先)
  if (planSummary) {
    addSection({
      id: 'plan-summary', name: '开发计划', source: 'plan',
      content: planSummary, truncated: false,
    });
  }

  // 1.5. AGENTS.md (v1.0)
  const agentsMd = readWorkspaceFile(workspacePath, '.automater/AGENTS.md');
  if (agentsMd && totalChars + agentsMd.length < charBudget * 0.2) {
    addSection({
      id: 'agents-md', name: 'AGENTS.md 项目指令', source: 'project-config',
      content: `## 项目规范\n${agentsMd}`, truncated: false, files: ['.automater/AGENTS.md'],
    });
  }

  // 2. 架构文档 (压缩版)
  const archContent = readWorkspaceFile(workspacePath, 'ARCHITECTURE.md');
  if (archContent) {
    const compressed = compressFileContent(archContent, 20);
    const section = `## 项目架构 (压缩)\n${compressed}`;
    if (totalChars + section.length < charBudget * 0.4) {
      addSection({
        id: 'architecture', name: '架构文档 (压缩)', source: 'architecture',
        content: section, truncated: true, files: ['ARCHITECTURE.md'],
      });
    }
  }

  // 3. 文件树 (紧凑版)
  const tree = readDirectoryTree(workspacePath, '', 3);
  if (tree.length > 0) {
    const treeText = `## 文件结构\n${formatTreeCompact(tree)}`;
    if (totalChars + treeText.length < charBudget * 0.6) {
      addSection({
        id: 'file-tree', name: '文件目录树', source: 'file-tree',
        content: treeText, truncated: false,
      });
    }
  }

  const contextText = sectionList.map(s => s.content).join('\n\n');
  const totalTokens = estimateTokens(contextText);

  for (const sec of sectionList) {
    sec.budgetRatio = totalTokens > 0 ? sec.tokens / tokenBudget : 0;
  }

  const snapshot: ContextSnapshot = {
    agentId: agentId || 'unknown',
    featureId: feature.id || 'unknown',
    timestamp: Date.now(),
    sections: sectionList,
    totalChars,
    totalTokens,
    tokenBudget,
    contextText,
    filesIncluded,
  };

  return {
    contextText,
    estimatedTokens: totalTokens,
    filesIncluded,
    snapshot,
  };
}

// ═══════════════════════════════════════
// v5.6: Baseline Context Preview — 无任务时的基线上下文预览
// ═══════════════════════════════════════

/**
 * 为指定角色生成基线上下文预览（无需 Feature）
 *
 * 展示该角色在开始任何任务前就已固定加载的上下文模块：
 * - Hot Memory (项目概况 + 架构摘要)
 * - Warm Memory (模块索引)
 * - AGENTS.md 项目规范
 * - 文件目录树
 * - Repository Map
 * - 3-layer Memory (角色记忆)
 *
 * 用途：让用户提前看到每个 agent 的基线 token 占用和剩余空间
 */
export function collectBaselineContext(
  workspacePath: string,
  role: string,
  tokenBudget: number = 128000,
  agentId?: string,
): ContextSnapshot {
  const sectionList: ContextSection[] = [];
  let totalChars = 0;
  let filesIncluded = 0;

  function addSection(sec: Omit<ContextSection, 'chars' | 'tokens'>) {
    const chars = sec.content.length;
    const tokens = estimateTokens(sec.content);
    sectionList.push({ ...sec, chars, tokens });
    totalChars += chars;
    filesIncluded += sec.files?.length ?? 0;
  }

  // ─── 1. Hot Memory (项目概况 + 架构摘要) ───
  const hot = buildHotMemory(workspacePath);
  if (hot.content) {
    addSection({
      id: 'hot-memory', name: 'Hot Memory (项目概况+架构)', source: 'architecture',
      content: hot.content, truncated: false,
    });
  }

  // ─── 2. Warm Memory (模块索引) ───
  const warm = buildWarmMemory(workspacePath);
  if (warm.content) {
    addSection({
      id: 'warm-memory', name: 'Warm Memory (模块索引)', source: 'repo-map',
      content: warm.content, truncated: false,
    });
  }

  // ─── 3. AGENTS.md 项目规范 ───
  const agentsMd = readWorkspaceFile(workspacePath, '.automater/AGENTS.md');
  if (agentsMd) {
    const content = `## 项目规范 (AGENTS.md)\n${agentsMd}`;
    addSection({
      id: 'agents-md', name: 'AGENTS.md 项目指令', source: 'project-config',
      content, truncated: false,
      files: ['.automater/AGENTS.md'],
    });
  }

  // ─── 4. 3-layer Memory (角色记忆) ───
  try {
    const memory = readMemoryForRole(workspacePath, role);
    if (memory.combined) {
      addSection({
        id: 'memory', name: `角色记忆 (${role})`, source: 'project-config',
        content: `## Agent 记忆\n${memory.combined}`, truncated: false,
        files: ['.automater/project-memory.md', `.automater/memories/${role}.md`],
      });
    }
  } catch { /* 非致命 */ }

  // ─── 5. 文件目录树 ───
  try {
    const tree = readDirectoryTree(workspacePath, '', 3);
    if (tree.length > 0) {
      const treeText = `## 文件结构\n\`\`\`\n${formatTreeCompact(tree)}\n\`\`\``;
      addSection({
        id: 'file-tree', name: '文件目录树', source: 'file-tree',
        content: treeText, truncated: false,
      });
    }
  } catch { /* 非致命 */ }

  // ─── 6. Repository Map ───
  try {
    const repoMap = generateRepoMap(workspacePath, 40, 10, 80);
    if (repoMap) {
      addSection({
        id: 'repo-map', name: 'Repository Map (代码符号索引)', source: 'repo-map',
        content: repoMap, truncated: false,
      });
    }
  } catch { /* 非致命 */ }

  // 构建快照
  const contextText = sectionList.map(s => s.content).join('\n\n');
  const totalTokens = estimateTokens(contextText);
  for (const sec of sectionList) {
    sec.budgetRatio = totalTokens > 0 ? sec.tokens / tokenBudget : 0;
  }

  return {
    agentId: agentId || `baseline-${role}`,
    featureId: 'baseline-preview',
    timestamp: Date.now(),
    sections: sectionList,
    totalChars,
    totalTokens,
    tokenBudget,
    contextText,
    filesIncluded,
  };
}
