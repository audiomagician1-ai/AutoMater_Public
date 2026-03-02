/**
 * decision-log.ts — 并行 Worker 文件冲突检测测试
 *
 * 使用真实 temp 目录，测试 claim/release/conflict/cleanup 完整流程。
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  claimFiles,
  releaseFiles,
  getActiveClaims,
  getClaimsSummary,
  predictAffectedFiles,
  cleanupDecisionLog,
  broadcastAchievement,
  broadcastFilesCreated,
  getRecentBroadcasts,
  formatBroadcastContext,
} from '../decision-log';
import type { FeatureRow } from '../types';

describe('decision-log', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'declog-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('claimFiles + getActiveClaims', () => {
    test('单 worker claim 后可查到活跃声明', () => {
      claimFiles(tmpDir, 'w1', 'f1', ['src/a.ts', 'src/b.ts']);
      const claims = getActiveClaims(tmpDir);
      expect(claims.size).toBe(2);
      expect(claims.get('src/a.ts')?.workerId).toBe('w1');
      expect(claims.get('src/b.ts')?.featureId).toBe('f1');
    });

    test('releaseFiles 后声明清除', () => {
      claimFiles(tmpDir, 'w1', 'f1', ['src/a.ts']);
      releaseFiles(tmpDir, 'w1', 'f1');
      const claims = getActiveClaims(tmpDir);
      expect(claims.size).toBe(0);
    });

    test('两个 worker 无冲突', () => {
      const c1 = claimFiles(tmpDir, 'w1', 'f1', ['src/a.ts']);
      const c2 = claimFiles(tmpDir, 'w2', 'f2', ['src/b.ts']);
      expect(c1).toHaveLength(0);
      expect(c2).toHaveLength(0);
    });

    test('两个 worker 有文件冲突', () => {
      claimFiles(tmpDir, 'w1', 'f1', ['src/shared.ts', 'src/a.ts']);
      const conflicts = claimFiles(tmpDir, 'w2', 'f2', ['src/shared.ts', 'src/c.ts']);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].otherWorkerId).toBe('w1');
      expect(conflicts[0].overlappingFiles).toContain('src/shared.ts');
    });

    test('同一 worker 重复 claim 不算冲突', () => {
      claimFiles(tmpDir, 'w1', 'f1', ['src/a.ts']);
      const conflicts = claimFiles(tmpDir, 'w1', 'f2', ['src/a.ts']);
      expect(conflicts).toHaveLength(0); // 同一 worker
    });
  });

  describe('getClaimsSummary', () => {
    test('无声明返回空串', () => {
      expect(getClaimsSummary(tmpDir)).toBe('');
    });

    test('有声明时返回格式化文本', () => {
      claimFiles(tmpDir, 'w1', 'f1', ['src/a.ts']);
      const summary = getClaimsSummary(tmpDir);
      expect(summary).toContain('w1');
      expect(summary).toContain('src/a.ts');
    });

    test('排除指定 worker', () => {
      claimFiles(tmpDir, 'w1', 'f1', ['src/a.ts']);
      const summary = getClaimsSummary(tmpDir, 'w1');
      expect(summary).toBe('');
    });
  });

  describe('predictAffectedFiles', () => {
    function makeFeature(overrides: Partial<FeatureRow>): FeatureRow {
      return {
        id: 'f1', project_id: 'p1', category: '', priority: 1, group_name: null,
        title: '', description: '', depends_on: '[]', status: 'todo', locked_by: null,
        acceptance_criteria: '[]', affected_files: '', notes: '', created_at: '',
        completed_at: null, requirement_doc_ver: 0, test_spec_doc_ver: 0,
        pm_verdict: null, pm_verdict_score: null, pm_verdict_feedback: null,
        ...overrides,
      };
    }

    test('有 affected_files JSON 直接返回', () => {
      const files = predictAffectedFiles(makeFeature({
        affected_files: '["src/a.ts", "src/b.ts"]',
      }));
      expect(files).toEqual(['src/a.ts', 'src/b.ts']);
    });

    test('无 affected_files 根据 category 猜测', () => {
      const files = predictAffectedFiles(makeFeature({
        category: 'UI',
        title: '新增页面组件',
      }));
      expect(files.length).toBeGreaterThan(0);
      expect(files.some(f => f.includes('component') || f.includes('page'))).toBe(true);
    });

    test('无有效信息返回空数组', () => {
      const files = predictAffectedFiles(makeFeature({}));
      expect(files).toEqual([]);
    });
  });

  describe('cleanupDecisionLog', () => {
    test('清理 24h 前的旧条目', () => {
      // 手动写入一条旧条目
      const logDir = path.join(tmpDir, '.automater');
      fs.mkdirSync(logDir, { recursive: true });
      const oldEntry = {
        featureId: 'f-old', workerId: 'w-old', plannedFiles: ['old.ts'],
        timestamp: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        action: 'claim',
      };
      const newEntry = {
        featureId: 'f-new', workerId: 'w-new', plannedFiles: ['new.ts'],
        timestamp: new Date().toISOString(),
        action: 'claim',
      };
      fs.writeFileSync(
        path.join(logDir, 'decision-log.jsonl'),
        JSON.stringify(oldEntry) + '\n' + JSON.stringify(newEntry) + '\n',
      );

      cleanupDecisionLog(tmpDir);

      const content = fs.readFileSync(path.join(logDir, 'decision-log.jsonl'), 'utf-8');
      expect(content).not.toContain('f-old');
      expect(content).toContain('f-new');
    });
  });

  describe('broadcast system', () => {
    test('broadcastAchievement + getRecentBroadcasts', () => {
      broadcastAchievement({
        workerId: 'w1', featureId: 'f1', type: 'file_created',
        detail: 'src/new-file.ts', timestamp: Date.now(),
      });
      const recent = getRecentBroadcasts(600_000);
      expect(recent.length).toBeGreaterThanOrEqual(1);
      expect(recent.some(b => b.detail === 'src/new-file.ts')).toBe(true);
    });

    test('broadcastFilesCreated 批量广播', () => {
      broadcastFilesCreated('w2', 'f2', ['a.ts', 'b.ts', 'c.ts']);
      const recent = getRecentBroadcasts(600_000, 'other');
      expect(recent.filter(b => b.workerId === 'w2').length).toBeGreaterThanOrEqual(3);
    });

    test('formatBroadcastContext 空输入返回空串', () => {
      expect(formatBroadcastContext([])).toBe('');
    });

    test('formatBroadcastContext 有数据时格式化', () => {
      const text = formatBroadcastContext([
        { workerId: 'w1', featureId: 'f1', type: 'file_created', detail: 'x.ts', timestamp: Date.now() },
      ]);
      expect(text).toContain('w1');
      expect(text).toContain('x.ts');
    });
  });
});
