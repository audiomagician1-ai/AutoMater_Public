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
export function collectDeveloperContext(
  workspacePath: string,
  projectId: string,
  feature: any,
  tokenBudget: number = 6000,
  agentId?: string
): ContextResult {
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
      const graph = buildCodeGraph(workspacePath, 300);
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
// v0.8: 分层上下文压缩
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
