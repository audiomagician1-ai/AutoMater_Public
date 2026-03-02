/**
 * Memory Layers — Hot / Warm / Cold 分层上下文
 *
 * 对标 Codified Context (arXiv 2602.20478):
 *   Hot  → 始终加载 (~3K tokens): skeleton 摘要 + ARCHITECTURE.md 摘要
 *   Warm → 始终加载 (~2K tokens): 模块摘要索引 (title + 一句话)
 *   Cold → 按需加载 (~5K/模块):   单模块详细摘要 + 源码片段
 *
 * 从 context-collector.ts 拆分 (v12.3)
 */

import fs from 'fs';
import path from 'path';
import { readWorkspaceFile } from './file-writer';
import type { FeatureRow } from './types';

// 粗略估算 token 数（中英文混合约 1.5 字符/token）
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.5);
}

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface MemoryLayer {
  tier: 'hot' | 'warm' | 'cold';
  content: string;
  tokens: number;
  moduleId?: string;
}

// ═══════════════════════════════════════
// Hot Memory — 始终常驻上下文
// ═══════════════════════════════════════

/**
 * 构建 Hot Memory — 始终常驻上下文
 * 包含: 项目骨架摘要 + 架构文档摘要 (取前 ~2000 字符)
 */
export function buildHotMemory(workspacePath: string): MemoryLayer {
  const parts: string[] = [];

  // 1. 从 skeleton.json 读取项目元数据
  const skeletonPath = `${workspacePath}/.automater/analysis/skeleton.json`;
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
  const archContent = readWorkspaceFile(workspacePath, '.automater/docs/ARCHITECTURE.md')
    || readWorkspaceFile(workspacePath, 'ARCHITECTURE.md');
  if (archContent) {
    const summary = archContent.length > 2000
      ? archContent.slice(0, 2000) + '\n... [架构文档已截断，详细内容可按需加载]'
      : archContent;
    parts.push(`## 架构概要\n${summary}`);
  }

  // 3. AGENTS.md 项目规范
  const agentsMd = readWorkspaceFile(workspacePath, '.automater/AGENTS.md');
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

// ═══════════════════════════════════════
// Warm Memory — 模块摘要索引
// ═══════════════════════════════════════

/**
 * 构建 Warm Memory — 模块摘要索引（始终加载）
 * 每个模块只保留 ID + 一句话职责
 */
export function buildWarmMemory(workspacePath: string): MemoryLayer {
  const modulesDir = `${workspacePath}/.automater/analysis/modules`;
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

// ═══════════════════════════════════════
// Cold Memory — 按需加载
// ═══════════════════════════════════════

/**
 * 加载 Cold Memory — 指定模块的详细摘要（按需）
 */
export function loadColdMemory(workspacePath: string, moduleId: string): MemoryLayer {
  const cacheFile = `${workspacePath}/.automater/analysis/modules/${moduleId}.summary.json`;
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
  feature: FeatureRow,
  maxModules: number = 5,
): string[] {
  const keywords = extractKeywords(
    (feature.title || '') + ' ' + (feature.description || ''),
  );

  const modulesDir = `${workspacePath}/.automater/analysis/modules`;
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

// ═══════════════════════════════════════
// Helper: keyword extraction
// ═══════════════════════════════════════

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'are',
  'not', 'but', 'all', 'can', 'will', 'one', 'each', 'which', 'their',
  'use', 'using', '实现', '功能', '需要', '支持', '包含', '确保',
]);

export function extractKeywords(text: string): string[] {
  return text.toLowerCase()
    .split(/[\s,;:.\-_/\\()\[\]{}'"#@!?|+*<>&=]+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}
