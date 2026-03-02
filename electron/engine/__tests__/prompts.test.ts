/// <reference types="vitest" />
/**
 * prompts.ts — 内置 Prompt 模板完整性测试
 *
 * 不测 prompt 内容语义（那是 LLM 的事），只测:
 *  1. 每个导出 prompt 非空且有最低长度
 *  2. 关键格式标记存在（角色定义、输出规则等）
 *  3. 防止意外清空或截断
 */

import {
  PM_SYSTEM_PROMPT,
  ARCHITECT_SYSTEM_PROMPT,
  PM_DESIGN_DOC_PROMPT,
  PM_SPLIT_REQS_PROMPT,
  QA_TEST_SPEC_PROMPT,
  PM_ACCEPTANCE_PROMPT,
  DEVELOPER_SYSTEM_PROMPT,
  QA_SYSTEM_PROMPT,
  DEVELOPER_REACT_PROMPT,
  PLANNER_FEATURE_PROMPT,
  QA_REACT_PROMPT,
  PM_IMPACT_ANALYSIS_PROMPT,
  PM_UPDATE_DESIGN_PROMPT,
  QA_UPDATE_TEST_SPEC_PROMPT,
  PM_WISH_TRIAGE_PROMPT,
} from '../prompts';

const ALL_PROMPTS: Record<string, string> = {
  PM_SYSTEM_PROMPT,
  ARCHITECT_SYSTEM_PROMPT,
  PM_DESIGN_DOC_PROMPT,
  PM_SPLIT_REQS_PROMPT,
  QA_TEST_SPEC_PROMPT,
  PM_ACCEPTANCE_PROMPT,
  DEVELOPER_SYSTEM_PROMPT,
  QA_SYSTEM_PROMPT,
  DEVELOPER_REACT_PROMPT,
  PLANNER_FEATURE_PROMPT,
  QA_REACT_PROMPT,
  PM_IMPACT_ANALYSIS_PROMPT,
  PM_UPDATE_DESIGN_PROMPT,
  QA_UPDATE_TEST_SPEC_PROMPT,
  PM_WISH_TRIAGE_PROMPT,
};

describe('prompts', () => {
  describe('基础完整性', () => {
    for (const [name, prompt] of Object.entries(ALL_PROMPTS)) {
      test(`${name} 非空且长度 ≥ 100 字符`, () => {
        expect(typeof prompt).toBe('string');
        expect(prompt.length).toBeGreaterThanOrEqual(100);
      });
    }
  });

  describe('关键角色 prompt 格式', () => {
    test('PM prompt 包含角色定义', () => {
      expect(PM_SYSTEM_PROMPT).toContain('产品经理');
    });

    test('Architect prompt 包含架构师角色', () => {
      expect(ARCHITECT_SYSTEM_PROMPT).toContain('架构');
    });

    test('Developer prompt 包含开发相关内容', () => {
      expect(DEVELOPER_SYSTEM_PROMPT).toContain('开发');
    });

    test('QA prompt 包含 QA/测试相关内容', () => {
      expect(QA_SYSTEM_PROMPT).toContain('QA');
    });

    test('Developer ReAct prompt 包含工具调用指引', () => {
      expect(DEVELOPER_REACT_PROMPT).toContain('工具');
    });

    test('QA ReAct prompt 包含审查相关内容', () => {
      expect(QA_REACT_PROMPT).toContain('审查');
    });
  });

  describe('输出格式约束', () => {
    test('PM system prompt 包含 JSON 输出规则', () => {
      expect(PM_SYSTEM_PROMPT).toContain('JSON');
    });

    test('PM acceptance prompt 包含评判规则', () => {
      const content = PM_ACCEPTANCE_PROMPT.toLowerCase();
      expect(
        content.includes('verdict') || content.includes('accept') || content.includes('score')
      ).toBe(true);
    });
  });

  describe('prompt 数量不意外减少', () => {
    test('至少 15 个 prompt 模板', () => {
      expect(Object.keys(ALL_PROMPTS).length).toBeGreaterThanOrEqual(15);
    });
  });
});

