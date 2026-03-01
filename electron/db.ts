/**
 * SQLite 数据库 — 内嵌在应用中，零配置
 * 
 * 使用 better-sqlite3 (同步 API，Electron 主进程友好)
 */

import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { ensureEventTable } from './engine/event-store';
import { ensureCheckpointTable } from './engine/mission';
import { ensureSessionsTable } from './engine/conversation-backup';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export async function initDatabase(): Promise<void> {
  const userDataPath = app.getPath('userData');
  const dbDir = path.join(userDataPath, 'data');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'automater.db');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 建表
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      wish TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'initializing',
      workspace_path TEXT,
      config TEXT NOT NULL DEFAULT '{}',
      git_mode TEXT NOT NULL DEFAULT 'local',
      github_repo TEXT,
      github_token TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS features (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 1,
      group_name TEXT,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      depends_on TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'todo',
      locked_by TEXT,
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      affected_files TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      PRIMARY KEY (id, project_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      current_task TEXT,
      session_count INTEGER NOT NULL DEFAULT 0,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_active_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'log',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  // 迁移: 为已有的 projects 表补充 v0.8 新字段
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN git_mode TEXT NOT NULL DEFAULT 'local'`);
  } catch { /* 列已存在 */ }
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN github_repo TEXT`);
  } catch { /* 列已存在 */ }
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN github_token TEXT`);
  } catch { /* 列已存在 */ }

  // v3.1: wishes 表 (需求队列)
  db.exec(`
    CREATE TABLE IF NOT EXISTS wishes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      pm_analysis TEXT,
      design_doc TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  // v3.1: team_members 表 (自定义团队成员)
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      model TEXT,
      capabilities TEXT NOT NULL DEFAULT '[]',
      system_prompt TEXT,
      context_files TEXT NOT NULL DEFAULT '[]',
      max_context_tokens INTEGER NOT NULL DEFAULT 128000,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  // v4.1: features 表增加 sub_group 字段
  try {
    db.exec(`ALTER TABLE features ADD COLUMN sub_group TEXT`);
  } catch { /* 列已存在 */ }

  // v6.0: features 两层索引 (G10) — group_id 用于大项目分组管理
  try {
    db.exec(`ALTER TABLE features ADD COLUMN group_id TEXT`);
  } catch { /* 列已存在 */ }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_features_group ON features(project_id, group_id)`);
  } catch { /* 索引已存在 */ }

  // v4.2: features 表增加文档追踪 + PM 验收字段
  const v42Migrations = [
    `ALTER TABLE features ADD COLUMN requirement_doc_ver INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE features ADD COLUMN test_spec_doc_ver INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE features ADD COLUMN pm_verdict TEXT`,
    `ALTER TABLE features ADD COLUMN pm_verdict_score INTEGER`,
    `ALTER TABLE features ADD COLUMN pm_verdict_feedback TEXT`,
  ];
  for (const sql of v42Migrations) {
    try { db.exec(sql); } catch { /* 列已存在 */ }
  }

  // v5.6: features 表增加 last_error / last_error_at — 用于 circuit-breaker 续跑判断
  const v56Migrations = [
    `ALTER TABLE features ADD COLUMN last_error TEXT`,
    `ALTER TABLE features ADD COLUMN last_error_at TEXT`,
  ];
  for (const sql of v56Migrations) {
    try { db.exec(sql); } catch { /* 列已存在 */ }
  }

  // v4.3: change_requests 表 (需求变更管理)
  db.exec(`
    CREATE TABLE IF NOT EXISTS change_requests (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      impact_analysis TEXT,
      affected_features TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  // v5.5: missions 表 (临时工作流 — 回归测试/代码审查/复盘等)
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      config TEXT DEFAULT '{}',
      plan TEXT,
      conclusion TEXT,
      patches TEXT DEFAULT '[]',
      token_usage INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mission_tasks (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      agent_id TEXT,
      input TEXT,
      output TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
    );
  `);

  // v11.0: team_members 表增加 成员级独立配置 (LLM / MCP / Skill)
  const v110Migrations = [
    `ALTER TABLE team_members ADD COLUMN llm_config TEXT`,      // JSON: { provider, apiKey, baseUrl, model }
    `ALTER TABLE team_members ADD COLUMN mcp_servers TEXT`,     // JSON: McpServerConfig[]
    `ALTER TABLE team_members ADD COLUMN skills TEXT`,          // JSON: string[] (skill 名称列表)
  ];
  for (const sql of v110Migrations) {
    try { db.exec(sql); } catch { /* 列已存在 */ }
  }

  // v7.0: 元Agent 管理配置表 — 管家的名字/提示词/上下文设定等
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta_agent_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // v7.0: 元Agent 记忆系统 — 分类持久化记忆
  //   category: identity / user_profile / lessons / facts / conversation_summary
  //   - identity: 管家的自我认知(名字/角色/性格)
  //   - user_profile: 对用户的了解(偏好/称呼/习惯)
  //   - lessons: 经验教训(自动积累, 大容量)
  //   - facts: 长期记忆事实(重要事件/决策/约定)
  //   - conversation_summary: 对话摘要(自动压缩历史)
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta_agent_memories (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'auto',
      importance INTEGER NOT NULL DEFAULT 5,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_meta_memories_category ON meta_agent_memories(category);
    CREATE INDEX IF NOT EXISTS idx_meta_memories_importance ON meta_agent_memories(importance DESC);
  `);

  // v12.0: 工作流预设表 — 可配置的阶段序列, 驱动 orchestrator 实际执行
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_presets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '🔄',
      stages TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 0,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_presets_project ON workflow_presets(project_id);
  `);

  console.log('[DB] Initialized at', dbPath);

  // v2.0: 确保新表存在
  ensureEventTable();
  ensureCheckpointTable();
  ensureSessionsTable();
  console.log('[DB] v2.0+ tables ensured (events, checkpoints, sessions)');
}
