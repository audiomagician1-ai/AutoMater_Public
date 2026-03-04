/**
 * Event Store — 结构化事件流 + 重放支持
 *
 * 所有 Agent 操作记录为不可变事件，写入 SQLite events 表。
 * 支持:
 *  - 按项目/agent/feature/类型查询
 *  - 时间线重放 (UI 可以逐事件回放某个 feature 的开发过程)
 *  - 导出为 JSON/NDJSON
 *  - 性能指标聚合 (每个 phase/feature/tool 的耗时、cost、token)
 *
 * 对标: OpenHands Event Stream Architecture
 *
 * v2.0.0: 初始实现
 */

import { getDb } from '../db';
import { createLogger } from './logger';
import type { SqliteStatement, EventRow } from './types';
import { safeJsonParse } from './safe-json';

const log = createLogger('event-store');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export type EventType =
  // Orchestrator lifecycle
  | 'project:start'
  | 'project:stop'
  | 'project:complete'
  // Phase transitions
  | 'phase:pm:start'
  | 'phase:pm:end'
  | 'phase:architect:start'
  | 'phase:architect:end'
  | 'phase:dev:start'
  | 'phase:dev:end'
  | 'phase:docs:end'
  | 'phase:incremental-pm:end'
  | 'phase:design-doc:end'
  | 'phase:pm-acceptance:end'
  | 'phase:devops:build'
  | 'phase:deploy:end'
  | 'change-request:completed'
  | 'wish:triaged'
  // Feature lifecycle
  | 'feature:locked'
  | 'feature:passed'
  | 'feature:failed'
  | 'feature:qa_passed'
  | 'feature:qa:start'
  | 'feature:qa:result'
  // ReAct loop
  | 'react:iteration'
  | 'react:complete'
  // Tool execution
  | 'tool:call'
  | 'tool:result'
  // LLM calls
  | 'llm:call'
  | 'llm:result'
  // Sub-agent
  | 'subagent:start'
  | 'subagent:result'
  // Memory
  | 'memory:write'
  | 'lesson:extracted'
  // v20.0: Decision audit trail
  | 'decision:point'
  // v28.0: Session-Agent 调度事件 (事件驱动调度总线的输入信号)
  | 'schedule:wish_created' // 需求列表新增
  | 'schedule:wish_updated' // 需求变更
  | 'schedule:feature_todo' // Feature 变为 todo (新增 / 重置 / PM 分析产出)
  | 'schedule:feature_completed' // Feature 完成 (释放 Agent capacity)
  | 'schedule:feature_failed' // Feature 失败
  | 'schedule:project_started' // 用户点击启动
  | 'schedule:project_paused' // 用户暂停
  | 'schedule:member_added' // 团队新增成员
  | 'schedule:member_updated' // 成员配置变更 (并发数等)
  | 'schedule:session_created' // Session 实例创建
  | 'schedule:session_failed' // Session 异常终止 (可能需要重新调度)
  // Errors
  | 'error';

export interface AgentEvent {
  id?: number; // auto-increment
  projectId: string;
  agentId: string;
  featureId?: string;
  type: EventType;
  /** 结构化 payload (JSON) */
  data: Record<string, unknown>;
  /** 事件耗时 ms (可选, 用于性能追踪) */
  durationMs?: number;
  /** LLM token 消耗 */
  inputTokens?: number;
  outputTokens?: number;
  /** 成本 USD */
  costUsd?: number;
  /** 时间戳 ISO */
  timestamp?: string;
}

// ═══════════════════════════════════════
// DB Schema Migration
// ═══════════════════════════════════════

/**
 * 确保 events 表存在 (在 initDatabase 后调用)
 */
export function ensureEventTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      feature_id TEXT,
      type TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      duration_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_feature ON events(project_id, feature_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(project_id, type);
  `);
}

// ═══════════════════════════════════════
// Write
// ═══════════════════════════════════════

let _insertStmt: SqliteStatement | null = null;

function getInsertStmt() {
  if (!_insertStmt) {
    const db = getDb();
    _insertStmt = db.prepare(`
      INSERT INTO events (project_id, agent_id, feature_id, type, data, duration_ms, input_tokens, output_tokens, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }
  return _insertStmt;
}

/**
 * 写入一个事件 (同步, 非常快, WAL 模式下 ~10μs)
 */
export function emitEvent(event: AgentEvent): number {
  try {
    const stmt = getInsertStmt();
    const result = stmt.run(
      event.projectId,
      event.agentId || '',
      event.featureId || null,
      event.type,
      JSON.stringify(event.data || {}),
      event.durationMs ?? null,
      event.inputTokens ?? null,
      event.outputTokens ?? null,
      event.costUsd ?? null,
    );
    return (result as { lastInsertRowid: number }).lastInsertRowid;
  } catch (err) {
    // 事件写入失败不应影响主流程
    log.error('emit failed', err);
    return -1;
  }
}

/**
 * 批量写入事件
 */
export function emitEvents(events: AgentEvent[]): void {
  const db = getDb();
  const stmt = getInsertStmt();
  const batch = db.transaction((items: AgentEvent[]) => {
    for (const e of items) {
      stmt.run(
        e.projectId,
        e.agentId || '',
        e.featureId || null,
        e.type,
        JSON.stringify(e.data || {}),
        e.durationMs ?? null,
        e.inputTokens ?? null,
        e.outputTokens ?? null,
        e.costUsd ?? null,
      );
    }
  });
  batch(events);
}

// ═══════════════════════════════════════
// Read / Query
// ═══════════════════════════════════════

export interface EventQuery {
  projectId: string;
  featureId?: string;
  agentId?: string;
  types?: EventType[];
  /** 起始时间 ISO */
  since?: string;
  /** 结束时间 ISO */
  until?: string;
  limit?: number;
  offset?: number;
}

function rowToEvent(row: EventRow): AgentEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    featureId: row.feature_id || undefined,
    type: row.type as EventType,
    data: safeJsonParse(row.data || '{}', {}),
    durationMs: row.duration_ms ?? undefined,
    inputTokens: row.input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    timestamp: row.created_at,
  };
}

/**
 * 查询事件
 */
export function queryEvents(query: EventQuery): AgentEvent[] {
  const db = getDb();
  const conditions: string[] = ['project_id = ?'];
  const params: Array<string | number> = [query.projectId];

  if (query.featureId) {
    conditions.push('feature_id = ?');
    params.push(query.featureId);
  }
  if (query.agentId) {
    conditions.push('agent_id = ?');
    params.push(query.agentId);
  }
  if (query.types && query.types.length > 0) {
    conditions.push(`type IN (${query.types.map(() => '?').join(',')})`);
    params.push(...query.types);
  }
  if (query.since) {
    conditions.push('created_at >= ?');
    params.push(query.since);
  }
  if (query.until) {
    conditions.push('created_at <= ?');
    params.push(query.until);
  }

  const limit = Math.min(query.limit ?? 200, 1000);
  const offset = query.offset ?? 0;

  const sql = `SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY id ASC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as EventRow[];
  return rows.map(rowToEvent);
}

/**
 * 获取 feature 的完整事件时间线 (用于 replay)
 */
export function getFeatureTimeline(projectId: string, featureId: string): AgentEvent[] {
  return queryEvents({ projectId, featureId, limit: 500 });
}

/**
 * 获取项目最近的事件
 */
export function getRecentEvents(projectId: string, limit: number = 50): AgentEvent[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT ?')
    .all(projectId, limit) as EventRow[];
  return rows.reverse().map(rowToEvent);
}

// ═══════════════════════════════════════
// Aggregation / Analytics
// ═══════════════════════════════════════

export interface EventStats {
  totalEvents: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  eventsByType: Record<string, number>;
  featureStats: Array<{
    featureId: string;
    events: number;
    durationMs: number;
    costUsd: number;
    toolCalls: number;
    llmCalls: number;
  }>;
  toolStats: Array<{
    toolName: string;
    calls: number;
    avgDurationMs: number;
    successRate: number;
  }>;
}

/**
 * 聚合项目统计信息
 */
export function getProjectEventStats(projectId: string): EventStats {
  const db = getDb();

  // 总体统计
  const total = db
    .prepare(
      `
    SELECT COUNT(*) as cnt,
           COALESCE(SUM(duration_ms), 0) as dur,
           COALESCE(SUM(input_tokens), 0) as inp,
           COALESCE(SUM(output_tokens), 0) as outp,
           COALESCE(SUM(cost_usd), 0) as cost
    FROM events WHERE project_id = ?
  `,
    )
    .get(projectId) as { cnt: number; dur: number; inp: number; outp: number; cost: number };

  // 按类型统计
  const typeRows = db
    .prepare('SELECT type, COUNT(*) as cnt FROM events WHERE project_id = ? GROUP BY type')
    .all(projectId) as Array<{ type: string; cnt: number }>;
  const eventsByType: Record<string, number> = {};
  for (const r of typeRows) eventsByType[r.type] = r.cnt;

  // 按 feature 统计
  const featureRows = db
    .prepare(
      `
    SELECT feature_id,
           COUNT(*) as cnt,
           COALESCE(SUM(duration_ms), 0) as dur,
           COALESCE(SUM(cost_usd), 0) as cost,
           SUM(CASE WHEN type = 'tool:call' THEN 1 ELSE 0 END) as tools,
           SUM(CASE WHEN type = 'llm:call' THEN 1 ELSE 0 END) as llms
    FROM events WHERE project_id = ? AND feature_id IS NOT NULL
    GROUP BY feature_id ORDER BY feature_id
  `,
    )
    .all(projectId) as Array<{
    feature_id: string;
    cnt: number;
    dur: number;
    cost: number;
    tools: number;
    llms: number;
  }>;
  const featureStats = featureRows.map(r => ({
    featureId: r.feature_id,
    events: r.cnt,
    durationMs: r.dur,
    costUsd: r.cost,
    toolCalls: r.tools,
    llmCalls: r.llms,
  }));

  // 工具调用统计
  const toolRows = db
    .prepare(
      `
    SELECT json_extract(data, '$.tool') as tool_name,
           COUNT(*) as cnt,
           AVG(duration_ms) as avg_dur,
           SUM(CASE WHEN json_extract(data, '$.success') = 1 THEN 1 ELSE 0 END) as successes
    FROM events WHERE project_id = ? AND type = 'tool:call' AND json_extract(data, '$.tool') IS NOT NULL
    GROUP BY tool_name ORDER BY cnt DESC
  `,
    )
    .all(projectId) as Array<{ tool_name: string; cnt: number; avg_dur: number; successes: number }>;
  const toolStats = toolRows.map(r => ({
    toolName: r.tool_name || 'unknown',
    calls: r.cnt,
    avgDurationMs: Math.round(r.avg_dur || 0),
    successRate: r.cnt > 0 ? r.successes / r.cnt : 0,
  }));

  return {
    totalEvents: total.cnt,
    totalDurationMs: total.dur,
    totalInputTokens: total.inp,
    totalOutputTokens: total.outp,
    totalCostUsd: total.cost,
    eventsByType,
    featureStats,
    toolStats,
  };
}

// ═══════════════════════════════════════
// Export
// ═══════════════════════════════════════

/**
 * 导出项目事件为 NDJSON 字符串
 */
export function exportEventsNDJSON(projectId: string): string {
  const events = queryEvents({ projectId, limit: 10000 });
  return events.map(e => JSON.stringify(e)).join('\n');
}
