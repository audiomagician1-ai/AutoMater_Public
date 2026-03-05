/**
 * Session Scheduler — Session 驱动的并发调度引擎 (v33.0)
 *
 * 核心职责:
 *   1. 成为 Dev+QA 阶段的 **唯一** 调度入口
 *   2. 扫描看板上可执行的 Feature，为空闲 Agent slot spawn Session + workerLoop
 *   3. 监听 SchedulerBus 事件，在 Feature 完成/失败时自动补充调度
 *   4. 提供 awaitAllFeaturesDone 阻塞式等待，供 orchestrator 使用
 *   5. 提供 fallbackCheck 供 daemon 定时兜底调用
 *   6. v33.0: 新增 PM 实时需求分析 — dev 阶段中新增 wish 自动触发 PM 增量分析
 *
 * 调度模型 (v32.0 — 1-Session-1-Feature):
 *   team_members 行 = Agent 类定义 (角色模板)
 *   sessions 行    = Agent 实例 (由 Scheduler spawn, 绑定唯一 Feature)
 *   一个 Agent 可同时有 N 个 running session (N = max_concurrent_sessions)
 *   **一个 Session 只处理一个 Feature** — 完成后 scheduler 自动 spawn 新 session
 *   Worker 不再自循环取活，scheduler 拥有完整的并发控制权
 *
 * v33.0 PM 实时分析:
 *   schedule:wish_created → onWishCreated → runInlineWishAnalysis
 *   PM 异步分析新 wish → 产出 features (status='todo') → schedule:feature_todo → scheduleProject
 *   PM 分析与 developer 工作完全并行，不阻塞现有任务
 *
 * 与 orchestrator 的关系:
 *   orchestrator 负责 pre-dev (PM/Architect/Docs) 和 post-dev (PM验收/文档同步/DevOps)
 *   orchestrator 在进入 Dev+QA 阶段时调用 runSessionDrivenDevPhase()
 *   scheduler 接管所有 Feature 的并发调度 → 全部完成后返回控制权给 orchestrator
 */

import { BrowserWindow } from 'electron';
import { getDb } from '../db';
import { createLogger } from './logger';
import { getSettings, sleep } from './llm-client';
import { lockNextFeature, spawnAgent } from './agent-manager';
import { createSessionForFeature, transitionSession, getRunningSessionCount } from './conversation-backup';
import { onScheduleEvent, emitScheduleEvent, type ScheduleEventPayload } from './scheduler-bus';
import { workerLoop, phaseIncrementalPM, type WorkerLoopOptions } from './phases';
import { sendToUI } from './ui-bridge';
import type { TeamMemberRow, FeatureRow, PhaseResult, AppSettings, CountResult, ProjectRow } from './types';
import type { AgentPermissions } from './tool-registry';
import type { GitProviderConfig } from './git-provider';

const log = createLogger('session-scheduler');

// ═══════════════════════════════════════
// Config
// ═══════════════════════════════════════

/** Scheduler 全局开关 — 通过 daemon config 控制 */
let _enabled = false;

export function enableScheduler(): void {
  _enabled = true;
}
export function disableScheduler(): void {
  _enabled = false;
}
export function isSchedulerEnabled(): boolean {
  return _enabled;
}

// ═══════════════════════════════════════
// Active session tracking (in-memory)
// ═══════════════════════════════════════

/** sessionId → Promise，用于追踪 workerLoop 生命周期 */
const activeSessions = new Map<string, AbortController>();
/** 活跃的 workerLoop Promise 集合 (projectId → Set<Promise>) */
const activeWorkerPromises = new Map<string, Set<Promise<void | PhaseResult>>>();

export function getActiveSessions(): Map<string, AbortController> {
  return activeSessions;
}

// ═══════════════════════════════════════
// Dev Phase Context — scheduler 自己管理运行上下文
// ═══════════════════════════════════════

/**
 * v32.0: Dev 阶段运行上下文 — 由 orchestrator 注入，scheduler 管理
 * 1-Session-1-Feature: scheduler 为每个 Feature spawn 独立 session+worker
 */
export interface DevPhaseContext {
  projectId: string;
  qaId: string;
  settings: AppSettings;
  win: BrowserWindow | null;
  signal: AbortSignal;
  workspacePath: string | null;
  gitConfig: GitProviderConfig;
  permissions?: AgentPermissions;
  /** 递增 worker ID 编号器 */
  nextWorkerSeq: number;
}

/** 活跃的 Dev 阶段上下文 (projectId → DevPhaseContext) */
const devPhaseContexts = new Map<string, DevPhaseContext>();

/** 获取项目的 Dev 阶段上下文 — 供外部（如 HotJoin listener）访问 */
export function getDevPhaseContext(projectId: string): DevPhaseContext | undefined {
  return devPhaseContexts.get(projectId);
}

// ═══════════════════════════════════════
// Core scheduling logic
// ═══════════════════════════════════════

/**
 * 为指定项目执行一轮调度:
 * 扫描 todo feature → 匹配有空闲 slot 的 Agent → spawn session → 启动 workerLoop
 *
 * v32.0: 1-Session-1-Feature — 每个 spawn 的 workerLoop 只处理 scheduler 分配的单个 feature，
 * 完成后由事件驱动的 onFeatureCompleted 触发新一轮 scheduleProject
 */
export async function scheduleProject(projectId: string): Promise<{ spawned: number }> {
  if (!_enabled) return { spawned: 0 };

  const ctx = devPhaseContexts.get(projectId);
  if (!ctx || ctx.signal.aborted) {
    // 没有活跃的 Dev 阶段上下文 — 无法启动 workerLoop
    log.debug('scheduleProject: no active DevPhaseContext, skipping', { projectId });
    return { spawned: 0 };
  }

  const db = getDb();

  // 1. 查询所有 developer 角色的 Agent (按创建顺序)
  const members = db
    .prepare("SELECT * FROM team_members WHERE project_id = ? AND role = 'developer' ORDER BY created_at ASC")
    .all(projectId) as TeamMemberRow[];

  // 如果没有自定义 developer 成员 → 使用默认配额 (settings.workerCount 或 3)
  const settings = ctx.settings;
  const DEFAULT_MAX_WORKERS = 3;
  const maxWorkers = settings.workerCount > 0 ? settings.workerCount : DEFAULT_MAX_WORKERS;

  let spawned = 0;

  if (members.length > 0) {
    // ── 有自定义团队成员: 按 member 的 max_concurrent_sessions 分配 ──
    for (const member of members) {
      const runningCount = getRunningSessionCount(member.id);
      const maxConcurrency = member.max_concurrent_sessions || 1;
      const availableSlots = maxConcurrency - runningCount;
      if (availableSlots <= 0) continue;

      for (let i = 0; i < availableSlots; i++) {
        const feature = lockNextFeature(projectId, member.id);
        if (!feature) break;

        const result = spawnSessionWorker(ctx, feature, member);
        if (result) spawned++;
      }
    }
  } else {
    // ── 无自定义团队: 使用默认 worker pool ──
    const workerPromises = activeWorkerPromises.get(projectId);
    const currentRunning = workerPromises?.size ?? 0;
    const availableSlots = maxWorkers - currentRunning;

    for (let i = 0; i < availableSlots; i++) {
      const lockId = `sched-default-${projectId}`;
      const feature = lockNextFeature(projectId, lockId);
      if (!feature) break;

      const result = spawnSessionWorker(ctx, feature, undefined);
      if (result) spawned++;
    }
  }

  if (spawned > 0) {
    log.info(`Scheduled ${spawned} session workers for project ${projectId}`);
    sendToUI(ctx.win, 'agent:log', {
      projectId,
      agentId: 'scheduler',
      content: `📋 调度器分配了 ${spawned} 个新任务 Session`,
    });
  }

  return { spawned };
}

/**
 * v32.0: 为一个 Feature spawn 一个独立 Session + workerLoop
 * 1-Session-1-Feature: worker 只处理此 feature，完成后退出。
 * scheduler 通过事件驱动自动为下一个 feature spawn 新 session。
 * 返回 sessionId (成功) 或 null (失败)
 */
function spawnSessionWorker(
  ctx: DevPhaseContext,
  feature: FeatureRow,
  member: TeamMemberRow | undefined,
): string | null {
  const db = getDb();
  const { projectId, qaId, settings, win, signal, workspacePath, gitConfig, permissions } = ctx;

  try {
    // 1. 分配 worker ID
    ctx.nextWorkerSeq += 1;
    const workerId = `dev-sess-${ctx.nextWorkerSeq}`;

    // 2. 创建 Session 记录
    const memberId = member?.id ?? workerId;
    const memberName = member?.name ?? workerId;
    const memberRole = member?.role ?? 'developer';
    const session = createSessionForFeature(memberId, feature.id, projectId, memberName, memberRole);

    emitScheduleEvent('schedule:session_created', {
      projectId,
      sessionId: session.id,
      memberId,
      featureId: feature.id,
    });

    // 3. Spawn Agent DB 记录
    spawnAgent(projectId, workerId, 'developer', win);
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = ? AND project_id = ?").run(workerId, projectId);

    // 4. 启动 workerLoop — v32.0: 传入 assignedFeature，worker 只处理此 feature
    const workerOpts: WorkerLoopOptions = {
      member,
      preCreatedSessionId: session.id,
      assignedFeature: feature,
    };

    const promise = workerLoop(
      projectId,
      workerId,
      qaId,
      settings,
      win,
      signal,
      workspacePath,
      gitConfig,
      permissions,
      workerOpts,
    );

    // 5. 追踪 Promise
    let promiseSet = activeWorkerPromises.get(projectId);
    if (!promiseSet) {
      promiseSet = new Set();
      activeWorkerPromises.set(projectId, promiseSet);
    }
    promiseSet.add(promise);
    promise.finally(() => {
      promiseSet!.delete(promise);
      activeSessions.delete(session.id);
    });

    activeSessions.set(session.id, new AbortController());

    log.info('Session worker spawned', {
      sessionId: session.id,
      workerId,
      memberId,
      memberName,
      featureId: feature.id,
      projectId,
    });

    return session.id;
  } catch (err) {
    log.error('Failed to spawn session worker', err, { featureId: feature.id });
    // 释放锁
    db.prepare(
      "UPDATE features SET status = 'todo', locked_by = NULL, locked_at = NULL WHERE id = ? AND project_id = ?",
    ).run(feature.id, projectId);
    return null;
  }
}

// ═══════════════════════════════════════
// v30.0: Session-Driven Dev Phase — 主入口
// ═══════════════════════════════════════

/**
 * Session 驱动的 Dev+QA 阶段
 *
 * 由 orchestrator 在进入 developing 阶段时调用。
 * 1. 注册 DevPhaseContext
 * 2. 启用 scheduler
 * 3. 首轮调度 (填满所有 slot)
 * 4. 阻塞等待所有 Feature 完成 (通过事件驱动 + 轮询兜底)
 * 5. 清理上下文并返回
 */
export async function runSessionDrivenDevPhase(params: {
  projectId: string;
  qaId: string;
  settings: AppSettings;
  win: BrowserWindow | null;
  signal: AbortSignal;
  workspacePath: string | null;
  gitConfig: GitProviderConfig;
  permissions?: AgentPermissions;
}): Promise<void> {
  const { projectId, signal } = params;

  // 1. 注册 Dev 阶段上下文
  const ctx: DevPhaseContext = {
    ...params,
    nextWorkerSeq: 0,
  };
  devPhaseContexts.set(projectId, ctx);
  activeWorkerPromises.set(projectId, new Set());

  // 2. 启用 scheduler (如果还没启用)
  const wasEnabled = _enabled;
  _enabled = true;

  sendToUI(params.win, 'agent:log', {
    projectId,
    agentId: 'scheduler',
    content: '🚀 Session 调度器启动 — 开始分配开发任务',
  });

  try {
    // 3. 首轮调度 — 填满所有 slot
    const initialResult = await scheduleProject(projectId);
    log.info(`Initial scheduling: ${initialResult.spawned} sessions spawned`, { projectId });

    // 4. 阻塞等待所有 Feature 处理完毕
    await awaitAllFeaturesDone(projectId, signal, params.win);
  } finally {
    // 5. 清理
    devPhaseContexts.delete(projectId);
    activeWorkerPromises.delete(projectId);
    if (!wasEnabled) _enabled = false;

    sendToUI(params.win, 'agent:log', {
      projectId,
      agentId: 'scheduler',
      content: '✅ Session 调度器: 所有 Feature 已处理完毕',
    });
  }
}

/**
 * 阻塞等待项目所有 Feature 完成/失败/暂停
 * v32.0: 1-Session-1-Feature 模型下，每个 worker 完成即退出，
 * activeCount 精确反映 inflight 任务数。事件驱动补充调度更高效。
 * v33.0: 增加 PM 分析感知 — 如果 PM 正在分析新 wish，不提前退出
 * 轮询兜底: 每 2s 检查一次并自动补充调度
 */
async function awaitAllFeaturesDone(projectId: string, signal: AbortSignal, win: BrowserWindow | null): Promise<void> {
  const db = getDb();
  const POLL_INTERVAL_MS = 2000;

  while (!signal.aborted) {
    const promiseSet = activeWorkerPromises.get(projectId);
    const activeCount = promiseSet?.size ?? 0;

    // 检查是否有 todo feature 尚未调度
    const todoCount = (
      db
        .prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ? AND status = 'todo'")
        .get(projectId) as CountResult
    ).c;

    // 检查是否有 in_progress/reviewing feature (活跃工作中)
    const workingCount = (
      db
        .prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ? AND status IN ('in_progress', 'reviewing')")
        .get(projectId) as CountResult
    ).c;

    // v33.0: 检查是否有 PM 正在分析新 wish（会产出新 features）
    const pmAnalyzing = _pmAnalysisRunning.has(projectId);

    // v33.0: 检查是否有 pending/analyzing wishes（即将被 PM 分析的）
    const pendingWishCount = (
      db
        .prepare(
          "SELECT COUNT(*) as c FROM wishes WHERE project_id = ? AND status IN ('pending', 'developing', 'analyzing')",
        )
        .get(projectId) as CountResult
    ).c;

    if (activeCount === 0 && todoCount === 0 && workingCount === 0 && !pmAnalyzing && pendingWishCount === 0) {
      // 全部完成且无待分析的新需求
      break;
    }

    // v32.0: 如果有 todo 但没有足够 active worker → 补充调度
    // 在 1-Session-1-Feature 模型下，scheduler 可以精确按 capacity 填充
    if (todoCount > 0) {
      await scheduleProject(projectId);
    }

    // 等待: race 任一 worker 完成 或 超时轮询
    if (activeCount > 0 && promiseSet) {
      const timeoutPromise = sleep(POLL_INTERVAL_MS);
      await Promise.race([...promiseSet, timeoutPromise]);
    } else {
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

// ═══════════════════════════════════════
// v33.0: PM 实时需求分析 — dev 阶段中新增 wish 自动触发
// ═══════════════════════════════════════

/** 每项目 PM 分析锁 — 防止并发分析同一项目的多个 wish */
const _pmAnalysisRunning = new Set<string>();

/**
 * v33.0: dev 阶段内嵌 PM 增量分析
 *
 * 当用户在 dev 阶段运行期间添加新 wish 时:
 * 1. 读取 pending wishes
 * 2. 调用 phaseIncrementalPM 产出新 features (status='todo')
 * 3. phaseIncrementalPM 内部会 emitScheduleEvent('schedule:feature_todo')
 * 4. feature_todo 事件触发 scheduleProject → 自动分配 developer
 *
 * PM 分析与 developer 工作完全并行，不阻塞现有任务。
 * 使用 per-project 锁防止同一项目的多个分析并发执行（会排队/合并）。
 */
async function runInlineWishAnalysis(projectId: string): Promise<void> {
  // 1. 检查前提条件
  if (!_enabled) return;
  const ctx = devPhaseContexts.get(projectId);
  if (!ctx || ctx.signal.aborted) return;

  // 2. 防并发: 如果该项目已有 PM 分析在跑，跳过 (当前分析会处理所有 pending wishes)
  if (_pmAnalysisRunning.has(projectId)) {
    log.info('PM analysis already running for project, skipping (will be picked up)', { projectId });
    return;
  }

  _pmAnalysisRunning.add(projectId);
  try {
    const db = getDb();

    // 3. 收集所有待处理的 wish
    const pendingWishes = db
      .prepare(
        "SELECT id, content FROM wishes WHERE project_id = ? AND status IN ('pending', 'developing') ORDER BY created_at ASC",
      )
      .all(projectId) as Array<{ id: string; content: string }>;

    if (pendingWishes.length === 0) {
      log.debug('No pending wishes to analyze', { projectId });
      return;
    }

    // 4. 标记 wishes 为 analyzing
    const wishIds = pendingWishes.map(w => w.id);
    const placeholders = wishIds.map(() => '?').join(',');
    db.prepare(
      `UPDATE wishes SET status = 'analyzing', updated_at = datetime('now') WHERE id IN (${placeholders})`,
    ).run(...wishIds);

    sendToUI(ctx.win, 'agent:log', {
      projectId,
      agentId: 'pm-0',
      content: `📋 检测到 ${pendingWishes.length} 个新需求，PM 开始实时分析...`,
    });

    // 5. 将 wishes 内容合成为 newCapabilities (phaseIncrementalPM 需要的格式)
    const newCapabilities = pendingWishes.map(w => ({
      title: w.content.slice(0, 100).split('\n')[0],
      description: w.content,
    }));

    // 6. 读取项目信息
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
    if (!project) {
      log.error('Project not found for inline wish analysis', { projectId });
      return;
    }

    // 7. 调用 PM 增量分析
    const pmResult = await phaseIncrementalPM(
      projectId,
      project,
      newCapabilities,
      ctx.settings,
      ctx.win,
      ctx.signal,
      ctx.workspacePath,
    );

    // 8. 标记 wishes 为 analyzed
    db.prepare(`UPDATE wishes SET status = 'analyzed', updated_at = datetime('now') WHERE id IN (${placeholders})`).run(
      ...wishIds,
    );

    const newFeatureCount = pmResult?.features?.length ?? 0;
    if (newFeatureCount > 0) {
      sendToUI(ctx.win, 'agent:log', {
        projectId,
        agentId: 'pm-0',
        content: `✅ PM 实时分析完成: 新增 ${newFeatureCount} 个 Feature，调度器将自动分配`,
      });
      // Note: phaseIncrementalPM 内部已经 emitScheduleEvent('schedule:feature_todo')
      // → onFeatureReady → scheduleProject → 自动分配给 developer
    } else {
      sendToUI(ctx.win, 'agent:log', {
        projectId,
        agentId: 'pm-0',
        content: '⚠️ PM 实时分析未产生新 Feature（可能与已有需求重复）',
      });
    }

    log.info('Inline wish analysis completed', {
      projectId,
      wishCount: pendingWishes.length,
      newFeatures: newFeatureCount,
    });
  } catch (err) {
    log.error('runInlineWishAnalysis failed', err, { projectId });
    sendToUI(devPhaseContexts.get(projectId)?.win ?? null, 'agent:log', {
      projectId,
      agentId: 'pm-0',
      content: `❌ PM 实时分析失败: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    _pmAnalysisRunning.delete(projectId);
  }
}

// ═══════════════════════════════════════
// Event handlers
// ═══════════════════════════════════════

/**
 * Feature 变为 todo / 项目启动 → 尝试调度
 */
async function onFeatureReady(payload: ScheduleEventPayload): Promise<void> {
  await scheduleProject(payload.projectId);
}

/**
 * Feature 完成/失败 → 释放 capacity → 检查是否有等待的 Feature
 */
async function onFeatureCompleted(payload: ScheduleEventPayload): Promise<void> {
  // capacity 已自动释放（workerLoop 结束 → session 不再 running）
  // 触发一次调度，看是否有新任务可以接
  await scheduleProject(payload.projectId);
}

/**
 * 新需求创建 → 触发 PM 实时增量分析 (v33.0)
 * dev 阶段中新增 wish 自动触发 PM 分析 → 产出 features → 自动调度
 * 不再需要手动暂停-重启才能分析新需求
 */
async function onWishCreated(payload: ScheduleEventPayload): Promise<void> {
  log.info('New wish created, triggering inline PM analysis', {
    projectId: payload.projectId,
    wishId: payload.wishId,
  });

  // 异步启动 PM 分析 — 不阻塞事件处理
  runInlineWishAnalysis(payload.projectId).catch(err => {
    log.error('Inline wish analysis failed', err, { projectId: payload.projectId });
  });
}

/**
 * 团队新增成员 → 检查是否有待处理的 feature
 */
async function onMemberAdded(payload: ScheduleEventPayload): Promise<void> {
  await scheduleProject(payload.projectId);
}

/**
 * Session 异常终止 → 释放 feature 锁 → 重新调度
 */
async function onSessionFailed(payload: ScheduleEventPayload): Promise<void> {
  if (payload.sessionId) {
    activeSessions.delete(payload.sessionId);
    transitionSession(payload.sessionId, 'failed', 'Session abnormally terminated');
  }
  // 重新调度
  await scheduleProject(payload.projectId);
}

// ═══════════════════════════════════════
// Fallback check (daemon 定时调用)
// ═══════════════════════════════════════

/**
 * 兜底检查 — daemon 每 30s 调用一次
 * 扫描所有 developing 项目，如果有未被调度的 todo feature 则触发调度
 */
export async function fallbackCheck(): Promise<void> {
  if (!_enabled) return;

  const db = getDb();
  const projects = db.prepare("SELECT id FROM projects WHERE status = 'developing'").all() as Array<{ id: string }>;

  for (const p of projects) {
    const todoCount = (
      db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ? AND status = 'todo'").get(p.id) as CountResult
    ).c;

    if (todoCount > 0) {
      await scheduleProject(p.id);
    }
  }
}

// ═══════════════════════════════════════
// Lifecycle: register event listeners
// ═══════════════════════════════════════

let _registered = false;

/**
 * 注册调度事件监听器 — 在 daemon 启动时调用一次
 */
export function registerSchedulerListeners(): void {
  if (_registered) return;
  _registered = true;

  onScheduleEvent('schedule:feature_todo', onFeatureReady);
  onScheduleEvent('schedule:feature_completed', onFeatureCompleted);
  onScheduleEvent('schedule:feature_failed', onFeatureCompleted); // 失败也释放 capacity
  onScheduleEvent('schedule:project_started', onFeatureReady);
  onScheduleEvent('schedule:wish_created', onWishCreated);
  onScheduleEvent('schedule:wish_updated', onWishCreated);
  onScheduleEvent('schedule:member_added', onMemberAdded);
  onScheduleEvent('schedule:member_updated', onMemberAdded);
  onScheduleEvent('schedule:session_failed', onSessionFailed);

  log.info('Scheduler event listeners registered');
}

/**
 * 取消注册（测试用）
 */
export function unregisterSchedulerListeners(): void {
  _registered = false;
}
