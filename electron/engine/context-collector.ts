/**
 * Context Collector — 为 Developer Agent 收集项目上下文
 *
 * 在每个 Feature 开发前，自动收集：
 * 1. ARCHITECTURE.md（架构文档）
 * 2. 已有文件目录树摘要
 * 3. 当前 Feature 依赖的已完成 Feature 产出的文件内容
 * 4. 与当前 Feature 可能相关的文件（按关键词匹配）
 *
 * 控制总上下文大小不超过指定 token 预算（粗略按字符数估算）
 */

import fs from 'fs';
import path from 'path';
import { readDirectoryTree, readWorkspaceFile, type FileNode } from './file-writer';
import { getDb } from '../db';

// 粗略估算 token 数（中英文混合约 1.5 字符/token）
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.5);
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

export interface ContextResult {
  /** 拼接好的上下文文本，可直接放入 LLM prompt */
  contextText: string;
  /** 估算的 token 数 */
  estimatedTokens: number;
  /** 包含的文件数 */
  filesIncluded: number;
}

/**
 * 为某个 Feature 收集开发上下文
 */
export function collectDeveloperContext(
  workspacePath: string,
  projectId: string,
  feature: any,
  tokenBudget: number = 6000
): ContextResult {
  const sections: string[] = [];
  let totalChars = 0;
  let filesIncluded = 0;
  const charBudget = tokenBudget * 1.5; // 粗略转换

  // ─── 1. 架构文档 (最高优先) ───
  const archContent = readWorkspaceFile(workspacePath, 'ARCHITECTURE.md');
  if (archContent) {
    const archSection = `## 项目架构文档\n${archContent}`;
    if (totalChars + archSection.length < charBudget * 0.4) {
      sections.push(archSection);
      totalChars += archSection.length;
      filesIncluded++;
    } else {
      // 截断架构文档
      const maxLen = Math.floor(charBudget * 0.3);
      sections.push(`## 项目架构文档 (已截断)\n${archContent.slice(0, maxLen)}\n... [截断]`);
      totalChars += maxLen;
      filesIncluded++;
    }
  }

  // ─── 2. 文件树摘要 ───
  const tree = readDirectoryTree(workspacePath, '', 4);
  if (tree.length > 0) {
    const treeText = `## 当前文件结构\n\`\`\`\n${formatTreeCompact(tree)}\n\`\`\``;
    if (totalChars + treeText.length < charBudget) {
      sections.push(treeText);
      totalChars += treeText.length;
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

  // 去重
  depFiles = [...new Set(depFiles)];

  // 读取依赖文件内容（在预算内）
  if (depFiles.length > 0) {
    const depSection: string[] = ['## 依赖的已有文件'];
    for (const f of depFiles) {
      if (totalChars >= charBudget * 0.85) break;
      const content = readWorkspaceFile(workspacePath, f);
      if (content) {
        const fileBlock = `### ${f}\n\`\`\`\n${content}\n\`\`\``;
        if (totalChars + fileBlock.length < charBudget * 0.85) {
          depSection.push(fileBlock);
          totalChars += fileBlock.length;
          filesIncluded++;
        } else {
          // 截断大文件
          const remaining = Math.floor(charBudget * 0.85 - totalChars - 50);
          if (remaining > 200) {
            depSection.push(`### ${f} (已截断)\n\`\`\`\n${content.slice(0, remaining)}\n... [截断]\n\`\`\``);
            totalChars += remaining;
            filesIncluded++;
          }
          break;
        }
      }
    }
    if (depSection.length > 1) {
      sections.push(depSection.join('\n'));
    }
  }

  // ─── 4. 关键词相关文件（补充预算） ───
  if (totalChars < charBudget * 0.7 && tree.length > 0) {
    const allFiles = flattenTree(tree).filter(p => !p.endsWith('/'));
    const keywords = extractKeywords(feature.title + ' ' + feature.description);

    // 找关键词匹配的文件（排除已包含的）
    const depSet = new Set(depFiles);
    const relatedFiles = allFiles
      .filter(f => !depSet.has(f) && f !== 'ARCHITECTURE.md')
      .filter(f => keywords.some(kw => f.toLowerCase().includes(kw)))
      .slice(0, 5); // 最多5个

    if (relatedFiles.length > 0) {
      const relSection: string[] = ['## 可能相关的已有文件'];
      for (const f of relatedFiles) {
        if (totalChars >= charBudget * 0.95) break;
        const content = readWorkspaceFile(workspacePath, f);
        if (content) {
          const fileBlock = `### ${f}\n\`\`\`\n${content}\n\`\`\``;
          if (totalChars + fileBlock.length < charBudget * 0.95) {
            relSection.push(fileBlock);
            totalChars += fileBlock.length;
            filesIncluded++;
          }
        }
      }
      if (relSection.length > 1) {
        sections.push(relSection.join('\n'));
      }
    }
  }

  const contextText = sections.join('\n\n');
  return {
    contextText,
    estimatedTokens: estimateTokens(contextText),
    filesIncluded,
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
