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
import { ensureHeartbeatTable } from './engine/meta-agent-daemon';
import { createLogger } from './engine/logger';
import { migrateGitHubTokensFromProjects } from './engine/secret-manager';
import { migrateApiKeyToSecretManager } from './ipc/settings';

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
    const row = db.prepare("SELECT value FROM schema_version WHERE key = 'version'").get() as
      | { value: string }
      | undefined;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    /* silent: schema_version表不存在(首次运行) */
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
          max_context_tokens INTEGER NOT NULL DEFAULT 256000,
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
  {
    version: 10,
    description: 'v13.0: project_secrets 加密密钥表 + features GitHub 关联字段',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_secrets (
          project_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          provider TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (project_id, key),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_project_secrets_provider ON project_secrets(project_id, provider);
      `);
      // features 表: GitHub Issue/PR/Branch 关联
      safeAddColumn('ALTER TABLE features ADD COLUMN github_issue_number INTEGER');
      safeAddColumn('ALTER TABLE features ADD COLUMN github_pr_number INTEGER');
      safeAddColumn('ALTER TABLE features ADD COLUMN github_branch TEXT');

      // 迁移旧 github_token 到 project_secrets
      try {
        migrateGitHubTokensFromProjects();
      } catch (err) {
        // 非致命: 首次安装时 projects 表可能为空
        log.debug('GitHub token migration skipped (likely first install)', { error: String(err) });
      }

      // v19.1: 迁移全局 API Key 到加密存储
      try {
        migrateApiKeyToSecretManager();
      } catch (err) {
        log.debug('API key migration skipped', { error: String(err) });
      }
    },
  },
  {
    version: 11,
    description: 'v18.0: team_members 成员级最大迭代轮数 + features 中断续跑快照',
    up: () => {
      safeAddColumn('ALTER TABLE team_members ADD COLUMN max_iterations INTEGER');
      safeAddColumn('ALTER TABLE features ADD COLUMN resume_snapshot TEXT');
    },
  },
  {
    version: 12,
    description: 'v20.0: meta_agent_chat_messages — 管家对话持久化 (应用级, 不跟随项目)',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta_agent_chat_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          project_id TEXT,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          triggered_wish INTEGER NOT NULL DEFAULT 0,
          attachments TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_macm_session ON meta_agent_chat_messages(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_macm_project ON meta_agent_chat_messages(project_id, created_at);
      `);
    },
  },
  {
    version: 13,
    description: 'D3: features.summary — PM 一句话摘要用于索引层',
    up: () => {
      safeAddColumn('ALTER TABLE features ADD COLUMN summary TEXT');
    },
  },
  {
    version: 14,
    description: 'agents 表改复合主键 (id, project_id)，支持同名 agent 跨项目独立统计',
    up: () => {
      db.exec(`
        -- 1. 重建 agents 表 (SQLite 不支持 ALTER PRIMARY KEY)
        CREATE TABLE agents_new (
          id TEXT NOT NULL,
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
          PRIMARY KEY (id, project_id),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        -- 2. 迁移旧数据
        INSERT OR IGNORE INTO agents_new
          SELECT id, project_id, role, status, current_task,
                 session_count, total_input_tokens, total_output_tokens, total_cost_usd,
                 created_at, last_active_at
          FROM agents;

        -- 3. 替换旧表
        DROP TABLE agents;
        ALTER TABLE agents_new RENAME TO agents;
      `);
    },
  },
  {
    version: 15,
    description: 'v21.0: sessions.chat_mode — 管家会话模式 (work/chat/deep)',
    up: () => {
      // sessions 表由 ensureSessionsTable() 创建，但它在 runMigrations() 之后才调用。
      // 全新安装时 sessions 表尚不存在，必须先建表再加列。
      ensureSessionsTable();
      safeAddColumn("ALTER TABLE sessions ADD COLUMN chat_mode TEXT NOT NULL DEFAULT 'work'");
    },
  },
  {
    version: 16,
    description: 'v27.0: sessions 置顶/重命名/隐藏 — pinned, custom_title, hidden',
    up: () => {
      safeAddColumn('ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
      safeAddColumn('ALTER TABLE sessions ADD COLUMN custom_title TEXT');
      safeAddColumn('ALTER TABLE sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 17,
    description: 'v28.0: Session-Agent 调度系统 — Session 语义升级 + 并发调度基础',
    up: () => {
      // sessions 表: 建立 Session → Agent(team_members) 实例化关系
      safeAddColumn('ALTER TABLE sessions ADD COLUMN member_id TEXT'); // → team_members.id
      safeAddColumn('ALTER TABLE sessions ADD COLUMN feature_id TEXT'); // 直接关联目标 Feature
      safeAddColumn('ALTER TABLE sessions ADD COLUMN started_at TEXT'); // 实际开始执行时间
      safeAddColumn('ALTER TABLE sessions ADD COLUMN suspended_at TEXT'); // 暂停时间
      safeAddColumn('ALTER TABLE sessions ADD COLUMN error_message TEXT'); // 失败原因
      // status 枚举扩展: 'created' | 'running' | 'suspended' | 'completed' | 'failed' | 'archived'
      // (SQLite 不强制枚举，由应用层保证)

      // sessions 索引: 按 member_id 查询 running session 数（并发调度核心查询）
      db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_member ON sessions(member_id, status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_feature ON sessions(feature_id)');

      // team_members 表: Agent 最大并发 Session 数
      safeAddColumn('ALTER TABLE team_members ADD COLUMN max_concurrent_sessions INTEGER DEFAULT 1');

      // features 表: 锁定时间戳（僵尸锁清理用）
      safeAddColumn('ALTER TABLE features ADD COLUMN locked_at TEXT');
    },
  },
  {
    version: 18,
    description: 'v29.0: 管家记忆项目隔离 — meta_agent_memories 增加 project_id 字段',
    up: () => {
      // 记忆表增加 project_id: NULL 表示全局记忆，非 NULL 关联到特定项目
      safeAddColumn('ALTER TABLE meta_agent_memories ADD COLUMN project_id TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_meta_memories_project ON meta_agent_memories(project_id)');
    },
  },
  {
    version: 19,
    description: 'v29.2: 自我进化基础设施 — evolution_archive + evolution_memories 表',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS evolution_archive (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          generation INTEGER NOT NULL,
          branch TEXT NOT NULL,
          fitness_score REAL NOT NULL DEFAULT 0,
          fitness_json TEXT NOT NULL DEFAULT '{}',
          description TEXT NOT NULL DEFAULT '',
          modified_files TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_evo_archive_gen ON evolution_archive(generation);
        CREATE INDEX IF NOT EXISTS idx_evo_archive_status ON evolution_archive(status);

        CREATE TABLE IF NOT EXISTS evolution_memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pattern TEXT NOT NULL,
          outcome TEXT NOT NULL,
          module TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          fitness_impact REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_evo_memories_outcome ON evolution_memories(outcome);

        CREATE TABLE IF NOT EXISTS evolution_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 20,
    description: 'v29.1: project_secrets 移除 FK 约束 — 全局密钥 (__global__) 被 FK 拦截导致 API Key 无法保存',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_secrets_new (
          project_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          provider TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (project_id, key)
        );

        INSERT OR IGNORE INTO project_secrets_new
          SELECT project_id, key, value, provider, created_at, updated_at
          FROM project_secrets;

        DROP TABLE project_secrets;
        ALTER TABLE project_secrets_new RENAME TO project_secrets;

        CREATE INDEX IF NOT EXISTS idx_project_secrets_provider ON project_secrets(project_id, provider);
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
          `Database may be in an inconsistent state — please check the logs.`,
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
      id TEXT NOT NULL,
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
      PRIMARY KEY (id, project_id),
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
  ensureHeartbeatTable();
  log.info('v2.0+ tables ensured (events, checkpoints, sessions, heartbeat)');
}
