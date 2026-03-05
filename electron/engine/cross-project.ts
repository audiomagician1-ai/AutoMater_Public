/**
 * Cross-project Learning — 跨项目经验池
 *
 * 所有项目完成后，将 project-memory 中的有价值经验
 * 提取/归类到全局经验池 (按技术栈分类)。
 * 新项目初始化时，自动匹配并注入相关经验。
 *
 * 存储: %APPDATA%/automater/knowledge/
 *   - _index.json     — 经验条目索引 (id, tags, source, summary)
 *   - typescript.md    — TypeScript 项目通用经验
 *   - react.md         — React 项目经验
 *   - python.md        — Python 项目经验
 *   - general.md       — 通用编程经验
 *   - ...
 *
 * v2.0.0: 初始实现
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { createLogger } from './logger';
const log = createLogger('cross-project');


// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface KnowledgeEntry {
  id: string;
  /** 来源项目名 */
  sourceProject: string;
  /** 标签 (技术栈、类型) */
  tags: string[];
  /** 一行摘要 */
  summary: string;
  /** 完整经验内容 */
  content: string;
  /** 创建时间 ISO */
  createdAt: string;
  /** 被引用次数 (新项目用到时 +1) */
  useCount: number;
}

export interface KnowledgeIndex {
  version: number;
  entries: KnowledgeEntry[];
}

// ═══════════════════════════════════════
// Storage
// ═══════════════════════════════════════

function getKnowledgeDir(): string {
  const dir = path.join(app.getPath('userData'), 'knowledge');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getIndexPath(): string {
  return path.join(getKnowledgeDir(), '_index.json');
}

function loadIndex(): KnowledgeIndex {
  const indexPath = getIndexPath();
  if (!fs.existsSync(indexPath)) {
    return { version: 1, entries: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  } catch (err) { /* silent: cross-project DB read failed */
    log.debug('Catch at cross-project.ts:72', { error: String(err) });
    return { version: 1, entries: [] };
  }
}

function saveIndex(index: KnowledgeIndex): void {
  fs.writeFileSync(getIndexPath(), JSON.stringify(index, null, 2), 'utf-8');
}

function getCategoryFile(tag: string): string {
  return path.join(getKnowledgeDir(), `${tag}.md`);
}

// ═══════════════════════════════════════
// Tag Classification
// ═══════════════════════════════════════

const TAG_PATTERNS: Array<{ tag: string; patterns: RegExp[] }> = [
  { tag: 'typescript', patterns: [/typescript/i, /\.tsx?\b/i, /tsconfig/i] },
  { tag: 'javascript', patterns: [/javascript/i, /\.jsx?\b/i, /node\.?js/i, /npm/i, /yarn/i, /pnpm/i] },
  { tag: 'react', patterns: [/react/i, /jsx/i, /next\.?js/i, /zustand/i, /redux/i, /vite/i] },
  { tag: 'python', patterns: [/python/i, /\.py\b/i, /pip/i, /django/i, /flask/i, /fastapi/i, /pytest/i] },
  { tag: 'rust', patterns: [/rust/i, /cargo/i, /\.rs\b/i] },
  { tag: 'go', patterns: [/\bgo\b/i, /golang/i, /\.go\b/i] },
  { tag: 'database', patterns: [/database/i, /sql/i, /postgres/i, /mysql/i, /sqlite/i, /prisma/i, /mongodb/i] },
  { tag: 'api', patterns: [/\bapi\b/i, /rest/i, /graphql/i, /endpoint/i, /fetch/i] },
  { tag: 'testing', patterns: [/test/i, /jest/i, /pytest/i, /vitest/i, /spec/i, /tdd/i] },
  { tag: 'docker', patterns: [/docker/i, /container/i, /k8s/i, /kubernetes/i] },
  { tag: 'git', patterns: [/\bgit\b/i, /github/i, /gitlab/i, /commit/i, /branch/i] },
  { tag: 'security', patterns: [/security/i, /auth/i, /encrypt/i, /xss/i, /injection/i, /cors/i] },
  { tag: 'css', patterns: [/css/i, /tailwind/i, /scss/i, /styled/i] },
  { tag: 'electron', patterns: [/electron/i, /tauri/i, /desktop/i] },
];

/**
 * 从经验文本中自动推断标签
 */
export function inferTags(text: string): string[] {
  const tags = new Set<string>();
  for (const { tag, patterns } of TAG_PATTERNS) {
    if (patterns.some(p => p.test(text))) {
      tags.add(tag);
    }
  }
  if (tags.size === 0) tags.add('general');
  return [...tags];
}

// ═══════════════════════════════════════
// Write — 提取经验到全局池
// ═══════════════════════════════════════

/**
 * 从项目 memory 中提取经验条目，归类到全局经验池
 *
 * @param sourceProject 来源项目名
 * @param entries 经验条目列表 (每条是一段文本)
 * @returns 新增条目数量
 */
export function contributeKnowledge(
  sourceProject: string,
  entries: Array<{ summary: string; content: string; tags?: string[] }>,
): number {
  if (entries.length === 0) return 0;

  const index = loadIndex();
  let added = 0;

  for (const entry of entries) {
    // 去重: 如果已有非常相似的条目就跳过
    const isDuplicate = index.entries.some(
      e => e.summary === entry.summary || e.content === entry.content
    );
    if (isDuplicate) continue;

    const tags = entry.tags || inferTags(entry.content + ' ' + entry.summary);
    const id = `K${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    const knowledgeEntry: KnowledgeEntry = {
      id,
      sourceProject,
      tags,
      summary: entry.summary.slice(0, 200),
      content: entry.content,
      createdAt: new Date().toISOString(),
      useCount: 0,
    };

    index.entries.push(knowledgeEntry);

    // 同时追加到分类 markdown 文件
    for (const tag of tags) {
      const categoryPath = getCategoryFile(tag);
      let existing = '';
      try { existing = fs.readFileSync(categoryPath, 'utf-8'); } catch (err) { /* silent: file read fallback */ }
      if (!existing) {
        existing = `# ${tag.charAt(0).toUpperCase() + tag.slice(1)} 经验库\n\n`;
      }
      existing += `\n## [${sourceProject}] ${entry.summary}\n${entry.content}\n`;
      fs.writeFileSync(categoryPath, existing, 'utf-8');
    }

    added++;
  }

  if (added > 0) saveIndex(index);
  return added;
}

/**
 * 从项目 memory 文件中自动提取有价值经验
 * (在项目完成/暂停时调用)
 */
export function extractFromProjectMemory(
  workspacePath: string,
  projectName: string,
): number {
  const memPath = path.join(workspacePath, '.automater', 'project-memory.md');
  if (!fs.existsSync(memPath)) return 0;

  const content = fs.readFileSync(memPath, 'utf-8');
  if (content.length < 50) return 0;

  // 按 ## 或 ### 标题分段
  const sections = content.split(/^#{2,3}\s+/m).filter(s => s.trim().length > 20);

  const entries = sections.map(section => {
    const lines = section.trim().split('\n');
    const summary = lines[0].replace(/^#+\s*/, '').trim().slice(0, 200);
    return {
      summary,
      content: section.trim().slice(0, 1000),
    };
  }).filter(e => e.summary.length > 5);

  return contributeKnowledge(projectName, entries);
}

// ═══════════════════════════════════════
// Read — 为新项目匹配经验
// ═══════════════════════════════════════

/**
 * 根据技术栈标签查询相关经验
 */
export function queryKnowledge(
  tags: string[],
  maxEntries: number = 10,
): KnowledgeEntry[] {
  const index = loadIndex();
  if (index.entries.length === 0) return [];

  const tagSet = new Set(tags.map(t => t.toLowerCase()));

  // 按标签匹配度排序
  const scored = index.entries.map(entry => {
    const matchCount = entry.tags.filter(t => tagSet.has(t)).length;
    return { entry, score: matchCount };
  }).filter(s => s.score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.entry.useCount - a.entry.useCount;
  });

  return scored.slice(0, maxEntries).map(s => s.entry);
}

/**
 * 从 wish + architecture 文本推断项目技术栈标签
 */
export function inferProjectTags(wish: string, archContent?: string): string[] {
  const text = `${wish} ${archContent || ''}`;
  return inferTags(text);
}

/**
 * 为新项目生成跨项目经验上下文
 * (注入到 Developer 上下文中)
 */
export function buildCrossProjectContext(
  wish: string,
  archContent?: string,
  maxTokens: number = 1500,
): string {
  const tags = inferProjectTags(wish, archContent);
  const entries = queryKnowledge(tags, 8);
  if (entries.length === 0) return '';

  // 标记使用
  const index = loadIndex();
  for (const entry of entries) {
    const idx = index.entries.findIndex(e => e.id === entry.id);
    if (idx >= 0) index.entries[idx].useCount++;
  }
  saveIndex(index);

  // 生成上下文文本
  const lines = ['## 跨项目经验 (来自历史项目)'];
  let totalLen = lines[0].length;
  const charBudget = maxTokens * 1.5;

  for (const entry of entries) {
    const block = `\n### [${entry.sourceProject}] ${entry.summary}\n${entry.content}`;
    if (totalLen + block.length > charBudget) break;
    lines.push(block);
    totalLen += block.length;
  }

  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * 获取全局经验统计
 */
export function getKnowledgeStats(): {
  totalEntries: number;
  byTag: Record<string, number>;
  topUsed: Array<{ summary: string; useCount: number }>;
} {
  const index = loadIndex();
  const byTag: Record<string, number> = {};
  for (const entry of index.entries) {
    for (const tag of entry.tags) {
      byTag[tag] = (byTag[tag] || 0) + 1;
    }
  }

  const topUsed = [...index.entries]
    .sort((a, b) => b.useCount - a.useCount)
    .slice(0, 5)
    .map(e => ({ summary: e.summary, useCount: e.useCount }));

  return { totalEntries: index.entries.length, byTag, topUsed };
}
