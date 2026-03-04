/**
 * Meta-Agent Daemon — 管家自主行为引擎
 *
 * 参照 OpenClaw 三大自主能力:
 *   1. Heartbeat — 每 N 分钟唤醒，LLM 审视所有项目状态，有事则通知
 *   2. Hooks — 监听 event-store 关键事件（feature 失败、项目完成等），即时反应
 *   3. Cron — 用户可配置定时任务（日报、检查等）
 *
 * HEARTBEAT_OK 协议:
 *   - 管家判断无事时回复 HEARTBEAT_OK → 静默不打扰
 *   - 有事则回复具体内容 → 推送通知给用户
 *
 * v7.0: 初始创建
 */

import { BrowserWindow, Notification } from 'electron';
import { getDb } from '../db';
import { callLLM, getSettings } from './llm-client';
import { sendToUI } from './ui-bridge';
import { createLogger } from './logger';
import { safeJsonParse } from './safe-json';
import {
  registerSchedulerListeners,
  fallbackCheck as schedulerFallbackCheck,
  enableScheduler,
  disableScheduler,
} from './session-scheduler';
import { cleanupZombieLocks, gcSessions } from './session-lifecycle';

const log = createLogger('meta-daemon');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface DaemonConfig {
  enabled: boolean; // 总开关
  heartbeatIntervalMin: number; // 心跳间隔(分钟), 0=禁用
  activeHoursStart: string; // 活跃时间窗口开始 "08:00"
  activeHoursEnd: string; // 活跃时间窗口结束 "24:00"
  dailyTokenBudget: number; // 每日 token 预算上限
  hooks: HookConfig; // 事件钩子配置
  cronJobs: CronJobConfig[]; // 定时任务列表
  heartbeatPrompt: string; // 自定义心跳 prompt (空=内置)
}

export interface HookConfig {
  onFeatureFailed: boolean; // feature QA 失败时通知
  onProjectComplete: boolean; // 项目完成时通知
  onProjectStalled: boolean; // 项目长时间无进展时通知
  onError: boolean; // 严重错误时通知
  stallThresholdMin: number; // 停滞阈值(分钟), 默认 30
}

export interface CronJobConfig {
  id: string;
  name: string;
  schedule: string; // 简化cron: "daily:09:00" | "hourly" | "every:120m"
  prompt: string; // 执行时发给 LLM 的指令
  enabled: boolean;
}

export interface HeartbeatLog {
  id?: number;
  type: 'heartbeat' | 'hook' | 'cron';
  trigger: string; // 触发原因描述
  result: 'ok' | 'notified' | 'error';
  message: string; // LLM 回复或静默标记
  tokensUsed: number;
  created_at?: string;
}

/** DB query result types (internal) */
interface ProjectRow {
  id: string;
  name: string;
  wish: string;
  status: string;
  updated_at: string | null;
}
interface FeatureStatusCount {
  status: string;
  count: number;
}
interface StalledFeature {
  id: string;
  title: string;
  status: string;
  locked_by: string | null;
}
interface FailedFeature {
  id: string;
  title: string;
  last_error: string | null;
}
interface CountRow {
  count: number;
}
interface MaxIdRow {
  maxId: number | null;
}
interface EventRow {
  id: number;
  project_id: string;
  type: string;
  data: string | null;
  created_at: string;
}
interface MemoryRow {
  content: string;
  category: string;
}

// ═══════════════════════════════════════
// Defaults
// ═══════════════════════════════════════

const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  enabled: false,
  heartbeatIntervalMin: 30,
  activeHoursStart: '08:00',
  activeHoursEnd: '24:00',
  dailyTokenBudget: 50000,
  hooks: {
    onFeatureFailed: true,
    onProjectComplete: true,
    onProjectStalled: true,
    onError: true,
    stallThresholdMin: 30,
  },
  cronJobs: [],
  heartbeatPrompt: '',
};

const HEARTBEAT_OK_TOKEN = 'HEARTBEAT_OK';

// ═══════════════════════════════════════
// DB helpers
// ═══════════════════════════════════════

export function ensureHeartbeatTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta_agent_heartbeat_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      trigger_desc TEXT NOT NULL,
      result TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      tokens_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_heartbeat_type ON meta_agent_heartbeat_log(type);
    CREATE INDEX IF NOT EXISTS idx_heartbeat_created ON meta_agent_heartbeat_log(created_at);
  `);
}

function logHeartbeat(entry: HeartbeatLog): void {
  try {
    const db = getDb();
    db.prepare(
      `
      INSERT INTO meta_agent_heartbeat_log (type, trigger_desc, result, message, tokens_used)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run(entry.type, entry.trigger, entry.result, entry.message, entry.tokensUsed);
  } catch (err) {
    log.error('Failed to log heartbeat', err);
  }
}

function getTodayTokenUsage(): number {
  try {
    const db = getDb();
    const row = db
      .prepare(
        `
      SELECT COALESCE(SUM(tokens_used), 0) as total
      FROM meta_agent_heartbeat_log
      WHERE created_at >= date('now')
    `,
      )
      .get() as { total: number };
    return row.total;
  } catch {
    return 0;
  }
}

// ═══════════════════════════════════════
// Config persistence
// ═══════════════════════════════════════

export function getDaemonConfig(): DaemonConfig {
  const db = getDb();
  const row = db.prepare('SELECT value FROM meta_agent_config WHERE key = ?').get('daemon') as
    | { value: string }
    | undefined;
  if (row) {
    try {
      return { ...DEFAULT_DAEMON_CONFIG, ...JSON.parse(row.value) };
    } catch {
      /* fallback */
    }
  }
  return { ...DEFAULT_DAEMON_CONFIG };
}

export function saveDaemonConfig(config: Partial<DaemonConfig>): DaemonConfig {
  const db = getDb();
  const current = getDaemonConfig();
  const merged = { ...current, ...config };
  db.prepare('INSERT OR REPLACE INTO meta_agent_config (key, value) VALUES (?, ?)').run(
    'daemon',
    JSON.stringify(merged),
  );
  return merged;
}

// ═══════════════════════════════════════
// Active hours check
// ═══════════════════════════════════════

function isWithinActiveHours(config: DaemonConfig): boolean {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return hhmm >= config.activeHoursStart && hhmm < config.activeHoursEnd;
}

// ═══════════════════════════════════════
// Project status snapshot (for heartbeat prompt)
// ═══════════════════════════════════════

function buildProjectStatusSnapshot(): string {
  const db = getDb();
  const projects = db
    .prepare('SELECT id, name, wish, status, updated_at FROM projects ORDER BY updated_at DESC LIMIT 10')
    .all() as ProjectRow[];

  if (projects.length === 0) return '当前没有任何项目。';

  const parts: string[] = ['## 项目状态总览'];
  for (const p of projects) {
    const features = db
      .prepare(
        `
      SELECT status, COUNT(*) as count FROM features WHERE project_id = ? GROUP BY status
    `,
      )
      .all(p.id) as FeatureStatusCount[];

    const statusSummary = features.map(f => `${f.status}:${f.count}`).join(', ');

    // Check for stalled features
    const stalledFeatures = db
      .prepare(
        `
      SELECT id, title, status, locked_by FROM features
      WHERE project_id = ? AND status IN ('in_progress', 'todo') AND locked_by IS NOT NULL
    `,
      )
      .all(p.id) as StalledFeature[];

    // Check for failed features
    const failedFeatures = db
      .prepare(
        `
      SELECT id, title, last_error FROM features
      WHERE project_id = ? AND status = 'failed'
    `,
      )
      .all(p.id) as FailedFeature[];

    // Recent events
    const recentEventCount = db
      .prepare(
        `
      SELECT COUNT(*) as count FROM events
      WHERE project_id = ? AND created_at >= datetime('now', '-30 minutes')
    `,
      )
      .get(p.id) as CountRow | undefined;

    parts.push(`### ${p.name} [${p.status}]`);
    parts.push(`  需求: ${(p.wish || '').slice(0, 100)}`);
    if (statusSummary) parts.push(`  Features: ${statusSummary}`);
    if (failedFeatures.length > 0) {
      parts.push(`  ⚠ 失败 (${failedFeatures.length}): ${failedFeatures.map(f => f.title).join(', ')}`);
    }
    if (stalledFeatures.length > 0) {
      parts.push(
        `  🔒 进行中 (${stalledFeatures.length}): ${stalledFeatures.map(f => `${f.title}(${f.locked_by})`).join(', ')}`,
      );
    }
    parts.push(`  最近30分钟事件: ${recentEventCount?.count ?? 0}`);
    parts.push(`  最后更新: ${p.updated_at || 'N/A'}`);
  }

  return parts.join('\n');
}

// ═══════════════════════════════════════
// Core: Run a heartbeat / hook / cron check
// ═══════════════════════════════════════

async function runAgentCheck(type: HeartbeatLog['type'], trigger: string, customPrompt?: string): Promise<void> {
  const settings = getSettings();
  if (!settings?.apiKey) {
    log.debug('Skipping agent check: no API key');
    return;
  }

  const config = getDaemonConfig();

  // Budget check
  const todayUsage = getTodayTokenUsage();
  if (todayUsage >= config.dailyTokenBudget) {
    log.info(`Daily token budget exhausted (${todayUsage}/${config.dailyTokenBudget}), skipping`);
    return;
  }

  // v23.0: 无活跃项目时跳过心跳 LLM 调用 — 避免空转浪费 token
  // 只有定时心跳才检查 (hook/cron 有明确触发事件, 不受此限)
  if (type === 'heartbeat') {
    const db0 = getDb();
    const activeCount = (
      db0
        .prepare(
          "SELECT COUNT(*) as c FROM projects WHERE status IN ('initializing', 'analyzing', 'developing', 'reviewing', 'deploying')",
        )
        .get() as { c: number }
    ).c;
    const totalCount = (db0.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number }).c;
    if (totalCount === 0 || activeCount === 0) {
      log.debug(`Heartbeat skipped: no active projects (total=${totalCount}, active=${activeCount})`);
      logHeartbeat({
        type,
        trigger,
        result: 'ok',
        message: `HEARTBEAT_OK (no active projects: ${totalCount} total, ${activeCount} active)`,
        tokensUsed: 0,
      });
      return;
    }
  }

  // Load meta-agent config for name/personality
  const db = getDb();
  const metaRow = db.prepare('SELECT value FROM meta_agent_config WHERE key = ?').get('config') as
    | { value: string }
    | undefined;
  const metaConfig = metaRow
    ? safeJsonParse<Record<string, string>>(metaRow.value, {}, 'meta-agent-config')
    : ({} as Record<string, string>);
  const agentName = metaConfig.name || '元Agent管家';
  const personality = metaConfig.personality || '专业、友好、高效';
  const userNickname = metaConfig.userNickname ? `称呼用户为"${metaConfig.userNickname}"` : '';

  // Load relevant memories
  const memories = db
    .prepare('SELECT content, category FROM meta_agent_memories ORDER BY importance DESC, updated_at DESC LIMIT 20')
    .all() as MemoryRow[];
  const memoryContext =
    memories.length > 0 ? '\n## 你的记忆\n' + memories.map(m => `- [${m.category}] ${m.content}`).join('\n') : '';

  const statusSnapshot = buildProjectStatusSnapshot();

  // Build prompt
  const heartbeatSystemPrompt = `你是"${agentName}"，一个AI软件开发平台的智能管家守护进程。${personality}。${userNickname}

这是一次${type === 'heartbeat' ? '定时心跳检查' : type === 'hook' ? '事件触发检查' : '定时任务'}。

你的职责:
1. 审视所有项目的当前状态
2. 判断是否有需要用户关注的事情（卡住的Feature、失败的任务、完成的里程碑等）
3. 如果一切正常无需打扰，回复 "${HEARTBEAT_OK_TOKEN}"
4. 如果有需要通知的事情，用简洁中文回复具体内容（不超过200字）

**关键规则**:
- 不要重复已经通知过的事情
- 只在真正需要用户介入时才通知（避免通知疲劳）
- 进行中且正常推进的任务不需要通知
- 失败/卡住/完成 才需要通知
${memoryContext}`;

  const userPrompt =
    customPrompt ||
    config.heartbeatPrompt ||
    `请审视以下项目状态，判断是否有需要我关注的事情。如果一切正常，回复 ${HEARTBEAT_OK_TOKEN}。\n\n${statusSnapshot}`;

  const messages = [
    { role: 'system', content: heartbeatSystemPrompt },
    { role: 'user', content: userPrompt },
  ];

  try {
    const model = settings.fastModel || settings.workerModel || settings.strongModel;
    const result = await callLLM(settings, model, messages, undefined, 512, 1);

    const text = (result.content ?? '').trim();
    const tokens = (result.inputTokens || 0) + (result.outputTokens || 0);
    const isOk = text.startsWith(HEARTBEAT_OK_TOKEN) || text === HEARTBEAT_OK_TOKEN;

    if (isOk) {
      // Silent — nothing to report
      logHeartbeat({ type, trigger, result: 'ok', message: HEARTBEAT_OK_TOKEN, tokensUsed: tokens });
      log.debug(`[${type}] ${HEARTBEAT_OK_TOKEN} — nothing to report`);
    } else {
      // Has something to say — notify user
      logHeartbeat({ type, trigger, result: 'notified', message: text, tokensUsed: tokens });
      log.info(`[${type}] Notifying user: ${text.slice(0, 80)}`);
      notifyUser(agentName, text, type, trigger);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[${type}] LLM call failed`, err);
    logHeartbeat({ type, trigger, result: 'error', message: msg.slice(0, 200), tokensUsed: 0 });
  }
}

function notifyUser(agentName: string, message: string, type: string, trigger: string): void {
  const win = BrowserWindow.getAllWindows()[0] ?? null;

  // 1. Push to UI as meta-agent message
  sendToUI(win, 'meta-agent:daemon-message', {
    type,
    trigger,
    message,
    timestamp: Date.now(),
  });

  // 2. Electron native notification
  if (Notification.isSupported()) {
    const typeLabel = type === 'heartbeat' ? '💓 心跳检查' : type === 'hook' ? '🪝 事件通知' : '⏰ 定时任务';
    new Notification({
      title: `${agentName} — ${typeLabel}`,
      body: message.slice(0, 200),
    }).show();
  }
}

// ═══════════════════════════════════════
// Event Hooks — poll event-store for notable events
// ═══════════════════════════════════════

let _lastEventCheckId = 0;

function checkEventHooks(): void {
  const config = getDaemonConfig();
  if (!config.hooks) return;

  try {
    const db = getDb();

    // Get new events since last check
    const events = db
      .prepare(
        `
      SELECT id, project_id, type, data, created_at FROM events
      WHERE id > ? ORDER BY id ASC LIMIT 50
    `,
      )
      .all(_lastEventCheckId) as EventRow[];

    if (events.length === 0) return;
    _lastEventCheckId = events[events.length - 1].id;

    const triggers: string[] = [];

    for (const evt of events) {
      if (config.hooks.onFeatureFailed && evt.type === 'feature:failed') {
        const data = safeJsonParse<Record<string, string>>(evt.data || '{}', {}, 'hook-feature-failed');
        triggers.push(`Feature 失败: ${data.title || data.featureId || evt.project_id}`);
      }
      if (config.hooks.onProjectComplete && evt.type === 'project:complete') {
        triggers.push(`项目完成: ${evt.project_id}`);
      }
      if (config.hooks.onError && evt.type === 'error') {
        const data = safeJsonParse<Record<string, string>>(evt.data || '{}', {}, 'hook-error');
        triggers.push(`错误: ${data.message?.slice(0, 80) || 'unknown'}`);
      }
    }

    if (triggers.length > 0) {
      const triggerSummary = triggers.join('\n');
      runAgentCheck(
        'hook',
        triggerSummary,
        `以下事件刚刚发生，请判断是否需要通知用户:\n${triggerSummary}\n\n如果不需要特别通知，回复 ${HEARTBEAT_OK_TOKEN}。`,
      );
    }
  } catch (err) {
    log.error('Event hook check failed', err);
  }
}

// ═══════════════════════════════════════
// Cron — simple cron-like scheduler
// ═══════════════════════════════════════

let _lastCronMinute = -1;

function checkCronJobs(): void {
  const config = getDaemonConfig();
  if (!config.cronJobs || config.cronJobs.length === 0) return;

  const now = new Date();
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  if (currentMinute === _lastCronMinute) return; // Already checked this minute
  _lastCronMinute = currentMinute;

  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  for (const job of config.cronJobs) {
    if (!job.enabled) continue;

    let shouldRun = false;

    if (job.schedule.startsWith('daily:')) {
      const time = job.schedule.slice(6); // "09:00"
      shouldRun = hhmm === time;
    } else if (job.schedule === 'hourly') {
      shouldRun = now.getMinutes() === 0;
    } else if (job.schedule.startsWith('every:')) {
      const intervalMin = parseInt(job.schedule.slice(6)) || 60;
      shouldRun = currentMinute % intervalMin === 0;
    }

    if (shouldRun) {
      log.info(`Cron job triggered: ${job.name} (${job.schedule})`);
      runAgentCheck('cron', `定时任务: ${job.name}`, job.prompt);
    }
  }
}

// ═══════════════════════════════════════
// Daemon Lifecycle
// ═══════════════════════════════════════

let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let _hookTimer: ReturnType<typeof setInterval> | null = null;
let _running = false;

export function startDaemon(): void {
  const config = getDaemonConfig();
  if (!config.enabled) {
    log.info('Daemon disabled, not starting');
    return;
  }
  if (_running) {
    log.info('Daemon already running, restarting...');
    stopDaemon();
  }

  _running = true;
  log.info(
    `Daemon starting — heartbeat every ${config.heartbeatIntervalMin}m, active ${config.activeHoursStart}-${config.activeHoursEnd}`,
  );

  // v28.0: 注册 Scheduler 事件监听器并启用自动调度
  registerSchedulerListeners();
  enableScheduler();

  // Initialize last event ID to current max
  try {
    const db = getDb();
    const row = db.prepare('SELECT MAX(id) as maxId FROM events').get() as MaxIdRow | undefined;
    _lastEventCheckId = row?.maxId ?? 0;
  } catch {
    _lastEventCheckId = 0;
  }

  // Heartbeat timer
  if (config.heartbeatIntervalMin > 0) {
    const intervalMs = config.heartbeatIntervalMin * 60 * 1000;
    _heartbeatTimer = setInterval(() => {
      if (!isWithinActiveHours(getDaemonConfig())) {
        log.debug('Outside active hours, skipping heartbeat');
        return;
      }
      runAgentCheck('heartbeat', `定时心跳 (每${config.heartbeatIntervalMin}分钟)`);
      // v28.0: 心跳时执行维护任务（低频，不会每 30s 跑）
      cleanupZombieLocks();
      gcSessions();
    }, intervalMs);
  }

  // Hook + Cron check timer (every 30 seconds)
  _hookTimer = setInterval(() => {
    const cfg = getDaemonConfig();
    if (!cfg.enabled) return;
    if (!isWithinActiveHours(cfg)) return;

    checkEventHooks();
    checkCronJobs();
    // v28.0: Scheduler 兜底检查 — 补漏事件驱动遗漏的调度
    schedulerFallbackCheck().catch(err => log.error('Scheduler fallback check failed', err));
  }, 30_000);
}

export function stopDaemon(): void {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
  if (_hookTimer) {
    clearInterval(_hookTimer);
    _hookTimer = null;
  }
  disableScheduler(); // v28.0
  _running = false;
  log.info('Daemon stopped');
}

export function restartDaemon(): void {
  stopDaemon();
  startDaemon();
}

export function isDaemonRunning(): boolean {
  return _running;
}

/** Get recent heartbeat logs */
export function getHeartbeatLogs(limit: number = 50): HeartbeatLog[] {
  try {
    const db = getDb();
    return db.prepare('SELECT * FROM meta_agent_heartbeat_log ORDER BY id DESC LIMIT ?').all(limit) as HeartbeatLog[];
  } catch {
    return [];
  }
}

/** Get daemon status summary */
export function getDaemonStatus(): {
  running: boolean;
  config: DaemonConfig;
  todayTokens: number;
  recentLogs: HeartbeatLog[];
} {
  return {
    running: _running,
    config: getDaemonConfig(),
    todayTokens: getTodayTokenUsage(),
    recentLogs: getHeartbeatLogs(10),
  };
}

/** Manual trigger — force a heartbeat check now */
export async function triggerManualHeartbeat(): Promise<void> {
  await runAgentCheck('heartbeat', '手动触发心跳');
}
