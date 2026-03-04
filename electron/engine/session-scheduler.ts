/**
 * Session Scheduler — 事件驱动的自动调度引擎 (v28.0)
 *
 * 核心职责:
 *   1. 监听 SchedulerBus 事件，在关键时刻自动调度
 *   2. 扫描看板上可执行的 Feature，为空闲 Agent slot spawn Session
 *   3. 提供 fallbackCheck 供 daemon 定时兜底调用
 *
 * 调度模型:
 *   team_members 行 = Agent 类定义
 *   sessions 行    = Agent 实例 (由 Scheduler spawn)
 *   一个 Agent 可同时有 N 个 running session (N = max_concurrent_sessions)
 */

import { BrowserWindow } from 'electron';
import { getDb } from '../db';
import { createLogger } from './logger';
import { getSettings } from './llm-client';
import { lockNextFeature, spawnAgent } from './agent-manager';
import { createSessionForFeature, transitionSession, getRunningSessionCount } from './conversation-backup';
import { onScheduleEvent, emitScheduleEvent, type ScheduleEventPayload } from './scheduler-bus';
import { getHotJoinContext } from './orchestrator';
import { workerLoop, type WorkerLoopOptions } from './phases';
import type { TeamMemberRow, FeatureRow, PhaseResult } from './types';

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

/** sessionId → AbortController，用于停止特定 session */
const activeSessions = new Map<string, AbortController>();

export function getActiveSessions(): Map<string, AbortController> {
  return activeSessions;
}

// ═══════════════════════════════════════
// Core scheduling logic
// ═══════════════════════════════════════

/**
 * 为指定项目执行一轮调度:
 * 扫描 todo feature → 匹配有空闲 slot 的 Agent → spawn session → 启动 workerLoop
 */
export async function scheduleProject(projectId: string): Promise<{ spawned: number }> {
  if (!_enabled) return { spawned: 0 };

  const settings = getSettings();
  if (!settings?.apiKey) return { spawned: 0 };

  // v28.0: 必须有 orchestrator 上下文才能真正启动 workerLoop
  const hjCtx = getHotJoinContext(projectId);
  if (!hjCtx || hjCtx.signal.aborted) {
    // 没有 developing 上下文 → 仅创建 session 记录（不启动 workerLoop）
    return scheduleProjectSessionOnly(projectId, settings);
  }

  const db = getDb();

  // 1. 查询所有 developer 角色的 Agent（按创建顺序）
  const members = db
    .prepare("SELECT * FROM team_members WHERE project_id = ? AND role = 'developer' ORDER BY created_at ASC")
    .all(projectId) as TeamMemberRow[];

  if (members.length === 0) return { spawned: 0 };

  let spawned = 0;

  for (const member of members) {
    // 2. 检查该 Agent 当前有几个 running/created session
    const runningCount = getRunningSessionCount(member.id);
    const maxConcurrency = member.max_concurrent_sessions || 1;
    const availableSlots = maxConcurrency - runningCount;

    if (availableSlots <= 0) continue;

    // 3. 为每个空闲 slot 尝试锁定一个 feature 并 spawn session + workerLoop
    for (let i = 0; i < availableSlots; i++) {
      const feature = lockNextFeature(projectId, member.id);
      if (!feature) break; // 没有更多可锁定的 feature

      try {
        const session = createSessionForFeature(member.id, feature.id, projectId, member.name, member.role);

        emitScheduleEvent('schedule:session_created', {
          projectId,
          sessionId: session.id,
          memberId: member.id,
          featureId: feature.id,
        });

        // v28.0: 分配 worker ID 并启动真正的 workerLoop
        hjCtx.nextWorkerSeq += 1;
        const workerId = `dev-sched-${hjCtx.nextWorkerSeq}`;
        spawnAgent(projectId, workerId, 'developer', hjCtx.win);
        db.prepare("UPDATE agents SET status = 'idle' WHERE id = ? AND project_id = ?").run(workerId, projectId);

        const workerOpts: WorkerLoopOptions = {
          member,
          preCreatedSessionId: session.id,
        };

        const promise = workerLoop(
          projectId,
          workerId,
          hjCtx.qaId,
          hjCtx.settings,
          hjCtx.win,
          hjCtx.signal,
          hjCtx.workspacePath,
          hjCtx.gitConfig,
          hjCtx.permissions,
          workerOpts,
        );
        hjCtx.workerPromises.add(promise);
        promise.finally(() => {
          hjCtx.workerPromises.delete(promise);
          activeSessions.delete(session.id);
        });

        // 追踪 active session (暂无 AbortController, 因为共用 orchestrator signal)
        activeSessions.set(session.id, new AbortController());

        log.info('Worker session spawned via scheduler', {
          sessionId: session.id,
          workerId,
          memberId: member.id,
          memberName: member.name,
          featureId: feature.id,
          projectId,
        });

        spawned++;
      } catch (err) {
        log.error('Failed to spawn worker session', err, { memberId: member.id, featureId: feature.id });
        // 释放锁：将 feature 重置为 todo
        db.prepare("UPDATE features SET status = 'todo', locked_by = NULL WHERE id = ? AND project_id = ?").run(
          feature.id,
          projectId,
        );
      }
    }
  }

  if (spawned > 0) {
    log.info(`Scheduled ${spawned} worker sessions for project ${projectId}`);
  }

  return { spawned };
}

/**
 * 仅创建 session 记录（不启动 workerLoop）
 * 用于 orchestrator 不在运行时的预创建场景
 */
function scheduleProjectSessionOnly(projectId: string, settings: import('./types').AppSettings): { spawned: number } {
  const db = getDb();
  const members = db
    .prepare("SELECT * FROM team_members WHERE project_id = ? AND role = 'developer' ORDER BY created_at ASC")
    .all(projectId) as TeamMemberRow[];

  if (members.length === 0) return { spawned: 0 };
  let spawned = 0;

  for (const member of members) {
    const runningCount = getRunningSessionCount(member.id);
    const maxConcurrency = member.max_concurrent_sessions || 1;
    const availableSlots = maxConcurrency - runningCount;
    if (availableSlots <= 0) continue;

    for (let i = 0; i < availableSlots; i++) {
      const feature = lockNextFeature(projectId, member.id);
      if (!feature) break;

      try {
        const session = createSessionForFeature(member.id, feature.id, projectId, member.name, member.role);
        emitScheduleEvent('schedule:session_created', {
          projectId,
          sessionId: session.id,
          memberId: member.id,
          featureId: feature.id,
        });
        log.info('Session pre-created (no active orchestrator)', { sessionId: session.id, featureId: feature.id });
        spawned++;
      } catch (err) {
        log.error('Failed to pre-create session', err, { memberId: member.id, featureId: feature.id });
        db.prepare("UPDATE features SET status = 'todo', locked_by = NULL WHERE id = ? AND project_id = ?").run(
          feature.id,
          projectId,
        );
      }
    }
  }

  return { spawned };
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
  // TODO: 如果项目处于 paused 状态且有自动调度开关，可以自动触发 PM 分析
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
  // 重新调度（可能有释放出的 feature 需要重分配）
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
    // 检查是否有 todo feature 且有 Agent 有空闲 slot
    const todoCount = (
      db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ? AND status = 'todo'").get(p.id) as {
        c: number;
      }
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
  // clearScheduleListeners() 在 scheduler-bus.ts 中
}
