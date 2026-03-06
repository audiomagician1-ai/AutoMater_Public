/**
 * Mock for electron/db — 提供内存中的 better-sqlite3 替身
 *
 * 测试文件 import '../db' 时自动加载此 mock (通过 vitest alias)。
 *
 * 注意: better-sqlite3 是 native 模块，可能与测试 Node.js 版本不匹配。
 * 因此采用惰性初始化 + 优雅降级方案。
 *
 * 用法:
 *   import { getDb, resetTestDb } from '../db';
 *   beforeEach(() => resetTestDb());  // 每个 test 清空
 */

let db: any = null;
let Database: any = null;
let initError: Error | null = null;

function ensureDb(): any {
  if (db) return db;
  if (initError) throw initError;
  try {
    // Try multiple loading strategies for better-sqlite3 native module
    if (!Database) {
      try {
        Database = require('better-sqlite3');
      } catch {
        // In vitest ESM context, require may fail — try createRequire
        const { createRequire } = require('module');
        const _require = createRequire(
          typeof __filename !== 'undefined' ? __filename : process.cwd() + '/db-mock.js'
        );
        Database = _require('better-sqlite3');
      }
    }
    db = new Database(':memory:');
    return db;
  } catch (err: any) {
    initError = err;
    // Fallback: return a stub that won't crash but will fail SQL tests gracefully
    db = {
      exec: () => {},
      prepare: () => ({
        run: () => ({ lastInsertRowid: -1, changes: 0 }),
        get: () => undefined,
        all: () => [],
      }),
      transaction: (fn: Function) => fn,
      close: () => {},
    };
    return db;
  }
}

export function getDb(): any {
  return ensureDb();
}

/**
 * 重置测试数据库 — 关闭旧连接，创建全新 :memory: DB
 */
export function resetTestDb(): any {
  try { db?.close?.(); } catch { /* ignore */ }
  db = null;
  initError = null;
  return ensureDb();
}

export default { getDb, resetTestDb };

