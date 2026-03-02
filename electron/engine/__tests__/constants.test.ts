/**
 * constants.ts — 值域校验 + 关系一致性测试
 *
 * 常量测试看似简单但至关重要：防止意外修改导致运行时行为偏移。
 */
import { describe, test, expect } from 'vitest';

import {
  REACT_MAX_ITERATIONS,
  REACT_MAX_TOKENS,
  REACT_MAX_COST_USD,
  BATCH_DOC_SIZE,
  PHASE3_TIMEOUT_MS,
  BATCH_ACCEPT_SIZE,
  WORKER_POLL_INTERVAL_MS,
  WORKER_MAX_IDLE_POLLS,
  QA_MAX_RETRIES,
  DEVOPS_BUILD_TIMEOUT_MS,
  DEVOPS_MAX_BUFFER,
  CHARS_PER_TOKEN_EN,
  CHARS_PER_TOKEN_ZH,
  DEFAULT_DAILY_BUDGET_USD,
  DEFAULT_FEATURE_BUDGET_USD,
  DEFAULT_FEATURE_TOKEN_LIMIT,
  DEFAULT_FEATURE_TIME_LIMIT_MIN,
} from '../constants';

describe('constants', () => {
  describe('value ranges — 防止意外改动', () => {
    test('ReAct 迭代上限应在合理范围 [5, 100]', () => {
      expect(REACT_MAX_ITERATIONS).toBeGreaterThanOrEqual(5);
      expect(REACT_MAX_ITERATIONS).toBeLessThanOrEqual(100);
    });

    test('ReAct token 预算应为正整数', () => {
      expect(REACT_MAX_TOKENS).toBeGreaterThan(0);
      expect(Number.isInteger(REACT_MAX_TOKENS)).toBe(true);
    });

    test('ReAct 成本上限应为正数', () => {
      expect(REACT_MAX_COST_USD).toBeGreaterThan(0);
    });

    test('批处理大小应为正整数', () => {
      expect(BATCH_DOC_SIZE).toBeGreaterThan(0);
      expect(Number.isInteger(BATCH_DOC_SIZE)).toBe(true);
      expect(BATCH_ACCEPT_SIZE).toBeGreaterThan(0);
      expect(Number.isInteger(BATCH_ACCEPT_SIZE)).toBe(true);
    });

    test('超时值应为正数毫秒', () => {
      expect(PHASE3_TIMEOUT_MS).toBeGreaterThan(0);
      expect(DEVOPS_BUILD_TIMEOUT_MS).toBeGreaterThan(0);
    });

    test('Worker 轮询配置合理', () => {
      expect(WORKER_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
      expect(WORKER_MAX_IDLE_POLLS).toBeGreaterThanOrEqual(1);
    });

    test('QA 重试次数合理 [1, 10]', () => {
      expect(QA_MAX_RETRIES).toBeGreaterThanOrEqual(1);
      expect(QA_MAX_RETRIES).toBeLessThanOrEqual(10);
    });

    test('DevOps 缓冲区大小应为正整数', () => {
      expect(DEVOPS_MAX_BUFFER).toBeGreaterThan(0);
      expect(Number.isInteger(DEVOPS_MAX_BUFFER)).toBe(true);
    });
  });

  describe('token 估算比率', () => {
    test('英文比率应 > 中文比率 (英文更高效)', () => {
      expect(CHARS_PER_TOKEN_EN).toBeGreaterThan(CHARS_PER_TOKEN_ZH);
    });

    test('比率应为正数', () => {
      expect(CHARS_PER_TOKEN_EN).toBeGreaterThan(0);
      expect(CHARS_PER_TOKEN_ZH).toBeGreaterThan(0);
    });
  });

  describe('预算默认值一致性', () => {
    test('单个 Feature 预算 ≤ 每日预算', () => {
      expect(DEFAULT_FEATURE_BUDGET_USD).toBeLessThanOrEqual(DEFAULT_DAILY_BUDGET_USD);
    });

    test('Feature token 上限 = ReAct token 预算 (应同步)', () => {
      expect(DEFAULT_FEATURE_TOKEN_LIMIT).toBe(REACT_MAX_TOKENS);
    });

    test('Feature 成本上限 = ReAct 成本上限 (应同步)', () => {
      expect(DEFAULT_FEATURE_BUDGET_USD).toBe(REACT_MAX_COST_USD);
    });

    test('Feature 时间限制应为正整数分钟', () => {
      expect(DEFAULT_FEATURE_TIME_LIMIT_MIN).toBeGreaterThan(0);
      expect(Number.isInteger(DEFAULT_FEATURE_TIME_LIMIT_MIN)).toBe(true);
    });
  });
});
