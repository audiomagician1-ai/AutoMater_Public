/**
 * Skill Evolution Engine — Agent 技能自主习得与进化
 *
 * 设计哲学 (参照 echo agent-memory 系统):
 *   - 技能从经验中"结晶"：Agent 在开发过程中反复遇到的模式 → 提炼为可复用技能
 *   - 三级成熟度: draft → proven → stable，只有被验证有效的技能才会沉淀
 *   - 自动触发匹配：新任务开始时，扫描已有技能的 trigger 描述，自动注入相关技能
 *   - 跨项目共享：技能存储在全局目录，所有项目的 Agent 均可使用
 *   - 版本可追溯：每次改进保留历史，可回退
 *
 * 存储结构 (%APPDATA%/automater/evolved-skills/):
 *   skill-index.json           — 技能索引 (id, name, trigger, maturity, stats)
 *   skills/{id}.json           — 技能定义 (含 execution + 版本历史)
 *   skills/{id}.md             — 技能知识文档 (Markdown, Agent 可读的步骤说明)
 *   pending/                   — 草案暂存区 (未被验证的新技能)
 *
 * 技能来源:
 *   1. Agent 主动习得 — 通过 skill_acquire 工具，Agent 在发现可复用模式时主动记录
 *   2. QA 经验结晶 — QA fail→fix 循环中反复出现的修复模式自动提炼
 *   3. 用户贡献 — 从外部 JSON 文件导入
 *   4. 跨项目迁移 — 成功项目的技能自动标记为可跨项目复用
 *
 * 扩展性设计:
 *   - SkillProvider 接口: 可扩展的技能来源 (本地文件 / HTTP / Git repo / npm registry)
 *   - SkillScorer 接口: 可插拔的评分策略 (使用频率 / 成功率 / 用户评价)
 *   - Event hooks: 技能生命周期事件 (acquired / improved / promoted / deprecated)
 *
 * @module skill-evolution
 * @since v5.1.0
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { createLogger } from './logger';

const log = createLogger('skill-evolution');

// ═══════════════════════════════════════
// Types — 面向扩展设计
// ═══════════════════════════════════════

/** 技能成熟度等级 */
export type SkillMaturity = 'draft' | 'proven' | 'stable' | 'deprecated';

/** 技能执行器类型 (可扩展) */
export type SkillExecutorType = 'command' | 'http' | 'script' | 'prompt' | 'composite';

/** 技能执行配置 */
export interface SkillExecutionConfig {
  type: SkillExecutorType;
  /** command: 子进程命令 */
  command?: string;
  args?: string[];
  cwd?: string;
  timeout?: number;
  /** http: 请求配置 */
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  bodyTemplate?: string;
  /** script: 内联 JS */
  code?: string;
  /** prompt: LLM prompt 模板 (最常见的技能类型) */
  promptTemplate?: string;
  /** composite: 子技能 ID 列表 (组合技能) */
  subSkillIds?: string[];
}

/** 技能参数 Schema (JSON Schema) */
export interface SkillParameterSchema {
  type: 'object';
  properties: Record<string, {
    type: string;
    description: string;
    default?: unknown;
    enum?: string[];
  }>;
  required?: string[];
}

/** 技能版本快照 */
export interface SkillVersion {
  version: number;
  timestamp: string;
  author: string;       // 'agent:{agentId}' | 'user' | 'system'
  changeNote: string;
  /** 快照的执行配置 (可选, 仅在大变更时保存) */
  executionSnapshot?: SkillExecutionConfig;
}

/** 技能使用统计 */
export interface SkillStats {
  /** 总使用次数 */
  usedCount: number;
  /** 成功次数 */
  successCount: number;
  /** 最近使用时间 */
  lastUsed: string | null;
  /** 使用过的项目 ID 列表 */
  projectIds: string[];
  /** 用户评价 (1-5, 0=未评价) */
  userRating: number;
  /** Agent 反馈摘要 (最近 3 条) */
  recentFeedback: Array<{ timestamp: string; agentId: string; feedback: string; success: boolean }>;
}

/** 完整的可进化技能定义 */
export interface EvolvableSkill {
  /** 唯一 ID (格式: SK-{NNN}) */
  id: string;
  /** 显示名称 */
  name: string;
  /** 简短描述 */
  description: string;
  /** 触发条件描述 (用于自动匹配, 类似我们记忆系统的 trigger) */
  trigger: string;
  /** 分类标签 */
  tags: string[];
  /** 成熟度 */
  maturity: SkillMaturity;
  /** 当前版本号 */
  version: number;
  /** 参数 Schema */
  parameters: SkillParameterSchema;
  /** 执行配置 */
  execution: SkillExecutionConfig;
  /** 知识文档路径 (相对于 skills 目录) */
  knowledgePath: string | null;
  /** 版本历史 */
  history: SkillVersion[];
  /** 使用统计 */
  stats: SkillStats;
  /** 来源 */
  source: {
    type: 'agent_acquired' | 'qa_crystallized' | 'user_contributed' | 'imported';
    projectId?: string;
    agentId?: string;
    timestamp: string;
  };
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
}

/** 技能索引条目 (轻量, 用于快速加载) */
export interface SkillIndexEntry {
  id: string;
  name: string;
  trigger: string;
  tags: string[];
  maturity: SkillMaturity;
  version: number;
  usedCount: number;
  successRate: number;
  lastUsed: string | null;
}

/** 技能搜索匹配结果 */
export interface SkillMatch {
  skill: SkillIndexEntry;
  relevance: number;   // 0-100
  matchReason: string;
}

// ── 扩展接口 ──

/** 技能来源提供者 (可扩展) */
export interface SkillProvider {
  /** 提供者名称 */
  readonly name: string;
  /** 扫描并返回可用技能 */
  scan(): Promise<EvolvableSkill[]>;
  /** 是否支持写回 */
  readonly writable: boolean;
}

/** 技能评分策略 (可扩展) */
export interface SkillScorer {
  /** 计算技能分数 (用于排序) */
  score(skill: EvolvableSkill): number;
}

/** 技能生命周期事件 */
export type SkillLifecycleEvent =
  | { type: 'acquired'; skill: EvolvableSkill }
  | { type: 'improved'; skillId: string; version: number; changeNote: string }
  | { type: 'promoted'; skillId: string; from: SkillMaturity; to: SkillMaturity }
  | { type: 'deprecated'; skillId: string; reason: string }
  | { type: 'used'; skillId: string; projectId: string; success: boolean };

export type SkillEventListener = (event: SkillLifecycleEvent) => void;

// ═══════════════════════════════════════
// Paths
// ═══════════════════════════════════════

function getEvolutionDir(): string {
  return path.join(app.getPath('userData'), 'evolved-skills');
}

function getIndexPath(): string {
  return path.join(getEvolutionDir(), 'skill-index.json');
}

function getSkillPath(id: string): string {
  return path.join(getEvolutionDir(), 'skills', `${id}.json`);
}

function getKnowledgePath(id: string): string {
  return path.join(getEvolutionDir(), 'skills', `${id}.md`);
}

function getPendingDir(): string {
  return path.join(getEvolutionDir(), 'pending');
}

// ═══════════════════════════════════════
// Skill Evolution Manager
// ═══════════════════════════════════════

/**
 * 技能进化管理器 — 全局单例。
 *
 * 核心职责:
 * 1. 管理技能索引 + 完整定义的 CRUD
 * 2. 自动匹配: 根据任务描述搜索相关技能
 * 3. 成熟度推进: draft → proven → stable 的自动晋升
 * 4. 统计追踪: 使用次数、成功率、项目分布
 * 5. 向外暴露事件 hook, 方便 UI 和其他模块订阅
 */
class SkillEvolutionManager {
  private index: SkillIndexEntry[] = [];
  private loaded = false;
  private listeners: SkillEventListener[] = [];
  private providers: SkillProvider[] = [];
  private scorers: SkillScorer[] = [];

  // ── 初始化 ──

  /** 确保目录结构存在, 加载索引 */
  ensureInitialized(): void {
    if (this.loaded) return;

    const dir = getEvolutionDir();
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    fs.mkdirSync(getPendingDir(), { recursive: true });

    this.loadIndex();
    this.loaded = true;
  }

  private loadIndex(): void {
    const indexPath = getIndexPath();
    if (!fs.existsSync(indexPath)) {
      this.index = [];
      this.saveIndex();
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      this.index = raw.skills || [];
    } catch (err: unknown) {
      log.warn('Failed to load skill index, resetting', { error: (err instanceof Error ? err.message : String(err)) });
      this.index = [];
    }
  }

  private saveIndex(): void {
    const indexPath = getIndexPath();
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify({
      _doc: 'AutoMater 进化技能索引 — 自动生成, 请勿手动编辑',
      _version: 1,
      updatedAt: new Date().toISOString(),
      skills: this.index,
    }, null, 2), 'utf-8');
  }

  // ── 技能 CRUD ──

  /** 生成下一个技能 ID */
  private nextId(): string {
    const maxNum = this.index.reduce((max, s) => {
      const match = s.id.match(/^SK-(\d+)$/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);
    return `SK-${String(maxNum + 1).padStart(3, '0')}`;
  }

  /**
   * 习得新技能 — Agent 或系统从经验中提炼出新技能。
   * 初始成熟度为 draft。
   */
  acquire(input: {
    name: string;
    description: string;
    trigger: string;
    tags?: string[];
    parameters?: SkillParameterSchema;
    execution: SkillExecutionConfig;
    knowledge?: string;
    source: EvolvableSkill['source'];
  }): EvolvableSkill {
    this.ensureInitialized();

    const id = this.nextId();
    const now = new Date().toISOString();

    const skill: EvolvableSkill = {
      id,
      name: input.name,
      description: input.description,
      trigger: input.trigger,
      tags: input.tags || [],
      maturity: 'draft',
      version: 1,
      parameters: input.parameters || { type: 'object', properties: {}, required: [] },
      execution: input.execution,
      knowledgePath: input.knowledge ? `${id}.md` : null,
      history: [{
        version: 1,
        timestamp: now,
        author: input.source.agentId ? `agent:${input.source.agentId}` : 'system',
        changeNote: 'Initial acquisition',
      }],
      stats: {
        usedCount: 0,
        successCount: 0,
        lastUsed: null,
        projectIds: input.source.projectId ? [input.source.projectId] : [],
        userRating: 0,
        recentFeedback: [],
      },
      source: input.source,
      createdAt: now,
      updatedAt: now,
    };

    // 保存技能定义
    fs.writeFileSync(getSkillPath(id), JSON.stringify(skill, null, 2), 'utf-8');

    // 保存知识文档
    if (input.knowledge) {
      fs.writeFileSync(getKnowledgePath(id), input.knowledge, 'utf-8');
    }

    // 更新索引
    this.index.push({
      id,
      name: skill.name,
      trigger: skill.trigger,
      tags: skill.tags,
      maturity: 'draft',
      version: 1,
      usedCount: 0,
      successRate: 0,
      lastUsed: null,
    });
    this.saveIndex();

    this.emit({ type: 'acquired', skill });
    log.info('Skill acquired', { id, name: skill.name, maturity: 'draft' });

    return skill;
  }

  /**
   * 改进已有技能 — 更新执行配置或知识文档。
   * 自动递增版本号。
   */
  improve(skillId: string, updates: {
    execution?: Partial<SkillExecutionConfig>;
    description?: string;
    trigger?: string;
    tags?: string[];
    knowledge?: string;
    changeNote: string;
    author: string;
  }): EvolvableSkill | null {
    this.ensureInitialized();

    const skill = this.loadSkill(skillId);
    if (!skill) return null;

    const now = new Date().toISOString();
    skill.version++;
    skill.updatedAt = now;

    if (updates.execution) {
      skill.execution = { ...skill.execution, ...updates.execution };
    }
    if (updates.description) skill.description = updates.description;
    if (updates.trigger) skill.trigger = updates.trigger;
    if (updates.tags) skill.tags = updates.tags;

    // 保存版本快照
    skill.history.push({
      version: skill.version,
      timestamp: now,
      author: updates.author,
      changeNote: updates.changeNote,
      executionSnapshot: updates.execution ? { ...skill.execution } : undefined,
    });

    // 限制历史长度 (保留最近 20 条)
    if (skill.history.length > 20) {
      skill.history = skill.history.slice(-20);
    }

    // 更新知识文档
    if (updates.knowledge) {
      fs.writeFileSync(getKnowledgePath(skillId), updates.knowledge, 'utf-8');
    }

    fs.writeFileSync(getSkillPath(skillId), JSON.stringify(skill, null, 2), 'utf-8');
    this.syncIndex(skill);

    this.emit({ type: 'improved', skillId, version: skill.version, changeNote: updates.changeNote });
    log.info('Skill improved', { id: skillId, version: skill.version });

    return skill;
  }

  /**
   * 记录一次技能使用及其结果。
   * 自动更新统计 + 触发成熟度晋升检查。
   */
  recordUsage(skillId: string, projectId: string, success: boolean, feedback?: string, agentId?: string): void {
    this.ensureInitialized();

    const skill = this.loadSkill(skillId);
    if (!skill) return;

    const now = new Date().toISOString();
    skill.stats.usedCount++;
    if (success) skill.stats.successCount++;
    skill.stats.lastUsed = now;

    if (projectId && !skill.stats.projectIds.includes(projectId)) {
      skill.stats.projectIds.push(projectId);
    }

    if (feedback) {
      skill.stats.recentFeedback.push({
        timestamp: now,
        agentId: agentId || 'unknown',
        feedback: feedback.slice(0, 200),
        success,
      });
      // 保留最近 5 条
      if (skill.stats.recentFeedback.length > 5) {
        skill.stats.recentFeedback = skill.stats.recentFeedback.slice(-5);
      }
    }

    skill.updatedAt = now;
    fs.writeFileSync(getSkillPath(skillId), JSON.stringify(skill, null, 2), 'utf-8');
    this.syncIndex(skill);

    this.emit({ type: 'used', skillId, projectId, success });

    // 检查是否应该晋升
    this.checkPromotion(skill);
  }

  // ── 成熟度推进 ──

  /**
   * 自动晋升检查:
   *   draft → proven: 使用 ≥ 3 次且成功率 ≥ 70%
   *   proven → stable: 使用 ≥ 10 次且成功率 ≥ 80% 且跨 ≥ 2 项目
   */
  private checkPromotion(skill: EvolvableSkill): void {
    const { usedCount, successCount, projectIds } = skill.stats;
    const successRate = usedCount > 0 ? successCount / usedCount : 0;
    const oldMaturity = skill.maturity;

    if (skill.maturity === 'draft' && usedCount >= 3 && successRate >= 0.7) {
      skill.maturity = 'proven';
    } else if (skill.maturity === 'proven' && usedCount >= 10 && successRate >= 0.8 && projectIds.length >= 2) {
      skill.maturity = 'stable';
    } else {
      return; // 未晋升
    }

    skill.updatedAt = new Date().toISOString();
    skill.history.push({
      version: skill.version,
      timestamp: skill.updatedAt,
      author: 'system',
      changeNote: `Auto-promoted: ${oldMaturity} → ${skill.maturity}`,
    });

    fs.writeFileSync(getSkillPath(skill.id), JSON.stringify(skill, null, 2), 'utf-8');
    this.syncIndex(skill);

    this.emit({ type: 'promoted', skillId: skill.id, from: oldMaturity, to: skill.maturity });
    log.info('Skill promoted', { id: skill.id, from: oldMaturity, to: skill.maturity });
  }

  /** 手动废弃技能 */
  deprecate(skillId: string, reason: string): boolean {
    this.ensureInitialized();

    const skill = this.loadSkill(skillId);
    if (!skill) return false;

    skill.maturity = 'deprecated';
    skill.updatedAt = new Date().toISOString();
    skill.history.push({
      version: skill.version,
      timestamp: skill.updatedAt,
      author: 'system',
      changeNote: `Deprecated: ${reason}`,
    });

    fs.writeFileSync(getSkillPath(skillId), JSON.stringify(skill, null, 2), 'utf-8');
    this.syncIndex(skill);

    this.emit({ type: 'deprecated', skillId, reason });
    return true;
  }

  // ── 搜索与匹配 ──

  /**
   * 按任务描述搜索相关技能。
   * 使用关键词匹配 trigger + tags + name + description。
   * 返回按相关度排序的匹配列表。
   */
  searchSkills(query: string, options?: {
    maxResults?: number;
    minMaturity?: SkillMaturity;
    tags?: string[];
  }): SkillMatch[] {
    this.ensureInitialized();

    const maxResults = options?.maxResults ?? 5;
    const minMaturityLevel = maturityLevel(options?.minMaturity ?? 'draft');
    const filterTags = options?.tags;

    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/[\s,./;:!?]+/).filter(w => w.length > 1);

    const matches: SkillMatch[] = [];

    for (const entry of this.index) {
      if (entry.maturity === 'deprecated') continue;
      if (maturityLevel(entry.maturity) < minMaturityLevel) continue;
      if (filterTags && !filterTags.some(t => entry.tags.includes(t))) continue;

      const relevance = this.calculateRelevance(entry, queryLower, queryWords);
      if (relevance > 10) {
        matches.push({
          skill: entry,
          relevance,
          matchReason: this.explainMatch(entry, queryWords),
        });
      }
    }

    // 排序: 相关度 → 成熟度 → 使用次数
    matches.sort((a, b) => {
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      if (maturityLevel(b.skill.maturity) !== maturityLevel(a.skill.maturity))
        return maturityLevel(b.skill.maturity) - maturityLevel(a.skill.maturity);
      return b.skill.usedCount - a.skill.usedCount;
    });

    return matches.slice(0, maxResults);
  }

  private calculateRelevance(entry: SkillIndexEntry, queryLower: string, queryWords: string[]): number {
    let score = 0;

    const triggerLower = entry.trigger.toLowerCase();
    const nameLower = entry.name.toLowerCase();
    const tagsLower = entry.tags.map(t => t.toLowerCase());

    // 完全包含 trigger
    if (queryLower.includes(triggerLower) || triggerLower.includes(queryLower)) {
      score += 50;
    }

    // 逐词匹配
    for (const word of queryWords) {
      if (triggerLower.includes(word)) score += 15;
      if (nameLower.includes(word)) score += 10;
      if (tagsLower.some(t => t.includes(word))) score += 8;
    }

    // 成熟度加分
    score += maturityLevel(entry.maturity) * 3;

    // 成功率加分
    score += entry.successRate * 10;

    return Math.min(100, score);
  }

  private explainMatch(entry: SkillIndexEntry, queryWords: string[]): string {
    const matched: string[] = [];
    const triggerLower = entry.trigger.toLowerCase();
    const nameLower = entry.name.toLowerCase();

    for (const word of queryWords) {
      if (triggerLower.includes(word)) matched.push(`trigger:"${word}"`);
      else if (nameLower.includes(word)) matched.push(`name:"${word}"`);
      else if (entry.tags.some(t => t.toLowerCase().includes(word))) matched.push(`tag:"${word}"`);
    }

    return matched.length > 0 ? `Matched: ${matched.join(', ')}` : 'Partial match';
  }

  // ── 数据访问 ──

  /** 加载完整技能定义 */
  loadSkill(skillId: string): EvolvableSkill | null {
    try {
      const p = getSkillPath(skillId);
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (err: unknown) {
      log.warn('Failed to load skill', { id: skillId, error: (err instanceof Error ? err.message : String(err)) });
      return null;
    }
  }

  /** 加载技能知识文档 */
  loadKnowledge(skillId: string): string | null {
    try {
      const p = getKnowledgePath(skillId);
      if (!fs.existsSync(p)) return null;
      return fs.readFileSync(p, 'utf-8');
    } catch { /* silent: knowledge file read failed */
      return null;
    }
  }

  /** 获取索引 (只读副本) */
  getIndex(): SkillIndexEntry[] {
    this.ensureInitialized();
    return [...this.index];
  }

  /** 获取统计概览 */
  getOverview(): {
    total: number;
    byMaturity: Record<SkillMaturity, number>;
    totalUsages: number;
    avgSuccessRate: number;
  } {
    this.ensureInitialized();

    const byMaturity: Record<SkillMaturity, number> = { draft: 0, proven: 0, stable: 0, deprecated: 0 };
    let totalUsages = 0;
    let totalRate = 0;
    let ratedCount = 0;

    for (const entry of this.index) {
      byMaturity[entry.maturity]++;
      totalUsages += entry.usedCount;
      if (entry.usedCount > 0) {
        totalRate += entry.successRate;
        ratedCount++;
      }
    }

    return {
      total: this.index.length,
      byMaturity,
      totalUsages,
      avgSuccessRate: ratedCount > 0 ? totalRate / ratedCount : 0,
    };
  }

  // ── 索引同步 ──

  private syncIndex(skill: EvolvableSkill): void {
    const successRate = skill.stats.usedCount > 0
      ? skill.stats.successCount / skill.stats.usedCount
      : 0;

    const idx = this.index.findIndex(e => e.id === skill.id);
    const entry: SkillIndexEntry = {
      id: skill.id,
      name: skill.name,
      trigger: skill.trigger,
      tags: skill.tags,
      maturity: skill.maturity,
      version: skill.version,
      usedCount: skill.stats.usedCount,
      successRate,
      lastUsed: skill.stats.lastUsed,
    };

    if (idx >= 0) {
      this.index[idx] = entry;
    } else {
      this.index.push(entry);
    }
    this.saveIndex();
  }

  // ── 事件系统 ──

  /** 订阅技能生命周期事件 */
  on(listener: SkillEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private emit(event: SkillLifecycleEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* listener error shouldn't crash manager */ }
    }
  }

  // ── 扩展点 ──

  /** 注册技能来源提供者 */
  registerProvider(provider: SkillProvider): void {
    this.providers.push(provider);
    log.info('Skill provider registered', { name: provider.name });
  }

  /** 注册评分策略 */
  registerScorer(scorer: SkillScorer): void {
    this.scorers.push(scorer);
  }

  /** 从所有 Provider 同步技能 */
  async syncFromProviders(): Promise<{ imported: number; errors: string[] }> {
    let imported = 0;
    const errors: string[] = [];

    for (const provider of this.providers) {
      try {
        const skills = await provider.scan();
        for (const skill of skills) {
          const existing = this.index.find(e => e.name === skill.name);
          if (!existing) {
            this.acquire({
              name: skill.name,
              description: skill.description,
              trigger: skill.trigger,
              tags: skill.tags,
              execution: skill.execution,
              source: skill.source,
            });
            imported++;
          }
        }
      } catch (err: unknown) {
        errors.push(`${provider.name}: ${(err instanceof Error ? err.message : String(err))}`);
      }
    }

    return { imported, errors };
  }

  /** 用综合评分排序所有技能 */
  getRankedSkills(): Array<SkillIndexEntry & { score: number }> {
    this.ensureInitialized();
    return this.index
      .filter(s => s.maturity !== 'deprecated')
      .map(s => {
        const skill = this.loadSkill(s.id);
        let score = maturityLevel(s.maturity) * 20 + s.usedCount * 2 + s.successRate * 30;
        if (skill) {
          for (const scorer of this.scorers) {
            try { score += scorer.score(skill); } catch { /* ignore scorer error */ }
          }
        }
        return { ...s, score };
      })
      .sort((a, b) => b.score - a.score);
  }
}

function maturityLevel(m: SkillMaturity): number {
  switch (m) {
    case 'deprecated': return 0;
    case 'draft': return 1;
    case 'proven': return 2;
    case 'stable': return 3;
  }
}

// ═══════════════════════════════════════
// Context Builder — 为 Agent 构建技能上下文
// ═══════════════════════════════════════

/**
 * 为当前任务构建技能上下文注入文本。
 * 类似 boot.md 的 Step 3.5 技能匹配逻辑。
 *
 * @param taskDescription - 任务描述 (feature title + description + acceptance)
 * @param maxSkills - 最多加载几个技能 (默认 2, 防 token 膨胀)
 * @returns 可直接注入 system prompt 的技能上下文文本
 */
export function buildSkillContext(
  taskDescription: string,
  maxSkills: number = 2,
): string {
  const matches = skillEvolution.searchSkills(taskDescription, {
    maxResults: maxSkills,
    minMaturity: 'draft',
  });

  if (matches.length === 0) return '';

  const sections: string[] = ['## 相关技能 (Matched Skills)'];

  for (const match of matches) {
    const knowledge = skillEvolution.loadKnowledge(match.skill.id);
    const section = [
      `### ${match.skill.name} [${match.skill.maturity}] (${match.matchReason})`,
      knowledge ? knowledge.slice(0, 2000) : `触发: ${match.skill.trigger}`,
    ].join('\n');
    sections.push(section);
  }

  return sections.join('\n\n');
}

/**
 * 构建技能习得 prompt — 让 LLM 从经验中提炼技能。
 * 用于 QA fail→fix 循环或 task_complete 后的自动结晶。
 */
export function buildSkillExtractionPrompt(context: {
  featureTitle: string;
  qaFeedback?: string;
  fixSummary?: string;
  filesChanged: string[];
  lessonsLearned: string[];
}): string {
  return `你是一个技能提取助手。请从以下开发经验中判断是否存在可复用的模式。

## Feature: ${context.featureTitle}
${context.qaFeedback ? `## QA 反馈\n${context.qaFeedback.slice(0, 500)}` : ''}
${context.fixSummary ? `## 修复摘要\n${context.fixSummary.slice(0, 500)}` : ''}
## 涉及文件\n${context.filesChanged.join(', ')}
## 经验教训\n${context.lessonsLearned.join('\n')}

如果存在可复用的模式/流程，请输出 JSON:
{
  "should_create": true,
  "name": "技能名称 (<20字)",
  "description": "简短描述 (<50字)",
  "trigger": "触发条件描述 (<30字)",
  "tags": ["tag1", "tag2"],
  "knowledge": "详细步骤说明 (Markdown, 200-500字)"
}

如果不存在值得提取的模式，输出: { "should_create": false, "reason": "原因" }

只输出 JSON，不要其他内容。`;
}

/** 全局技能进化管理器实例 */
export const skillEvolution = new SkillEvolutionManager();
