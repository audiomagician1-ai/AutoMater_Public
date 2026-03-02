/**
 * Experience Library — 分层经验知识库 (迁移自 EchoAgent 记忆系统)
 *
 * 三层金字塔:
 *   1. Principles (≤8条) — 不可违反的元准则，跨项目跨角色通用
 *      例: "修改文件后必须验证编译", "先搜索再修改"
 *
 *   2. Patterns (≤20条) — 按领域(domain)分组的可复用行为模式
 *      例: [typescript] "tsconfig paths 与 vite resolve.alias 必须同步"
 *      每条 pattern 可包含多个子项(通过分号或编号分隔)
 *
 *   3. Instances (无上限, FIFO淘汰) — 具体的 "遇到X→做了Y→结果Z" 案例
 *      来源: QA fail→fix, error→resolution, feature done, 用户纠正
 *      定期蒸馏: 3+同领域 instance → 自动提炼为 pattern
 *
 * 容量控制:
 *   - principles 满时新增必须合并到现有条目
 *   - patterns 满时新增必须 (a) 合并到同 domain 条目, 或 (b) 淘汰最旧无用的
 *   - instances 超过 100 条时, FIFO 淘汰最旧的(已被 pattern 覆盖的优先)
 *
 * 存储: {workspace}/.automater/experience-library.json
 * 全局: %APPDATA%/automater/global-experience.json (跨项目)
 *
 * 设计来源: EchoAgent agent-memory/core/lessons_learned.json 三层架构
 *
 * @module experience-library
 * @since v22.0
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { createLogger } from './logger';
import type { AppSettings } from './types';

const log = createLogger('experience-library');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface Principle {
  id: string;
  text: string;
  /** 从哪些 pattern/instance 提炼而来 */
  derived_from?: string;
  created_at: string;
}

export interface Pattern {
  id: string;
  /** 领域分类: typescript, react, css, api, testing, git, security, performance, general */
  domain: string;
  /** 模式描述(可含多个子项) */
  text: string;
  /** 最后验证/更新时间 */
  last_validated: string;
  /** 被引用次数(每次注入 Agent 上下文时 +1) */
  use_count: number;
}

export interface Instance {
  id: string;
  /** 一句话摘要 */
  summary: string;
  /** 具体化为哪个 pattern 或 principle */
  materialized_as?: string;
  /** 来源 */
  source: 'qa_fail' | 'error_fixed' | 'feature_done' | 'user_correction' | 'auto';
  created_at: string;
}

export interface ExperienceLibrary {
  _version: string;
  principles: Principle[];
  patterns: Pattern[];
  instances: Instance[];
  /** principles 容量上限 */
  max_principles: number;
  /** patterns 容量上限 */
  max_patterns: number;
  /** instances 容量上限 */
  max_instances: number;
  /** 上次蒸馏时间 */
  last_distilled: string;
}

// ═══════════════════════════════════════
// Capacity Limits (from EchoAgent config)
// ═══════════════════════════════════════

const DEFAULT_MAX_PRINCIPLES = 8;
const DEFAULT_MAX_PATTERNS = 20;
const DEFAULT_MAX_INSTANCES = 100;

// ═══════════════════════════════════════
// Storage Paths
// ═══════════════════════════════════════

function getProjectLibraryPath(workspacePath: string): string {
  return path.join(workspacePath, '.automater', 'experience-library.json');
}

function getGlobalLibraryPath(): string {
  return path.join(app.getPath('userData'), 'global-experience.json');
}

// ═══════════════════════════════════════
// CRUD
// ═══════════════════════════════════════

function createEmpty(): ExperienceLibrary {
  return {
    _version: '1.0',
    principles: [],
    patterns: [],
    instances: [],
    max_principles: DEFAULT_MAX_PRINCIPLES,
    max_patterns: DEFAULT_MAX_PATTERNS,
    max_instances: DEFAULT_MAX_INSTANCES,
    last_distilled: new Date().toISOString(),
  };
}

export function loadLibrary(filePath: string): ExperienceLibrary {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as ExperienceLibrary;
      return {
        ...createEmpty(),
        ...data,
        principles: data.principles || [],
        patterns: data.patterns || [],
        instances: data.instances || [],
      };
    }
  } catch (err) {
    log.warn('Failed to load experience library', { path: filePath, error: String(err) });
  }
  return createEmpty();
}

export function saveLibrary(filePath: string, lib: ExperienceLibrary): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(lib, null, 2), 'utf-8');
  } catch (err) {
    log.error('Failed to save experience library', { path: filePath, error: String(err) });
  }
}

/** 加载项目级经验库 */
export function loadProjectLibrary(workspacePath: string): ExperienceLibrary {
  return loadLibrary(getProjectLibraryPath(workspacePath));
}

/** 保存项目级经验库 */
export function saveProjectLibrary(workspacePath: string, lib: ExperienceLibrary): void {
  saveLibrary(getProjectLibraryPath(workspacePath), lib);
}

/** 加载全局经验库 */
export function loadGlobalLibrary(): ExperienceLibrary {
  return loadLibrary(getGlobalLibraryPath());
}

/** 保存全局经验库 */
export function saveGlobalLibrary(lib: ExperienceLibrary): void {
  saveLibrary(getGlobalLibraryPath(), lib);
}

// ═══════════════════════════════════════
// Instance 录入 — 最频繁的写操作
// ═══════════════════════════════════════

/**
 * 录入一条新的经验实例
 * 自动处理:
 *   1. 去重(同摘要跳过)
 *   2. FIFO 淘汰(超容量时删最旧的已 materialized 条目)
 *   3. 触发蒸馏检查(每录入5条检查一次)
 */
export function addInstance(
  workspacePath: string,
  source: Instance['source'],
  summary: string,
  materializedAs?: string,
): Instance | null {
  const lib = loadProjectLibrary(workspacePath);

  // 去重: 完全相同的摘要
  if (lib.instances.some(i => i.summary === summary)) {
    return null;
  }

  // 模糊去重: 80% 相似度
  if (lib.instances.some(i => stringSimilarity(i.summary, summary) > 0.8)) {
    return null;
  }

  const instance: Instance = {
    id: `I-${Date.now().toString(36)}`,
    summary: summary.slice(0, 300),
    materialized_as: materializedAs,
    source,
    created_at: new Date().toISOString(),
  };

  lib.instances.push(instance);

  // FIFO 淘汰: 优先删已 materialized 的旧条目
  if (lib.instances.length > lib.max_instances) {
    const materializedOld = lib.instances
      .filter(i => i.materialized_as)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (materializedOld.length > 0) {
      lib.instances = lib.instances.filter(i => i.id !== materializedOld[0].id);
    } else {
      lib.instances = lib.instances.slice(-lib.max_instances);
    }
  }

  saveProjectLibrary(workspacePath, lib);

  // 每 5 条新 instance 触发一次蒸馏检查
  if (lib.instances.filter(i => !i.materialized_as).length % 5 === 0) {
    tryDistillPatterns(workspacePath);
  }

  return instance;
}

// ═══════════════════════════════════════
// Pattern 管理
// ═══════════════════════════════════════

/**
 * 添加或合并 pattern
 * 如果同 domain 已有相似 pattern → 合并(追加子项)
 * 如果超容量 → 淘汰 use_count 最低的
 */
export function addOrMergePattern(workspacePath: string, domain: string, text: string, derivedFrom?: string): Pattern {
  const lib = loadProjectLibrary(workspacePath);

  // 查找同 domain 的现有 pattern
  const existing = lib.patterns.find(p => p.domain === domain && stringSimilarity(p.text, text) > 0.4);

  if (existing) {
    // 合并: 追加新内容到现有 pattern
    if (!existing.text.includes(text.slice(0, 50))) {
      existing.text += `; ${text}`;
    }
    existing.last_validated = new Date().toISOString();
    saveProjectLibrary(workspacePath, lib);
    return existing;
  }

  // 新建 pattern
  const pattern: Pattern = {
    id: `P-${lib.patterns.length + 1}`.padStart(5, '0'),
    domain,
    text: text.slice(0, 500),
    last_validated: new Date().toISOString(),
    use_count: 0,
  };

  // 容量控制
  if (lib.patterns.length >= lib.max_patterns) {
    // 淘汰 use_count 最低且最旧的 pattern
    const candidates = [...lib.patterns].sort((a, b) => {
      if (a.use_count !== b.use_count) return a.use_count - b.use_count;
      return a.last_validated.localeCompare(b.last_validated);
    });
    const victim = candidates[0];
    log.info(`Pattern capacity full, evicting ${victim.id} (use_count=${victim.use_count})`);
    lib.patterns = lib.patterns.filter(p => p.id !== victim.id);
  }

  lib.patterns.push(pattern);
  saveProjectLibrary(workspacePath, lib);
  return pattern;
}

// ═══════════════════════════════════════
// Principle 管理
// ═══════════════════════════════════════

/**
 * 添加 principle (仅在反复验证的 pattern 升级时调用)
 * 容量满时合并到最相似的现有 principle
 */
export function addOrMergePrinciple(workspacePath: string, text: string, derivedFrom?: string): Principle {
  const lib = loadProjectLibrary(workspacePath);

  // 检查重复
  const existing = lib.principles.find(p => stringSimilarity(p.text, text) > 0.5);
  if (existing) {
    // 合并
    if (!existing.text.includes(text.slice(0, 30))) {
      existing.text += `; ${text}`;
    }
    saveProjectLibrary(workspacePath, lib);
    return existing;
  }

  if (lib.principles.length >= lib.max_principles) {
    // 合并到最相似的
    let bestMatch = lib.principles[0];
    let bestSim = 0;
    for (const p of lib.principles) {
      const sim = stringSimilarity(p.text, text);
      if (sim > bestSim) {
        bestSim = sim;
        bestMatch = p;
      }
    }
    bestMatch.text += `; ${text}`;
    saveProjectLibrary(workspacePath, lib);
    return bestMatch;
  }

  const principle: Principle = {
    id: `PR-${lib.principles.length + 1}`.padStart(6, '0'),
    text: text.slice(0, 300),
    derived_from: derivedFrom,
    created_at: new Date().toISOString(),
  };

  lib.principles.push(principle);
  saveProjectLibrary(workspacePath, lib);
  return principle;
}

// ═══════════════════════════════════════
// 自动蒸馏 — instances → patterns
// ═══════════════════════════════════════

/**
 * 检查未 materialized 的 instances，找出可蒸馏为 pattern 的聚类
 *
 * 蒸馏条件: 3+ 条 instance 含相似关键词 → 提炼为 1 条 pattern
 * 蒸馏方式: 关键词聚类(轻量，不需要 LLM)
 */
export function tryDistillPatterns(workspacePath: string): number {
  const lib = loadProjectLibrary(workspacePath);
  const unmatched = lib.instances.filter(i => !i.materialized_as);

  if (unmatched.length < 3) return 0;

  // 按关键词聚类
  const clusters = clusterByKeywords(unmatched);
  let distilled = 0;

  for (const [keywords, members] of clusters.entries()) {
    if (members.length < 3) continue;

    // 从聚类成员中提炼 pattern
    const domain = inferDomain(keywords);
    const summaries = members.map(m => m.summary).join('; ');
    const patternText = `${keywords}: ${summaries.slice(0, 400)}`;

    const pattern = addOrMergePattern(workspacePath, domain, patternText);

    // 标记 instances 为已 materialized
    for (const member of members) {
      const idx = lib.instances.findIndex(i => i.id === member.id);
      if (idx >= 0) {
        lib.instances[idx].materialized_as = pattern.id;
      }
    }

    distilled++;
    log.info(`Distilled ${members.length} instances → pattern ${pattern.id} [${domain}]`);
  }

  if (distilled > 0) {
    lib.last_distilled = new Date().toISOString();
    saveProjectLibrary(workspacePath, lib);
  }

  return distilled;
}

// ═══════════════════════════════════════
// 上下文注入 — 供 Agent 使用
// ═══════════════════════════════════════

/**
 * 生成经验库上下文文本，注入 Agent 系统 prompt
 *
 * Token 预算控制:
 *   - principles: 全部注入 (~400 tokens)
 *   - patterns: 按 domain 相关性过滤 + 按 use_count 排序 (~800 tokens)
 *   - instances: 不注入(太多太具体)
 *
 * @param maxChars 最大字符数限制
 */
export function formatLibraryForContext(
  lib: ExperienceLibrary,
  relevantDomains?: string[],
  maxChars: number = 3000,
): string {
  const sections: string[] = [];
  let totalLen = 0;

  // 1. Principles — 全部注入
  if (lib.principles.length > 0) {
    const pLines = lib.principles.map((p, i) => `${i + 1}. ${p.text}`);
    const pSection = `## 🔴 必须遵守的原则\n${pLines.join('\n')}`;
    if (totalLen + pSection.length < maxChars) {
      sections.push(pSection);
      totalLen += pSection.length;
    }
  }

  // 2. Patterns — 按相关性过滤
  if (lib.patterns.length > 0) {
    const patterns = [...lib.patterns];

    // 优先相关 domain
    if (relevantDomains && relevantDomains.length > 0) {
      const domainSet = new Set(relevantDomains);
      patterns.sort((a, b) => {
        const aRelevant = domainSet.has(a.domain) ? 1 : 0;
        const bRelevant = domainSet.has(b.domain) ? 1 : 0;
        if (aRelevant !== bRelevant) return bRelevant - aRelevant;
        return b.use_count - a.use_count;
      });
    } else {
      patterns.sort((a, b) => b.use_count - a.use_count);
    }

    const pLines: string[] = [];
    for (const p of patterns) {
      const line = `- [${p.domain}] ${p.text}`;
      if (totalLen + line.length + 50 > maxChars) break;
      pLines.push(line);
      totalLen += line.length;
      // 标记使用
      p.use_count++;
    }

    if (pLines.length > 0) {
      sections.push(`## 📘 项目经验模式\n${pLines.join('\n')}`);
    }
  }

  if (sections.length === 0) return '';
  return `# 📚 经验知识库\n\n${sections.join('\n\n')}`;
}

/**
 * 便捷方法: 加载并格式化项目经验库
 */
export function getProjectExperienceContext(
  workspacePath: string,
  relevantDomains?: string[],
  maxChars?: number,
): string {
  const lib = loadProjectLibrary(workspacePath);
  const context = formatLibraryForContext(lib, relevantDomains, maxChars);
  if (context) saveProjectLibrary(workspacePath, lib); // 保存 use_count 更新
  return context;
}

// ═══════════════════════════════════════
// 蒸馏到全局经验库 (项目完成时)
// ═══════════════════════════════════════

/**
 * 将项目经验库中高频使用的 patterns 贡献到全局经验库
 * (在项目完成/暂停时由 orchestrator 调用)
 */
export function contributeToGlobal(workspacePath: string, projectName: string): number {
  const projectLib = loadProjectLibrary(workspacePath);
  const globalLib = loadGlobalLibrary();

  // 只贡献 use_count > 0 的 patterns
  const candidates = projectLib.patterns.filter(p => p.use_count > 0);
  let contributed = 0;

  for (const pattern of candidates) {
    // 全局库去重
    if (globalLib.patterns.some(g => g.domain === pattern.domain && stringSimilarity(g.text, pattern.text) > 0.5)) {
      continue;
    }

    // 容量检查
    if (globalLib.patterns.length >= globalLib.max_patterns) {
      // 淘汰最旧最少用的
      const sorted = [...globalLib.patterns].sort((a, b) => a.use_count - b.use_count);
      globalLib.patterns = globalLib.patterns.filter(p => p.id !== sorted[0].id);
    }

    globalLib.patterns.push({
      ...pattern,
      id: `G-${pattern.id}`,
      last_validated: new Date().toISOString(),
    });
    contributed++;
  }

  // 贡献 principles (高价值，直接合并)
  for (const principle of projectLib.principles) {
    if (!globalLib.principles.some(g => stringSimilarity(g.text, principle.text) > 0.5)) {
      if (globalLib.principles.length < globalLib.max_principles) {
        globalLib.principles.push({
          ...principle,
          id: `G-${principle.id}`,
        });
        contributed++;
      }
    }
  }

  if (contributed > 0) {
    saveGlobalLibrary(globalLib);
    log.info(`Contributed ${contributed} experience entries from ${projectName} to global library`);
  }

  return contributed;
}

/**
 * 从全局经验库注入相关经验到新项目
 * (在项目初始化时调用)
 */
export function injectGlobalExperience(workspacePath: string, relevantDomains: string[]): number {
  const globalLib = loadGlobalLibrary();
  const projectLib = loadProjectLibrary(workspacePath);

  const domainSet = new Set(relevantDomains);
  const relevant = globalLib.patterns.filter(p => domainSet.has(p.domain));
  let injected = 0;

  for (const pattern of relevant) {
    if (!projectLib.patterns.some(p => p.domain === pattern.domain && stringSimilarity(p.text, pattern.text) > 0.5)) {
      projectLib.patterns.push({
        ...pattern,
        id: pattern.id.replace('G-', 'INJ-'),
        use_count: 0,
      });
      injected++;
    }
  }

  // 也注入 principles
  for (const principle of globalLib.principles) {
    if (!projectLib.principles.some(p => stringSimilarity(p.text, principle.text) > 0.5)) {
      if (projectLib.principles.length < projectLib.max_principles) {
        projectLib.principles.push({
          ...principle,
          id: principle.id.replace('G-', 'INJ-'),
        });
        injected++;
      }
    }
  }

  if (injected > 0) {
    saveProjectLibrary(workspacePath, projectLib);
    log.info(`Injected ${injected} global experience entries into project`);
  }

  return injected;
}

// ═══════════════════════════════════════
// Token Budget Control
// ═══════════════════════════════════════

/**
 * 检查 project-memory.md 大小，超过预算时触发 LLM 压缩
 * 压缩策略: 保留最新 50% + LLM 摘要最旧 50%
 */
export function checkMemoryBudget(
  workspacePath: string,
  maxChars: number = 8000,
): { overBudget: boolean; currentSize: number; limit: number } {
  const memPath = path.join(workspacePath, '.automater', 'project-memory.md');
  try {
    if (!fs.existsSync(memPath)) return { overBudget: false, currentSize: 0, limit: maxChars };
    const content = fs.readFileSync(memPath, 'utf-8');
    return {
      overBudget: content.length > maxChars,
      currentSize: content.length,
      limit: maxChars,
    };
  } catch {
    return { overBudget: false, currentSize: 0, limit: maxChars };
  }
}

/**
 * 压缩 project-memory.md: 保留头部结构 + 最新条目，中间截断
 * (不需要 LLM，纯规则压缩)
 */
export function compactProjectMemory(workspacePath: string, maxChars: number = 8000): boolean {
  const memPath = path.join(workspacePath, '.automater', 'project-memory.md');
  try {
    if (!fs.existsSync(memPath)) return false;
    const content = fs.readFileSync(memPath, 'utf-8');
    if (content.length <= maxChars) return false;

    const lines = content.split('\n');
    // 找到所有日期标记的条目 (- [2026-xx-xx] ...)
    const entryIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^- \[\d{4}-\d{2}/.test(lines[i])) {
        entryIndices.push(i);
      }
    }

    if (entryIndices.length < 4) return false;

    // 保留头部(到第一个条目) + 最新 50% 条目
    const keepCount = Math.ceil(entryIndices.length / 2);
    const keepFrom = entryIndices[entryIndices.length - keepCount];
    const header = lines.slice(0, entryIndices[0]).join('\n');
    const kept = lines.slice(keepFrom).join('\n');
    const removedCount = entryIndices.length - keepCount;

    const compacted = `${header}\n\n> ⚠️ ${removedCount} 条旧经验已被压缩 (${new Date().toISOString().split('T')[0]})\n\n${kept}`;
    fs.writeFileSync(memPath, compacted, 'utf-8');

    log.info(
      `Compacted project-memory.md: ${content.length} → ${compacted.length} chars, removed ${removedCount} old entries`,
    );
    return true;
  } catch (err) {
    log.warn('Failed to compact project memory', { error: String(err) });
    return false;
  }
}

// ═══════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════

/** 简单字符串相似度 (Jaccard on bigrams) */
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    const lower = s.toLowerCase();
    for (let i = 0; i < lower.length - 1; i++) {
      set.add(lower.slice(i, i + 2));
    }
    return set;
  };

  const setA = bigrams(a);
  const setB = bigrams(b);
  let intersection = 0;
  for (const bg of setA) {
    if (setB.has(bg)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 从多条 instance 中提取共同关键词 */
function clusterByKeywords(instances: Instance[]): Map<string, Instance[]> {
  // 提取每条 instance 的关键词 (>= 2 字的非停用词)
  const stopWords = new Set([
    '的',
    '了',
    '在',
    '是',
    '和',
    '与',
    '或',
    '到',
    '从',
    '对',
    '被',
    '把',
    'the',
    'is',
    'in',
    'at',
    'to',
    'a',
    'an',
    'of',
    'for',
    'and',
    'or',
    'but',
    '修复',
    '问题',
    '导致',
    '错误',
    '使用',
    '需要',
    '可以',
    '通过',
    '进行',
    '设置',
  ]);

  function extractKeywords(text: string): string[] {
    // 提取中英文词汇
    const words = text.match(/[a-zA-Z_]{3,}|[\u4e00-\u9fa5]{2,}/g) || [];
    return words.filter(w => !stopWords.has(w.toLowerCase())).slice(0, 8);
  }

  // 两两比较，找共同关键词 >= 2 的归为一组
  const clusters = new Map<string, Instance[]>();

  for (const inst of instances) {
    const kw = extractKeywords(inst.summary);
    let matched = false;

    for (const [key, members] of clusters.entries()) {
      const clusterKw = key.split(',');
      const common = kw.filter(k => clusterKw.includes(k));
      if (common.length >= 2) {
        members.push(inst);
        matched = true;
        break;
      }
    }

    if (!matched) {
      clusters.set(kw.join(','), [inst]);
    }
  }

  return clusters;
}

/** 从关键词推断 domain */
function inferDomain(keywords: string): string {
  const kw = keywords.toLowerCase();
  if (/typescript|tsx?|tsconfig|type|interface/.test(kw)) return 'typescript';
  if (/react|component|hook|state|props|jsx/.test(kw)) return 'react';
  if (/css|style|tailwind|layout|flex|grid/.test(kw)) return 'css';
  if (/api|endpoint|fetch|request|response|rest/.test(kw)) return 'api';
  if (/test|spec|assert|mock|jest|vitest/.test(kw)) return 'testing';
  if (/git|commit|branch|merge|rebase/.test(kw)) return 'git';
  if (/security|auth|token|encrypt|permission/.test(kw)) return 'security';
  if (/perf|memory|cache|optimize|bundle/.test(kw)) return 'performance';
  if (/sql|database|migration|table|query/.test(kw)) return 'database';
  if (/electron|ipc|preload|main.process/.test(kw)) return 'electron';
  if (/deploy|build|ci|cd|docker/.test(kw)) return 'deploy';
  return 'general';
}
