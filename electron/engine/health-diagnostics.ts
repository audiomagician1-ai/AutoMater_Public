/**
 * Health Diagnostics — 异常模式检测器 (v34.0)
 *
 * 纯程序化检测，零 LLM token 消耗。
 * 由 meta-agent-daemon 心跳/事件钩子触发，持续扫描所有项目的健康指标。
 *
 * 检测 7 种异常模式:
 *   1. FeatureLooping   — Feature 循环失败 (同一 feature 连续 N 次 fail)
 *   2. QARejectLoop     — QA 无限 reject (reviewing↔in_progress 反复切换)
 *   3. WorkerMassDeath  — Worker 批量死亡 (短时间内多个 session 崩溃)
 *   4. ProjectStall     — 项目停滞 (developing 状态但无进展超过阈值)
 *   5. LLMConnFailure   — LLM 连接/API 持续失败
 *   6. ResourceExhaust  — 资源枯竭 (Token 预算耗尽 / 并发 slot 全死锁)
 *   7. ZombieFeature     — 僵尸 Feature (in_progress 但无活跃 session)
 *
 * 每种 anomaly 输出结构化 AnomalyReport，供 auto-remediation 消费。
 */

import { getDb } from '../db';
import { createLogger } from './logger';

const log = createLogger('health-diag');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

/** 异常严重级别 */
export type AnomalySeverity = 'warning' | 'error' | 'critical';

/** 异常模式类型 */
export type AnomalyPattern =
  | 'feature_looping'
  | 'qa_reject_loop'
  | 'worker_mass_death'
  | 'project_stall'
  | 'llm_conn_failure'
  | 'resource_exhaust'
  | 'zombie_feature';

/** 建议修复级别 */
export type SuggestedLevel = 1 | 2 | 3;

/** 单条异常诊断报告 */
export interface AnomalyReport {
  pattern: AnomalyPattern;
  severity: AnomalySeverity;
  projectId: string;
  featureId?: string;
  sessionId?: string;
  /** 人类可读描述 */
  description: string;
  /** 检测到的数据证据 */
  evidence: Record<string, unknown>;
  /** 建议修复级别: 1=程序化 2=LLM诊断 3=深度自修复 */
  suggestedLevel: SuggestedLevel;
  /** 建议的 L1 程序化修复动作 (如果 suggestedLevel=1) */
  suggestedAction?: L1Action;
  /** 检测时间 */
  detectedAt: string;
}

/** L1 程序化修复动作类型 */
export type L1ActionType =
  | 'restart_session'
  | 'release_lock'
  | 'switch_model'
  | 'mark_blocked'
  | 'adjust_scheduler'
  | 'reset_feature'
  | 'gc_sessions';

/** L1 程序化修复动作 */
export interface L1Action {
  type: L1ActionType;
  params: Record<string, unknown>;
}

/** 检测阈值配置 */
export interface DiagnosticThresholds {
  /** Feature 连续失败次数阈值 (默认 3) */
  featureFailCount: number;
  /** QA reject 循环次数阈值 (默认 4) */
  qaRejectCount: number;
  /** Worker 批量死亡: 时间窗口内死亡数阈值 (默认 3) */
  massDeathCount: number;
  /** Worker 批量死亡: 时间窗口(分钟) (默认 10) */
  massDeathWindowMin: number;
  /** 项目停滞阈值(分钟) (默认 60) */
  projectStallMin: number;
  /** LLM 连续失败次数阈值 (默认 5) */
  llmFailCount: number;
  /** LLM 失败检测时间窗口(分钟) (默认 15) */
  llmFailWindowMin: number;
  /** 僵尸 Feature 超时(分钟) (默认 30) */
  zombieTimeoutMin: number;
}

const DEFAULT_THRESHOLDS: DiagnosticThresholds = {
  featureFailCount: 3,
  qaRejectCount: 4,
  massDeathCount: 3,
  massDeathWindowMin: 10,
  projectStallMin: 60,
  llmFailCount: 5,
  llmFailWindowMin: 15,
  zombieTimeoutMin: 30,
};

// ═══════════════════════════════════════
// Internal DB query helpers
// ═══════════════════════════════════════

interface FeatureFailHistory {
  feature_id: string;
  project_id: string;
  title: string;
  fail_count: number;
  last_error: string | null;
}

interface QARejectHistory {
  feature_id: string;
  project_id: string;
  title: string;
  reject_count: number;
}

interface DeadSession {
  id: string;
  project_id: string;
  feature_id: string | null;
  error_message: string | null;
  completed_at: string;
}

interface StalledProject {
  id: string;
  name: string;
  status: string;
  updated_at: string;
  todo_count: number;
  in_progress_count: number;
  passed_count: number;
}

interface LLMFailEvent {
  id: number;
  project_id: string;
  data: string;
  created_at: string;
}

interface ZombieFeatureRow {
  id: string;
  project_id: string;
  title: string;
  locked_by: string | null;
  locked_at: string | null;
}

// ═══════════════════════════════════════
// Feature Health Tracking (in-memory ring buffer)
// ═══════════════════════════════════════

interface FeatureHealthEntry {
  featureId: string;
  projectId: string;
  consecutiveFailures: number;
  qaRejectCycles: number;
  lastFailTime?: string;
  lastRejectTime?: string;
}

/** featureId → health tracking */
const featureHealthMap = new Map<string, FeatureHealthEntry>();

/** 记录 feature 失败 — 由事件钩子调用 */
export function recordFeatureFailure(projectId: string, featureId: string): void {
  const entry = featureHealthMap.get(featureId) ?? {
    featureId,
    projectId,
    consecutiveFailures: 0,
    qaRejectCycles: 0,
  };
  entry.consecutiveFailures++;
  entry.lastFailTime = new Date().toISOString();
  featureHealthMap.set(featureId, entry);
}

/** 记录 QA reject — 由事件钩子调用 */
export function recordQAReject(projectId: string, featureId: string): void {
  const entry = featureHealthMap.get(featureId) ?? {
    featureId,
    projectId,
    consecutiveFailures: 0,
    qaRejectCycles: 0,
  };
  entry.qaRejectCycles++;
  entry.lastRejectTime = new Date().toISOString();
  featureHealthMap.set(featureId, entry);
}

/** Feature 成功时重置计数器 */
export function recordFeatureSuccess(featureId: string): void {
  featureHealthMap.delete(featureId);
}

/** 获取 feature 健康条目 (供测试/外部查询) */
export function getFeatureHealth(featureId: string): FeatureHealthEntry | undefined {
  return featureHealthMap.get(featureId);
}

// ═══════════════════════════════════════
// Core Diagnostic Engine
// ═══════════════════════════════════════

/**
 * 执行全面健康诊断 — 扫描所有活跃项目
 *
 * @param thresholds 可选阈值覆盖
 * @returns 检测到的所有异常报告 (空数组 = 一切正常)
 */
export function runDiagnostics(thresholds?: Partial<DiagnosticThresholds>): AnomalyReport[] {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const now = new Date().toISOString();
  const anomalies: AnomalyReport[] = [];

  try {
    anomalies.push(...detectFeatureLooping(t, now));
    anomalies.push(...detectQARejectLoop(t, now));
    anomalies.push(...detectWorkerMassDeath(t, now));
    anomalies.push(...detectProjectStall(t, now));
    anomalies.push(...detectLLMConnFailure(t, now));
    anomalies.push(...detectResourceExhaust(t, now));
    anomalies.push(...detectZombieFeatures(t, now));
  } catch (err) {
    log.error('Diagnostic scan failed', err);
  }

  if (anomalies.length > 0) {
    log.info(`Diagnostics found ${anomalies.length} anomalies`, {
      patterns: anomalies.map(a => a.pattern),
    });
  }

  return anomalies;
}

/**
 * 对单个项目执行诊断
 */
export function runProjectDiagnostics(
  projectId: string,
  thresholds?: Partial<DiagnosticThresholds>,
): AnomalyReport[] {
  const all = runDiagnostics(thresholds);
  return all.filter(a => a.projectId === projectId);
}

// ═══════════════════════════════════════
// Pattern 1: Feature 循环失败
// ═══════════════════════════════════════

function detectFeatureLooping(t: DiagnosticThresholds, now: string): AnomalyReport[] {
  const results: AnomalyReport[] = [];

  // 1. 检查内存中的计数器 (由事件钩子实时更新)
  for (const [featureId, entry] of featureHealthMap) {
    if (entry.consecutiveFailures >= t.featureFailCount) {
      const isHigh = entry.consecutiveFailures >= t.featureFailCount * 2;
      results.push({
        pattern: 'feature_looping',
        severity: isHigh ? 'critical' : 'error',
        projectId: entry.projectId,
        featureId,
        description: `Feature 连续失败 ${entry.consecutiveFailures} 次 (阈值: ${t.featureFailCount})`,
        evidence: {
          consecutiveFailures: entry.consecutiveFailures,
          lastFailTime: entry.lastFailTime,
        },
        suggestedLevel: isHigh ? 2 : 1,
        suggestedAction: isHigh
          ? undefined
          : {
              type: 'switch_model',
              params: { featureId, reason: 'consecutive_failures' },
            },
        detectedAt: now,
      });
    }
  }

  // 2. 补充: 从 DB 检查近期 failed features 的 event 历史
  try {
    const db = getDb();
    const failedFeatures = db
      .prepare(
        `
        SELECT f.id as feature_id, f.project_id, f.title,
               COUNT(e.id) as fail_count,
               MAX(f.notes) as last_error
        FROM features f
        JOIN events e ON e.feature_id = f.id AND e.type = 'feature:failed'
        WHERE f.status IN ('failed', 'todo')
        GROUP BY f.id
        HAVING fail_count >= ?
      `,
      )
      .all(t.featureFailCount) as FeatureFailHistory[];

    for (const ff of failedFeatures) {
      // 避免与内存检测重复
      if (results.some(r => r.featureId === ff.feature_id)) continue;

      results.push({
        pattern: 'feature_looping',
        severity: ff.fail_count >= t.featureFailCount * 2 ? 'critical' : 'error',
        projectId: ff.project_id,
        featureId: ff.feature_id,
        description: `Feature "${ff.title}" 历史失败 ${ff.fail_count} 次 (DB 统计)`,
        evidence: {
          failCount: ff.fail_count,
          lastError: ff.last_error,
          source: 'db_events',
        },
        suggestedLevel: ff.fail_count >= t.featureFailCount * 2 ? 2 : 1,
        suggestedAction:
          ff.fail_count >= t.featureFailCount * 2
            ? undefined
            : {
                type: 'reset_feature',
                params: { featureId: ff.feature_id, projectId: ff.project_id },
              },
        detectedAt: now,
      });
    }
  } catch (err) {
    log.debug('Feature looping DB check failed', { error: String(err) });
  }

  return results;
}

// ═══════════════════════════════════════
// Pattern 2: QA 无限 Reject 循环
// ═══════════════════════════════════════

function detectQARejectLoop(t: DiagnosticThresholds, now: string): AnomalyReport[] {
  const results: AnomalyReport[] = [];

  // 内存计数器
  for (const [featureId, entry] of featureHealthMap) {
    if (entry.qaRejectCycles >= t.qaRejectCount) {
      results.push({
        pattern: 'qa_reject_loop',
        severity: entry.qaRejectCycles >= t.qaRejectCount * 2 ? 'critical' : 'error',
        projectId: entry.projectId,
        featureId,
        description: `Feature QA 被 reject ${entry.qaRejectCycles} 次 (阈值: ${t.qaRejectCount})`,
        evidence: {
          rejectCycles: entry.qaRejectCycles,
          lastRejectTime: entry.lastRejectTime,
        },
        suggestedLevel: entry.qaRejectCycles >= t.qaRejectCount * 2 ? 2 : 1,
        suggestedAction:
          entry.qaRejectCycles >= t.qaRejectCount * 2
            ? undefined
            : {
                type: 'switch_model',
                params: { featureId, reason: 'qa_reject_loop' },
              },
        detectedAt: now,
      });
    }
  }

  // DB 补充: 检查 qa:result 事件中 reject 频率
  try {
    const db = getDb();
    const rejects = db
      .prepare(
        `
        SELECT e.feature_id, f.project_id, f.title,
               COUNT(*) as reject_count
        FROM events e
        JOIN features f ON f.id = e.feature_id
        WHERE e.type = 'feature:qa:result'
          AND e.data LIKE '%"verdict":"reject"%'
          AND f.status NOT IN ('passed', 'qa_passed')
        GROUP BY e.feature_id
        HAVING reject_count >= ?
      `,
      )
      .all(t.qaRejectCount) as QARejectHistory[];

    for (const r of rejects) {
      if (!r.feature_id || results.some(x => x.featureId === r.feature_id)) continue;
      results.push({
        pattern: 'qa_reject_loop',
        severity: r.reject_count >= t.qaRejectCount * 2 ? 'critical' : 'warning',
        projectId: r.project_id,
        featureId: r.feature_id,
        description: `Feature "${r.title}" QA reject ${r.reject_count} 次 (DB 统计)`,
        evidence: {
          rejectCount: r.reject_count,
          source: 'db_events',
        },
        suggestedLevel: r.reject_count >= t.qaRejectCount * 2 ? 2 : 1,
        suggestedAction:
          r.reject_count >= t.qaRejectCount * 2
            ? undefined
            : {
                type: 'mark_blocked',
                params: { featureId: r.feature_id, reason: 'qa_reject_loop' },
              },
        detectedAt: now,
      });
    }
  } catch (err) {
    log.debug('QA reject loop DB check failed', { error: String(err) });
  }

  return results;
}

// ═══════════════════════════════════════
// Pattern 3: Worker 批量死亡
// ═══════════════════════════════════════

function detectWorkerMassDeath(t: DiagnosticThresholds, now: string): AnomalyReport[] {
  const results: AnomalyReport[] = [];

  try {
    const db = getDb();

    // 查询时间窗口内 failed sessions，按项目聚合
    const deadSessions = db
      .prepare(
        `
        SELECT s.id, s.project_id, s.feature_id, s.error_message, s.completed_at
        FROM sessions s
        WHERE s.status = 'failed'
          AND s.completed_at >= datetime('now', '-' || ? || ' minutes')
        ORDER BY s.completed_at DESC
      `,
      )
      .all(t.massDeathWindowMin) as DeadSession[];

    // 按项目聚合
    const byProject = new Map<string, DeadSession[]>();
    for (const ds of deadSessions) {
      if (!ds.project_id) continue;
      const list = byProject.get(ds.project_id) ?? [];
      list.push(ds);
      byProject.set(ds.project_id, list);
    }

    for (const [projectId, sessions] of byProject) {
      if (sessions.length >= t.massDeathCount) {
        // 检查是否所有错误相同 (共因)
        const errors = sessions.map(s => s.error_message ?? 'unknown');
        const uniqueErrors = new Set(errors);
        const isCommonCause = uniqueErrors.size === 1;

        results.push({
          pattern: 'worker_mass_death',
          severity: sessions.length >= t.massDeathCount * 2 ? 'critical' : 'error',
          projectId,
          description: `${sessions.length} 个 session 在 ${t.massDeathWindowMin} 分钟内崩溃` +
            (isCommonCause ? ` (共因: ${errors[0]?.slice(0, 80)})` : ` (${uniqueErrors.size} 种错误)`),
          evidence: {
            deadCount: sessions.length,
            windowMinutes: t.massDeathWindowMin,
            commonCause: isCommonCause,
            errors: [...uniqueErrors].slice(0, 5),
            sessionIds: sessions.slice(0, 5).map(s => s.id),
          },
          suggestedLevel: isCommonCause ? 2 : 1,
          suggestedAction: isCommonCause
            ? undefined
            : {
                type: 'gc_sessions',
                params: { projectId },
              },
          detectedAt: now,
        });
      }
    }
  } catch (err) {
    log.debug('Worker mass death check failed', { error: String(err) });
  }

  return results;
}

// ═══════════════════════════════════════
// Pattern 4: 项目停滞
// ═══════════════════════════════════════

function detectProjectStall(t: DiagnosticThresholds, now: string): AnomalyReport[] {
  const results: AnomalyReport[] = [];

  try {
    const db = getDb();

    const projects = db
      .prepare(
        `
        SELECT p.id, p.name, p.status, p.updated_at,
               (SELECT COUNT(*) FROM features WHERE project_id = p.id AND status = 'todo') as todo_count,
               (SELECT COUNT(*) FROM features WHERE project_id = p.id AND status = 'in_progress') as in_progress_count,
               (SELECT COUNT(*) FROM features WHERE project_id = p.id AND status IN ('passed', 'qa_passed')) as passed_count
        FROM projects p
        WHERE p.status = 'developing'
      `,
      )
      .all() as StalledProject[];

    for (const p of projects) {
      // 检查最近事件活跃度
      const recentEvents = db
        .prepare(
          `
          SELECT COUNT(*) as c FROM events
          WHERE project_id = ? AND created_at >= datetime('now', '-' || ? || ' minutes')
        `,
        )
        .get(p.id, t.projectStallMin) as { c: number };

      const activeSessions = db
        .prepare(
          `
          SELECT COUNT(*) as c FROM sessions
          WHERE project_id = ? AND status IN ('running', 'active', 'created')
        `,
        )
        .get(p.id) as { c: number };

      // 停滞 = developing 状态 + 无近期事件 + 无活跃 session + 有未完成 feature
      const hasWorkToDo = p.todo_count > 0 || p.in_progress_count > 0;
      const isStalled = recentEvents.c === 0 && activeSessions.c === 0 && hasWorkToDo;

      if (isStalled) {
        results.push({
          pattern: 'project_stall',
          severity: 'error',
          projectId: p.id,
          description: `项目 "${p.name}" 停滞 — 状态为 developing 但 ${t.projectStallMin} 分钟内无活动`,
          evidence: {
            todoCount: p.todo_count,
            inProgressCount: p.in_progress_count,
            passedCount: p.passed_count,
            recentEvents: recentEvents.c,
            activeSessions: activeSessions.c,
            lastUpdate: p.updated_at,
          },
          suggestedLevel: 1,
          suggestedAction: {
            type: 'restart_session',
            params: { projectId: p.id, reason: 'project_stall' },
          },
          detectedAt: now,
        });
      }
    }
  } catch (err) {
    log.debug('Project stall check failed', { error: String(err) });
  }

  return results;
}

// ═══════════════════════════════════════
// Pattern 5: LLM 连接/API 持续失败
// ═══════════════════════════════════════

function detectLLMConnFailure(t: DiagnosticThresholds, now: string): AnomalyReport[] {
  const results: AnomalyReport[] = [];

  try {
    const db = getDb();

    // 检查 events 表中的 llm:result 包含错误的记录
    const failedCalls = db
      .prepare(
        `
        SELECT id, project_id, data, created_at
        FROM events
        WHERE type = 'llm:result'
          AND (data LIKE '%"error"%' OR data LIKE '%"status":"error"%' OR data LIKE '%rate_limit%' OR data LIKE '%timeout%')
          AND created_at >= datetime('now', '-' || ? || ' minutes')
        ORDER BY created_at DESC
      `,
      )
      .all(t.llmFailWindowMin) as LLMFailEvent[];

    // 按项目聚合
    const byProject = new Map<string, LLMFailEvent[]>();
    for (const fc of failedCalls) {
      const list = byProject.get(fc.project_id) ?? [];
      list.push(fc);
      byProject.set(fc.project_id, list);
    }

    for (const [projectId, events] of byProject) {
      if (events.length >= t.llmFailCount) {
        // 分析错误类型
        const errorTypes = new Set<string>();
        for (const e of events) {
          if (e.data.includes('rate_limit')) errorTypes.add('rate_limit');
          else if (e.data.includes('timeout')) errorTypes.add('timeout');
          else if (e.data.includes('auth')) errorTypes.add('auth');
          else errorTypes.add('api_error');
        }

        const isAuth = errorTypes.has('auth');
        const isRateLimit = errorTypes.has('rate_limit');

        results.push({
          pattern: 'llm_conn_failure',
          severity: isAuth ? 'critical' : 'error',
          projectId,
          description: `LLM API ${events.length} 次失败 (${t.llmFailWindowMin}min 内), 类型: ${[...errorTypes].join(',')}`,
          evidence: {
            failCount: events.length,
            windowMinutes: t.llmFailWindowMin,
            errorTypes: [...errorTypes],
            isAuth,
            isRateLimit,
          },
          suggestedLevel: isAuth ? 1 : isRateLimit ? 1 : 2,
          suggestedAction: isRateLimit
            ? {
                type: 'adjust_scheduler',
                params: { action: 'reduce_concurrency', projectId },
              }
            : isAuth
              ? {
                  type: 'mark_blocked',
                  params: { projectId, reason: 'auth_failure' },
                }
              : undefined,
          detectedAt: now,
        });
      }
    }
  } catch (err) {
    log.debug('LLM conn failure check failed', { error: String(err) });
  }

  return results;
}

// ═══════════════════════════════════════
// Pattern 6: 资源枯竭
// ═══════════════════════════════════════

function detectResourceExhaust(t: DiagnosticThresholds, now: string): AnomalyReport[] {
  const results: AnomalyReport[] = [];

  try {
    const db = getDb();

    // 检查每个 developing 项目的 token/cost 预算
    const projects = db
      .prepare("SELECT id, name, config FROM projects WHERE status = 'developing'")
      .all() as Array<{ id: string; name: string; config: string }>;

    for (const p of projects) {
      // Token/Cost 统计
      const todayCost = db
        .prepare(
          `
          SELECT COALESCE(SUM(cost_usd), 0) as total
          FROM events
          WHERE project_id = ? AND created_at >= date('now')
        `,
        )
        .get(p.id) as { total: number };

      // 检查是否所有 feature 都被 lock 但无活跃 session (死锁)
      const lockedFeatures = db
        .prepare(
          `
          SELECT COUNT(*) as c FROM features
          WHERE project_id = ? AND status = 'in_progress' AND locked_by IS NOT NULL
        `,
        )
        .get(p.id) as { c: number };

      const activeSessions = db
        .prepare(
          `
          SELECT COUNT(*) as c FROM sessions
          WHERE project_id = ? AND status IN ('running', 'active', 'created')
        `,
        )
        .get(p.id) as { c: number };

      const todoFeatures = db
        .prepare(
          `
          SELECT COUNT(*) as c FROM features
          WHERE project_id = ? AND status = 'todo'
        `,
        )
        .get(p.id) as { c: number };

      // 死锁检测: 有 locked features 但无活跃 session 且无 todo
      if (lockedFeatures.c > 0 && activeSessions.c === 0 && todoFeatures.c === 0) {
        results.push({
          pattern: 'resource_exhaust',
          severity: 'critical',
          projectId: p.id,
          description: `项目 "${p.name}" 检测到死锁: ${lockedFeatures.c} 个 feature 被锁定但无活跃 session`,
          evidence: {
            lockedCount: lockedFeatures.c,
            activeSessionCount: activeSessions.c,
            todoCount: todoFeatures.c,
            type: 'deadlock',
          },
          suggestedLevel: 1,
          suggestedAction: {
            type: 'release_lock',
            params: { projectId: p.id, all: true },
          },
          detectedAt: now,
        });
      }

      // 预算检测 (如果配置了日预算)
      try {
        const config = JSON.parse(p.config || '{}');
        const dailyBudget = config.dailyBudgetUsd ?? 0;
        if (dailyBudget > 0 && todayCost.total >= dailyBudget * 0.95) {
          results.push({
            pattern: 'resource_exhaust',
            severity: todayCost.total >= dailyBudget ? 'critical' : 'warning',
            projectId: p.id,
            description: `项目 "${p.name}" 今日花费 $${todayCost.total.toFixed(2)} / $${dailyBudget.toFixed(2)} (${Math.round((todayCost.total / dailyBudget) * 100)}%)`,
            evidence: {
              todayCost: todayCost.total,
              dailyBudget,
              percentUsed: Math.round((todayCost.total / dailyBudget) * 100),
              type: 'budget',
            },
            suggestedLevel: 1,
            suggestedAction: {
              type: 'adjust_scheduler',
              params: { action: 'pause_project', projectId: p.id },
            },
            detectedAt: now,
          });
        }
      } catch {
        /* config parse failure is non-critical */
      }
    }
  } catch (err) {
    log.debug('Resource exhaust check failed', { error: String(err) });
  }

  return results;
}

// ═══════════════════════════════════════
// Pattern 7: 僵尸 Feature
// ═══════════════════════════════════════

function detectZombieFeatures(t: DiagnosticThresholds, now: string): AnomalyReport[] {
  const results: AnomalyReport[] = [];

  try {
    const db = getDb();

    const zombies = db
      .prepare(
        `
        SELECT f.id, f.project_id, f.title, f.locked_by, f.locked_at
        FROM features f
        WHERE f.status = 'in_progress'
          AND f.locked_by IS NOT NULL
          AND (
            f.locked_at IS NULL
            OR f.locked_at < datetime('now', '-' || ? || ' minutes')
          )
      `,
      )
      .all(t.zombieTimeoutMin) as ZombieFeatureRow[];

    for (const z of zombies) {
      // 验证: 是否有对应的活跃 session
      const hasActiveSession = db
        .prepare(
          `
          SELECT 1 FROM sessions
          WHERE (id = ? OR agent_id = ?)
            AND status IN ('running', 'active', 'created')
          LIMIT 1
        `,
        )
        .get(z.locked_by, z.locked_by);

      if (!hasActiveSession) {
        results.push({
          pattern: 'zombie_feature',
          severity: 'warning',
          projectId: z.project_id,
          featureId: z.id,
          description: `Feature "${z.title}" 被 ${z.locked_by} 锁定超过 ${t.zombieTimeoutMin} 分钟，无对应活跃 session`,
          evidence: {
            lockedBy: z.locked_by,
            lockedAt: z.locked_at,
            timeoutMinutes: t.zombieTimeoutMin,
          },
          suggestedLevel: 1,
          suggestedAction: {
            type: 'release_lock',
            params: { featureId: z.id, projectId: z.project_id },
          },
          detectedAt: now,
        });
      }
    }
  } catch (err) {
    log.debug('Zombie feature check failed', { error: String(err) });
  }

  return results;
}

// ═══════════════════════════════════════
// Utility: Anomaly summary for UI/logging
// ═══════════════════════════════════════

/** 将异常列表格式化为人类可读摘要 */
export function formatAnomalySummary(anomalies: AnomalyReport[]): string {
  if (anomalies.length === 0) return '✅ 所有项目运行正常';

  const lines: string[] = [`⚠️ 检测到 ${anomalies.length} 个异常:`];
  const grouped = new Map<string, AnomalyReport[]>();

  for (const a of anomalies) {
    const key = a.projectId;
    const list = grouped.get(key) ?? [];
    list.push(a);
    grouped.set(key, list);
  }

  for (const [projectId, items] of grouped) {
    lines.push(`\n📁 项目 ${projectId}:`);
    for (const item of items) {
      const icon = item.severity === 'critical' ? '🔴' : item.severity === 'error' ? '🟠' : '🟡';
      lines.push(`  ${icon} [${item.pattern}] ${item.description} (建议: L${item.suggestedLevel})`);
    }
  }

  return lines.join('\n');
}

/** 清空内存中的健康追踪数据 (测试用) */
export function resetHealthTracking(): void {
  featureHealthMap.clear();
}
