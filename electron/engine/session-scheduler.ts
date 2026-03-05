/**
 * Session Scheduler — Feature 级并发调度引擎 (v30.1)
 *
 * 核心职责:
 *   1. 成为 Dev+QA 阶段的 **唯一** 调度入口
 *   2. 扫描看板上可执行的 Feature，为空闲 Agent slot spawn Session + workerLoop
 *   3. 监听 SchedulerBus 事件，在 Feature 完成/失败时自动补充调度
 *   4. 提供 awaitAllFeaturesDone 阻塞式等待，供 orchestrator 使用
 *   5. 提供 fallbackCheck 供 daemon 定时兜底调用
 *
 * 调度模型 (v30.0+):
 *   并发单元 = Feature (lockNextFeature 互斥)
 *   team_members 行 = Agent 类定义 (角色模板 + 并发配额)
 *   sessions 行    = 工作记录 (由 Scheduler spawn, 绑定 Feature)
 *   一个 Agent 可同时有 N 个 running session (N = max_concurrent_sessions)
 *   workerLoop 内部 ReAct 循环是串行的，并行发生在多 Feature 之间
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
import { workerLoop, type WorkerLoopOptions } from './phases';
import { sendToUI } from './ui-bridge';
import type { TeamMemberRow, FeatureRow, PhaseResult, AppSettings, CountResult } from './types';
import type { AgentPermissions } from './tool-registry';
import type { GitProviderConfig } from './git-provider';

const log = createLogger('session-scheduler');

// ═══════════════════════════════════════
// Config
// ═══════════════════════════════════════

/**
 * Scheduler 启用状态 — 按项目追踪 (v30.1)
 * 改进: 不再使用全局 boolean，避免多项目并发时的竞态。
 * daemon 级 enable/disable 通过 _daemonEnabled 控制 fallbackCheck;
 * 项目级启用通过 devPhaseContexts.has(projectId) 隐式判断。
 */
let _daemonEnabled = false;

export function enableScheduler(): void {
  _daemonEnabled = true;
}
export function disableScheduler(): void {
  _daemonEnabled = false;
}
export function isSchedulerEnabled(): boolean {
  return _daemonEnabled;
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
 * v30.0: Dev 阶段运行上下文 — 由 orchestrator 注入，scheduler 管理
 * 替代旧的 HotJoinContext (orchestrator 不再直接 spawn worker)
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
 * v30.0: scheduler 自持 DevPhaseContext, 不再依赖 orchestrator 的 HotJoinContext
 */
export async function scheduleProject(projectId: string): Promise<{ spawned: number }> {
  // 项目级判断: 有活跃 DevPhaseContext 即可调度 (不依赖全局开关)
  // 全局开关仅控制 daemon fallbackCheck

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
 * 为一个 Feature spawn 一个 Session + workerLoop
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

    // 4. 启动 workerLoop
    const workerOpts: WorkerLoopOptions = {
      member,
      preCreatedSessionId: session.id,
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

  // 2. 确保 daemon 级 scheduler 已启用 (用于 fallbackCheck 兜底)
  _daemonEnabled = true;

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
    // 如果没有其他活跃项目，daemon 级开关保持不变 (由 stopDaemon 统一关闭)

    sendToUI(params.win, 'agent:log', {
      projectId,
      agentId: 'scheduler',
      content: '✅ Session 调度器: 所有 Feature 已处理完毕',
    });
  }
}

/**
 * 阻塞等待项目所有 Feature 完成/失败/暂停
 * 使用轮询 + 事件驱动混合策略:
 *   - 事件驱动: Feature 完成/失败时 scheduleProject 自动触发新调度
 *   - 轮询兜底: 每 2s 检查一次是否还有活跃 worker 或 todo feature
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

    if (activeCount === 0 && todoCount === 0 && workingCount === 0) {
      // 全部完成
      break;
    }

    // 如果有 todo 但 active worker 未满 → 补充调度
    const ctx = devPhaseContexts.get(projectId);
    const DEFAULT_MAX_WORKERS = 3;
    const maxSlots = ctx
      ? ctx.settings.workerCount > 0
        ? ctx.settings.workerCount
        : DEFAULT_MAX_WORKERS
      : DEFAULT_MAX_WORKERS;
    if (todoCount > 0 && activeCount < maxSlots) {
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
 * 新需求创建 → 如果项目在 developing 状态，后续 PM 分析会产出 feature_todo 事件
 * 这里仅记录日志，实际调度由 feature_todo 触发
 */
async function onWishCreated(payload: ScheduleEventPayload): Promise<void> {
  log.info('New wish created, awaiting PM analysis to produce features', {
    projectId: payload.projectId,
    wishId: payload.wishId,
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
  if (!_daemonEnabled) return;

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
