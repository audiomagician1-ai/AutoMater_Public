/**
 * Scheduler Bus — 事件驱动调度总线 (v28.0)
 *
 * 核心设计: 不靠定时轮询，靠事件即时触发调度。
 * 各 IPC handler / Phase 在关键时刻发射调度事件 → Scheduler 立即响应。
 * daemon 的 30s 定时轮询仅作为兜底（防止事件丢失）。
 *
 * 事件流:
 *   wish:create (IPC) → emitScheduleEvent('schedule:wish_created') → scheduler.onWishCreated()
 *   feature→todo (PM)  → emitScheduleEvent('schedule:feature_todo')  → scheduler.onFeatureReady()
 *   project:start (IPC)→ emitScheduleEvent('schedule:project_started')→ scheduler.onProjectStarted()
 *   feature completed   → emitScheduleEvent('schedule:feature_completed')→ scheduler.onFeatureCompleted()
 *   session failed      → emitScheduleEvent('schedule:session_failed')→ scheduler.onSessionFailed()
 */

import { EventEmitter } from 'events';
import { emitEvent, type EventType } from './event-store';
import { createLogger } from './logger';

const log = createLogger('scheduler-bus');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface ScheduleEventPayload {
  projectId: string;
  featureId?: string;
  sessionId?: string;
  memberId?: string;
  wishId?: string;
  /** 任意附加数据 */
  [key: string]: unknown;
}

// 调度事件类型子集 (与 event-store.ts 的 schedule:* 对应)
export type ScheduleEventType =
  | 'schedule:wish_created'
  | 'schedule:wish_updated'
  | 'schedule:feature_todo'
  | 'schedule:feature_completed'
  | 'schedule:feature_failed'
  | 'schedule:project_started'
  | 'schedule:project_paused'
  | 'schedule:member_added'
  | 'schedule:member_updated'
  | 'schedule:session_created'
  | 'schedule:session_failed';

// ═══════════════════════════════════════
// Bus Singleton
// ═══════════════════════════════════════

const bus = new EventEmitter();
bus.setMaxListeners(50);

/**
 * 发射调度事件 — 在各 IPC handler / Phase 的关键位置调用
 * 同时写入 event-store 用于审计。
 */
export function emitScheduleEvent(type: ScheduleEventType, payload: ScheduleEventPayload): void {
  log.debug(`Schedule event: ${type}`, { projectId: payload.projectId, featureId: payload.featureId });

  // 1. 写入 event-store（审计 + 持久化）
  try {
    emitEvent({
      projectId: payload.projectId,
      agentId: 'scheduler',
      featureId: payload.featureId,
      type: type as EventType,
      data: payload,
    });
  } catch {
    /* non-critical: 审计失败不影响调度 */
  }

  // 2. 发射到内存总线（Scheduler 即时响应）
  bus.emit(type, payload);
}

/**
 * 监听调度事件 — Scheduler 启动时注册
 */
export function onScheduleEvent(
  type: ScheduleEventType,
  handler: (payload: ScheduleEventPayload) => void | Promise<void>,
): void {
  bus.on(type, (payload: ScheduleEventPayload) => {
    try {
      const result = handler(payload);
      // 如果 handler 是 async，捕获 rejection
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(err => {
          log.error(`Schedule handler error [${type}]`, err);
        });
      }
    } catch (err) {
      log.error(`Schedule handler error [${type}]`, err);
    }
  });
}

/**
 * 移除所有调度事件监听器 — 测试或重启时使用
 */
export function clearScheduleListeners(): void {
  bus.removeAllListeners();
}
