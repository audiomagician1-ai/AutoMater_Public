/**
 * Auto-Remediation Engine — 三级自动修复编排器 (v34.0)
 *
 * 消费 health-diagnostics 的 AnomalyReport，按级别执行修复:
 *
 *   Level 1 (程序化): 零 token，即时修复
 *     - restart_session: 重启失败的 session
 *     - release_lock: 释放僵尸锁
 *     - switch_model: 切换到更稳定的模型
 *     - mark_blocked: 标记 feature 为阻塞
 *     - adjust_scheduler: 调整调度参数 (降低并发/暂停)
 *     - reset_feature: 重置 feature 状态到 todo
 *     - gc_sessions: 清理死亡 session
 *
 *   Level 2 (LLM 诊断): Meta-agent 用 ReAct 循环诊断+修复
 *     - 受限工具集 (只读日志/DB/文件 + 调度管理)
 *     - 独立 token 预算 (每次诊断 max 8K tokens)
 *     - 输出结构化修复计划并执行
 *
 *   Level 3 (深度自修复): 复用 SelfEvolutionEngine 的 SafeGitOps 基础设施
 *     - 由 self-repair-engine.ts 实现 (本文件只做桥接)
 *
 * 核心原则:
 *   - 每个 feature 最多 L1 重试 3 次，L2 诊断 1 次
 *   - 修复操作全部记录到 remediation_log
 *   - 修复不阻塞正常调度 — 异步执行
 */

import { getDb } from '../db';
import { createLogger } from './logger';
import { callLLM, getSettings } from './llm-client';
import { sendToUI } from './ui-bridge';
import { cleanupZombieLocks } from './session-lifecycle';
import { scheduleProject } from './session-scheduler';
import { emitScheduleEvent } from './scheduler-bus';
import type { AppSettings } from './types';
import {
  type AnomalyReport,
  type L1Action,
  type L1ActionType,
  type AnomalyPattern,
  formatAnomalySummary,
} from './health-diagnostics';

const log = createLogger('auto-remediation');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export type RemediationStatus = 'pending' | 'executing' | 'success' | 'failed' | 'skipped';

export interface RemediationRecord {
  id?: number;
  anomalyPattern: AnomalyPattern;
  level: 1 | 2 | 3;
  projectId: string;
  featureId?: string;
  action: string;
  status: RemediationStatus;
  detail: string;
  tokensUsed: number;
  costUsd: number;
  createdAt?: string;
  completedAt?: string;
}

/** L1 修复尝试计数器: featureId|projectId → count */
const l1AttemptCounts = new Map<string, number>();
/** L2 诊断尝试计数器: featureId|projectId → count */
const l2AttemptCounts = new Map<string, number>();

/** L1 最大重试次数 */
const MAX_L1_ATTEMPTS = 3;
/** L2 最大诊断次数 (per feature) */
const MAX_L2_ATTEMPTS = 1;
/** L2 诊断 token 预算 */
const L2_MAX_TOKENS = 8192;

// ═══════════════════════════════════════
// DB Schema & Helpers
// ═══════════════════════════════════════

/** 确保 remediation_log 表存在 */
export function ensureRemediationTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS remediation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anomaly_pattern TEXT NOT NULL,
      level INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      feature_id TEXT,
      action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      detail TEXT NOT NULL DEFAULT '',
      tokens_used INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_remediation_project ON remediation_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_remediation_pattern ON remediation_log(anomaly_pattern);
    CREATE INDEX IF NOT EXISTS idx_remediation_status ON remediation_log(status);
  `);
}

function logRemediation(record: RemediationRecord): number {
  try {
    const db = getDb();
    const result = db
      .prepare(
        `
      INSERT INTO remediation_log (anomaly_pattern, level, project_id, feature_id, action, status, detail, tokens_used, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        record.anomalyPattern,
        record.level,
        record.projectId,
        record.featureId ?? null,
        record.action,
        record.status,
        record.detail,
        record.tokensUsed,
        record.costUsd,
      );
    return (result as { lastInsertRowid: number }).lastInsertRowid ?? 0;
  } catch (err) {
    log.error('Failed to log remediation', err);
    return 0;
  }
}

function updateRemediationStatus(id: number, status: RemediationStatus, detail?: string): void {
  try {
    const db = getDb();
    const now = status === 'success' || status === 'failed' ? new Date().toISOString() : null;
    db.prepare(
      `
      UPDATE remediation_log
      SET status = ?, detail = COALESCE(?, detail), completed_at = COALESCE(?, completed_at)
      WHERE id = ?
    `,
    ).run(status, detail ?? null, now, id);
  } catch (err) {
    log.error('Failed to update remediation status', err);
  }
}

// ═══════════════════════════════════════
// Core Orchestrator
// ═══════════════════════════════════════

/**
 * 处理一批异常报告 — 主入口
 *
 * 由 meta-agent-daemon 的心跳/钩子触发。
 * 按优先级排序: critical > error > warning，逐条处理。
 * 修复是异步的但串行执行 (防止并发修复冲突)。
 */
export async function handleAnomalies(
  anomalies: AnomalyReport[],
  win: Electron.BrowserWindow | null,
): Promise<RemediationRecord[]> {
  if (anomalies.length === 0) return [];

  ensureRemediationTable();

  // 按严重程度排序
  const severityOrder: Record<string, number> = { critical: 0, error: 1, warning: 2 };
  const sorted = [...anomalies].sort(
    (a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9),
  );

  const results: RemediationRecord[] = [];

  for (const anomaly of sorted) {
    try {
      const record = await processAnomaly(anomaly, win);
      if (record) results.push(record);
    } catch (err) {
      log.error('Remediation failed for anomaly', err, { pattern: anomaly.pattern });
    }
  }

  // 通知 UI
  if (results.length > 0) {
    const successCount = results.filter(r => r.status === 'success').length;
    sendToUI(win, 'agent:log', {
      projectId: 'system',
      agentId: 'auto-remediation',
      content: `🔧 自动修复完成: ${successCount}/${results.length} 成功`,
    });
  }

  return results;
}

/**
 * 处理单条异常
 */
async function processAnomaly(
  anomaly: AnomalyReport,
  win: Electron.BrowserWindow | null,
): Promise<RemediationRecord | null> {
  const key = anomaly.featureId ?? anomaly.projectId;

  // 检查 L1 重试限制
  if (anomaly.suggestedLevel === 1) {
    const l1Count = l1AttemptCounts.get(key) ?? 0;
    if (l1Count >= MAX_L1_ATTEMPTS) {
      log.info('L1 attempts exhausted, escalating to L2', { key, attempts: l1Count });
      anomaly.suggestedLevel = 2;
      anomaly.suggestedAction = undefined;
    }
  }

  // 检查 L2 限制
  if (anomaly.suggestedLevel === 2) {
    const l2Count = l2AttemptCounts.get(key) ?? 0;
    if (l2Count >= MAX_L2_ATTEMPTS) {
      log.info('L2 attempts exhausted, escalating to L3', { key, attempts: l2Count });
      anomaly.suggestedLevel = 3;
    }
  }

  switch (anomaly.suggestedLevel) {
    case 1:
      return executeL1(anomaly, win);
    case 2:
      return executeL2(anomaly, win);
    case 3:
      // L3 由 self-repair-engine.ts 实现，这里只记录并标记
      return markForL3(anomaly);
    default:
      return null;
  }
}

// ═══════════════════════════════════════
// Level 1: 程序化修复
// ═══════════════════════════════════════

async function executeL1(
  anomaly: AnomalyReport,
  win: Electron.BrowserWindow | null,
): Promise<RemediationRecord> {
  const action = anomaly.suggestedAction;
  if (!action) {
    return {
      anomalyPattern: anomaly.pattern,
      level: 1,
      projectId: anomaly.projectId,
      featureId: anomaly.featureId,
      action: 'none',
      status: 'skipped' as RemediationStatus,
      detail: 'No L1 action suggested',
      tokensUsed: 0,
      costUsd: 0,
    };
  }

  const key = anomaly.featureId ?? anomaly.projectId;
  l1AttemptCounts.set(key, (l1AttemptCounts.get(key) ?? 0) + 1);

  const recordId = logRemediation({
    anomalyPattern: anomaly.pattern,
    level: 1,
    projectId: anomaly.projectId,
    featureId: anomaly.featureId,
    action: action.type,
    status: 'executing',
    detail: JSON.stringify(action.params),
    tokensUsed: 0,
    costUsd: 0,
  });

  log.info(`Executing L1 remediation: ${action.type}`, {
    pattern: anomaly.pattern,
    projectId: anomaly.projectId,
    featureId: anomaly.featureId,
  });

  try {
    const detail = await executeL1Action(action, anomaly, win);
    updateRemediationStatus(recordId, 'success', detail);

    return {
      anomalyPattern: anomaly.pattern,
      level: 1,
      projectId: anomaly.projectId,
      featureId: anomaly.featureId,
      action: action.type,
      status: 'success',
      detail,
      tokensUsed: 0,
      costUsd: 0,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    updateRemediationStatus(recordId, 'failed', errMsg);

    return {
      anomalyPattern: anomaly.pattern,
      level: 1,
      projectId: anomaly.projectId,
      featureId: anomaly.featureId,
      action: action.type,
      status: 'failed',
      detail: errMsg,
      tokensUsed: 0,
      costUsd: 0,
    };
  }
}

/**
 * 执行具体的 L1 修复动作
 */
async function executeL1Action(
  action: L1Action,
  anomaly: AnomalyReport,
  win: Electron.BrowserWindow | null,
): Promise<string> {
  const db = getDb();
  const params = action.params;

  switch (action.type) {
    case 'release_lock': {
      const featureId = params.featureId as string | undefined;
      const projectId = params.projectId as string;
      const all = params.all as boolean | undefined;

      if (all) {
        // 释放项目中所有僵尸锁
        const count = cleanupZombieLocks(0); // timeout=0 → 释放所有无 session 的锁
        return `Released ${count} zombie locks for project ${projectId}`;
      } else if (featureId) {
        db.prepare(
          "UPDATE features SET status = 'todo', locked_by = NULL, locked_at = NULL WHERE id = ? AND project_id = ?",
        ).run(featureId, projectId);
        // 触发重新调度
        emitScheduleEvent('schedule:feature_todo', { projectId, featureId });
        return `Released lock on feature ${featureId}`;
      }
      return 'No target specified for release_lock';
    }

    case 'restart_session': {
      const projectId = params.projectId as string;
      // 清理僵尸锁后触发重新调度
      cleanupZombieLocks(15);
      await scheduleProject(projectId);
      return `Cleaned zombie locks and triggered re-scheduling for project ${projectId}`;
    }

    case 'reset_feature': {
      const featureId = params.featureId as string;
      const projectId = params.projectId as string;
      // 重置 feature 到 todo
      db.prepare(
        "UPDATE features SET status = 'todo', locked_by = NULL, locked_at = NULL WHERE id = ? AND project_id = ?",
      ).run(featureId, projectId);
      emitScheduleEvent('schedule:feature_todo', { projectId, featureId });
      return `Reset feature ${featureId} to todo`;
    }

    case 'switch_model': {
      // 记录建议切换模型 — 实际切换需要在 workerLoop 层面支持
      // 当前实现: 将信息写入 feature notes 供下次 workerLoop 读取
      const featureId = params.featureId as string;
      const reason = params.reason as string;
      if (featureId) {
        db.prepare(
          "UPDATE features SET notes = notes || '\n[auto-remediation] 建议切换模型: ' || ? WHERE id = ?",
        ).run(reason, featureId);
      }
      return `Recommended model switch for feature ${featureId}: ${reason}`;
    }

    case 'mark_blocked': {
      const featureId = params.featureId as string | undefined;
      const projectId = params.projectId as string;
      const reason = params.reason as string;

      if (featureId) {
        db.prepare(
          "UPDATE features SET status = 'failed', locked_by = NULL, locked_at = NULL, notes = notes || '\n[blocked] ' || ? WHERE id = ?",
        ).run(reason, featureId);
        return `Marked feature ${featureId} as blocked: ${reason}`;
      } else {
        // 项目级别阻塞
        db.prepare("UPDATE projects SET status = 'paused' WHERE id = ?").run(projectId);
        emitScheduleEvent('schedule:project_paused', { projectId });
        return `Paused project ${projectId}: ${reason}`;
      }
    }

    case 'adjust_scheduler': {
      const projectId = params.projectId as string;
      const adjustAction = params.action as string;

      if (adjustAction === 'reduce_concurrency') {
        // 降低并发 — 通过暂时减少 worker 数
        log.info('Reducing concurrency (advisory)', { projectId });
        return `Advisory: reduce concurrency for project ${projectId}`;
      } else if (adjustAction === 'pause_project') {
        db.prepare("UPDATE projects SET status = 'paused' WHERE id = ?").run(projectId);
        emitScheduleEvent('schedule:project_paused', { projectId });
        return `Paused project ${projectId} due to resource exhaustion`;
      }
      return `Unknown scheduler adjustment: ${adjustAction}`;
    }

    case 'gc_sessions': {
      const projectId = params.projectId as string;
      // 清理 failed sessions
      const result = db
        .prepare(
          `
          UPDATE sessions SET status = 'archived'
          WHERE project_id = ? AND status = 'failed' AND completed_at < datetime('now', '-5 minutes')
        `,
        )
        .run(projectId);
      const archived = (result as { changes: number }).changes ?? 0;
      // 清理锁并重新调度
      cleanupZombieLocks(10);
      await scheduleProject(projectId);
      return `Archived ${archived} failed sessions, cleaned locks, re-scheduled project ${projectId}`;
    }

    default:
      return `Unknown L1 action: ${action.type}`;
  }
}

// ═══════════════════════════════════════
// Level 2: LLM 诊断修复
// ═══════════════════════════════════════

/**
 * L2: 使用 LLM 分析异常并生成修复计划
 *
 * LLM 基于结构化的异常证据 + 项目上下文，输出具体修复指令。
 * 仅限读操作 + 已有 admin 工具，不会修改代码。
 */
async function executeL2(
  anomaly: AnomalyReport,
  win: Electron.BrowserWindow | null,
): Promise<RemediationRecord> {
  const key = anomaly.featureId ?? anomaly.projectId;
  l2AttemptCounts.set(key, (l2AttemptCounts.get(key) ?? 0) + 1);

  const recordId = logRemediation({
    anomalyPattern: anomaly.pattern,
    level: 2,
    projectId: anomaly.projectId,
    featureId: anomaly.featureId,
    action: 'llm_diagnosis',
    status: 'executing',
    detail: '',
    tokensUsed: 0,
    costUsd: 0,
  });

  log.info('Executing L2 LLM diagnosis', {
    pattern: anomaly.pattern,
    projectId: anomaly.projectId,
  });

  try {
    const settings = getSettings();
    if (!settings) {
      throw new Error('No LLM settings available for L2 diagnosis');
    }

    // 构建诊断上下文
    const context = buildL2DiagnosisContext(anomaly);
    const prompt = buildL2Prompt(anomaly, context);

    // 调用 LLM
    const result = await callLLM(
      settings,
      settings.strongModel, // 用强模型做诊断
      [
        { role: 'system', content: L2_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      undefined,
      L2_MAX_TOKENS,
      1, // retries
    );

    const tokensUsed = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
    const costUsd = 0; // cost tracked externally

    // 解析 LLM 修复建议
    const diagnosis = parseL2Response(result.content ?? '');

    // 执行 LLM 建议的 L1 动作
    let execDetail = `LLM diagnosis: ${diagnosis.summary}\n`;
    for (const action of diagnosis.actions) {
      try {
        const actionResult = await executeL1Action(action, anomaly, win);
        execDetail += `  ✅ ${action.type}: ${actionResult}\n`;
      } catch (err) {
        execDetail += `  ❌ ${action.type}: ${err instanceof Error ? err.message : String(err)}\n`;
      }
    }

    updateRemediationStatus(recordId, 'success', execDetail);

    // 更新 token 统计
    try {
      const db = getDb();
      db.prepare('UPDATE remediation_log SET tokens_used = ?, cost_usd = ? WHERE id = ?').run(
        tokensUsed,
        costUsd,
        recordId,
      );
    } catch {
      /* non-critical */
    }

    return {
      anomalyPattern: anomaly.pattern,
      level: 2,
      projectId: anomaly.projectId,
      featureId: anomaly.featureId,
      action: 'llm_diagnosis',
      status: 'success',
      detail: execDetail,
      tokensUsed,
      costUsd,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    updateRemediationStatus(recordId, 'failed', errMsg);

    return {
      anomalyPattern: anomaly.pattern,
      level: 2,
      projectId: anomaly.projectId,
      featureId: anomaly.featureId,
      action: 'llm_diagnosis',
      status: 'failed',
      detail: errMsg,
      tokensUsed: 0,
      costUsd: 0,
    };
  }
}

// ═══════════════════════════════════════
// L2 Prompt Engineering
// ═══════════════════════════════════════

const L2_SYSTEM_PROMPT = `你是 AutoMater 项目管家的自动修复诊断引擎。
你的职责是分析异常报告，诊断根因，并输出结构化的修复动作列表。

可用修复动作类型:
- release_lock: 释放 feature 锁。params: { featureId, projectId }
- restart_session: 重启调度。params: { projectId }
- reset_feature: 重置 feature 到 todo。params: { featureId, projectId }
- switch_model: 建议切换模型。params: { featureId, reason }
- mark_blocked: 标记为阻塞。params: { featureId?, projectId, reason }
- adjust_scheduler: 调整调度。params: { projectId, action: 'reduce_concurrency'|'pause_project' }
- gc_sessions: 清理死亡 session。params: { projectId }

请以 JSON 格式回复:
{
  "summary": "诊断结论 (一句话)",
  "rootCause": "根因分析",
  "actions": [
    { "type": "release_lock", "params": { "featureId": "...", "projectId": "..." } }
  ],
  "preventionAdvice": "预防建议"
}

只输出 JSON，不要其他文字。`;

interface L2DiagnosisContext {
  recentEvents: string;
  featureStatus: string;
  sessionStatus: string;
}

function buildL2DiagnosisContext(anomaly: AnomalyReport): L2DiagnosisContext {
  const db = getDb();

  // 近期事件
  let recentEvents = '';
  try {
    const events = db
      .prepare(
        `
        SELECT type, data, created_at FROM events
        WHERE project_id = ?
        ORDER BY created_at DESC LIMIT 20
      `,
      )
      .all(anomaly.projectId) as Array<{ type: string; data: string; created_at: string }>;

    recentEvents = events
      .map(e => `[${e.created_at}] ${e.type}: ${(e.data ?? '').slice(0, 100)}`)
      .join('\n');
  } catch {
    recentEvents = '(无法获取)';
  }

  // Feature 状态
  let featureStatus = '';
  try {
    const features = db
      .prepare(
        `
        SELECT id, title, status, locked_by FROM features
        WHERE project_id = ?
        ORDER BY status, priority
      `,
      )
      .all(anomaly.projectId) as Array<{
        id: string;
        title: string;
        status: string;
        locked_by: string | null;
      }>;

    featureStatus = features
      .map(f => `${f.id}: "${f.title}" [${f.status}] ${f.locked_by ? `locked:${f.locked_by}` : ''}`)
      .join('\n');
  } catch {
    featureStatus = '(无法获取)';
  }

  // Session 状态
  let sessionStatus = '';
  try {
    const sessions = db
      .prepare(
        `
        SELECT id, status, feature_id, error_message FROM sessions
        WHERE project_id = ?
        ORDER BY created_at DESC LIMIT 10
      `,
      )
      .all(anomaly.projectId) as Array<{
        id: string;
        status: string;
        feature_id: string | null;
        error_message: string | null;
      }>;

    sessionStatus = sessions
      .map(
        s =>
          `${s.id}: [${s.status}] feature=${s.feature_id ?? 'N/A'} ${s.error_message ? `err: ${s.error_message.slice(0, 80)}` : ''}`,
      )
      .join('\n');
  } catch {
    sessionStatus = '(无法获取)';
  }

  return { recentEvents, featureStatus, sessionStatus };
}

function buildL2Prompt(anomaly: AnomalyReport, ctx: L2DiagnosisContext): string {
  return `## 异常报告

模式: ${anomaly.pattern}
严重度: ${anomaly.severity}
项目: ${anomaly.projectId}
Feature: ${anomaly.featureId ?? 'N/A'}
描述: ${anomaly.description}
证据: ${JSON.stringify(anomaly.evidence, null, 2)}

## 项目上下文

### 近期事件
${ctx.recentEvents}

### Feature 状态
${ctx.featureStatus}

### Session 状态
${ctx.sessionStatus}

请分析根因并输出修复动作。`;
}

interface L2Diagnosis {
  summary: string;
  rootCause: string;
  actions: L1Action[];
  preventionAdvice: string;
}

function parseL2Response(text: string): L2Diagnosis {
  const defaultDiagnosis: L2Diagnosis = {
    summary: '无法解析 LLM 诊断',
    rootCause: 'unknown',
    actions: [],
    preventionAdvice: '',
  };

  try {
    // 提取 JSON (可能被 markdown code fence 包裹)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return defaultDiagnosis;

    const parsed = JSON.parse(jsonMatch[0]);
    const validTypes: L1ActionType[] = [
      'restart_session',
      'release_lock',
      'switch_model',
      'mark_blocked',
      'adjust_scheduler',
      'reset_feature',
      'gc_sessions',
    ];

    const actions: L1Action[] = (parsed.actions ?? [])
      .filter(
        (a: { type: string; params?: Record<string, unknown> }) =>
          a && validTypes.includes(a.type as L1ActionType),
      )
      .map((a: { type: string; params?: Record<string, unknown> }) => ({
        type: a.type as L1ActionType,
        params: a.params ?? {},
      }));

    return {
      summary: parsed.summary ?? 'unknown',
      rootCause: parsed.rootCause ?? 'unknown',
      actions,
      preventionAdvice: parsed.preventionAdvice ?? '',
    };
  } catch (err) {
    log.debug('Failed to parse L2 response', { error: String(err), text: text.slice(0, 200) });
    return defaultDiagnosis;
  }
}

// ═══════════════════════════════════════
// Level 3: Bridge to Self-Repair Engine
// ═══════════════════════════════════════

function markForL3(anomaly: AnomalyReport): RemediationRecord {
  const record: RemediationRecord = {
    anomalyPattern: anomaly.pattern,
    level: 3,
    projectId: anomaly.projectId,
    featureId: anomaly.featureId,
    action: 'self_repair_pending',
    status: 'pending',
    detail: `L1+L2 exhausted. Anomaly: ${anomaly.description}. Evidence: ${JSON.stringify(anomaly.evidence)}`,
    tokensUsed: 0,
    costUsd: 0,
  };

  logRemediation(record);

  log.info('Anomaly marked for L3 self-repair', {
    pattern: anomaly.pattern,
    projectId: anomaly.projectId,
    featureId: anomaly.featureId,
  });

  return record;
}

// ═══════════════════════════════════════
// Query Helpers (for admin tools / IPC)
// ═══════════════════════════════════════

/** 获取项目的修复历史 */
export function getRemediationHistory(
  projectId: string,
  limit: number = 20,
): RemediationRecord[] {
  try {
    const db = getDb();
    return db
      .prepare(
        `
        SELECT * FROM remediation_log
        WHERE project_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
      )
      .all(projectId, limit) as RemediationRecord[];
  } catch {
    return [];
  }
}

/** 获取待处理的 L3 修复请求 */
export function getPendingL3Repairs(): RemediationRecord[] {
  try {
    const db = getDb();
    return db
      .prepare(
        `
        SELECT * FROM remediation_log
        WHERE level = 3 AND status = 'pending'
        ORDER BY created_at ASC
      `,
      )
      .all() as RemediationRecord[];
  } catch {
    return [];
  }
}

/** 获取修复统计摘要 */
export function getRemediationStats(projectId?: string): {
  total: number;
  success: number;
  failed: number;
  byLevel: Record<number, number>;
  byPattern: Record<string, number>;
} {
  try {
    const db = getDb();
    const whereClause = projectId ? 'WHERE project_id = ?' : '';
    const params = projectId ? [projectId] : [];

    const rows = db
      .prepare(
        `
        SELECT level, anomaly_pattern, status, COUNT(*) as count
        FROM remediation_log
        ${whereClause}
        GROUP BY level, anomaly_pattern, status
      `,
      )
      .all(...params) as Array<{
        level: number;
        anomaly_pattern: string;
        status: string;
        count: number;
      }>;

    const stats = {
      total: 0,
      success: 0,
      failed: 0,
      byLevel: {} as Record<number, number>,
      byPattern: {} as Record<string, number>,
    };

    for (const row of rows) {
      stats.total += row.count;
      if (row.status === 'success') stats.success += row.count;
      if (row.status === 'failed') stats.failed += row.count;
      stats.byLevel[row.level] = (stats.byLevel[row.level] ?? 0) + row.count;
      stats.byPattern[row.anomaly_pattern] =
        (stats.byPattern[row.anomaly_pattern] ?? 0) + row.count;
    }

    return stats;
  } catch {
    return { total: 0, success: 0, failed: 0, byLevel: {}, byPattern: {} };
  }
}

/** 重置计数器 (测试用) */
export function resetAttemptCounters(): void {
  l1AttemptCounts.clear();
  l2AttemptCounts.clear();
}
