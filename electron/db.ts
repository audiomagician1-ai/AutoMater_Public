/**
 * SQLite 数据库 — 内嵌在应用中，零配置
 *
 * 使用 better-sqlite3 (同步 API，Electron 主进程友好)
 * v12.1: 引入 schema_version 迁移系统，替代 try-catch 吞错误模式
 */

import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { ensureEventTable } from './engine/event-store';
import { ensureCheckpointTable } from './engine/mission';
import { ensureSessionsTable } from './engine/conversation-backup';
import { createLogger } from './engine/logger';

const log = createLogger('db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

// ═══════════════════════════════════════
// Schema Migration System
// ═══════════════════════════════════════

/** 安全地执行 ALTER TABLE ADD COLUMN — 仅忽略 "duplicate column" 错误，其他错误抛出 */
function safeAddColumn(sql: string): void {
  try {
    db.exec(sql);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('duplicate column') || msg.includes('already exists')) {
      return; // 列已存在，安全忽略
    }
    // 真实错误（语法错误、磁盘满、锁冲突等）— 必须抛出
    throw err;
  }
}

/** 获取当前 schema 版本号 */
function getSchemaVersion(): number {
  try {
    const row = db.prepare("SELECT value FROM schema_version WHERE key = 'version'").get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    // schema_version 表不存在 = 旧版本数据库
    return 0;
  }
}

/** 设置 schema 版本号 */
function setSchemaVersion(version: number): void {
  db.prepare("INSERT OR REPLACE INTO schema_version (key, value) VALUES ('version', ?)").run(String(version));
}

interface Migration {
  version: number;
  description: string;
  up: () => void;
}

/** 顺序迁移脚本列表 — 新迁移追加到末尾 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'v0.8: projects 表补充 git 字段',
    up: () => {
      safeAddColumn("ALTER TABLE projects ADD COLUMN git_mode TEXT NOT NULL DEFAULT 'local'");
      safeAddColumn('ALTER TABLE projects ADD COLUMN github_repo TEXT');
      safeAddColumn('ALTER TABLE projects ADD COLUMN github_token TEXT');
    },
  },
  {
    version: 2,
    description: 'v3.1: wishes 表 + team_members 表',
    up: () => {
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
    },
  },
  {
    version: 3,
    description: 'v4.1~v4.2: features 扩展字段 (sub_group, group_id, 文档追踪, PM 验收)',
    up: () => {
      safeAddColumn('ALTER TABLE features ADD COLUMN sub_group TEXT');
      safeAddColumn('ALTER TABLE features ADD COLUMN group_id TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_features_group ON features(project_id, group_id)');
      safeAddColumn('ALTER TABLE features ADD COLUMN requirement_doc_ver INTEGER NOT NULL DEFAULT 0');
      safeAddColumn('ALTER TABLE features ADD COLUMN test_spec_doc_ver INTEGER NOT NULL DEFAULT 0');
      safeAddColumn('ALTER TABLE features ADD COLUMN pm_verdict TEXT');
      safeAddColumn('ALTER TABLE features ADD COLUMN pm_verdict_score INTEGER');
      safeAddColumn('ALTER TABLE features ADD COLUMN pm_verdict_feedback TEXT');
    },
  },
  {
    version: 4,
    description: 'v4.3: change_requests 表',
    up: () => {
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
    },
  },
  {
    version: 5,
    description: 'v5.5: missions 表 + mission_tasks 表',
    up: () => {
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
    },
  },
  {
    version: 6,
    description: 'v5.6: features circuit-breaker 字段 (last_error, last_error_at)',
    up: () => {
      safeAddColumn('ALTER TABLE features ADD COLUMN last_error TEXT');
      safeAddColumn('ALTER TABLE features ADD COLUMN last_error_at TEXT');
    },
  },
  {
    version: 7,
    description: 'v7.0: 元Agent 管理配置表 + 记忆系统',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta_agent_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
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
    },
  },
  {
    version: 8,
    description: 'v11.0: team_members 成员级独立配置 (LLM / MCP / Skill)',
    up: () => {
      safeAddColumn('ALTER TABLE team_members ADD COLUMN llm_config TEXT');
      safeAddColumn('ALTER TABLE team_members ADD COLUMN mcp_servers TEXT');
      safeAddColumn('ALTER TABLE team_members ADD COLUMN skills TEXT');
    },
  },
  {
    version: 9,
    description: 'v12.0: 工作流预设表',
    up: () => {
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
    },
  },
];

/** 执行所有待执行的迁移脚本 */
function runMigrations(): void {
  const currentVersion = getSchemaVersion();
  const pending = MIGRATIONS.filter(m => m.version > currentVersion);

  if (pending.length === 0) {
    log.info(`Schema at version ${currentVersion}, no migrations needed`);
    return;
  }

  log.info(`Schema at version ${currentVersion}, running ${pending.length} migrations...`);

  for (const migration of pending) {
    try {
      migration.up();
      setSchemaVersion(migration.version);
      log.info(`  ✅ Migration ${migration.version}: ${migration.description}`);
    } catch (err) {
      log.error(`  ❌ Migration ${migration.version} FAILED: ${migration.description}`, err);
      throw new Error(
        `Database migration ${migration.version} failed: ${migration.description}. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}. ` +
        `Database may be in an inconsistent state — please check the logs.`
      );
    }
  }

  log.info(`Schema upgraded to version ${pending[pending.length - 1].version}`);
}

// ═══════════════════════════════════════
// Initialization
// ═══════════════════════════════════════

export async function initDatabase(): Promise<void> {
  const userDataPath = app.getPath('userData');
  const dbDir = path.join(userDataPath, 'data');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'automater.db');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // schema_version 表 — 迁移系统自身需要的表
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // 核心建表 (首次安装)
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

  // 执行所有待执行的顺序迁移
  runMigrations();

  log.info(`Initialized at ${dbPath}`);

  // v2.0: 确保新表存在 (这些模块自己管理表创建)
  ensureEventTable();
  ensureCheckpointTable();
  ensureSessionsTable();
  log.info('v2.0+ tables ensured (events, checkpoints, sessions)');
}
