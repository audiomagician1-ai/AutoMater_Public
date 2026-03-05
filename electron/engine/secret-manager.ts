/**
 * Secret Manager — 统一密钥/凭证管理
 *
 * 为项目提供加密的密钥存储，支持多平台凭证 (GitHub / Supabase / Cloudflare / 自定义)。
 * 加密方式: AES-256-GCM，密钥由 machineId + 应用固定盐派生。
 *
 * v1.0: 初始实现
 */

import crypto from 'crypto';
import { getDb } from '../db';
import { createLogger } from './logger';

const log = createLogger('secret-manager');

// ═══════════════════════════════════════
// Encryption
// ═══════════════════════════════════════

/** 应用固定盐 — 与 machineId 一起派生加密密钥。⚠️ 不可修改: 历史遗留标识,改动会导致已加密数据无法解密 */
const APP_SALT = 'AgentForge:SecretManager:v1:a8f3b2c1';

/** 缓存派生密钥 */
let derivedKey: Buffer | null = null;

/**
 * 获取或生成加密密钥。
 * 使用 PBKDF2 从 machineId + APP_SALT 派生 32 字节密钥。
 * 如果无法获取 machineId (CI 环境等)，降级使用纯 APP_SALT (安全性降低但仍可用)。
 */
function getEncryptionKey(): Buffer {
  if (derivedKey) return derivedKey;

  let machineId = 'fallback-desktop-id';
  try {
    // Electron 环境: 使用进程 PID 文件夹路径作为 machine 标识 (跨重启稳定)
    const { app } = require('electron');
    machineId = app.getPath('userData');
  } catch (err) {
    /* silent: electron app路径获取失败,使用回退 */
    log.debug('electron app路径获取失败,使用回退', { error: String(err) });
    // 非 Electron 环境 (测试): 使用 hostname
    const os = require('os');
    machineId = os.hostname();
  }

  derivedKey = crypto.pbkdf2Sync(
    machineId,
    APP_SALT,
    100_000, // iterations
    32, // key length (AES-256)
    'sha256',
  );

  return derivedKey;
}

/** AES-256-GCM 加密 */
function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // GCM 推荐 12 字节 IV
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  // 格式: iv:authTag:ciphertext (全 hex)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/** AES-256-GCM 解密 */
function decrypt(encryptedData: string): string {
  const key = getEncryptionKey();
  const parts = encryptedData.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const ciphertext = parts[2];

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');

  return decrypted;
}

// ═══════════════════════════════════════
// Public API
// ═══════════════════════════════════════

export type SecretProvider = 'github' | 'supabase' | 'cloudflare' | 'custom';

export interface SecretInfo {
  key: string;
  provider: SecretProvider;
  maskedValue: string;
  updatedAt: string;
}

/** 存储密钥 (创建或更新) */
export function setSecret(projectId: string, key: string, value: string, provider: SecretProvider): void {
  const db = getDb();
  const encrypted = encrypt(value);

  db.prepare(
    `
    INSERT INTO project_secrets (project_id, key, value, provider, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT (project_id, key) DO UPDATE SET
      value = excluded.value,
      provider = excluded.provider,
      updated_at = datetime('now')
  `,
  ).run(projectId, key, encrypted, provider);

  log.info(`Secret set: ${projectId}/${key} [${provider}]`);
}

/** 读取密钥 (明文) */
export function getSecret(projectId: string, key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM project_secrets WHERE project_id = ? AND key = ?').get(projectId, key) as
    | { value: string }
    | undefined;

  if (!row) return null;

  try {
    return decrypt(row.value);
  } catch (err) {
    log.error(`Failed to decrypt secret ${projectId}/${key}`, err);
    return null;
  }
}

/** 列出项目的所有密钥 (仅元信息 + 掩码值，不暴露原文) */
export function listSecrets(projectId: string, provider?: SecretProvider): SecretInfo[] {
  const db = getDb();
  let rows: Array<{ key: string; value: string; provider: string; updated_at: string }>;

  if (provider) {
    rows = db
      .prepare(
        'SELECT key, value, provider, updated_at FROM project_secrets WHERE project_id = ? AND provider = ? ORDER BY key',
      )
      .all(projectId, provider) as typeof rows;
  } else {
    rows = db
      .prepare('SELECT key, value, provider, updated_at FROM project_secrets WHERE project_id = ? ORDER BY key')
      .all(projectId) as typeof rows;
  }

  return rows.map(r => {
    let maskedValue = '****';
    try {
      const plain = decrypt(r.value);
      if (plain.length <= 8) {
        maskedValue = '****';
      } else {
        maskedValue = plain.slice(0, 4) + '…' + plain.slice(-4);
      }
    } catch (err) {
      /* silent: 解密失败,值不可用 */
      log.debug('解密失败,值不可用', { error: String(err) });
      maskedValue = '(解密失败)';
    }

    return {
      key: r.key,
      provider: r.provider as SecretProvider,
      maskedValue,
      updatedAt: r.updated_at,
    };
  });
}

/** 删除密钥 */
export function deleteSecret(projectId: string, key: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM project_secrets WHERE project_id = ? AND key = ?').run(projectId, key);
  return result.changes > 0;
}

/** 批量获取某个 provider 的所有密钥 (明文 key-value 对) — 用于环境变量注入 */
export function getProviderSecrets(projectId: string, provider: SecretProvider): Record<string, string> {
  const db = getDb();
  const rows = db
    .prepare('SELECT key, value FROM project_secrets WHERE project_id = ? AND provider = ?')
    .all(projectId, provider) as Array<{ key: string; value: string }>;

  const result: Record<string, string> = {};
  for (const r of rows) {
    try {
      result[r.key] = decrypt(r.value);
    } catch (err) {
      log.error(`Failed to decrypt secret ${projectId}/${r.key}`, err);
    }
  }
  return result;
}

/** 检查某个密钥是否存在 */
export function hasSecret(projectId: string, key: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM project_secrets WHERE project_id = ? AND key = ?').get(projectId, key);
  return !!row;
}

// ═══════════════════════════════════════
// Migration Helper
// ═══════════════════════════════════════

/**
 * 从 projects 表的旧 github_token 字段迁移到 project_secrets 表。
 * 在 DB 迁移中调用一次。
 */
export function migrateGitHubTokensFromProjects(): number {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, github_token, github_repo FROM projects WHERE github_token IS NOT NULL AND github_token != ''")
    .all() as Array<{ id: string; github_token: string; github_repo: string | null }>;

  let migrated = 0;
  for (const row of rows) {
    try {
      // 检查是否已迁移
      if (!hasSecret(row.id, 'github_token')) {
        setSecret(row.id, 'github_token', row.github_token, 'github');
        if (row.github_repo) {
          setSecret(row.id, 'github_repo', row.github_repo, 'github');
        }
        migrated++;
      }
    } catch (err) {
      log.error(`Failed to migrate github_token for project ${row.id}`, err);
    }
  }

  if (migrated > 0) {
    log.info(`Migrated ${migrated} GitHub tokens from projects table to project_secrets`);
  }

  return migrated;
}

// ═══════════════════════════════════════
// Git Config Helper
// ═══════════════════════════════════════

/**
 * 构建 GitProviderConfig，优先从 project_secrets 读取 token，
 * 回退到 projects 表的旧字段 (向后兼容)。
 */
export function getGitConfigFromSecrets(
  projectId: string,
  workspacePath: string,
): {
  mode: 'local' | 'github';
  workspacePath: string;
  githubRepo?: string;
  githubToken?: string;
} {
  const db = getDb();
  const project = db.prepare('SELECT git_mode, github_repo, github_token FROM projects WHERE id = ?').get(projectId) as
    | { git_mode: string; github_repo: string | null; github_token: string | null }
    | undefined;

  if (!project) {
    return { mode: 'local', workspacePath };
  }

  // 优先从 secrets 读取
  const token = getSecret(projectId, 'github_token') || project.github_token || undefined;
  const repo = getSecret(projectId, 'github_repo') || project.github_repo || undefined;

  return {
    mode: (project.git_mode || 'local') as 'local' | 'github',
    workspacePath,
    githubRepo: repo,
    githubToken: token,
  };
}
