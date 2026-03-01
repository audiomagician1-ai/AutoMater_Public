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
  feature: any,
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
  const agentsMd = readWorkspaceFile(workspacePath, '.agentforge/AGENTS.md');
  if (agentsMd) {
    const agentsContent = `## 项目规范 (AGENTS.md)\n${agentsMd}`;
    if (agentsContent.length < charBudget * 0.15) {
      addSection({
        id: 'agents-md', name: 'AGENTS.md 项目指令', source: 'project-config',
        content: agentsContent, truncated: false, files: ['.agentforge/AGENTS.md'],
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
        files: ['.agentforge/project-memory.md', '.agentforge/memories/developer.md'],
      });
    } else if (memContent.length > 100) {
      // 截断
      const maxLen = Math.floor(charBudget * 0.1);
      addSection({
        id: 'memory', name: '3-layer Memory (截断)', source: 'project-config',
        content: memContent.slice(0, maxLen) + '\n... [记忆已截断]', truncated: true,
        files: ['.agentforge/project-memory.md', '.agentforge/memories/developer.md'],
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
 * 从文本中提取有意义的关键词（简单实现）
 */
function extractKeywords(text: string): string[] {
  // 提取英文单词和有意义的中文词
  const words = text.toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3)
    .filter(w => !STOP_WORDS.has(w));
  return [...new Set(words)].slice(0, 10);
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'are',
  'not', 'but', 'all', 'can', 'will', 'one', 'each', 'which', 'their',
  'use', 'using', '实现', '功能', '需要', '支持', '包含', '确保',
]);

// ═══════════════════════════════════════
// v2.0: Hot / Warm / Cold Memory 分层
// ═══════════════════════════════════════
// 对标 Codified Context (arXiv 2602.20478):
//   Hot  → 始终加载 (~3K tokens): skeleton 摘要 + ARCHITECTURE.md 摘要
//   Warm → 始终加载 (~2K tokens): 模块摘要索引 (title + 一句话)
//   Cold → 按需加载 (~5K/模块):   单模块详细摘要 + 源码片段
// ═══════════════════════════════════════

export interface MemoryLayer {
  tier: 'hot' | 'warm' | 'cold';
  content: string;
  tokens: number;
  moduleId?: string;
}

/**
 * 构建 Hot Memory — 始终常驻上下文
 * 包含: 项目骨架摘要 + 架构文档摘要 (取前 ~2000 字符)
 */
export function buildHotMemory(workspacePath: string): MemoryLayer {
  const parts: string[] = [];

  // 1. 从 skeleton.json 读取项目元数据
  const skeletonPath = `${workspacePath}/.agentforge/analysis/skeleton.json`;
  try {
    if (fs.existsSync(skeletonPath)) {
      const skeleton = JSON.parse(fs.readFileSync(skeletonPath, 'utf-8'));
      parts.push([
        `## 项目概况 (Hot Memory)`,
        `名称: ${skeleton.name}`,
        `技术栈: ${(skeleton.techStack || []).join(', ')}`,
        `规模: ${skeleton.fileCount} 文件, ${skeleton.totalLOC} 行代码, ${(skeleton.modules || []).length} 模块`,
        `入口: ${(skeleton.entryFiles || []).slice(0, 3).join(', ')}`,
      ].join('\n'));
    }
  } catch { /* skeleton 不存在，跳过 */ }

  // 2. 架构文档摘要（前 2000 字符）
  const archContent = readWorkspaceFile(workspacePath, '.agentforge/docs/ARCHITECTURE.md')
    || readWorkspaceFile(workspacePath, 'ARCHITECTURE.md');
  if (archContent) {
    const summary = archContent.length > 2000
      ? archContent.slice(0, 2000) + '\n... [架构文档已截断，详细内容可按需加载]'
      : archContent;
    parts.push(`## 架构概要\n${summary}`);
  }

  // 3. AGENTS.md 项目规范
  const agentsMd = readWorkspaceFile(workspacePath, '.agentforge/AGENTS.md');
  if (agentsMd) {
    const maxLen = 1000;
    const trimmed = agentsMd.length > maxLen
      ? agentsMd.slice(0, maxLen) + '\n... [截断]'
      : agentsMd;
    parts.push(`## 项目规范 (AGENTS.md)\n${trimmed}`);
  }

  const content = parts.join('\n\n');
  return {
    tier: 'hot',
    content,
    tokens: estimateTokens(content),
  };
}

/**
 * 构建 Warm Memory — 模块摘要索引（始终加载）
 * 每个模块只保留 ID + 一句话职责
 */
export function buildWarmMemory(workspacePath: string): MemoryLayer {
  const modulesDir = `${workspacePath}/.agentforge/analysis/modules`;
  const parts: string[] = ['## 模块索引 (Warm Memory)'];

  try {
    if (fs.existsSync(modulesDir)) {
      const files = fs.readdirSync(modulesDir).filter(f => f.endsWith('.summary.json'));
      for (const file of files.slice(0, 50)) {
        try {
          const summary = JSON.parse(fs.readFileSync(path.join(modulesDir, file), 'utf-8'));
          parts.push(`- **${summary.moduleId}** (${summary.rootPath}): ${summary.responsibility}`);
        } catch { /* skip corrupt */ }
      }
    }
  } catch { /* no analysis */ }

  if (parts.length <= 1) {
    return { tier: 'warm', content: '', tokens: 0 };
  }

  const content = parts.join('\n');
  return {
    tier: 'warm',
    content,
    tokens: estimateTokens(content),
  };
}

/**
 * 加载 Cold Memory — 指定模块的详细摘要（按需）
 */
export function loadColdMemory(workspacePath: string, moduleId: string): MemoryLayer {
  const cacheFile = `${workspacePath}/.agentforge/analysis/modules/${moduleId}.summary.json`;
  try {
    if (fs.existsSync(cacheFile)) {
      const summary = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      return {
        tier: 'cold',
        moduleId,
        content: summary.fullText || JSON.stringify(summary, null, 2),
        tokens: estimateTokens(summary.fullText || ''),
      };
    }
  } catch { /* */ }
  return { tier: 'cold', moduleId, content: '', tokens: 0 };
}

/**
 * 根据 Feature 的关键词和依赖关系，自动选择需要加载的 Cold Memory 模块
 */
export function selectColdModules(
  workspacePath: string,
  feature: any,
  maxModules: number = 5,
): string[] {
  const keywords = extractKeywords(
    (feature.title || '') + ' ' + (feature.description || ''),
  );

  const modulesDir = `${workspacePath}/.agentforge/analysis/modules`;
  const scores = new Map<string, number>();

  try {
    if (!fs.existsSync(modulesDir)) return [];
    const files = fs.readdirSync(modulesDir).filter(f => f.endsWith('.summary.json'));

    for (const file of files) {
      try {
        const summary = JSON.parse(fs.readFileSync(path.join(modulesDir, file), 'utf-8'));
        let score = 0;

        // 关键词匹配
        const text = `${summary.moduleId} ${summary.rootPath} ${summary.responsibility} ${(summary.publicAPI || []).join(' ')}`.toLowerCase();
        for (const kw of keywords) {
          if (text.includes(kw)) score += 2;
        }

        // 依赖文件匹配
        try {
          const depFiles: string[] = JSON.parse(feature.depends_on || '[]');
          const affectedFiles: string[] = JSON.parse(feature.affected_files || '[]');
          const allRelated = [...depFiles, ...affectedFiles];
          if (allRelated.some(f => f.includes(summary.rootPath))) score += 5;
        } catch { /* */ }

        if (score > 0) scores.set(summary.moduleId, score);
      } catch { /* */ }
    }
  } catch { /* */ }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxModules)
    .map(([id]) => id);
}

/**
 * 构建三层上下文（Hot + Warm + 选中的 Cold 模块）
 * 这是 collectDeveloperContext 的增强版本
 */
export function collectLayeredContext(
  workspacePath: string,
  projectId: string,
  feature: any,
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

// ═══════════════════════════════════════
// v2.0: Compaction — 上下文压缩（ReAct 循环中）
// ═══════════════════════════════════════
// 当 ReAct 循环的对话历史接近上下文窗口限制时，
// 智能压缩历史消息，保留关键信息，释放 token 空间。
// 对标 Anthropic Context Engineering: "summarize → reinitiate"
// ═══════════════════════════════════════

export interface CompactionResult {
  /** 压缩后的消息数组 */
  messages: Array<{ role: string; content: string }>;
  /** 压缩前的 token 数 */
  tokensBefore: number;
  /** 压缩后的 token 数 */
  tokensAfter: number;
  /** 压缩比 */
  ratio: number;
  /** 是否执行了 LLM 调用进行摘要 */
  usedLLM: boolean;
}

/**
 * 检查消息列表是否需要压缩
 */
export function needsCompaction(
  messages: Array<{ role: string; content: string }>,
  tokenBudget: number,
  threshold: number = 0.75,
): boolean {
  const total = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  return total > tokenBudget * threshold;
}

/**
 * 对 ReAct 对话历史进行智能压缩
 *
 * 策略：
 * 1. 保留 system prompt（第一条消息）
 * 2. 保留最近 N 条消息（活跃窗口）
 * 3. 中间的消息用确定性压缩（提取关键信息）
 * 4. 如果提供了 LLM 调用能力，可选用 LLM 生成摘要
 *
 * @param messages 完整消息列表
 * @param tokenBudget 目标 token 上限
 * @param keepRecentCount 保留最近消息数量
 * @param llmSummarize 可选：LLM 摘要回调
 */
export async function compactMessages(
  messages: Array<{ role: string; content: string }>,
  tokenBudget: number,
  keepRecentCount: number = 6,
  llmSummarize?: (text: string) => Promise<string>,
): Promise<CompactionResult> {
  const tokensBefore = messages.reduce((s, m) => s + estimateTokens(m.content), 0);

  // 如果在预算内，不压缩
  if (tokensBefore <= tokenBudget * 0.75) {
    return {
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      ratio: 1.0,
      usedLLM: false,
    };
  }

  // 分区
  const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
  const nonSystem = systemMsg ? messages.slice(1) : messages;
  const recentStart = Math.max(0, nonSystem.length - keepRecentCount);
  const recent = nonSystem.slice(recentStart);
  const middle = nonSystem.slice(0, recentStart);

  if (middle.length === 0) {
    // 没有可压缩的中间部分
    return { messages, tokensBefore, tokensAfter: tokensBefore, ratio: 1.0, usedLLM: false };
  }

  // 确定性压缩中间消息
  let summaryText: string;
  let usedLLM = false;

  const middleText = middle.map(m => {
    const prefix = m.role === 'assistant' ? '[Agent]' : m.role === 'user' ? '[Tool Result]' : `[${m.role}]`;
    // 提取关键行：工具调用、错误、文件操作、关键决策
    const lines = m.content.split('\n');
    const keyLines = lines.filter(l => {
      const t = l.trim();
      return (
        t.startsWith('##') ||          // 标题
        t.includes('Error') ||         // 错误
        t.includes('✅') || t.includes('❌') || // 结果标记
        t.includes('created') || t.includes('modified') || // 文件操作
        t.startsWith('Think:') || t.startsWith('Action:') || // ReAct 步骤
        t.startsWith('write_file') || t.startsWith('read_file') || // 工具调用
        t.match(/^(Step|步骤)\s*\d/) // 步骤标记
      );
    });
    const compressed = keyLines.length > 0
      ? keyLines.slice(0, 10).join('\n')
      : lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n...' : '');
    return `${prefix}: ${compressed}`;
  }).join('\n');

  if (llmSummarize && estimateTokens(middleText) > 2000) {
    // 用 LLM 进一步压缩
    try {
      summaryText = await llmSummarize(
        `请将以下 ReAct 对话历史压缩为关键摘要（保留：已完成的操作、已创建/修改的文件、遇到的错误、关键决策）：\n\n${middleText}`,
      );
      usedLLM = true;
    } catch {
      summaryText = middleText;
    }
  } else {
    summaryText = middleText;
  }

  // 构建压缩后的消息
  const compactedSummaryMsg = {
    role: 'user' as const,
    content: `[Compaction Summary — 以下是之前 ${middle.length} 条消息的压缩摘要]\n\n${summaryText}\n\n[End of compacted history. Continue from here.]`,
  };

  const result: Array<{ role: string; content: string }> = [];
  if (systemMsg) result.push(systemMsg);
  result.push(compactedSummaryMsg);
  result.push(...recent);

  const tokensAfter = result.reduce((s, m) => s + estimateTokens(m.content), 0);

  return {
    messages: result,
    tokensBefore,
    tokensAfter,
    ratio: tokensAfter / tokensBefore,
    usedLLM,
  };
}

/**
 * 对单条工具返回结果进行裁剪
 * 当工具返回大段代码/日志时，智能截取关键部分
 */
export function trimToolResult(content: string, maxTokens: number = 3000): string {
  const charLimit = maxTokens * 1.5;
  if (content.length <= charLimit) return content;

  // 策略：保留头部 + 尾部 + 错误信息
  const lines = content.split('\n');
  const errorLines = lines.filter(l =>
    l.includes('Error') || l.includes('error') || l.includes('FAIL') || l.includes('warning'),
  );

  const headCount = Math.floor(lines.length * 0.3);
  const tailCount = Math.floor(lines.length * 0.15);

  const head = lines.slice(0, Math.min(headCount, 50));
  const tail = lines.slice(-Math.min(tailCount, 20));
  const errors = errorLines.slice(0, 10);

  const parts = [
    ...head,
    '',
    `... [省略 ${lines.length - headCount - tailCount} 行]`,
    '',
  ];

  if (errors.length > 0) {
    parts.push('--- 关键错误/警告 ---');
    parts.push(...errors);
    parts.push('');
  }

  parts.push(...tail);

  const result = parts.join('\n');
  return result.length <= charLimit
    ? result
    : result.slice(0, Math.floor(charLimit)) + '\n... [结果已截断]';
}

// ═══════════════════════════════════════
// v0.8: 分层上下文压缩 (legacy, 保持兼容)
// ═══════════════════════════════════════

/**
 * 对单个文件内容进行压缩摘要
 * 保留：imports、exports、函数签名、类定义、关键注释
 * 裁剪：函数体、冗余注释、空行
 */
export function compressFileContent(content: string, maxLines: number = 30): string {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;

  const important: string[] = [];
  let insideFunc = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // 始终保留: import, export, interface, type, class, function 签名, 关键注释
    if (
      trimmed.startsWith('import ') ||
      trimmed.startsWith('export ') ||
      trimmed.startsWith('interface ') ||
      trimmed.startsWith('type ') ||
      trimmed.startsWith('class ') ||
      trimmed.match(/^(export\s+)?(async\s+)?function\s/) ||
      trimmed.match(/^(export\s+)?const\s+\w+\s*[:=]/) ||
      trimmed.startsWith('/**') ||
      trimmed.startsWith('// ═') ||
      trimmed.startsWith('## ') ||
      trimmed.startsWith('# ')
    ) {
      important.push(line);
    }

    if (important.length >= maxLines) break;
  }

  if (important.length === 0) {
    // fallback: 取前 N 行 + 后 N 行
    const head = lines.slice(0, Math.floor(maxLines / 2));
    const tail = lines.slice(-Math.floor(maxLines / 4));
    return [...head, '// ... [已压缩]', ...tail].join('\n');
  }

  return [...important, `\n// ... [已压缩: ${lines.length} → ${important.length} 行]`].join('\n');
}

/**
 * 为 ReAct 工具循环准备的轻量上下文 (v0.8)
 * 比 collectDeveloperContext 更紧凑: 只给架构摘要 + 文件树 + 计划进度
 * v1.1: 返回结构化 ContextSnapshot
 */
export function collectLightContext(
  workspacePath: string,
  projectId: string,
  feature: any,
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
  const agentsMd = readWorkspaceFile(workspacePath, '.agentforge/AGENTS.md');
  if (agentsMd && totalChars + agentsMd.length < charBudget * 0.2) {
    addSection({
      id: 'agents-md', name: 'AGENTS.md 项目指令', source: 'project-config',
      content: `## 项目规范\n${agentsMd}`, truncated: false, files: ['.agentforge/AGENTS.md'],
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
  const agentsMd = readWorkspaceFile(workspacePath, '.agentforge/AGENTS.md');
  if (agentsMd) {
    const content = `## 项目规范 (AGENTS.md)\n${agentsMd}`;
    addSection({
      id: 'agents-md', name: 'AGENTS.md 项目指令', source: 'project-config',
      content, truncated: false,
      files: ['.agentforge/AGENTS.md'],
    });
  }

  // ─── 4. 3-layer Memory (角色记忆) ───
  try {
    const memory = readMemoryForRole(workspacePath, role);
    if (memory.combined) {
      addSection({
        id: 'memory', name: `角色记忆 (${role})`, source: 'project-config',
        content: `## Agent 记忆\n${memory.combined}`, truncated: false,
        files: ['.agentforge/project-memory.md', `.agentforge/memories/${role}.md`],
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
