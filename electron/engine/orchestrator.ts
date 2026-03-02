/**
 * Orchestrator — Agent 编排引擎 (5 阶段流水线) — Entry Point
 *
 * Phase functions are extracted to phases/ directory for maintainability.
 * This file retains only: runOrchestrator (main entry), HotJoin, workflow resolver, ensureAgentsMd.
 *
 * v5.0→v6.2: 1884→~600 lines via phases/ extraction.
 */

import { BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { getDb } from '../db';
import { createLogger } from './logger';

const log = createLogger('orchestrator');

// ── Core engine imports (used directly in runOrchestrator) ──
import { getSettings, sleep, validateModel } from './llm-client';
import { sendToUI, notify } from './ui-bridge';
import {
  registerOrchestrator, unregisterOrchestrator, isOrchestratorRunning,
  spawnAgent, getTeamMemberLLMConfig,
} from './agent-manager';
import { gateArchitectToDeveloper } from './guards';
import { commitWorkspace } from './workspace-git';
import { ensureGlobalMemory, ensureProjectMemory } from './memory-system';
import { emitEvent } from './event-store';
import { cleanupDecisionLog } from './decision-log';
import { cleanExpiredLocks } from './file-lock';
import { detectImplicitChanges, runChangeRequest, type WishTriageResult } from './change-manager';
import type { AppSettings, ProjectRow, CountResult, WorkflowStage, WorkflowStageId } from './types';
import type { GitProviderConfig } from './git-provider';

// ── Phase modules (all logic extracted) ──
import {
  phasePMAnalysis, phaseIncrementalPM, phasePMAcceptance,
  phaseArchitect,
  phaseReqsAndTestSpecs, phaseIncrementalDocSync,
  workerLoop,
  phaseDevOpsBuild,
  phaseDeployPipeline,
  phaseFinalize,
  phaseEnvironmentBootstrap,
} from './phases';

// ═══════════════════════════════════════
// Workflow Preset Resolver
// ═══════════════════════════════════════

/** 获取项目当前激活的工作流阶段列表。没有选择时回退到完整开发流程。 */
function getActiveWorkflowStages(projectId: string): WorkflowStageId[] {
  const db = getDb();
  const row = db.prepare('SELECT stages FROM workflow_presets WHERE project_id = ? AND is_active = 1')
    .get(projectId) as { stages: string } | undefined;

  if (!row) {
    // 默认: 完整开发流程
    return ['pm_analysis', 'architect', 'docs_gen', 'dev_implement', 'qa_review', 'pm_acceptance', 'devops_build', 'incremental_doc_sync', 'finalize'];
  }

  try {
    const stages: WorkflowStage[] = JSON.parse(row.stages);
    return stages.map(s => s.id as WorkflowStageId);
  } catch { /* silent: stages JSON parse — use default pipeline */
    return ['pm_analysis', 'architect', 'docs_gen', 'dev_implement', 'qa_review', 'finalize'];
  }
}

/** 检查工作流是否包含指定阶段 */
function hasStage(stages: WorkflowStageId[], stageId: WorkflowStageId): boolean {
  return stages.includes(stageId);
}

/** 模块级成员模型解析器 — 按角色返回该成员实际使用的 LLM 模型名 (供 standalone phase 函数使用) */
function resolveMemberModel(projectId: string, role: string, settings: AppSettings, agentIndex: number = 0): string {
  return getTeamMemberLLMConfig(projectId, role, agentIndex, settings).model;
}

// ═══════════════════════════════════════
// Re-exports (保持向后兼容的 public API)
// ═══════════════════════════════════════

export { stopOrchestrator } from './agent-manager';
export { getAgentReactStates, getContextSnapshots } from './react-loop';
export type { AgentReactState, ReactIterationState, MessageTokenBreakdown, GenericReactConfig, GenericReactResult } from './react-loop';

// ═══════════════════════════════════════
// Hot-Join: 运行中的 Worker Pool 上下文
// ═══════════════════════════════════════

/** 每个 developing 项目的热加入上下文 */
interface HotJoinContext {
  projectId: string;
  qaId: string;
  settings: AppSettings;
  win: BrowserWindow | null;
  signal: AbortSignal;
  workspacePath: string | null;
  gitConfig: GitProviderConfig;
  workerPromises: Set<Promise<void>>;
  /** 已分配的最大 worker 编号 (用于生成唯一 workerId) */
  nextWorkerSeq: number;
  /** v16.0: 项目级权限开关 */
  permissions?: import('./tool-registry').AgentPermissions;
}

/** 活跃的热加入上下文表 (projectId → HotJoinContext) */
const hotJoinContexts = new Map<string, HotJoinContext>();

/**
 * 注册热加入上下文 — 在进入 developing 阶段时调用。
 * orchestrator 结束后自动清理。
 */
function registerHotJoinContext(ctx: HotJoinContext) {
  hotJoinContexts.set(ctx.projectId, ctx);
}

function unregisterHotJoinContext(projectId: string) {
  hotJoinContexts.delete(projectId);
}

/**
 * v9.0: 热加入 IPC 事件监听器 (仅需注册一次)
 * 当 team:add 成功后，project.ts 调用 emitMemberAdded() 触发此监听。
 * 如果该项目当前处于 developing 阶段，立即 spawn 新 worker。
 */
const orchestratorBus = new EventEmitter();
orchestratorBus.setMaxListeners(20);
let hotJoinListenerRegistered = false;

/** project.ts 调用此函数触发热加入事件 */
export function emitMemberAdded(payload: { projectId: string; memberId: string; role: string; name: string }) {
  orchestratorBus.emit('team:member-added', payload);
}

export function ensureHotJoinListener() {
  if (hotJoinListenerRegistered) return;
  hotJoinListenerRegistered = true;

  orchestratorBus.on('team:member-added', (payload: { projectId: string; memberId: string; role: string; name: string }) => {
    const { projectId, memberId, role, name } = payload;

    // 只对 developer 角色做热加入 spawn
    if (role !== 'developer') {
      log.debug(`Hot-join: ignoring non-developer role "${role}" for project ${projectId}`);
      return;
    }

    const ctx = hotJoinContexts.get(projectId);
    if (!ctx) {
      log.debug(`Hot-join: no active developing context for project ${projectId}`);
      return;
    }

    if (ctx.signal.aborted) {
      log.debug(`Hot-join: orchestrator already aborted for project ${projectId}`);
      return;
    }

    // 验证项目确实在 developing 阶段
    const db = getDb();
    const project = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId) as { status: string } | undefined;
    if (project?.status !== 'developing') {
      log.debug(`Hot-join: project ${projectId} not in developing phase (status=${project?.status})`);
      return;
    }

    // 分配 worker ID
    ctx.nextWorkerSeq += 1;
    const workerId = `dev-hot-${ctx.nextWorkerSeq}`;

    log.info(`Hot-join: spawning new worker "${workerId}" for project ${projectId} (member: ${name} [${memberId}])`);
    sendToUI(ctx.win, 'agent:log', {
      projectId,
      agentId: 'system',
      content: `🔥 热加入: "${name}" 已上线为 ${workerId}，立即投入开发`,
    });

    spawnAgent(projectId, workerId, 'developer', ctx.win);
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = ? AND project_id = ?").run(workerId, projectId);

    // 启动 workerLoop — 它会自动从 lockNextFeature 领取任务
    const promise = workerLoop(
      projectId, workerId, ctx.qaId, ctx.settings, ctx.win, ctx.signal,
      ctx.workspacePath, ctx.gitConfig, ctx.permissions,
    );
    ctx.workerPromises.add(promise);
    // 当 workerLoop 结束（正常完成或异常），从集合中移除
    promise.finally(() => {
      ctx.workerPromises.delete(promise);
    });
  });
}

// ═══════════════════════════════════════
// Main Orchestrator Entry Point
// ═══════════════════════════════════════

export async function runOrchestrator(projectId: string, win: BrowserWindow | null) {
  // ── v5.6: 防重入 — 如果已有编排流在跑，拒绝第二次调用 ──
  if (isOrchestratorRunning(projectId)) {
    log.warn(`Orchestrator already running for ${projectId}, ignoring duplicate call`);
    sendToUI(win, 'agent:log', {
      projectId, agentId: 'system',
      content: '⚠️ 编排器已在运行中，忽略重复启动请求',
    });
    return;
  }

  const abortCtrl = new AbortController();
  registerOrchestrator(projectId, abortCtrl);
  const signal = abortCtrl.signal;

  const db = getDb();
  const settings = getSettings();

  if (!settings || !settings.apiKey) {
    sendToUI(win, 'agent:error', { projectId, error: '请先在设置中配置 LLM API Key' });
    unregisterOrchestrator(projectId);
    return;
  }

  // ── v5.6: Pre-flight 模型可用性预检 ──
  {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '🔍 预检: 验证 LLM 模型可用性...' });
    const modelsToCheck = [...new Set([settings.strongModel, settings.workerModel, settings.fastModel].filter((m): m is string => Boolean(m)))];
    const errors: string[] = [];
    for (const m of modelsToCheck) {
      const err = await validateModel(settings, m!);
      if (err) errors.push(err);
    }
    if (errors.length > 0) {
      const errMsg = `模型预检失败，请在设置中修正:\n${errors.join('\n')}`;
      sendToUI(win, 'agent:error', { projectId, error: errMsg });
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `❌ ${errMsg}` });
      db.prepare("UPDATE projects SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(projectId);
      sendToUI(win, 'project:status', { projectId, status: 'paused' });
      unregisterOrchestrator(projectId);
      return;
    }
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `✅ 预检通过: ${modelsToCheck.join(', ')}` });
  }

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
  if (!project) {
    sendToUI(win, 'agent:error', { projectId, error: '项目不存在' });
    unregisterOrchestrator(projectId);
    return;
  }

  const workspacePath = project.workspace_path;
  if (workspacePath) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  // v16.0: 从项目 config 解析权限开关
  let permissions: import('./tool-registry').AgentPermissions | undefined;
  try {
    const cfg = JSON.parse(project.config || '{}');
    if (cfg.permissions) {
      permissions = {
        externalRead: cfg.permissions.externalRead === true,
        externalWrite: cfg.permissions.externalWrite === true,
        shellExec: cfg.permissions.shellExec === true,
      };
    }
  } catch { /* config parse error — use defaults (all denied) */ }

  ensureGlobalMemory();
  if (workspacePath) ensureProjectMemory(workspacePath);
  if (workspacePath) cleanupDecisionLog(workspacePath); // v5.5: 清理过期决策日志
  cleanExpiredLocks(); // v6.1 (构想A): 清理僵尸文件锁

  // ═══════════════════════════════════════
  // Phase 0: 环境初始化 (v13.0)
  // ═══════════════════════════════════════
  if (workspacePath && !signal.aborted) {
    await phaseEnvironmentBootstrap(projectId, settings, win, signal, workspacePath);
    if (signal.aborted) { unregisterOrchestrator(projectId); return; }
  }

  // v11.0: 成员级模型解析器 — 按角色返回该成员实际使用的 LLM 模型名
  const memberModel = (role: string, agentIndex: number = 0): string => {
    return getTeamMemberLLMConfig(projectId, role, agentIndex, settings).model;
  };

  emitEvent({
    projectId, agentId: 'system', type: 'project:start',
    data: { wish: project.wish, name: project.name, workspace: workspacePath },
  });

  const existingFeatures = db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ?").get(projectId) as CountResult;
  const isResume = existingFeatures.c > 0;

  // v12.0: 解析项目激活的工作流预设 — 决定执行哪些阶段
  const workflowStages = getActiveWorkflowStages(projectId);
  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `📐 工作流阶段: ${workflowStages.join(' → ')}` });

  if (!isResume) {
    // ═══════════════════════════════════════
    // 首次运行: 按工作流配置执行阶段 (v12.0)
    // ═══════════════════════════════════════

    // v13.1: 将 wishes 表中所有 pending/developing 的需求标记为 analyzing
    db.prepare(
      "UPDATE wishes SET status = 'analyzing', updated_at = datetime('now') WHERE project_id = ? AND status IN ('pending', 'developing')"
    ).run(projectId);

    // PM 分析 (pm_analysis or pm_triage)
    if (hasStage(workflowStages, 'pm_analysis')) {
      const features = await phasePMAnalysis(projectId, project, settings, win, signal, permissions);
      if (!features || signal.aborted) { unregisterOrchestrator(projectId); return; }

      // v13.1: PM 分析完成 → 标记 wishes 为 analyzed
      db.prepare(
        "UPDATE wishes SET status = 'analyzed', updated_at = datetime('now') WHERE project_id = ? AND status = 'analyzing'"
      ).run(projectId);

      // 架构设计 (architect)
      if (hasStage(workflowStages, 'architect')) {
        await phaseArchitect(projectId, project, features, settings, win, signal, workspacePath);
        if (signal.aborted) { unregisterOrchestrator(projectId); return; }
      }

      // 文档生成 (docs_gen)
      if (hasStage(workflowStages, 'docs_gen') && workspacePath) {
        await phaseReqsAndTestSpecs(projectId, features, settings, win, signal, workspacePath);
        if (signal.aborted) { unregisterOrchestrator(projectId); return; }
      }
    } else if (hasStage(workflowStages, 'pm_triage')) {
      // 快速迭代模式: 只做分诊, 跳过架构和文档
      const features = await phasePMAnalysis(projectId, project, settings, win, signal, permissions);
      if (!features || signal.aborted) { unregisterOrchestrator(projectId); return; }

      // v13.1: PM 分析完成 → 标记 wishes 为 analyzed
      db.prepare(
        "UPDATE wishes SET status = 'analyzed', updated_at = datetime('now') WHERE project_id = ? AND status = 'analyzing'"
      ).run(projectId);
    }
  } else {
    // ═══════════════════════════════════════
    // Phase 0: PM 需求分诊 (Wish Triage) — 由 PM 执行, 非元 Agent
    // ═══════════════════════════════════════

    // ── v5.6: Circuit Breaker — 检查上次失败原因是否仍然存在 ──
    {
      const failedFeatures = db.prepare(
        "SELECT id, last_error, last_error_at FROM features WHERE project_id = ? AND status = 'failed' AND last_error IS NOT NULL"
      ).all(projectId) as Array<{ id: string; last_error: string; last_error_at: string }>;

      if (failedFeatures.length > 0) {
        // 检查是否全部都是不可重试错误
        const nonRetryable = failedFeatures.filter(f => f.last_error?.includes('[NonRetryable:'));
        if (nonRetryable.length === failedFeatures.length) {
          // 所有失败的 Feature 都是不可重试错误 → 不要盲目重跑
          const sampleError = nonRetryable[0].last_error;
          sendToUI(win, 'agent:log', {
            projectId, agentId: 'system',
            content: `🔴 Circuit Breaker: ${nonRetryable.length} 个 Feature 因不可重试错误失败 (如模型不可用、API Key 无效)。\n示例: ${sampleError}\n请在设置中修正后重新启动。`,
          });
          sendToUI(win, 'agent:error', {
            projectId,
            error: `所有 ${nonRetryable.length} 个失败的 Feature 都是配置类错误。请检查 LLM 设置后重试。`,
          });
          notify('🔴 AutoMater 需要修改配置', `${nonRetryable.length} 个 Feature 因模型/配置错误无法继续`);
          db.prepare("UPDATE projects SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(projectId);
          sendToUI(win, 'project:status', { projectId, status: 'paused' });
          unregisterOrchestrator(projectId);
          return;
        }

        // 有部分是不可重试的 → 清除可重试的 failed Feature 让它们重跑，不可重试的保持 failed
        if (nonRetryable.length > 0) {
          sendToUI(win, 'agent:log', {
            projectId, agentId: 'system',
            content: `⚠️ ${nonRetryable.length} 个 Feature 因不可重试错误保持 failed 状态，${failedFeatures.length - nonRetryable.length} 个可重试 Feature 将重新执行`,
          });
        }
      }

      // 将可重试的 failed Feature 重置为 todo (不可重试的保持 failed)
      db.prepare(
        "UPDATE features SET status = 'todo', locked_by = NULL WHERE project_id = ? AND status = 'failed' AND (last_error IS NULL OR last_error NOT LIKE '%[NonRetryable:%')"
      ).run(projectId);
    }

    // 元 Agent 只负责通用交互/路由, 不加载项目设计内容。
    // 分诊需要项目上下文(已有 Feature + 设计文档), 因此由 PM 角色执行。
    // 用户可能只是续跑未完成的 feature, 也可能带了新 wish。
    // 关键: 新 wish 可能隐含对已有 feature 的变更 — 用户不会主动说"这是变更"。
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '♻️ 项目续跑 — PM 检查是否有新需求或隐式变更...' });

    // v13.1: 从 wishes 表收集所有待处理的需求 (pending / developing)
    // 修复: 此前只读 projects.wish (单字段)，导致 wishes 表中待分析的需求被忽略
    const pendingWishes = db.prepare(
      "SELECT id, content FROM wishes WHERE project_id = ? AND status IN ('pending', 'developing') ORDER BY created_at ASC"
    ).all(projectId) as Array<{ id: string; content: string }>;

    // 获取 projects.wish (可能被用户更新过)
    const freshProject = db.prepare('SELECT wish FROM projects WHERE id = ?').get(projectId) as { wish: string };
    const projectWish = freshProject.wish?.trim() || '';

    // 合并需求来源: wishes 表中的待处理条目 + projects.wish
    // wishes 表是精确的需求队列, projects.wish 是 legacy 兼容字段
    let mergedWishContent = '';
    const pendingWishIds: string[] = [];

    if (pendingWishes.length > 0) {
      // 优先使用 wishes 表的待处理需求
      mergedWishContent = pendingWishes.map(w => w.content).join('\n\n---\n\n');
      pendingWishIds.push(...pendingWishes.map(w => w.id));
      sendToUI(win, 'agent:log', {
        projectId, agentId: 'system',
        content: `📋 发现 ${pendingWishes.length} 个待处理需求, 纳入本轮分析`,
      });
    } else if (projectWish) {
      // 兜底: 如果 wishes 表没有 pending, 使用 projects.wish
      mergedWishContent = projectWish;
    }

    // 标记 wishes 为 analyzing
    if (pendingWishIds.length > 0) {
      const placeholders = pendingWishIds.map(() => '?').join(',');
      db.prepare(`UPDATE wishes SET status = 'analyzing', updated_at = datetime('now') WHERE id IN (${placeholders})`)
        .run(...pendingWishIds);
    }

    // 判断是否有新 wish 需要处理 (对比最近一次 wish 是否与现有 features 有偏差)
    // 如果 workspace 存在且有设计文档, 做分诊; 否则直接续跑
    let triage: WishTriageResult | null = null;

    if (workspacePath && mergedWishContent) {
      triage = await detectImplicitChanges(
        projectId, mergedWishContent, settings, win, signal, workspacePath,
      );
      if (signal.aborted) { unregisterOrchestrator(projectId); return; }
    }

    if (triage && triage.category !== 'pure_new' && triage.implicitChanges.length > 0) {
      // ── 检测到隐式变更: 先执行变更流程 ──
      sendToUI(win, 'agent:log', {
        projectId, agentId: 'system',
        content: `🔀 检测到 ${triage.implicitChanges.length} 个隐式变更, 启动变更管理流程...`,
      });

      // 将隐式变更合成为变更描述
      const changeDescription = [
        `用户新需求: ${mergedWishContent}`,
        '',
        '检测到的隐式变更:',
        ...triage.implicitChanges.map(c =>
          `- ${c.featureId} (${c.featureTitle}): ${c.changeDescription} [${c.severity}]`
        ),
        ...(triage.conflicts.length > 0 ? [
          '',
          '潜在冲突:',
          ...triage.conflicts.map(c => `- ${c.description} (涉及: ${c.involvedFeatures.join(', ')})`),
        ] : []),
      ].join('\n');

      // 创建变更请求记录
      const crId = `cr-auto-${Date.now().toString(36)}`;
      db.prepare("INSERT INTO change_requests (id, project_id, description, status) VALUES (?, ?, ?, 'analyzing')")
        .run(crId, projectId, changeDescription);

      // 执行级联更新
      const changeResult = await runChangeRequest(projectId, crId, changeDescription, win, signal);
      if (signal.aborted) { unregisterOrchestrator(projectId); return; }

      if (!changeResult.success) {
        sendToUI(win, 'agent:log', {
          projectId, agentId: 'system',
          content: `⚠️ 变更管理流程未完全成功: ${changeResult.error}. 继续开发已有任务。`,
        });
      }
    }

    if (triage && triage.newCapabilities.length > 0) {
      // ── 有新功能: 走 PM 增量分析 → 新增 Feature ──
      sendToUI(win, 'agent:log', {
        projectId, agentId: 'system',
        content: `🆕 检测到 ${triage.newCapabilities.length} 个新功能, 启动增量 PM 分析...`,
      });

      const incrementalFeatures = await phaseIncrementalPM(
        projectId, project, triage.newCapabilities, settings, win, signal, workspacePath,
      );
      if (signal.aborted) { unregisterOrchestrator(projectId); return; }

      // 为新 Feature 生成子需求 + 测试规格
      if (incrementalFeatures && incrementalFeatures.length > 0 && workspacePath) {
        await phaseReqsAndTestSpecs(projectId, incrementalFeatures, settings, win, signal, workspacePath);
        if (signal.aborted) { unregisterOrchestrator(projectId); return; }
      }
    }

    if (!triage || (triage.implicitChanges.length === 0 && triage.newCapabilities.length === 0)) {
      sendToUI(win, 'agent:log', {
        projectId, agentId: 'system',
        content: '♻️ 无新需求或变更, 继续处理未完成的 Feature...',
      });
    }

    // v13.1: 更新 wishes 表状态 — 标记已处理的需求为 analyzed
    if (pendingWishIds.length > 0) {
      const placeholders = pendingWishIds.map(() => '?').join(',');
      db.prepare(`UPDATE wishes SET status = 'analyzed', updated_at = datetime('now') WHERE id IN (${placeholders})`)
        .run(...pendingWishIds);
      log.info(`Updated ${pendingWishIds.length} wishes to 'analyzed'`);
    }
  }

  if (workspacePath) await commitWorkspace(workspacePath, 'AutoMater: PM analysis + Architecture + Docs');
  if (workspacePath) ensureAgentsMd(workspacePath, project.wish);

  // v3.0: Architect→Developer 程序化门控
  if (!isResume) {
    const archGate = gateArchitectToDeveloper(workspacePath);
    if (!archGate.passed) {
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `⚠️ Architect→Developer 门控: ${archGate.reason} (继续但可能影响质量)` });
    }
  }

  // ═══════════════════════════════════════
  // Phase 4a: Developer 实现 + QA 代码审查 (v5.0: 原 Phase 5)
  // ═══════════════════════════════════════
  if (signal.aborted) { unregisterOrchestrator(projectId); return; }
  db.prepare("UPDATE projects SET status = 'developing', updated_at = datetime('now') WHERE id = ?").run(projectId);
  sendToUI(win, 'project:status', { projectId, status: 'developing' });

  const featureCount = (db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ?").get(projectId) as CountResult).c;
  const maxWorkers = settings.workerCount > 0 ? settings.workerCount : featureCount;
  const workerCount = Math.min(maxWorkers, featureCount);

  const qaId = 'qa-0';  // 固定 ID: 复用同一 QA Agent
  spawnAgent(projectId, qaId, 'qa', win);
  sendToUI(win, 'agent:log', { projectId, agentId: qaId, content: '🧪 QA 工程师就绪' });
  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ? AND project_id = ?").run(qaId, projectId);

  const project2 = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow;
  const gitConfig: GitProviderConfig = {
    mode: project2.git_mode || 'local',
    workspacePath: workspacePath || '',
    githubRepo: project2.github_repo ?? undefined,
    githubToken: project2.github_token ?? undefined,
  };

  // v9.0: 注册热加入上下文 — 支持 developing 阶段动态添加 worker
  ensureHotJoinListener();
  const workerPromiseSet = new Set<Promise<void>>();
  const hotJoinCtx: HotJoinContext = {
    projectId, qaId, settings, win, signal, workspacePath, gitConfig,
    workerPromises: workerPromiseSet,
    nextWorkerSeq: workerCount,  // 从已有 worker 数量开始编号
    permissions,
  };
  registerHotJoinContext(hotJoinCtx);

  for (let i = 0; i < workerCount; i++) {
    const workerId = `dev-${i + 1}`;
    spawnAgent(projectId, workerId, 'developer', win);
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = ? AND project_id = ?").run(workerId, projectId);
    const p = workerLoop(projectId, workerId, qaId, settings, win, signal, workspacePath, gitConfig, permissions);
    workerPromiseSet.add(p);
    p.finally(() => workerPromiseSet.delete(p));
  }
  // 等待所有 worker (含热加入的) 完成
  // 使用轮询而非 Promise.all, 因为热加入会动态添加 promise
  while (workerPromiseSet.size > 0 && !signal.aborted) {
    await Promise.race([...workerPromiseSet]);
    // race 返回时至少一个 worker 完成/移除了, 继续等待剩余的
    // 如果热加入又加了新 worker, 下一轮 while 会 pick up
    await sleep(100);  // 微等以允许 finally 清理
  }
  unregisterHotJoinContext(projectId);

  if (signal.aborted) { unregisterOrchestrator(projectId); return; }

  // ═══════════════════════════════════════
  // Phase 4b: PM 批量验收审查 (v12.0: 按工作流控制)
  // ═══════════════════════════════════════
  if (workspacePath && hasStage(workflowStages, 'pm_acceptance')) {
    await phasePMAcceptance(projectId, settings, win, signal, workspacePath);
    if (signal.aborted) { unregisterOrchestrator(projectId); return; }
  }

  // ═══════════════════════════════════════
  // Phase 4c: 增量文档同步 (v12.0: 按工作流控制)
  // ═══════════════════════════════════════
  if (workspacePath && hasStage(workflowStages, 'incremental_doc_sync')) {
    await phaseIncrementalDocSync(projectId, win, signal, workspacePath);
    if (signal.aborted) { unregisterOrchestrator(projectId); return; }
  }

  // ═══════════════════════════════════════
  // Phase 4d: DevOps 全自动部署 Pipeline (v15.0: 按工作流控制)
  // ═══════════════════════════════════════
  if (workspacePath && hasStage(workflowStages, 'devops_build')) {
    await phaseDeployPipeline(projectId, settings, win, signal, workspacePath, gitConfig);
    if (signal.aborted) { unregisterOrchestrator(projectId); return; }
  }

  // ═══════════════════════════════════════
  // Phase 5: 汇总 + 用户验收等待
  // ═══════════════════════════════════════
  if (hasStage(workflowStages, 'finalize')) {
    await phaseFinalize(projectId, settings, win, signal, workspacePath, project.name);
  }

  unregisterOrchestrator(projectId);
}

// ═══════════════════════════════════════
// Dead inline phases removed (v12.3 code-quality cleanup)
// All phase logic lives in ./phases/ modules.
// ═══════════════════════════════════════

function ensureAgentsMd(workspacePath: string, wish: string) {
  const agentsDir = path.join(workspacePath, '.automater');
  const agentsPath = path.join(agentsDir, 'AGENTS.md');
  fs.mkdirSync(agentsDir, { recursive: true });

  // v6.0 (G15): 每次运行都重新生成 AGENTS.md (而非仅首次)
  // 读取实际的架构信息
  let techInfo = '';
  const archPath = path.join(workspacePath, 'ARCHITECTURE.md');
  if (fs.existsSync(archPath)) {
    techInfo = fs.readFileSync(archPath, 'utf-8').split('\n').slice(0, 50).join('\n');
  }

  // 读取 package.json / pyproject.toml 获取依赖信息
  let depsInfo = '';
  const pkgPath = path.join(workspacePath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = Object.keys(pkg.dependencies || {}).slice(0, 20);
      const devDeps = Object.keys(pkg.devDependencies || {}).slice(0, 10);
      depsInfo = `### 依赖\n- 运行时: ${deps.join(', ') || '无'}\n- 开发: ${devDeps.join(', ') || '无'}`;
    } catch { /* parse error */ }
  }

  // 读取 .gitignore 获取忽略规则
  let gitignoreInfo = '';
  const gitignorePath = path.join(workspacePath, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const ignoreRules = fs.readFileSync(gitignorePath, 'utf-8').split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 15);
    gitignoreInfo = `### .gitignore 规则\n${ignoreRules.map(r => `- ${r}`).join('\n')}`;
  }

  // 读取 tsconfig.json 获取编译配置
  let tsInfo = '';
  const tsConfigPath = path.join(workspacePath, 'tsconfig.json');
  if (fs.existsSync(tsConfigPath)) {
    try {
      const tsConfig = JSON.parse(fs.readFileSync(tsConfigPath, 'utf-8'));
      const co = tsConfig.compilerOptions || {};
      tsInfo = `### TypeScript 配置\n- target: ${co.target || 'N/A'}\n- module: ${co.module || 'N/A'}\n- strict: ${co.strict ?? 'N/A'}\n- outDir: ${co.outDir || 'N/A'}`;
    } catch { /* parse error */ }
  }

  // 检测目录结构
  let dirStructure = '';
  try {
    const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map(e => e.name);
    const files = entries.filter(e => e.isFile()).map(e => e.name);
    dirStructure = `### 项目结构\n- 目录: ${dirs.join(', ') || '无'}\n- 根文件: ${files.slice(0, 15).join(', ')}`;
  } catch { /* read error */ }

  const content = [
    `# AGENTS.md — 项目规范`,
    `> 此文件由 AutoMater 自动生成和维护，Agent 和用户均可编辑。`,
    `> 最后更新: ${new Date().toISOString().slice(0, 19)}`,
    ``,
    `## 项目概述`,
    wish.slice(0, 800),
    ``,
    `## 技术栈概要`,
    techInfo || '(待补充 — 架构文档生成后自动填充)',
    ``,
    depsInfo || '',
    tsInfo || '',
    dirStructure || '',
    gitignoreInfo || '',
    ``,
    `## 编码规范`,
    `- 使用项目已有的代码风格和缩进`,
    `- 文件组织遵循 ARCHITECTURE.md`,
    `- 所有新文件必须包含必要的 import/export`,
    `- 不要忽略异常，使用适当的错误处理`,
    `- 优先使用 edit_file 而非 write_file 修改已有文件`,
    `- 新增文件前先搜索是否已有类似功能`,
    ``,
    `## 常用命令`,
    `- 安装依赖: npm install / pip install -r requirements.txt`,
    `- 编译检查: npx tsc --noEmit`,
    `- 运行测试: npm test / pytest`,
    `- 构建: npm run build (如可用)`,
    ``,
    `## 注意事项`,
    `- 修改已有文件用 edit_file，不要 write_file 重写`,
    `- 每个 Feature 完成后调用 task_complete`,
    `- 遇到信息不足时使用 report_blocked 阻塞`,
    `- 发现设计问题使用 rfc_propose 提案`,
    ``,
  ].filter(Boolean).join('\n');

  fs.writeFileSync(agentsPath, content, 'utf-8');
}
