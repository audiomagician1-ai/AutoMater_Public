/**
 * Feature Workpad — 每 Feature 持久化进度文档 (v31.0)
 *
 * 灵感: OpenAI Symphony 的 workspace isolation + retry continuation context
 *
 * 解决的问题:
 *   1. QA 驳回后重做时, Agent 丢失之前的工作上下文
 *   2. 达到 max_iterations 暂停后恢复时, Agent 不知道做到哪了
 *   3. 跨 Worker 交接时 (hot-join), 新 Worker 无法了解前任进度
 *
 * 设计:
 *   - 每个 Feature 一个 JSON 文件: .automater/workpads/{featureId}.json
 *   - Harness 在关键时刻自动写入 (dev 开始、QA 结果、错误)
 *   - Agent 可通过 scratchpad_write 工具主动记录
 *   - 注入 prompt 时, 将 workpad 格式化为上下文 — Agent 立即知道之前做了什么
 *
 * @module feature-workpad
 * @since v31.0
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';

const log = createLogger('feature-workpad');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface WorkpadEntry {
  /** 内容 */
  content: string;
  /** 记录时间 */
  timestamp: number;
  /** 记录者 */
  source: 'harness' | 'agent';
  /** 阶段标记 */
  phase: 'dev' | 'qa' | 'rework' | 'resume';
}

export interface FeatureWorkpad {
  /** Feature ID */
  featureId: string;
  /** 项目 ID */
  projectId: string;
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;

  /** 当前 QA 尝试次数 */
  qaAttempt: number;
  /** 当前状态 */
  status: 'dev' | 'reviewing' | 'rework' | 'paused' | 'done' | 'failed';

  /** 时间线 — 按时间顺序记录的关键事件 */
  timeline: WorkpadEntry[];

  /** 已写入的文件列表 (所有尝试的累计) */
  filesWritten: string[];
  /** 最近一次 QA 反馈 */
  lastQAFeedback: string | null;
  /** 最近一次 QA 分数 */
  lastQAScore: number | null;
  /** Agent 记录的关键决策 */
  decisions: string[];
  /** Agent 记录的已知问题 */
  knownIssues: string[];
}

// ═══════════════════════════════════════
// File Operations
// ═══════════════════════════════════════

function workpadDir(workspacePath: string): string {
  return path.join(workspacePath, '.automater', 'workpads');
}

function workpadFile(workspacePath: string, featureId: string): string {
  const safe = featureId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return path.join(workpadDir(workspacePath), `${safe}.json`);
}

/** 加载 Feature 的 Workpad, 不存在则返回 null */
export function loadWorkpad(workspacePath: string, featureId: string): FeatureWorkpad | null {
  const filePath = workpadFile(workspacePath, featureId);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as FeatureWorkpad;
  } catch (err) {
    log.warn('Failed to load workpad', { featureId, error: String(err) });
    return null;
  }
}

/** 保存 Workpad — 自动限制 timeline 长度 */
function saveWorkpad(workspacePath: string, pad: FeatureWorkpad): void {
  const dir = workpadDir(workspacePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    pad.updatedAt = Date.now();
    // Trim timeline to max 50 entries
    if (pad.timeline.length > 50) {
      pad.timeline = pad.timeline.slice(-50);
    }
    const filePath = workpadFile(workspacePath, pad.featureId);
    fs.writeFileSync(filePath, JSON.stringify(pad, null, 2), 'utf-8');
  } catch (err) {
    log.error('Failed to save workpad', { featureId: pad.featureId, error: String(err) });
  }
}

/** 创建新的 Workpad */
function createWorkpad(featureId: string, projectId: string): FeatureWorkpad {
  return {
    featureId,
    projectId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    qaAttempt: 0,
    status: 'dev',
    timeline: [],
    filesWritten: [],
    lastQAFeedback: null,
    lastQAScore: null,
    decisions: [],
    knownIssues: [],
  };
}

// ═══════════════════════════════════════
// Harness API — 在关键时刻自动写入
// ═══════════════════════════════════════

/**
 * [Harness] 开发阶段开始
 * 在 workerLoop 锁定 Feature 后调用
 */
export function workpadDevStart(
  workspacePath: string,
  featureId: string,
  projectId: string,
  workerId: string,
  qaAttempt: number,
  qaFeedback?: string,
): void {
  let pad = loadWorkpad(workspacePath, featureId);
  if (!pad) {
    pad = createWorkpad(featureId, projectId);
  }

  pad.qaAttempt = qaAttempt;
  pad.status = qaAttempt > 1 ? 'rework' : 'dev';

  const phase = qaAttempt > 1 ? 'rework' : 'dev';
  pad.timeline.push({
    content:
      qaAttempt > 1
        ? `[rework:${qaAttempt}] 开始重做 by ${workerId}. QA 反馈: ${(qaFeedback || '').slice(0, 200)}`
        : `[dev:start] 开发开始 by ${workerId}`,
    timestamp: Date.now(),
    source: 'harness',
    phase,
  });

  if (qaFeedback) {
    pad.lastQAFeedback = qaFeedback;
  }

  saveWorkpad(workspacePath, pad);
}

/**
 * [Harness] 开发阶段完成
 */
export function workpadDevDone(
  workspacePath: string,
  featureId: string,
  filesWritten: string[],
  iterations: number,
  cost: number,
): void {
  const pad = loadWorkpad(workspacePath, featureId);
  if (!pad) return;

  pad.status = 'reviewing';

  // Merge files (deduplicate)
  const fileSet = new Set(pad.filesWritten);
  for (const f of filesWritten) fileSet.add(f);
  pad.filesWritten = [...fileSet];

  pad.timeline.push({
    content: `[dev:done] 完成 ${filesWritten.length} 文件, ${iterations} 轮, $${cost.toFixed(4)}`,
    timestamp: Date.now(),
    source: 'harness',
    phase: pad.qaAttempt > 1 ? 'rework' : 'dev',
  });

  saveWorkpad(workspacePath, pad);
}

/**
 * [Harness] QA 审查结果
 */
export function workpadQAResult(
  workspacePath: string,
  featureId: string,
  verdict: 'pass' | 'fail',
  score: number,
  feedback: string,
): void {
  const pad = loadWorkpad(workspacePath, featureId);
  if (!pad) return;

  pad.lastQAScore = score;
  if (verdict === 'fail') {
    pad.lastQAFeedback = feedback;
    pad.status = 'rework';
  } else {
    pad.status = 'done';
  }

  pad.timeline.push({
    content: `[qa:${verdict}] 分数 ${score}: ${(feedback || '').slice(0, 200)}`,
    timestamp: Date.now(),
    source: 'harness',
    phase: 'qa',
  });

  saveWorkpad(workspacePath, pad);
}

/**
 * [Harness] Feature 暂停 (达到 max iterations)
 */
export function workpadPaused(workspacePath: string, featureId: string, iterations: number, reason: string): void {
  const pad = loadWorkpad(workspacePath, featureId);
  if (!pad) return;

  pad.status = 'paused';
  pad.timeline.push({
    content: `[paused] ${iterations} 轮后暂停: ${reason}`,
    timestamp: Date.now(),
    source: 'harness',
    phase: 'dev',
  });

  saveWorkpad(workspacePath, pad);
}

/**
 * [Harness] Feature 恢复执行
 */
export function workpadResumed(workspacePath: string, featureId: string, workerId: string): void {
  const pad = loadWorkpad(workspacePath, featureId);
  if (!pad) return;

  pad.status = pad.qaAttempt > 1 ? 'rework' : 'dev';
  pad.timeline.push({
    content: `[resumed] 恢复执行 by ${workerId}`,
    timestamp: Date.now(),
    source: 'harness',
    phase: 'resume',
  });

  saveWorkpad(workspacePath, pad);
}

/**
 * [Agent] 记录关键决策
 */
export function workpadRecordDecision(workspacePath: string, featureId: string, decision: string): void {
  const pad = loadWorkpad(workspacePath, featureId);
  if (!pad) return;

  pad.decisions.push(decision.slice(0, 300));
  if (pad.decisions.length > 20) {
    pad.decisions = pad.decisions.slice(-20);
  }

  pad.timeline.push({
    content: `[decision] ${decision.slice(0, 150)}`,
    timestamp: Date.now(),
    source: 'agent',
    phase: pad.status === 'rework' ? 'rework' : 'dev',
  });

  saveWorkpad(workspacePath, pad);
}

/**
 * [Agent] 记录已知问题
 */
export function workpadRecordIssue(workspacePath: string, featureId: string, issue: string): void {
  const pad = loadWorkpad(workspacePath, featureId);
  if (!pad) return;

  pad.knownIssues.push(issue.slice(0, 300));
  if (pad.knownIssues.length > 15) {
    pad.knownIssues = pad.knownIssues.slice(-15);
  }

  saveWorkpad(workspacePath, pad);
}

// ═══════════════════════════════════════
// Context Generation — 注入 prompt
// ═══════════════════════════════════════

/**
 * 将 Workpad 格式化为可注入 prompt 的上下文文本。
 *
 * 这是 Symphony "continuation context" 的核心 — 让 Agent 在重试/恢复时
 * 立即了解之前做了什么、QA 说了什么、有什么已知问题。
 */
export function formatWorkpadForPrompt(workspacePath: string, featureId: string): string | null {
  const pad = loadWorkpad(workspacePath, featureId);
  if (!pad) return null;

  // 如果是全新的 (只有一个 dev:start entry), 不注入
  if (pad.timeline.length <= 1 && pad.qaAttempt <= 1) return null;

  const sections: string[] = [];

  // Header
  sections.push(`## 📋 Feature Workpad — ${featureId}`);
  sections.push(`当前状态: ${pad.status} | QA 尝试: #${pad.qaAttempt} | 文件: ${pad.filesWritten.length} 个`);

  // QA feedback (most important for rework)
  if (pad.lastQAFeedback && pad.qaAttempt > 1) {
    sections.push(`\n### ❌ 上次 QA 反馈 (分数: ${pad.lastQAScore ?? '?'})`);
    sections.push(pad.lastQAFeedback.slice(0, 800));
  }

  // Files written
  if (pad.filesWritten.length > 0) {
    const files = pad.filesWritten.slice(-20);
    sections.push(`\n### 📁 已修改文件 (${pad.filesWritten.length})`);
    sections.push(files.join('\n'));
  }

  // Decisions
  if (pad.decisions.length > 0) {
    const recent = pad.decisions.slice(-5);
    sections.push(`\n### 🎯 之前的关键决策`);
    sections.push(recent.map(d => `- ${d}`).join('\n'));
  }

  // Known issues
  if (pad.knownIssues.length > 0) {
    const recent = pad.knownIssues.slice(-5);
    sections.push(`\n### ⚠️ 已知问题`);
    sections.push(recent.map(d => `- ${d}`).join('\n'));
  }

  // Timeline summary (last 5 entries)
  const recentTimeline = pad.timeline.slice(-5);
  if (recentTimeline.length > 0) {
    sections.push(`\n### 📊 最近进展`);
    sections.push(
      recentTimeline
        .map(e => {
          const time = new Date(e.timestamp).toISOString().slice(11, 19);
          return `- [${time}] ${e.content}`;
        })
        .join('\n'),
    );
  }

  return sections.join('\n');
}

/**
 * 生成续跑指令 — 当 Feature 从暂停/失败恢复时, 注入特定的行为指导。
 */
export function buildContinuationDirective(workspacePath: string, featureId: string, qaAttempt: number): string {
  const pad = loadWorkpad(workspacePath, featureId);
  if (!pad) return '';

  if (qaAttempt <= 1 && pad.status !== 'paused') return '';

  const directives: string[] = [];

  if (pad.status === 'paused') {
    directives.push(
      `⚡ 这是一个**恢复的任务** — 之前因达到轮数上限而暂停。`,
      `请先 read_file/search_files 检查已完成的部分, 然后从断点继续。不要重做已完成的工作。`,
    );
  }

  if (qaAttempt > 1) {
    directives.push(
      `⚡ 这是第 ${qaAttempt} 次 QA 尝试 — 之前的尝试未通过审查。`,
      `**必须优先修复 QA 反馈中指出的问题**, 不要忽略或遗漏任何一项。`,
      `请先查看 Workpad 中的 QA 反馈, 然后制定修复计划。`,
    );
  }

  if (pad.knownIssues.length > 0) {
    directives.push(`已知的 ${pad.knownIssues.length} 个问题需要关注。`);
  }

  return directives.length > 0 ? `\n## 🔄 续跑指令 (Continuation Context)\n${directives.join('\n')}` : '';
}

// ═══════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════

/** 删除 Feature 的 Workpad */
export function clearWorkpad(workspacePath: string, featureId: string): void {
  const filePath = workpadFile(workspacePath, featureId);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* silent */
  }
}

/** 列出所有 Workpad */
export function listWorkpads(workspacePath: string): string[] {
  const dir = workpadDir(workspacePath);
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}
