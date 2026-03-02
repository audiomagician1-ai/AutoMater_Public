/**
 * secret-manager.test.ts — AES-256-GCM 加密密钥存储测试
 *
 * 需要 better-sqlite3 原生模块。Node 版本不匹配时自动跳过 (CI 用 Node 20 可运行)。
 */
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { getDb } from '../db';
import {
  setSecret, getSecret, listSecrets, deleteSecret, hasSecret, getProviderSecrets,
} from '../secret-manager';

let realDb = false;

function initTable(): boolean {
  try {
    const db = getDb();
    db.exec('CREATE TABLE IF NOT EXISTS test_probe (id TEXT)');
    db.prepare('INSERT INTO test_probe VALUES (?)').run('check');
    const row = db.prepare('SELECT * FROM test_probe').get() as { id: string } | undefined;
    db.exec('DROP TABLE test_probe');
    if (row?.id !== 'check') return false;
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_secrets (
        project_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        provider TEXT DEFAULT 'custom',
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (project_id, key)
      )
    `);
    return true;
  } catch { return false; }
}

describe('secret-manager', () => {
  beforeAll(() => { realDb = initTable(); });
  beforeEach(() => { if (realDb) try { getDb().exec('DELETE FROM project_secrets'); } catch { /* */ } });

  it('setSecret + getSecret round-trip', () => {
    if (!realDb) return; // skip: native sqlite unavailable
    setSecret('proj-1', 'api_key', 'sk-test-12345', 'custom');
    expect(getSecret('proj-1', 'api_key')).toBe('sk-test-12345');
  });

  it('overwrites existing secret', () => {
    if (!realDb) return;
    setSecret('proj-1', 'k', 'old', 'custom');
    setSecret('proj-1', 'k', 'new', 'custom');
    expect(getSecret('proj-1', 'k')).toBe('new');
  });

  it('handles special characters', () => {
    if (!realDb) return;
    const val = 'key!@#$%^&*()_+-={}[]|\\:";\'<>?,./~`';
    setSecret('proj-1', 'sp', val, 'custom');
    expect(getSecret('proj-1', 'sp')).toBe(val);
  });

  it('returns null for non-existent key', () => {
    if (!realDb) return;
    expect(getSecret('proj-1', 'missing')).toBeNull();
  });

  it('isolates secrets by project', () => {
    if (!realDb) return;
    setSecret('p1', 'k', 'v1', 'custom');
    setSecret('p2', 'k', 'v2', 'custom');
    expect(getSecret('p1', 'k')).toBe('v1');
    expect(getSecret('p2', 'k')).toBe('v2');
  });

  it('deleteSecret returns true/false', () => {
    if (!realDb) return;
    setSecret('p1', 'k', 'v', 'custom');
    expect(deleteSecret('p1', 'k')).toBe(true);
    expect(deleteSecret('p1', 'k')).toBe(false);
  });

  it('hasSecret', () => {
    if (!realDb) return;
    expect(hasSecret('p1', 'k')).toBe(false);
    setSecret('p1', 'k', 'v', 'custom');
    expect(hasSecret('p1', 'k')).toBe(true);
  });

  it('listSecrets masks values', () => {
    if (!realDb) return;
    setSecret('p1', 'long', 'this-is-long-secret', 'github');
    setSecret('p1', 'tiny', 'ab', 'custom');
    const list = listSecrets('p1');
    expect(list).toHaveLength(2);
    expect(list.find(s => s.key === 'tiny')!.maskedValue).toBe('****');
  });

  it('getProviderSecrets returns decrypted pairs', () => {
    if (!realDb) return;
    setSecret('p1', 'tok', 'ghp_xx', 'github');
    expect(getProviderSecrets('p1', 'github').tok).toBe('ghp_xx');
  });

  // Stub fallback (when native sqlite unavailable)
  it('stub fallback: getSecret returns null', () => {
    if (realDb) return; // only run on stub
    expect(getSecret('x', 'y')).toBeNull();
  });

  it('stub fallback: deleteSecret returns false', () => {
    if (realDb) return;
    expect(deleteSecret('x', 'y')).toBe(false);
  });
});
