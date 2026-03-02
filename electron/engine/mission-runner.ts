/**
 * Mission Runner — 临时工作流引擎 (v5.5)
 *
 * 参考架构:
 * - Cursor 2026: Planner → Worker → Judge 三层模式
 * - Society Agent (TechRxiv 2026): Persistent supervisors + Ephemeral workers
 * - Gas Town (Yegge 2026): Polecats (spawn → complete → disappear)
 *
 * 执行流程: create → plan → execute(parallel) → judge → archive
 *
 * @module mission-runner
 */

import { getDb } from '../db';
import { callLLM, getSettings } from './llm-client';
import { sendToUI, addLog } from './ui-bridge';
import { createLogger } from './logger';
import { BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';

const log = createLogger('mission-runner');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export type MissionType =
  | 'regression_test'
  | 'code_review'
  | 'retrospective'
  | 'security_audit'
  | 'perf_benchmark'
  | 'custom';

export type MissionStatus =
  | 'pending'
  | 'planning'
  | 'executing'
  | 'judging'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface MissionConfig {
  /** 作用范围: 文件 glob / feature ids / 'all' */
  scope?: string;
  /** Token 预算上限 */
  tokenBudget?: number;
  /** 最大存活时间 (小时) */
  ttlHours?: number;
  /** 并行 worker 数 */
  maxWorkers?: number;
  /** 用户自定义指令 */
  customInstruction?: string;
  /** v6.0: 归档策略 — 控制任务完成后如何处理中间数据 */
  archivePolicy?: 'keep-all' | 'keep-conclusion' | 'delete';
}

export interface MissionTask {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  input: string;   // JSON
  output?: string;  // JSON
}

export interface MissionResult {
  missionId: string;
  conclusion: string;
  patches: Array<{ file: string; diff: string; description: string }>;
  stats: {
    totalTasks: number;
    passed: number;
    failed: number;
    skipped: number;
    tokenUsage: number;
    costUsd: number;
  };
}

// ═══════════════════════════════════════
// Mission CRUD
// ═══════════════════════════════════════

export function createMission(
  projectId: string,
  type: MissionType,
  config: MissionConfig = {},
): string {
  const db = getDb();
  const id = `mission-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  db.prepare(`
    INSERT INTO missions (id, project_id, type, status, config)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(id, projectId, type, JSON.stringify(config));

  log.info('Mission created', { id, projectId, type });
  return id;
}

export function getMission(missionId: string) {
  const db = getDb();
  return db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId) as any;
}

export function listMissions(projectId: string) {
  const db = getDb();
  return db.prepare('SELECT * FROM missions WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as any[];
}

export function getMissionTasks(missionId: string) {
  const db = getDb();
  return db.prepare('SELECT * FROM mission_tasks WHERE mission_id = ? ORDER BY created_at').all(missionId) as any[];
}

// ═══════════════════════════════════════
// Mission Type Prompts
// ═══════════════════════════════════════

const MISSION_PROMPTS: Record<MissionType, {
  plannerPrompt: string;
  workerPrompt: string;
  judgePrompt: string;
}> = {
  regression_test: {
    plannerPrompt: `你是 QA 规划专家。分析项目的所有 features 和测试规格，生成全量回归测试任务清单。
每个任务应覆盖一个 feature 或功能模块。输出 JSON 数组: [{"title": "测试xxx", "input": "相关文件和测试标准"}]`,
    workerPrompt: `你是 QA 测试工程师。根据提供的代码和测试规格，评估该功能是否正确实现。
输出 JSON: {"passed": true/false, "issues": ["问题描述"], "severity": "critical/major/minor", "fixSuggestion": "修复建议"}`,
    judgePrompt: `你是 QA 主管。汇总所有测试结果，生成回归测试报告。
判断: 如果通过率 >= 95% 则 PASS，否则 FAIL。输出总结、关键问题、修复优先级。`,
  },
  code_review: {
    plannerPrompt: `你是代码审查规划专家。扫描工作区代码文件，按模块/功能分组，生成审查任务清单。
关注: 代码质量、安全漏洞、性能问题、一致性。输出 JSON 数组。`,
    workerPrompt: `你是高级代码审查员。审查提供的代码文件，检查:
1. 代码质量 (命名、结构、DRY、SOLID)
2. 安全性 (注入、泄露、认证)
3. 性能 (N+1查询、内存泄漏、不必要的计算)
4. 可维护性 (复杂度、文档)
输出 JSON: {"score": 1-10, "issues": [{"severity": "...", "file": "...", "line": N, "description": "..."}], "suggestions": [...]}`,
    judgePrompt: `你是技术总监。汇总所有模块的审查结果，生成代码质量报告。
给出总体评分、Top 问题、改进路线图。`,
  },
  retrospective: {
    plannerPrompt: `你是架构复盘专家。分析项目的设计文档、代码结构和 feature 完成情况。
生成多维度复盘任务: 架构合理性、技术债、性能瓶颈、扩展性、团队协作效率。输出 JSON 数组。`,
    workerPrompt: `你是技术分析师。针对指定维度深入分析项目现状。
输出 JSON: {"dimension": "...", "currentState": "...", "problems": [...], "recommendations": [...], "priority": "high/medium/low"}`,
    judgePrompt: `你是 CTO。汇总所有维度分析，生成项目复盘报告。
输出: 项目健康度评分、关键决策回顾、下阶段改进计划。`,
  },
  security_audit: {
    plannerPrompt: `你是安全审计规划师。扫描项目代码，识别需要安全审计的区域。
关注: 认证/授权、数据处理、API 安全、依赖漏洞、配置安全。输出 JSON 任务清单。`,
    workerPrompt: `你是安全工程师。审查代码的安全性。
检查 OWASP Top 10、CWE 常见漏洞、硬编码密钥、不安全的依赖。
输出 JSON: {"vulnerabilities": [{"cwe": "...", "severity": "critical/high/medium/low", "file": "...", "description": "...", "remediation": "..."}]}`,
    judgePrompt: `你是 CISO。汇总安全审计结果，按 CVSS 评分排序。
输出: 安全评级、关键漏洞、修复时间线。`,
  },
  perf_benchmark: {
    plannerPrompt: `你是性能工程师。分析项目架构，识别需要性能评估的关键路径。
关注: 启动时间、内存使用、API 响应时间、数据库查询效率。输出 JSON 任务清单。`,
    workerPrompt: `你是性能分析师。分析指定代码路径的性能特征。
识别: 时间复杂度、空间复杂度、I/O 瓶颈、可并行化机会。
输出 JSON: {"hotspots": [...], "optimization": [...], "estimatedImpact": "..."}`,
    judgePrompt: `你是性能架构师。汇总性能分析，生成优化路线图。
输出: 性能基线、Top 瓶颈、优化方案和预期收益。`,
  },
  custom: {
    plannerPrompt: `你是项目管理专家。根据用户的自定义指令，分析范围并拆解为具体任务。输出 JSON 数组。`,
    workerPrompt: `你是全栈工程师。按照任务描述执行分析和处理。输出 JSON 格式的结果。`,
    judgePrompt: `你是项目负责人。汇总所有任务结果，生成综合报告。`,
  },
};

// ═══════════════════════════════════════
// Mission Execution Engine
// ═══════════════════════════════════════

/**
 * 运行一个 Mission 的完整生命周期
 *
 * Phase 1: Planning (Planner Agent)
 * Phase 2: Executing (Worker Agents, 可并行)
 * Phase 3: Judging (Judge Agent)
 * Phase 4: Archiving
 */
export async function runMission(
  missionId: string,
  win: BrowserWindow | null,
  signal?: AbortSignal,
): Promise<MissionResult> {
  const db = getDb();
  const settings = getSettings();
  if (!settings?.apiKey) throw new Error('No LLM settings configured');

  const mission = getMission(missionId);
  if (!mission) throw new Error(`Mission ${missionId} not found`);

  const projectId = mission.project_id;
  const type = mission.type as MissionType;
  const config: MissionConfig = JSON.parse(mission.config || '{}');
  const prompts = MISSION_PROMPTS[type] || MISSION_PROMPTS.custom;

  // Get project context
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
  if (!project) throw new Error('Project not found');

  const workspacePath = project.workspace_path;
  const missionDir = path.join(workspacePath, '.automater', 'missions', missionId);
  fs.mkdirSync(missionDir, { recursive: true });

  let totalTokens = 0;
  let totalCost = 0;

  const emitProgress = (phase: string, step: string) => {
    sendToUI(win, 'agent:log', {
      projectId,
      agentId: `mission-${type}`,
      content: `[${missionId.slice(-6)}] ${phase}: ${step}`,
    });
    sendToUI(win, 'mission:progress', { missionId, projectId, phase, step });
  };

  try {
    // ════════════════════════════════════
    // v6.0: TTL 超时检查 — 如果任务已过期则立即失败
    // ════════════════════════════════════
    const ttlMs = (config.ttlHours || 24) * 3600 * 1000;
    const startTime = new Date(mission.created_at).getTime();
    const checkTTL = () => {
      if (Date.now() - startTime > ttlMs) {
        throw new Error(`TTL expired: mission exceeded ${config.ttlHours || 24} hours`);
      }
    };
    checkTTL();

    // ════════════════════════════════════
    // Phase 1: PLANNING
    // ════════════════════════════════════
    db.prepare("UPDATE missions SET status = 'planning', started_at = datetime('now') WHERE id = ?").run(missionId);
    emitProgress('📋 Planning', '规划任务范围...');

    // Collect project context for planner
    const features = db.prepare('SELECT id, title, status, category FROM features WHERE project_id = ?').all(projectId) as any[];
    const contextParts = [
      `项目: ${project.name}`,
      `Features (${features.length}个):`,
      ...features.map((f: any) => `  - [${f.status}] ${f.title}`),
    ];

    // Read architecture doc if exists
    const archPath = path.join(workspacePath, '.automater', 'docs', 'ARCHITECTURE.md');
    if (fs.existsSync(archPath)) {
      contextParts.push(`\n架构文档(前3000字):\n${fs.readFileSync(archPath, 'utf-8').slice(0, 3000)}`);
    }

    // Scope instruction
    if (config.customInstruction) {
      contextParts.push(`\n用户指令: ${config.customInstruction}`);
    }

    const planResult = await callLLM(settings, settings.strongModel, [
      { role: 'system', content: prompts.plannerPrompt },
      { role: 'user', content: contextParts.join('\n') },
    ], signal, 8192);
    totalTokens += planResult.inputTokens + planResult.outputTokens;

    // Parse plan into tasks
    let tasks: Array<{ title: string; input: string }> = [];
    try {
      const jsonMatch = planResult.content.match(/\[[\s\S]*\]/);
      if (jsonMatch) tasks = JSON.parse(jsonMatch[0]);
    } catch {
      log.warn('Failed to parse planner output as JSON, creating single task');
      tasks = [{ title: '全量分析', input: planResult.content }];
    }

    // Limit tasks
    const maxTasks = Math.min(tasks.length, 20);
    tasks = tasks.slice(0, maxTasks);

    // Insert tasks into DB
    for (const task of tasks) {
      const taskId = `mt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      db.prepare('INSERT INTO mission_tasks (id, mission_id, title, status, input) VALUES (?, ?, ?, ?, ?)')
        .run(taskId, missionId, task.title, 'pending', typeof task.input === 'string' ? task.input : JSON.stringify(task.input));
    }

    db.prepare('UPDATE missions SET plan = ? WHERE id = ?').run(JSON.stringify(tasks), missionId);
    emitProgress('📋 Planning', `已规划 ${tasks.length} 个任务`);

    if (signal?.aborted) throw new Error('Cancelled');
    checkTTL();

    // ════════════════════════════════════
    // Phase 2: EXECUTING (Workers)
    // ════════════════════════════════════
    db.prepare("UPDATE missions SET status = 'executing' WHERE id = ?").run(missionId);
    emitProgress('⚡ Executing', `开始执行 ${tasks.length} 个任务...`);

    const missionTasks = getMissionTasks(missionId);
    const maxParallel = config.maxWorkers || 3;
    const tokenBudget = config.tokenBudget || 100000;

    // Execute tasks (batched parallel)
    const allPatches: Array<{ file: string; diff: string; description: string }> = [];

    for (let i = 0; i < missionTasks.length; i += maxParallel) {
      if (signal?.aborted) throw new Error('Cancelled');
      checkTTL();
      if (totalTokens > tokenBudget) {
        emitProgress('⚠️ Budget', `Token 预算用尽 (${totalTokens}/${tokenBudget}), 跳过剩余任务`);
        break;
      }

      const batch = missionTasks.slice(i, i + maxParallel);
      emitProgress('⚡ Executing', `任务 ${i + 1}-${Math.min(i + maxParallel, missionTasks.length)}/${missionTasks.length}`);

      const results = await Promise.allSettled(
        batch.map(async (task: any) => {
          db.prepare("UPDATE mission_tasks SET status = 'running', agent_id = ? WHERE id = ?")
            .run(`worker-${task.id.slice(-4)}`, task.id);

          const workerResult = await callLLM(settings, settings.workerModel, [
            { role: 'system', content: prompts.workerPrompt },
            { role: 'user', content: `任务: ${task.title}\n\n输入:\n${task.input}` },
          ], signal, 4096);

          totalTokens += workerResult.inputTokens + workerResult.outputTokens;

          db.prepare("UPDATE mission_tasks SET status = 'passed', output = ?, completed_at = datetime('now') WHERE id = ?")
            .run(workerResult.content, task.id);

          // v6.0: 提取 Worker 产出中的 patches (文件修改建议)
          const taskPatches = extractPatches(workerResult.content, task.title);
          allPatches.push(...taskPatches);

          return { taskId: task.id, output: workerResult.content };
        }),
      );

      // Handle failures
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'rejected') {
          const err = (results[j] as PromiseRejectedResult).reason;
          db.prepare("UPDATE mission_tasks SET status = 'failed', output = ?, completed_at = datetime('now') WHERE id = ?")
            .run(JSON.stringify({ error: (err instanceof Error ? err.message : String(err)) }), batch[j].id);
        }
      }
    }

    if (signal?.aborted) throw new Error('Cancelled');
    checkTTL();

    // ════════════════════════════════════
    // Phase 3: JUDGING
    // ════════════════════════════════════
    db.prepare("UPDATE missions SET status = 'judging' WHERE id = ?").run(missionId);
    emitProgress('⚖️ Judging', '评估结果...');

    const completedTasks = getMissionTasks(missionId);
    const taskSummaries = completedTasks.map((t: any) =>
      `[${t.status}] ${t.title}: ${(t.output || '').slice(0, 500)}`
    ).join('\n\n');

    const judgeResult = await callLLM(settings, settings.strongModel, [
      { role: 'system', content: prompts.judgePrompt },
      { role: 'user', content: `任务结果汇总 (${completedTasks.length} 个):\n\n${taskSummaries}` },
    ], signal, 8192);
    totalTokens += judgeResult.inputTokens + judgeResult.outputTokens;

    // Calculate cost (approximate)
    totalCost = totalTokens * 0.000003; // rough average

    const stats = {
      totalTasks: completedTasks.length,
      passed: completedTasks.filter((t: any) => t.status === 'passed').length,
      failed: completedTasks.filter((t: any) => t.status === 'failed').length,
      skipped: completedTasks.filter((t: any) => t.status === 'skipped').length,
      tokenUsage: totalTokens,
      costUsd: totalCost,
    };

    // ════════════════════════════════════
    // Phase 4: ARCHIVING
    // ════════════════════════════════════
    const conclusion = judgeResult.content;

    // Save conclusion to file
    fs.writeFileSync(
      path.join(missionDir, 'conclusion.md'),
      `# Mission: ${type}\n\n${conclusion}\n\n---\nStats: ${JSON.stringify(stats, null, 2)}`,
    );

    // v6.0: 保存 patches
    if (allPatches.length > 0) {
      fs.writeFileSync(
        path.join(missionDir, 'patches.json'),
        JSON.stringify(allPatches, null, 2),
      );
    }

    db.prepare(`
      UPDATE missions SET
        status = 'completed',
        conclusion = ?,
        token_usage = ?,
        cost_usd = ?,
        completed_at = datetime('now')
      WHERE id = ?
    `).run(conclusion, totalTokens, totalCost, missionId);

    emitProgress('✅ Completed', `完成! ${stats.passed}/${stats.totalTasks} 通过, $${totalCost.toFixed(4)}${allPatches.length ? `, ${allPatches.length} 个修复建议` : ''}`);

    // v6.0: 归档策略
    const archivePolicy = config.archivePolicy || 'keep-all';
    if (archivePolicy === 'delete') {
      // 删除任务明细和工作目录, 只保留 missions 表记录
      db.prepare('DELETE FROM mission_tasks WHERE mission_id = ?').run(missionId);
      if (fs.existsSync(missionDir)) fs.rmSync(missionDir, { recursive: true, force: true });
    } else if (archivePolicy === 'keep-conclusion') {
      // 删除任务明细, 保留 conclusion 文件
      db.prepare('DELETE FROM mission_tasks WHERE mission_id = ?').run(missionId);
      const patchesFile = path.join(missionDir, 'patches.json');
      // 保留 conclusion.md 和 patches.json, 删除其他
    }
    // 'keep-all' — 不做任何清理

    return { missionId, conclusion, patches: allPatches, stats };

  } catch (err: unknown) {
    if ((err instanceof Error ? err.message : String(err)) === 'Cancelled') {
      db.prepare("UPDATE missions SET status = 'cancelled', completed_at = datetime('now') WHERE id = ?").run(missionId);
      emitProgress('⏹ Cancelled', '任务已取消');
    } else {
      db.prepare("UPDATE missions SET status = 'failed', conclusion = ?, completed_at = datetime('now') WHERE id = ?")
        .run(`❌ 执行失败: ${(err instanceof Error ? err.message : String(err))}`, missionId);
      emitProgress('❌ Failed', (err instanceof Error ? err.message : String(err)));
    }
    throw err;
  }
}

// ═══════════════════════════════════════
// Mission Lifecycle Management
// ═══════════════════════════════════════

/** 取消正在运行的 mission */
export function cancelMission(missionId: string) {
  const db = getDb();
  db.prepare("UPDATE missions SET status = 'cancelled', completed_at = datetime('now') WHERE id = ?").run(missionId);
  db.prepare("UPDATE mission_tasks SET status = 'skipped' WHERE mission_id = ? AND status IN ('pending', 'running')").run(missionId);
}

/** 清理已完成的 mission 工作目录 */
export function cleanupMission(missionId: string) {
  const db = getDb();
  const mission = getMission(missionId);
  if (!mission) return;

  const project = db.prepare('SELECT workspace_path FROM projects WHERE id = ?').get(mission.project_id) as any;
  if (project?.workspace_path) {
    const missionDir = path.join(project.workspace_path, '.automater', 'missions', missionId);
    if (fs.existsSync(missionDir)) {
      fs.rmSync(missionDir, { recursive: true, force: true });
    }
  }

  // Keep DB records but clear intermediate data
  db.prepare('DELETE FROM mission_tasks WHERE mission_id = ?').run(missionId);
}

/** 删除 mission 及其所有数据 */
export function deleteMission(missionId: string) {
  const db = getDb();
  cleanupMission(missionId);
  db.prepare('DELETE FROM missions WHERE id = ?').run(missionId);
}

// ═══════════════════════════════════════
// v6.0: Patch 提取 — 从 Worker 输出中解析文件修改建议
// ═══════════════════════════════════════

/**
 * 从 Worker LLM 输出中提取文件修改建议。
 * 支持两种格式:
 * 1. JSON 格式: {"patches": [{"file": "...", "diff": "...", "description": "..."}]}
 * 2. Markdown diff 格式: ```diff\n--- a/file\n+++ b/file\n@@ ... @@\n```
 */
function extractPatches(
  output: string,
  taskTitle: string,
): Array<{ file: string; diff: string; description: string }> {
  const patches: Array<{ file: string; diff: string; description: string }> = [];

  // Attempt 1: 解析 JSON patches 字段
  try {
    const jsonMatch = output.match(/\{[\s\S]*"patches"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.patches)) {
        for (const p of parsed.patches) {
          if (p.file && (p.diff || p.description)) {
            patches.push({
              file: String(p.file),
              diff: String(p.diff || ''),
              description: String(p.description || ''),
            });
          }
        }
        if (patches.length > 0) return patches;
      }
    }
  } catch { /* not valid JSON, try other formats */ }

  // Attempt 2: 解析 Markdown diff 代码块
  const diffBlocks = output.matchAll(/```diff\n([\s\S]*?)```/g);
  for (const match of diffBlocks) {
    const diffContent = match[1];
    // Extract file name from --- a/file or +++ b/file
    const fileMatch = diffContent.match(/(?:---|\+\+\+)\s+[ab]\/(.+)/);
    const file = fileMatch?.[1]?.trim() || 'unknown';
    patches.push({
      file,
      diff: diffContent.trim(),
      description: `来自任务: ${taskTitle}`,
    });
  }

  // Attempt 3: 解析 "fixSuggestion" 字段 (用于 regression_test / code_review)
  try {
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.fixSuggestion && parsed.file) {
        patches.push({
          file: String(parsed.file || 'unknown'),
          diff: '',
          description: String(parsed.fixSuggestion),
        });
      }
      // code_review format: issues with file + remediation
      if (Array.isArray(parsed.issues)) {
        for (const issue of parsed.issues) {
          if (issue.file && (issue.remediation || issue.description)) {
            patches.push({
              file: String(issue.file),
              diff: '',
              description: `[${issue.severity || 'info'}] ${issue.description || ''} → ${issue.remediation || ''}`.trim(),
            });
          }
        }
      }
      // security_audit format: vulnerabilities
      if (Array.isArray(parsed.vulnerabilities)) {
        for (const vuln of parsed.vulnerabilities) {
          if (vuln.file) {
            patches.push({
              file: String(vuln.file),
              diff: '',
              description: `[${vuln.cwe || vuln.severity || 'security'}] ${vuln.description || ''} → ${vuln.remediation || ''}`.trim(),
            });
          }
        }
      }
    }
  } catch { /* not valid JSON */ }

  return patches;
}

// ═══════════════════════════════════════
// v6.0: Mission 获取 patches
// ═══════════════════════════════════════

/** 获取 mission 的所有修复建议 */
export function getMissionPatches(missionId: string): Array<{ file: string; diff: string; description: string }> {
  const mission = getMission(missionId);
  if (!mission) return [];

  const db = getDb();
  const project = db.prepare('SELECT workspace_path FROM projects WHERE id = ?').get(mission.project_id) as any;
  if (!project?.workspace_path) return [];

  const patchesFile = path.join(project.workspace_path, '.automater', 'missions', missionId, 'patches.json');
  if (fs.existsSync(patchesFile)) {
    try {
      return JSON.parse(fs.readFileSync(patchesFile, 'utf-8'));
    } catch { /* corrupted file */ }
  }
  return [];
}
