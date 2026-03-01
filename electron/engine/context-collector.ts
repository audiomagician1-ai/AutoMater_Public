/**
 * Context Collector — 为 Developer Agent 收集项目上下文
 *
 * 在每个 Feature 开发前，自动收集：
 * 1. ARCHITECTURE.md（架构文档）
 * 2. 已有文件目录树摘要
 * 3. 当前 Feature 依赖的已完成 Feature 产出的文件内容
 * 4. 与当前 Feature 可能相关的文件（按关键词匹配）
 * 5. 计划进度摘要 (v0.8)
 *
 * 控制总上下文大小不超过指定 token 预算（粗略按字符数估算）
 * v0.8: 新增分层压缩 — 超预算时自动对大文件生成摘要
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
 */
export function collectLightContext(
  workspacePath: string,
  projectId: string,
  feature: any,
  planSummary?: string,
  tokenBudget: number = 3000
): ContextResult {
  const sections: string[] = [];
  let totalChars = 0;
  let filesIncluded = 0;
  const charBudget = tokenBudget * 1.5;

  // 1. 计划进度 (最高优先)
  if (planSummary) {
    sections.push(planSummary);
    totalChars += planSummary.length;
  }

  // 2. 架构文档 (压缩版)
  const archContent = readWorkspaceFile(workspacePath, 'ARCHITECTURE.md');
  if (archContent) {
    const compressed = compressFileContent(archContent, 20);
    const section = `## 项目架构 (压缩)\n${compressed}`;
    if (totalChars + section.length < charBudget * 0.4) {
      sections.push(section);
      totalChars += section.length;
      filesIncluded++;
    }
  }

  // 3. 文件树 (紧凑版)
  const tree = readDirectoryTree(workspacePath, '', 3);
  if (tree.length > 0) {
    const treeText = `## 文件结构\n${formatTreeCompact(tree)}`;
    if (totalChars + treeText.length < charBudget * 0.6) {
      sections.push(treeText);
      totalChars += treeText.length;
    }
  }

  const contextText = sections.join('\n\n');
  return {
    contextText,
    estimatedTokens: estimateTokens(contextText),
    filesIncluded,
  };
}
