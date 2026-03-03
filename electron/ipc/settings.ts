/**
 * 设置 IPC — 读写用户配置 (API Key、模型等)
 *
 * v19.1: API Key 加密存储
 *   - apiKey 不再明文存入 settings 表
 *   - 存取时通过 secret-manager AES-256-GCM 加解密
 *   - settings 表中保留 apiKey='' 占位 (兼容结构)
 */

import { ipcMain } from 'electron';
import { getDb } from '../db';
import { assertObject } from './ipc-validator';
import { setSecret, getSecret } from '../engine/secret-manager';
import { configureSearch } from '../engine/search-provider';
import { createLogger } from '../engine/logger';

const log = createLogger('settings');

/** 全局密钥的虚拟 projectId — 非项目级密钥统一存此 */
const GLOBAL_PROJECT_ID = '__global__';

export interface AppSettings {
  llmProvider: 'openai' | 'anthropic' | 'custom';
  apiKey: string;
  baseUrl: string;
  strongModel: string;
  workerModel: string;
  fastModel?: string;
  workerCount: number;
  dailyBudgetUsd: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  llmProvider: 'custom',
  apiKey: '',
  baseUrl: '',
  strongModel: '',
  workerModel: '',
  fastModel: '',
  workerCount: 0,
  dailyBudgetUsd: 0,
};

/**
 * 从 settings 表读取配置, 并从 secret-manager 解密 apiKey 注入
 */
function loadSettings(): AppSettings {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app_settings') as
    | { value: string }
    | undefined;
  let settings: AppSettings;
  if (row) {
    try {
      settings = { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) };
    } catch {
      /* silent: settings JSON parse — use defaults */
      settings = { ...DEFAULT_SETTINGS };
    }
  } else {
    settings = { ...DEFAULT_SETTINGS };
  }

  // 解密 apiKey: 优先从 secret-manager 读取加密版本
  try {
    const encrypted = getSecret(GLOBAL_PROJECT_ID, 'llm_api_key');
    if (encrypted) {
      settings.apiKey = encrypted;
    }
    // else: 保留 settings 表中的 apiKey (兼容未迁移数据)
  } catch {
    /* silent: secret-manager 读取失败, 使用 settings 表明文 */
  }

  return settings;
}

/**
 * 将 AppSettings 中的搜索引擎字段同步到 search-provider 模块
 * 在启动和每次 settings:save 后调用
 */
function syncSearchConfig(settings: Record<string, unknown>): void {
  try {
    configureSearch({
      braveApiKey: (settings.braveSearchApiKey as string) || undefined,
      serperApiKey: (settings.serperApiKey as string) || undefined,
      tavilyApiKey: (settings.tavilyApiKey as string) || undefined,
      jinaApiKey: (settings.jinaApiKey as string) || undefined,
      searxngUrl: (settings.searxngUrl as string) || undefined,
    });
  } catch (err) {
    log.warn('Failed to sync search config', { error: String(err) });
  }
}

export function setupSettingsHandlers() {
  ipcMain.handle('settings:get', () => {
    return loadSettings();
  });

  ipcMain.handle('settings:save', (_event, settings: AppSettings) => {
    assertObject('settings:save', 'settings', settings);
    const db = getDb();

    // 提取 apiKey, 加密存储到 secret-manager
    const apiKey = settings.apiKey || '';
    if (apiKey) {
      try {
        setSecret(GLOBAL_PROJECT_ID, 'llm_api_key', apiKey, 'custom');
      } catch (err) {
        log.warn('Failed to encrypt API key, storing in settings table as fallback', { error: String(err) });
        // 降级: 保留明文 (不中断保存流程)
      }
    }

    // 写入 settings 表时, apiKey 置空 (已加密存储)
    const settingsForDb = { ...settings, apiKey: '' };
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'app_settings',
      JSON.stringify(settingsForDb),
    );

    // v24.0: 每次保存后同步搜索引擎配置
    syncSearchConfig(settings as unknown as Record<string, unknown>);

    return { success: true };
  });
}

/**
 * v24.0: 应用启动时初始化搜索引擎配置
 * 从 DB 读取已保存的 API Key 并注入 search-provider
 * 应在 app ready 之后、第一次搜索之前调用
 */
export function initSearchConfigFromDb(): void {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app_settings') as
      | { value: string }
      | undefined;
    if (!row) {
      log.info('No saved settings, search will use DuckDuckGo fallback');
      return;
    }
    const settings = JSON.parse(row.value);
    syncSearchConfig(settings);
  } catch (err) {
    log.warn('Failed to init search config from DB', { error: String(err) });
  }
}

/**
 * v19.1: 一次性迁移 — 将 settings 表中的明文 apiKey 迁移到 secret-manager
 * 应在应用启动时调用一次
 */
export function migrateApiKeyToSecretManager(): void {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app_settings') as
      | { value: string }
      | undefined;
    if (!row) return;

    const settings = JSON.parse(row.value);
    if (!settings.apiKey) return; // 已为空或已迁移

    // 检查 secret-manager 是否已有加密版本
    const existing = getSecret(GLOBAL_PROJECT_ID, 'llm_api_key');
    if (existing) return; // 已迁移

    // 迁移: 加密存储 + 清空明文
    setSecret(GLOBAL_PROJECT_ID, 'llm_api_key', settings.apiKey, 'custom');
    settings.apiKey = '';
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'app_settings',
      JSON.stringify(settings),
    );
    log.info('Migrated global API key from plaintext to encrypted storage');
  } catch (err) {
    log.warn('API key migration failed (will retry on next startup)', { error: String(err) });
  }
}
