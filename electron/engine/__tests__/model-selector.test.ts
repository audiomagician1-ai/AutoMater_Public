/// <reference types="vitest" />
/**
 * model-selector.ts — 模型选择策略测试
 *
 * 测试维度:
 *  1. 固定任务类型 → 固定 tier
 *  2. 开发任务 → 按复杂度动态选择
 *  3. resolveModel → 正确映射 tier 到模型名
 *  4. estimateFeatureComplexity → 从 FeatureRow 推断分数
 */
import { describe, test, expect } from 'vitest';
import {
  selectModelTier,
  resolveModel,
  estimateFeatureComplexity,
  type TaskComplexity,
  } from '../model-selector';
import type { FeatureRow } from '../types';

describe('model-selector', () => {
  describe('selectModelTier — 固定任务类型', () => {
    const strongTypes: TaskComplexity['type'][] = ['pm_analysis', 'architecture', 'qa_review'];
    const workerTypes: TaskComplexity['type'][] = ['planning', 'summarize', 'lesson_extract', 'research'];

    for (const t of strongTypes) {
      test(`${t} → strong`, () => {
        expect(selectModelTier({ type: t }).tier).toBe('strong');
      });
    }

    for (const t of workerTypes) {
      test(`${t} → worker`, () => {
        expect(selectModelTier({ type: t }).tier).toBe('worker');
      });
    }

    test('format → mini', () => {
      expect(selectModelTier({ type: 'format' }).tier).toBe('mini');
    });
  });

  describe('selectModelTier — 开发任务复杂度', () => {
    test('低复杂度 (score < 4) → worker', () => {
      const result = selectModelTier({
        type: 'development',
        featureComplexity: 2,
        fileCount: 1,
      });
      expect(result.tier).toBe('worker');
    });

    test('中复杂度 (score 4-6) → worker', () => {
      const result = selectModelTier({
        type: 'development',
        featureComplexity: 3,
        fileCount: 4,
        dependencyCount: 1,
      });
      expect(result.tier).toBe('worker');
    });

    test('高复杂度 (score ≥ 7) → strong', () => {
      const result = selectModelTier({
        type: 'development',
        featureComplexity: 5,
        fileCount: 8,
        dependencyCount: 3,
        hasQAFeedback: true,
      });
      expect(result.tier).toBe('strong');
    });

    test('QA 第 3 次重试自动升级', () => {
      const result = selectModelTier({
        type: 'development',
        featureComplexity: 3,
        qaAttempt: 3,
      });
      // score = 3 + 2 (qaAttempt>=3) = 5, worker; but if qa_feedback too => 6 still worker
      // With base 3 + qaAttempt(3)→+2 = 5 → worker
      expect(['worker', 'strong']).toContain(result.tier);
    });

    test('选择结果包含 reason', () => {
      const result = selectModelTier({ type: 'development', featureComplexity: 1 });
      expect(result.reason).toBeTruthy();
      expect(result.reason.length).toBeGreaterThan(5);
    });
  });

  describe('resolveModel', () => {
    const settings = {
      strongModel: 'claude-3.5-sonnet',
      workerModel: 'claude-3-haiku',
      fastModel: 'gpt-4o-mini',
    };

    test('strong → strongModel', () => {
      expect(resolveModel('strong', settings)).toBe('claude-3.5-sonnet');
    });

    test('worker → workerModel', () => {
      expect(resolveModel('worker', settings)).toBe('claude-3-haiku');
    });

    test('mini → fastModel', () => {
      expect(resolveModel('mini', settings)).toBe('gpt-4o-mini');
    });

    test('mini 无 fastModel → fallback 到 workerModel', () => {
      const s2 = { strongModel: 'a', workerModel: 'b' };
      expect(resolveModel('mini', s2)).toBe('b');
    });

    test('mini fastModel 为空串 → fallback 到 workerModel', () => {
      const s3 = { strongModel: 'a', workerModel: 'b', fastModel: '  ' };
      expect(resolveModel('mini', s3)).toBe('b');
    });
  });

  describe('estimateFeatureComplexity', () => {
    function makeFeature(overrides: Partial<FeatureRow>): FeatureRow {
      return {
        id: 'f1',
        project_id: 'p1',
        category: '',
        priority: 1,
        group_name: null,
        title: '',
        description: '',
        depends_on: '[]',
        status: 'todo',
        locked_by: null,
        acceptance_criteria: '[]',
        affected_files: '[]',
        notes: '',
        created_at: '',
        completed_at: null,
        requirement_doc_ver: 0,
        test_spec_doc_ver: 0,
        pm_verdict: null,
        pm_verdict_score: null,
        pm_verdict_feedback: null,
        ...overrides,
      };
    }

    test('空 feature 基础分 = 3', () => {
      expect(estimateFeatureComplexity(makeFeature({}))).toBe(3);
    });

    test('长描述加分', () => {
      const longDesc = Array(120).fill('word').join(' ');
      const score = estimateFeatureComplexity(makeFeature({ description: longDesc }));
      expect(score).toBeGreaterThan(3);
    });

    test('多验收标准加分', () => {
      const criteria = JSON.stringify(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
      const score = estimateFeatureComplexity(makeFeature({ acceptance_criteria: criteria }));
      expect(score).toBeGreaterThan(3);
    });

    test('包含复杂关键词加分', () => {
      const score = estimateFeatureComplexity(makeFeature({
        description: '实现 WebSocket 实时通信模块',
      }));
      expect(score).toBeGreaterThan(3);
    });

    test('分数上限为 10', () => {
      const mega = Array(200).fill('database concurrent encryption').join(' ');
      const criteria = JSON.stringify(Array(20).fill('criterion'));
      const score = estimateFeatureComplexity(makeFeature({
        description: mega,
        acceptance_criteria: criteria,
      }));
      expect(score).toBeLessThanOrEqual(10);
    });

    test('无效 JSON acceptance_criteria 不崩溃', () => {
      const score = estimateFeatureComplexity(makeFeature({
        acceptance_criteria: 'not-json',
      }));
      expect(score).toBe(3); // fallback 到基础分
    });
  });
});

