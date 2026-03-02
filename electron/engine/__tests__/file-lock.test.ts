/// <reference types="vitest" />
/**
 * file-lock.ts — 进程内文件级写锁测试
 *
 * 纯内存操作，无 FS/DB 依赖。
 * 注意: fileLocks 是模块级 Map，测试间需清理。
 */

import {
  acquireFileLock,
  releaseFeatureLocks,
  releaseWorkerLocks,
  cleanExpiredLocks,
  getActiveLockCount,
  getLocksSummary,
} from '../file-lock';

describe('file-lock', () => {
  // 每个 test 后清理所有锁
  afterEach(() => {
    releaseWorkerLocks('w1');
    releaseWorkerLocks('w2');
    releaseWorkerLocks('w3');
  });

  describe('acquireFileLock', () => {
    test('首次获取成功', () => {
      const result = acquireFileLock('/ws', 'src/a.ts', 'w1', 'f1');
      expect(result.acquired).toBe(true);
      expect(result.holder).toBeUndefined();
    });

    test('同 Worker 重入安全', () => {
      acquireFileLock('/ws', 'src/a.ts', 'w1', 'f1');
      const result = acquireFileLock('/ws', 'src/a.ts', 'w1', 'f2');
      expect(result.acquired).toBe(true);
    });

    test('不同 Worker 冲突', () => {
      acquireFileLock('/ws', 'src/a.ts', 'w1', 'f1');
      const result = acquireFileLock('/ws', 'src/a.ts', 'w2', 'f2');
      expect(result.acquired).toBe(false);
      expect(result.holder?.workerId).toBe('w1');
      expect(result.holder?.featureId).toBe('f1');
    });

    test('不同文件不冲突', () => {
      acquireFileLock('/ws', 'src/a.ts', 'w1', 'f1');
      const result = acquireFileLock('/ws', 'src/b.ts', 'w2', 'f2');
      expect(result.acquired).toBe(true);
    });
  });

  describe('releaseFeatureLocks', () => {
    test('释放指定 feature 的锁', () => {
      acquireFileLock('/ws', 'src/a.ts', 'w1', 'f1');
      acquireFileLock('/ws', 'src/b.ts', 'w1', 'f1');
      acquireFileLock('/ws', 'src/c.ts', 'w1', 'f2');

      const released = releaseFeatureLocks('w1', 'f1');
      expect(released).toBe(2);

      // f2 的锁还在
      expect(getActiveLockCount()).toBeGreaterThanOrEqual(1);
    });

    test('无锁可释放返回 0', () => {
      expect(releaseFeatureLocks('w1', 'nonexistent')).toBe(0);
    });
  });

  describe('releaseWorkerLocks', () => {
    test('释放指定 worker 的所有锁', () => {
      acquireFileLock('/ws', 'src/a.ts', 'w1', 'f1');
      acquireFileLock('/ws', 'src/b.ts', 'w1', 'f2');
      acquireFileLock('/ws', 'src/c.ts', 'w2', 'f3');

      const released = releaseWorkerLocks('w1');
      expect(released).toBe(2);
      // w2 的锁还在
      expect(getActiveLockCount()).toBe(1);
    });
  });

  describe('cleanExpiredLocks', () => {
    test('清理过期锁', async () => {
      acquireFileLock('/ws', 'src/a.ts', 'w1', 'f1');
      // 等待 10ms 让锁"老化"，然后用 maxAge=5 清理
      await new Promise(r => setTimeout(r, 10));
      const cleaned = cleanExpiredLocks(5);
      expect(cleaned).toBe(1);
      expect(getActiveLockCount()).toBe(0);
    });

    test('未过期的锁不清理', () => {
      acquireFileLock('/ws', 'src/a.ts', 'w1', 'f1');
      const cleaned = cleanExpiredLocks(999_999_999);
      expect(cleaned).toBe(0);
      expect(getActiveLockCount()).toBe(1);
    });
  });

  describe('getActiveLockCount / getLocksSummary', () => {
    test('空锁返回 0 和空串', () => {
      expect(getActiveLockCount()).toBe(0);
      expect(getLocksSummary()).toBe('');
    });

    test('有锁时返回正确计数和摘要', () => {
      acquireFileLock('/ws', 'src/a.ts', 'w1', 'f1');
      acquireFileLock('/ws', 'src/b.ts', 'w1', 'f1');
      expect(getActiveLockCount()).toBe(2);

      const summary = getLocksSummary();
      expect(summary).toContain('w1');
      expect(summary).toContain('2');
    });
  });
});

