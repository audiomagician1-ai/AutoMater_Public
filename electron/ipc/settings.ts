/**
 * 设置 IPC — 读写用户配置 (API Key、模型等)
 */

import { ipcMain } from 'electron';
import { getDb } from '../db';

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

export function setupSettingsHandlers() {
  ipcMain.handle('settings:get', () => {
    const db = getDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app_settings') as { value: string } | undefined;
    if (row) {
      try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) };
      } catch {
        return DEFAULT_SETTINGS;
      }
    }
    return DEFAULT_SETTINGS;
  });

  ipcMain.handle('settings:save', (_event, settings: AppSettings) => {
    const db = getDb();
    db.prepare(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
    ).run('app_settings', JSON.stringify(settings));
    return { success: true };
  });
}
