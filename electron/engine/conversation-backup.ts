/**
 * Conversation Backup — 对话备份系统
 *
 * 在每个 Agent（包括元 Agent）的一轮对话完成后，自动备份完整对话记录，
 * 包含思维链（think）和 ReAct 循环的所有消息。
 *
 * 目录结构:
 *   <packageRoot>/conversation-backups/
 *     └── 2026-03-02/                      ← 按日期
 *         ├── pm-001/                      ← agent名字 + 编号
 *         │   ├── session-abc123.json      ← 以 session 为单位的备份文件
 *         │   └── session-def456.json
 *         ├── dev-1-002/
 *         │   └── session-ghi789.json
 *         └── meta-agent-001/
 *             └── session-jkl012.json
 *
 * Session 管理:
 *   - 每个 Agent 自动创建 session（按项目运行轮次递增）
 *   - 支持从 UI 手动切换/创建 session
 *   - Session 元信息存储在 SQLite sessions 表中
 *
 * v8.0: 初始创建
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { getDb } from '../db';
import { createLogger } from './logger';

const log = createLogger('conversation-backup');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: any;
  tool_calls?: any[];
  tool_call_id?: string;
  timestamp?: number;
}

export interface ConversationBackup {
  /** 备份版本 */
  version: '1.0';
  /** Session ID */
  sessionId: string;
  /** 项目 ID (null = 元 Agent 全局对话) */
  projectId: string | null;
  /** Agent ID (如 pm-xxx, dev-1, meta-agent) */
  agentId: string;
  /** Agent 角色 */
  agentRole: string;
  /** Feature ID (如果有) */
  featureId?: string;
  /** 对话开始时间 */
  startedAt: string;
  /** 对话结束时间 */
  endedAt: string;
  /** 总消息数 */
  messageCount: number;
  /** ReAct 迭代次数 (如果是 ReAct 循环) */
  reactIterations?: number;
  /** Token 消耗 */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  /** 模型 */
  model?: string;
  /** 是否完成 */
  completed: boolean;
  /** 完整消息历史 */
  messages: ConversationMessage[];
  /** 补充元信息 */
  metadata?: Record<string, any>;
}

export interface SessionInfo {
  id: string;
  projectId: string | null;
  agentId: string;
  agentRole: string;
  /** 该 agent 在该项目下的序号 (如 001, 002) */
  agentSeq: number;
  status: 'active' | 'completed' | 'archived';
  backupPath: string | null;
  createdAt: string;
  completedAt: string | null;
  messageCount: number;
  totalTokens: number;
  totalCost: number;
}

// ═══════════════════════════════════════
// Feature-Session Association Types
// ═══════════════════════════════════════

/** 工作类型 — 描述一次 Session 的具体工作性质 */
export type WorkType =
  | 'pm-analysis'       // PM 需求分析
  | 'pm-design'         // PM 设计文档
  | 'pm-incremental'    // PM 增量分析
  | 'pm-acceptance'     // PM 验收审查
  | 'architect-design'  // 架构 + 产品设计
  | 'dev-implement'     // 开发实现
  | 'dev-rework'        // QA 驳回后重做
  | 'qa-review'         // QA 代码审查
  | 'qa-tdd'            // QA TDD 测试骨架
  | 'devops-build'      // DevOps 构建验证
  | 'doc-generation'    // 子需求/测试规格文档生成
  | 'meta-agent';       // 元 Agent 对话

/** Feature-Session 关联记录 */
export interface FeatureSessionLink {
  id: string;
  featureId: string;
  sessionId: string;
  projectId: string;
  agentId: string;
  agentRole: string;
  /** 这次 session 的工作类型 */
  workType: WorkType;
  /** 预期交付物描述 */
  expectedOutput: string;
  /** 实际产出摘要 (完成后填) */
  actualOutput: string | null;
  status: 'pending' | 'active' | 'completed' | 'failed';
  createdAt: string;
  completedAt: string | null;
}

// ═══════════════════════════════════════
// DB Table Setup
// ═══════════════════════════════════════

export function ensureSessionsTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      agent_id TEXT NOT NULL,
      agent_role TEXT NOT NULL,
      agent_seq INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      backup_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      metadata TEXT DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, agent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id, status);
  `);

  // v8.1: Feature-Session 关联表 — 追踪每个 Feature 关联的所有 Session
  db.exec(`
    CREATE TABLE IF NOT EXISTS feature_sessions (
      id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_role TEXT NOT NULL,
      work_type TEXT NOT NULL,
      expected_output TEXT NOT NULL DEFAULT '',
      actual_output TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fs_feature ON feature_sessions(feature_id, project_id);
    CREATE INDEX IF NOT EXISTS idx_fs_session ON feature_sessions(session_id);
    CREATE INDEX IF NOT EXISTS idx_fs_project ON feature_sessions(project_id, status);
  `);
}

// ═══════════════════════════════════════
// Backup Directory Management
// ═══════════════════════════════════════

function getBackupRoot(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'conversation-backups');
}

function getDateFolder(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * 根据 agentId 和 seq 构建文件夹名
 * 例: pm-001, dev-1-002, meta-agent-003
 */
function buildAgentFolderName(agentId: string, seq: number): string {
  // 清理 agentId 中的特殊字符 (保留字母数字和 -)
  const cleanId = agentId.replace(/[^a-zA-Z0-9-]/g, '');
  return `${cleanId}-${String(seq).padStart(3, '0')}`;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

// ═══════════════════════════════════════
// Session Management
// ═══════════════════════════════════════

/**
 * 获取下一个 agent 序号 (在同一项目下同一角色的递增编号)
 */
function getNextAgentSeq(projectId: string | null, agentId: string): number {
  const db = getDb();
  const key = projectId || '_global';
  const row = db.prepare(
    'SELECT MAX(agent_seq) as max_seq FROM sessions WHERE (project_id = ? OR (project_id IS NULL AND ? IS NULL)) AND agent_id = ?'
  ).get(key === '_global' ? null : key, key === '_global' ? null : key, agentId) as { max_seq: number | null } | undefined;
  return (row?.max_seq ?? 0) + 1;
}

/**
 * 创建一个新 Session
 */
export function createSession(
  projectId: string | null,
  agentId: string,
  agentRole: string,
): SessionInfo {
  const db = getDb();
  const id = `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const seq = getNextAgentSeq(projectId, agentId);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO sessions (id, project_id, agent_id, agent_role, agent_seq, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?)
  `).run(id, projectId, agentId, agentRole, seq, now);

  log.info('Session created', { id, projectId, agentId, agentRole, seq });

  return {
    id, projectId, agentId, agentRole, agentSeq: seq,
    status: 'active', backupPath: null, createdAt: now,
    completedAt: null, messageCount: 0, totalTokens: 0, totalCost: 0,
  };
}

/**
 * 获取某个 Agent 的活跃 Session (如果有)
 */
export function getActiveSession(projectId: string | null, agentId: string): SessionInfo | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM sessions WHERE (project_id = ? OR (project_id IS NULL AND ? IS NULL)) AND agent_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
  ).get(projectId, projectId, agentId) as any;
  return row ? mapSessionRow(row) : null;
}

/**
 * 获取或自动创建 Session
 */
export function getOrCreateSession(
  projectId: string | null,
  agentId: string,
  agentRole: string,
): SessionInfo {
  const existing = getActiveSession(projectId, agentId);
  if (existing) return existing;
  return createSession(projectId, agentId, agentRole);
}

/**
 * 切换到指定 Session (将当前活跃 Session 标记为 completed, 激活目标 Session)
 */
export function switchSession(sessionId: string): SessionInfo | null {
  const db = getDb();
  const target = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
  if (!target) return null;

  // 将该 agent 当前的 active session 标记为 completed
  db.prepare(
    "UPDATE sessions SET status = 'completed', completed_at = datetime('now') WHERE agent_id = ? AND (project_id = ? OR (project_id IS NULL AND ? IS NULL)) AND status = 'active'"
  ).run(target.agent_id, target.project_id, target.project_id);

  // 激活目标 session
  db.prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run(sessionId);

  log.info('Session switched', { sessionId, agentId: target.agent_id });
  return mapSessionRow({ ...target, status: 'active' });
}

/**
 * 列出某个 Agent 的所有 Session
 */
export function listSessions(projectId: string | null, agentId?: string): SessionInfo[] {
  const db = getDb();
  let rows: any[];
  if (agentId) {
    rows = db.prepare(
      'SELECT * FROM sessions WHERE (project_id = ? OR (project_id IS NULL AND ? IS NULL)) AND agent_id = ? ORDER BY created_at DESC'
    ).all(projectId, projectId, agentId);
  } else {
    rows = db.prepare(
      'SELECT * FROM sessions WHERE (project_id = ? OR (project_id IS NULL AND ? IS NULL)) ORDER BY created_at DESC'
    ).all(projectId, projectId);
  }
  return rows.map(mapSessionRow);
}

/**
 * 列出所有项目的所有 Session (用于全局管理)
 */
export function listAllSessions(limit: number = 100): SessionInfo[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?').all(limit);
  return (rows as any[]).map(mapSessionRow);
}

function mapSessionRow(row: any): SessionInfo {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    agentRole: row.agent_role,
    agentSeq: row.agent_seq,
    status: row.status,
    backupPath: row.backup_path,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    messageCount: row.message_count,
    totalTokens: row.total_tokens,
    totalCost: row.total_cost,
  };
}

// ═══════════════════════════════════════
// Backup Writing
// ═══════════════════════════════════════

/**
 * 备份一轮完整对话 — 在 Agent 一轮对话完成后调用
 *
 * @param sessionId - Session ID (如果为 null, 自动获取/创建)
 * @param projectId - 项目 ID
 * @param agentId - Agent ID
 * @param agentRole - Agent 角色
 * @param messages - 完整消息历史
 * @param stats - 对话统计
 * @param metadata - 额外元信息
 * @returns 备份文件路径
 */
export function backupConversation(opts: {
  sessionId?: string | null;
  projectId: string | null;
  agentId: string;
  agentRole: string;
  featureId?: string;
  messages: ConversationMessage[];
  reactIterations?: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  model?: string;
  completed: boolean;
  metadata?: Record<string, any>;
}): string | null {
  try {
    const db = getDb();

    // 获取或创建 session
    let session: SessionInfo;
    if (opts.sessionId) {
      const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(opts.sessionId) as any;
      session = row ? mapSessionRow(row) : createSession(opts.projectId, opts.agentId, opts.agentRole);
    } else {
      session = getOrCreateSession(opts.projectId, opts.agentId, opts.agentRole);
    }

    // 构建备份目录
    const backupRoot = getBackupRoot();
    const dateFolder = getDateFolder();
    const agentFolder = buildAgentFolderName(opts.agentId, session.agentSeq);
    const dirPath = path.join(backupRoot, dateFolder, agentFolder);
    ensureDir(dirPath);

    // 构建备份数据
    const now = new Date().toISOString();
    const backup: ConversationBackup = {
      version: '1.0',
      sessionId: session.id,
      projectId: opts.projectId,
      agentId: opts.agentId,
      agentRole: opts.agentRole,
      featureId: opts.featureId,
      startedAt: session.createdAt,
      endedAt: now,
      messageCount: opts.messages.length,
      reactIterations: opts.reactIterations,
      totalInputTokens: opts.totalInputTokens,
      totalOutputTokens: opts.totalOutputTokens,
      totalCost: opts.totalCost,
      model: opts.model,
      completed: opts.completed,
      messages: opts.messages.map(m => ({
        ...m,
        timestamp: m.timestamp ?? Date.now(),
      })),
      metadata: opts.metadata,
    };

    // 写入备份文件
    const fileName = `session-${session.id}.json`;
    const filePath = path.join(dirPath, fileName);
    fs.writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf-8');

    // 更新 session 记录
    db.prepare(`
      UPDATE sessions SET
        status = 'completed',
        completed_at = ?,
        backup_path = ?,
        message_count = ?,
        total_tokens = ?,
        total_cost = ?
      WHERE id = ?
    `).run(now, filePath, opts.messages.length, opts.totalInputTokens + opts.totalOutputTokens, opts.totalCost, session.id);

    log.info('Conversation backed up', {
      sessionId: session.id,
      agentId: opts.agentId,
      messages: opts.messages.length,
      path: filePath,
    });

    return filePath;

  } catch (err: any) {
    log.error('Conversation backup failed', err, { agentId: opts.agentId });
    return null;
  }
}

// ═══════════════════════════════════════
// Backup Reading
// ═══════════════════════════════════════

/**
 * 读取一个备份文件
 */
export function readBackup(filePath: string): ConversationBackup | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as ConversationBackup;
  } catch (err: any) {
    log.error('Failed to read backup', err, { filePath });
    return null;
  }
}

/**
 * 读取 Session 对应的备份
 */
export function readSessionBackup(sessionId: string): ConversationBackup | null {
  const db = getDb();
  const row = db.prepare('SELECT backup_path FROM sessions WHERE id = ?').get(sessionId) as { backup_path: string | null } | undefined;
  if (!row?.backup_path) return null;
  return readBackup(row.backup_path);
}

// ═══════════════════════════════════════
// Backup Stats
// ═══════════════════════════════════════

/**
 * 获取备份统计信息
 */
export function getBackupStats(): {
  totalSessions: number;
  totalBackupFiles: number;
  totalBackupSizeBytes: number;
  oldestBackup: string | null;
  newestBackup: string | null;
} {
  const db = getDb();
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      MIN(created_at) as oldest,
      MAX(created_at) as newest
    FROM sessions
  `).get() as any;

  let totalSize = 0;
  let fileCount = 0;
  const backupRoot = getBackupRoot();
  if (fs.existsSync(backupRoot)) {
    try {
      const walkSize = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkSize(full);
          } else if (entry.name.endsWith('.json')) {
            totalSize += fs.statSync(full).size;
            fileCount++;
          }
        }
      };
      walkSize(backupRoot);
    } catch { /* safe walk */ }
  }

  return {
    totalSessions: stats.total,
    totalBackupFiles: fileCount,
    totalBackupSizeBytes: totalSize,
    oldestBackup: stats.oldest,
    newestBackup: stats.newest,
  };
}

/**
 * 清理旧备份 (保留最近 N 天)
 */
export function cleanupOldBackups(keepDays: number = 30): number {
  const backupRoot = getBackupRoot();
  if (!fs.existsSync(backupRoot)) return 0;

  const now = Date.now();
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  try {
    const dateFolders = fs.readdirSync(backupRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name));

    for (const df of dateFolders) {
      const dateStr = df.name;
      const dateMs = new Date(dateStr).getTime();
      if (dateMs < cutoff) {
        const fullPath = path.join(backupRoot, dateStr);
        fs.rmSync(fullPath, { recursive: true, force: true });
        deleted++;
        log.info('Deleted old backup folder', { date: dateStr });
      }
    }
  } catch (err) {
    log.error('Cleanup old backups failed', err);
  }

  return deleted;
}
