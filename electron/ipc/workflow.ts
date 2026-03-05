/**
 * IPC handlers: 工作流预设管理 (v12.0)
 *
 * - CRUD for workflow presets
 * - 内置 3 种预设自动初始化
 * - 选中/激活工作流
 */

import { ipcMain } from 'electron';
import { getDb } from '../db';
import type { WorkflowPresetRow, WorkflowPreset, WorkflowStage, WorkflowTransition } from '../engine/types';
import { assertNonEmptyString, assertProjectId, assertObject } from './ipc-validator';
import { createLogger } from '../engine/logger';
const log = createLogger('ipc:workflow');


// ═══════════════════════════════════════
// Built-in Workflow Presets (3 种常用预设)
// ═══════════════════════════════════════

const BUILTIN_PRESETS: Array<{
  id: string; name: string; description: string; icon: string; stages: WorkflowStage[];
}> = [
  {
    id: 'builtin-full-dev',
    name: '完整开发',
    description: '从零开始的新项目 — 覆盖需求分析、架构设计、文档生成、开发、QA、验收、构建的全流程',
    icon: '🚀',
    stages: [
      { id: 'pm_analysis',    label: 'PM 需求分析',  icon: '🧠', color: 'bg-violet-500',
        transitions: [{ target: 'architect', condition: 'success' }] },
      { id: 'architect',      label: '架构 + 设计',   icon: '🏗️', color: 'bg-blue-500',
        transitions: [{ target: 'docs_gen', condition: 'success' }] },
      { id: 'docs_gen',       label: '文档生成',      icon: '📋', color: 'bg-cyan-500',
        transitions: [{ target: 'dev_implement', condition: 'success' }] },
      { id: 'dev_implement',  label: '开发实现',      icon: '💻', color: 'bg-amber-500',
        transitions: [
          { target: 'pm_acceptance', condition: 'success' },
          { target: 'dev_implement', condition: 'failure', maxRetries: 3 },
        ] },
      { id: 'qa_review',      label: 'QA 审查',       icon: '🧪', color: 'bg-emerald-500' },
      { id: 'pm_acceptance',  label: 'PM 验收',       icon: '📝', color: 'bg-indigo-500', skippable: true,
        transitions: [{ target: 'incremental_doc_sync', condition: 'success' }, { target: 'incremental_doc_sync', condition: 'failure' }] },
      { id: 'devops_build',   label: 'DevOps 构建',   icon: '🚀', color: 'bg-rose-500', skippable: true },
      { id: 'incremental_doc_sync', label: '文档同步', icon: '📄', color: 'bg-teal-500', skippable: true,
        transitions: [{ target: 'devops_build', condition: 'always' }] },
      { id: 'finalize',       label: '交付',          icon: '🎯', color: 'bg-orange-500' },
    ],
  },
  {
    id: 'builtin-fast-iterate',
    name: '快速迭代',
    description: '已有架构的项目 — 跳过架构设计和文档生成，直接分诊需求后进入开发和QA，快速交付',
    icon: '⚡',
    stages: [
      { id: 'pm_triage',      label: 'PM 分诊',      icon: '🔀', color: 'bg-violet-500',
        transitions: [{ target: 'dev_implement', condition: 'success' }] },
      { id: 'dev_implement',  label: '开发实现',      icon: '💻', color: 'bg-amber-500',
        transitions: [
          { target: 'devops_build', condition: 'success' },
          { target: 'dev_implement', condition: 'failure', maxRetries: 2 },
        ] },
      { id: 'qa_review',      label: 'QA 审查',       icon: '🧪', color: 'bg-emerald-500' },
      { id: 'devops_build',   label: '构建验证',      icon: '🚀', color: 'bg-rose-500', skippable: true },
      { id: 'finalize',       label: '交付',          icon: '🎯', color: 'bg-orange-500' },
    ],
  },
  {
    id: 'builtin-quality-hardening',
    name: '质量加固',
    description: '代码已基本完成 — 专注于质量审查、安全审计、性能基准，输出改进建议和修复补丁',
    icon: '🔬',
    stages: [
      { id: 'static_analysis', label: '静态分析',    icon: '🔍', color: 'bg-blue-500' },
      { id: 'qa_review',       label: '全量 QA',     icon: '🧪', color: 'bg-emerald-500' },
      { id: 'security_audit',  label: '安全审计',    icon: '🔒', color: 'bg-red-500' },
      { id: 'perf_benchmark',  label: '性能基准',    icon: '⚡', color: 'bg-amber-500' },
      { id: 'devops_build',    label: '构建验证',    icon: '🚀', color: 'bg-rose-500', skippable: true },
      { id: 'finalize',        label: '报告输出',    icon: '📊', color: 'bg-orange-500' },
    ],
  },
];

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

function rowToPreset(row: WorkflowPresetRow): WorkflowPreset {
  let stages: WorkflowStage[] = [];
  try { stages = JSON.parse(row.stages); } catch { stages = []; }
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    stages,
    isActive: row.is_active === 1,
    isBuiltin: row.is_builtin === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 确保项目有内置预设 — 首次打开项目时自动创建。
 * 默认激活 "完整开发" 预设。
 */
function ensureBuiltinPresets(projectId: string): void {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM workflow_presets WHERE project_id = ? AND is_builtin = 1')
    .all(projectId) as Array<{ id: string }>;
  const existingIds = new Set(existing.map(r => r.id));

  const insert = db.prepare(`
    INSERT OR IGNORE INTO workflow_presets (id, project_id, name, description, icon, stages, is_active, is_builtin)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `);

  for (const preset of BUILTIN_PRESETS) {
    const pid = `${preset.id}-${projectId}`;
    if (!existingIds.has(pid)) {
      const isActive = preset.id === 'builtin-full-dev' ? 1 : 0;
      insert.run(pid, projectId, preset.name, preset.description, preset.icon, JSON.stringify(preset.stages), isActive);
    }
  }
}

// ═══════════════════════════════════════
// IPC Registration
// ═══════════════════════════════════════

export function registerWorkflowHandlers(): void {
  /** 列出项目的所有工作流预设 (自动初始化内置预设) */
  ipcMain.handle('workflow:list', (_e, projectId: string) => {
    assertProjectId('workflow:list', projectId);
    ensureBuiltinPresets(projectId);
    const db = getDb();
    const rows = db.prepare('SELECT * FROM workflow_presets WHERE project_id = ? ORDER BY is_builtin DESC, created_at ASC')
      .all(projectId) as WorkflowPresetRow[];
    return rows.map(rowToPreset);
  });

  /** 获取项目当前激活的工作流 */
  ipcMain.handle('workflow:get-active', (_e, projectId: string) => {
    assertProjectId('workflow:get-active', projectId);
    ensureBuiltinPresets(projectId);
    const db = getDb();
    const row = db.prepare('SELECT * FROM workflow_presets WHERE project_id = ? AND is_active = 1')
      .get(projectId) as WorkflowPresetRow | undefined;
    return row ? rowToPreset(row) : null;
  });

  /** 获取单个工作流 */
  ipcMain.handle('workflow:get', (_e, presetId: string) => {
    assertNonEmptyString('workflow:get', 'presetId', presetId);
    const db = getDb();
    const row = db.prepare('SELECT * FROM workflow_presets WHERE id = ?').get(presetId) as WorkflowPresetRow | undefined;
    return row ? rowToPreset(row) : null;
  });

  /** 激活某个工作流 (同一项目只能激活一个) */
  ipcMain.handle('workflow:activate', (_e, projectId: string, presetId: string) => {
    assertProjectId('workflow:activate', projectId);
    assertNonEmptyString('workflow:activate', 'presetId', presetId);
    const db = getDb();
    db.prepare('UPDATE workflow_presets SET is_active = 0, updated_at = datetime(\'now\') WHERE project_id = ?').run(projectId);
    db.prepare('UPDATE workflow_presets SET is_active = 1, updated_at = datetime(\'now\') WHERE id = ? AND project_id = ?').run(presetId, projectId);
    return { success: true };
  });

  /** 创建自定义工作流 */
  ipcMain.handle('workflow:create', (_e, projectId: string, data: {
    name: string; description?: string; icon?: string; stages: WorkflowStage[];
  }) => {
    assertProjectId('workflow:create', projectId);
    assertObject('workflow:create', 'data', data);
    assertNonEmptyString('workflow:create', 'data.name', (data as Record<string, unknown>).name);
    const db = getDb();
    const id = `wf-custom-${Date.now().toString(36)}`;
    db.prepare(`
      INSERT INTO workflow_presets (id, project_id, name, description, icon, stages, is_active, is_builtin)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0)
    `).run(id, projectId, data.name, data.description || '', data.icon || '🔧', JSON.stringify(data.stages));
    const row = db.prepare('SELECT * FROM workflow_presets WHERE id = ?').get(id) as WorkflowPresetRow;
    return rowToPreset(row);
  });

  /** 更新工作流 (名称/描述/阶段/图标) */
  ipcMain.handle('workflow:update', (_e, presetId: string, updates: {
    name?: string; description?: string; icon?: string; stages?: WorkflowStage[];
  }) => {
    assertNonEmptyString('workflow:update', 'presetId', presetId);
    assertObject('workflow:update', 'updates', updates);
    const db = getDb();
    const sets: string[] = [];
    const params: Array<string | number | null> = [];

    if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name); }
    if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
    if (updates.icon !== undefined) { sets.push('icon = ?'); params.push(updates.icon); }
    if (updates.stages !== undefined) { sets.push('stages = ?'); params.push(JSON.stringify(updates.stages)); }
    sets.push("updated_at = datetime('now')");
    params.push(presetId);

    if (sets.length > 1) {
      db.prepare(`UPDATE workflow_presets SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
    const row = db.prepare('SELECT * FROM workflow_presets WHERE id = ?').get(presetId) as WorkflowPresetRow;
    return row ? rowToPreset(row) : null;
  });

  /** 删除自定义工作流 (内置不可删除) */
  ipcMain.handle('workflow:delete', (_e, presetId: string) => {
    assertNonEmptyString('workflow:delete', 'presetId', presetId);
    const db = getDb();
    const row = db.prepare('SELECT is_builtin FROM workflow_presets WHERE id = ?').get(presetId) as { is_builtin: number } | undefined;
    if (row?.is_builtin === 1) {
      return { success: false, error: '内置工作流不可删除' };
    }
    db.prepare('DELETE FROM workflow_presets WHERE id = ? AND is_builtin = 0').run(presetId);
    return { success: true };
  });

  /** 复制工作流 (作为自定义副本) */
  ipcMain.handle('workflow:duplicate', (_e, presetId: string) => {
    assertNonEmptyString('workflow:duplicate', 'presetId', presetId);
    const db = getDb();
    const source = db.prepare('SELECT * FROM workflow_presets WHERE id = ?').get(presetId) as WorkflowPresetRow | undefined;
    if (!source) return { success: false, error: '源工作流不存在' };
    const newId = `wf-custom-${Date.now().toString(36)}`;
    db.prepare(`
      INSERT INTO workflow_presets (id, project_id, name, description, icon, stages, is_active, is_builtin)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0)
    `).run(newId, source.project_id, `${source.name} (副本)`, source.description, source.icon, source.stages);
    const row = db.prepare('SELECT * FROM workflow_presets WHERE id = ?').get(newId) as WorkflowPresetRow;
    return rowToPreset(row);
  });

  /** 获取所有可用的阶段定义 (供编辑器选择) */
  ipcMain.handle('workflow:available-stages', () => {
    return AVAILABLE_STAGES;
  });
}

/** 所有可用的工作流阶段 — 供编辑器 UI 使用 */
const AVAILABLE_STAGES: WorkflowStage[] = [
  { id: 'pm_analysis',    label: 'PM 需求分析',     icon: '🧠', color: 'bg-violet-500' },
  { id: 'pm_triage',      label: 'PM 分诊',         icon: '🔀', color: 'bg-violet-500' },
  { id: 'architect',      label: '架构 + 设计',      icon: '🏗️', color: 'bg-blue-500' },
  { id: 'docs_gen',       label: '文档生成',         icon: '📋', color: 'bg-cyan-500' },
  { id: 'dev_implement',  label: '开发实现',         icon: '💻', color: 'bg-amber-500' },
  { id: 'qa_review',      label: 'QA 审查',          icon: '🧪', color: 'bg-emerald-500' },
  { id: 'pm_acceptance',  label: 'PM 验收',          icon: '📝', color: 'bg-indigo-500', skippable: true },
  { id: 'devops_build',   label: 'DevOps 构建',      icon: '🚀', color: 'bg-rose-500', skippable: true },
  { id: 'incremental_doc_sync', label: '增量文档同步', icon: '📄', color: 'bg-teal-500', skippable: true },
  { id: 'static_analysis', label: '静态分析',        icon: '🔍', color: 'bg-blue-500' },
  { id: 'security_audit',  label: '安全审计',        icon: '🔒', color: 'bg-red-500' },
  { id: 'perf_benchmark',  label: '性能基准',        icon: '⚡', color: 'bg-amber-500' },
  { id: 'finalize',        label: '交付 / 报告',     icon: '🎯', color: 'bg-orange-500' },
];