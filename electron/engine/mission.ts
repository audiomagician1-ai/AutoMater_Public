/**
 * Multi-day Missions — 长期任务管理 + 断点续跑 + 进度检查点
 *
 * 支持项目跨 session 自主执行:
 *  - 检查点 (Checkpoint): 在关键节点保存完整状态快照
 *  - 断点续跑 (Resume): 从最近检查点恢复执行
 *  - 进度报告 (Progress Report): 定期生成项目进度摘要
 *  - 自动恢复: 应用重启后检测未完成项目，提示/自动续跑
 *
 * 对标: Factory Missions (多日自主执行)
 *
 * v2.0.0: 初始实现
 */

import { getDb } from '../db';
import fs from 'fs';
import path from 'path';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface Checkpoint {
  id: number;
  projectId: string;
  /** 检查点标签 (如 "PM完成", "F003通过", "第5个Feature") */
  label: string;
  /** 项目状态 */
  projectStatus: string;
  /** 已完成 feature 数 */
  featuresCompleted: number;
  /** 总 feature 数 */
  featuresTotal: number;
  /** 总消耗 token */
  totalTokens: number;
  /** 总成本 */
  totalCostUsd: number;
  /** 当前活跃 agent 信息快照 */
  agentSnapshot: string; // JSON
  /** 进度摘要 */
  progressSummary: string;
  /** 时间戳 */
  createdAt: string;
}

export interface MissionStatus {
  projectId: string;
  projectName: string;
  wish: string;
  status: string;
  /** 总 feature */
  total: number;
  /** 已通过 */
  passed: number;
  /** 失败 */
  failed: number;
  /** 进行中 */
  inProgress: number;
  /** 总成本 */
  totalCostUsd: number;
  /** 最后检查点 */
  lastCheckpoint: Checkpoint | null;
  /** 可以续跑 */
  canResume: boolean;
  /** 预估剩余成本 (基于平均 per-feature cost) */
  estimatedRemainingCostUsd: number;
}

// ═══════════════════════════════════════
// DB Schema
// ═══════════════════════════════════════

/**
 * 确保 checkpoints 表存在
 */
export function ensureCheckpointTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      label TEXT NOT NULL,
      project_status TEXT NOT NULL,
      features_completed INTEGER NOT NULL DEFAULT 0,
      features_total INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      agent_snapshot TEXT NOT NULL DEFAULT '{}',
      progress_summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_project ON checkpoints(project_id, created_at);
  `);
}

// ═══════════════════════════════════════
// Checkpoint Operations
// ═══════════════════════════════════════

/**
 * 创建一个检查点 (在关键节点调用)
 */
export function createCheckpoint(projectId: string, label: string): Checkpoint | null {
  const db = getDb();

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
  if (!project) return null;

  const featureStats = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) as passed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
           SUM(CASE WHEN status IN ('in_progress', 'reviewing') THEN 1 ELSE 0 END) as in_progress
    FROM features WHERE project_id = ?
  `).get(projectId) as any;

  const costStats = db.prepare(`
    SELECT COALESCE(SUM(total_input_tokens + total_output_tokens), 0) as total_tokens,
           COALESCE(SUM(total_cost_usd), 0) as total_cost
    FROM agents WHERE project_id = ?
  `).get(projectId) as any;

  const agents = db.prepare(
    'SELECT id, role, status, current_task FROM agents WHERE project_id = ?'
  ).all(projectId);

  const progressSummary = [
    `项目: ${project.name}`,
    `状态: ${project.status}`,
    `Features: ${featureStats.passed}/${featureStats.total} 完成`,
    featureStats.failed > 0 ? `失败: ${featureStats.failed}` : '',
    featureStats.in_progress > 0 ? `进行中: ${featureStats.in_progress}` : '',
    `成本: $${costStats.total_cost.toFixed(4)}`,
  ].filter(Boolean).join(' | ');

  const result = db.prepare(`
    INSERT INTO checkpoints (project_id, label, project_status, features_completed, features_total, total_tokens, total_cost_usd, agent_snapshot, progress_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId, label, project.status,
    featureStats.passed, featureStats.total,
    costStats.total_tokens, costStats.total_cost,
    JSON.stringify(agents),
    progressSummary,
  );

  return {
    id: result.lastInsertRowid as number,
    projectId,
    label,
    projectStatus: project.status,
    featuresCompleted: featureStats.passed,
    featuresTotal: featureStats.total,
    totalTokens: costStats.total_tokens,
    totalCostUsd: costStats.total_cost,
    agentSnapshot: JSON.stringify(agents),
    progressSummary,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 获取项目的所有检查点
 */
export function getCheckpoints(projectId: string): Checkpoint[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM checkpoints WHERE project_id = ? ORDER BY created_at ASC'
  ).all(projectId) as any[];

  return rows.map(r => ({
    id: r.id,
    projectId: r.project_id,
    label: r.label,
    projectStatus: r.project_status,
    featuresCompleted: r.features_completed,
    featuresTotal: r.features_total,
    totalTokens: r.total_tokens,
    totalCostUsd: r.total_cost_usd,
    agentSnapshot: r.agent_snapshot,
    progressSummary: r.progress_summary,
    createdAt: r.created_at,
  }));
}

/**
 * 获取最近一个检查点
 */
export function getLatestCheckpoint(projectId: string): Checkpoint | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM checkpoints WHERE project_id = ? ORDER BY id DESC LIMIT 1'
  ).get(projectId) as any;
  if (!row) return null;

  return {
    id: row.id,
    projectId: row.project_id,
    label: row.label,
    projectStatus: row.project_status,
    featuresCompleted: row.features_completed,
    featuresTotal: row.features_total,
    totalTokens: row.total_tokens,
    totalCostUsd: row.total_cost_usd,
    agentSnapshot: row.agent_snapshot,
    progressSummary: row.progress_summary,
    createdAt: row.created_at,
  };
}

// ═══════════════════════════════════════
// Mission Status
// ═══════════════════════════════════════

/**
 * 获取项目的 Mission 状态 (包含续跑判断和成本预估)
 */
export function getMissionStatus(projectId: string): MissionStatus | null {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
  if (!project) return null;

  const featureStats = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) as passed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
           SUM(CASE WHEN status IN ('in_progress', 'reviewing') THEN 1 ELSE 0 END) as in_progress,
           SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as todo
    FROM features WHERE project_id = ?
  `).get(projectId) as any;

  const costStats = db.prepare(
    'SELECT COALESCE(SUM(total_cost_usd), 0) as total_cost FROM agents WHERE project_id = ?'
  ).get(projectId) as any;

  const lastCheckpoint = getLatestCheckpoint(projectId);

  // 可续跑: 状态为 paused/developing/error 且还有未完成 feature
  const canResume = ['paused', 'developing', 'error'].includes(project.status) &&
    (featureStats.todo > 0 || featureStats.in_progress > 0 || featureStats.failed > 0);

  // 预估剩余成本: 基于已完成 feature 的平均成本
  let estimatedRemainingCostUsd = 0;
  if (featureStats.passed > 0) {
    const avgCostPerFeature = costStats.total_cost / featureStats.passed;
    const remaining = featureStats.todo + featureStats.in_progress + featureStats.failed;
    estimatedRemainingCostUsd = avgCostPerFeature * remaining;
  }

  return {
    projectId,
    projectName: project.name,
    wish: project.wish,
    status: project.status,
    total: featureStats.total,
    passed: featureStats.passed,
    failed: featureStats.failed,
    inProgress: featureStats.in_progress,
    totalCostUsd: costStats.total_cost,
    lastCheckpoint,
    canResume,
    estimatedRemainingCostUsd,
  };
}

/**
 * 检测所有可续跑的项目 (应用启动时调用)
 */
export function detectResumableProjects(): MissionStatus[] {
  const db = getDb();
  const projects = db.prepare(
    "SELECT id FROM projects WHERE status IN ('paused', 'developing', 'error') ORDER BY updated_at DESC"
  ).all() as any[];

  return projects
    .map(p => getMissionStatus(p.id))
    .filter((s): s is MissionStatus => s !== null && s.canResume);
}

/**
 * 生成进度报告 (Markdown)
 */
export function generateProgressReport(projectId: string): string {
  const status = getMissionStatus(projectId);
  if (!status) return '项目不存在';

  const db = getDb();
  const features = db.prepare(
    'SELECT id, title, status, completed_at FROM features WHERE project_id = ? ORDER BY priority, id'
  ).all(projectId) as any[];

  const checkpoints = getCheckpoints(projectId);

  const statusEmoji: Record<string, string> = {
    todo: '⬜', in_progress: '🔄', reviewing: '🔍',
    passed: '✅', failed: '❌',
  };

  const lines = [
    `# 项目进度报告: ${status.projectName}`,
    `> 生成时间: ${new Date().toISOString()}`,
    '',
    `## 概览`,
    `- 状态: ${status.status}`,
    `- 进度: ${status.passed}/${status.total} Features 完成 (${Math.round(status.passed / Math.max(status.total, 1) * 100)}%)`,
    `- 总成本: $${status.totalCostUsd.toFixed(4)}`,
    status.estimatedRemainingCostUsd > 0
      ? `- 预估剩余成本: $${status.estimatedRemainingCostUsd.toFixed(4)}`
      : '',
    '',
    `## Feature 状态`,
  ];

  for (const f of features) {
    const emoji = statusEmoji[f.status] || '❓';
    const time = f.completed_at ? ` (${f.completed_at})` : '';
    lines.push(`${emoji} ${f.id}: ${f.title}${time}`);
  }

  if (checkpoints.length > 0) {
    lines.push('', '## 检查点历史');
    for (const cp of checkpoints) {
      lines.push(`- [${cp.createdAt}] ${cp.label} — ${cp.progressSummary}`);
    }
  }

  return lines.filter(l => l !== undefined).join('\n');
}
