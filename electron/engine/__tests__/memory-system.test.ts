/// <reference types="vitest" />
/**
 * memory-system.ts — 3-layer Agent 记忆系统测试
 *
 * 使用 temp dir 模拟 workspace。
 * Global memory 路径依赖 Electron app.getPath() → 走 mock。
 * 因此只测 project/role 层级 (不依赖 Electron)，以及纯函数。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  readProjectMemory,
  writeProjectMemory,
  readRoleMemory,
  writeRoleMemory,
  readMemoryForRole,
  appendProjectMemory,
  appendRoleMemory,
  recordLessonLearned,
  buildLessonExtractionPrompt,
  ensureProjectMemory,
  appendSharedDecision,
  readRecentDecisions,
  formatDecisionsForContext,
  type LessonLearned,
} from '../memory-system';

describe('memory-system', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Project Memory ──

  describe('project memory read/write', () => {
    test('空目录读取返回空串', () => {
      expect(readProjectMemory(tmpDir)).toBe('');
    });

    test('写入后可读取', () => {
      writeProjectMemory(tmpDir, '# Test Memory\n- lesson 1');
      const content = readProjectMemory(tmpDir);
      expect(content).toContain('Test Memory');
      expect(content).toContain('lesson 1');
    });

    test('覆盖写入', () => {
      writeProjectMemory(tmpDir, 'v1');
      writeProjectMemory(tmpDir, 'v2');
      expect(readProjectMemory(tmpDir)).toBe('v2');
    });
  });

  // ── Role Memory ──

  describe('role memory read/write', () => {
    test('空读取返回空串', () => {
      expect(readRoleMemory(tmpDir, 'developer')).toBe('');
    });

    test('写入后可读取', () => {
      writeRoleMemory(tmpDir, 'qa', 'QA rules here');
      expect(readRoleMemory(tmpDir, 'qa')).toBe('QA rules here');
    });

    test('不同角色独立存储', () => {
      writeRoleMemory(tmpDir, 'developer', 'dev content');
      writeRoleMemory(tmpDir, 'qa', 'qa content');
      expect(readRoleMemory(tmpDir, 'developer')).toBe('dev content');
      expect(readRoleMemory(tmpDir, 'qa')).toBe('qa content');
    });
  });

  // ── readMemoryForRole ──

  describe('readMemoryForRole', () => {
    test('所有层级为空时返回空 combined', () => {
      const result = readMemoryForRole(tmpDir, 'developer');
      expect(result.project).toBe('');
      expect(result.role).toBe('');
      expect(result.combined).toBe('');
    });

    test('有 project + role 记忆时正确组合', () => {
      writeProjectMemory(tmpDir, 'project stuff');
      writeRoleMemory(tmpDir, 'developer', 'dev stuff');
      const result = readMemoryForRole(tmpDir, 'developer');
      expect(result.project).toBe('project stuff');
      expect(result.role).toBe('dev stuff');
      expect(result.combined).toContain('project stuff');
      expect(result.combined).toContain('dev stuff');
      expect(result.combined).toContain('项目记忆');
      expect(result.combined).toContain('角色记忆');
    });
  });

  // ── Append ──

  describe('appendProjectMemory / appendRoleMemory', () => {
    test('追加条目', () => {
      appendProjectMemory(tmpDir, 'lesson 1');
      appendProjectMemory(tmpDir, 'lesson 2');
      const content = readProjectMemory(tmpDir);
      expect(content).toContain('lesson 1');
      expect(content).toContain('lesson 2');
    });

    test('追加的条目带时间戳', () => {
      appendRoleMemory(tmpDir, 'developer', 'remember this');
      const content = readRoleMemory(tmpDir, 'developer');
      // 格式: [YYYY-MM-DDTHH:MM:SS]
      expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\]/);
    });
  });

  // ── Lesson Learned ──

  describe('recordLessonLearned', () => {
    test('写入格式化的经验教训', () => {
      const lesson: LessonLearned = {
        featureId: 'F-001',
        qaAttempt: 2,
        qaFeedback: '缺少错误处理',
        fixSummary: '添加了 try-catch',
        lesson: '所有 async 函数都应该有 error handling',
      };
      recordLessonLearned(tmpDir, lesson);
      const content = readProjectMemory(tmpDir);
      expect(content).toContain('F-001');
      expect(content).toContain('QA attempt 2');
      expect(content).toContain('缺少错误处理');
    });
  });

  // ── buildLessonExtractionPrompt (纯函数) ──

  describe('buildLessonExtractionPrompt', () => {
    test('生成包含所有参数的 prompt', () => {
      const prompt = buildLessonExtractionPrompt(
        'F-002',
        'TypeScript 类型错误',
        ['src/utils.ts', 'src/index.ts'],
        '添加了类型断言',
      );
      expect(prompt).toContain('F-002');
      expect(prompt).toContain('TypeScript 类型错误');
      expect(prompt).toContain('src/utils.ts');
      expect(prompt).toContain('添加了类型断言');
      expect(prompt).toContain('经验');
    });

    test('截断过长的输入', () => {
      const longFeedback = 'x'.repeat(1000);
      const prompt = buildLessonExtractionPrompt('F-003', longFeedback, [], 'fix');
      // 应截断到 500
      expect(prompt.length).toBeLessThan(longFeedback.length);
    });
  });

  // ── ensureProjectMemory ──

  describe('ensureProjectMemory', () => {
    test('首次调用创建默认模板', () => {
      ensureProjectMemory(tmpDir);
      const content = readProjectMemory(tmpDir);
      expect(content).toContain('Project Memory');
      expect(content).toContain('架构决策');
    });

    test('已存在时不覆盖', () => {
      writeProjectMemory(tmpDir, 'custom content');
      ensureProjectMemory(tmpDir);
      expect(readProjectMemory(tmpDir)).toBe('custom content');
    });
  });

  // ── Shared Decision Log ──

  describe('shared decisions', () => {
    test('追加和读取决策', () => {
      appendSharedDecision(tmpDir, {
        agentId: 'dev-1',
        featureId: 'F-001',
        type: 'library_chosen',
        description: '选择 zod 做 schema 校验',
      });
      appendSharedDecision(tmpDir, {
        agentId: 'dev-2',
        featureId: 'F-002',
        type: 'file_created',
        description: '创建 src/validators.ts',
      });

      const decisions = readRecentDecisions(tmpDir);
      expect(decisions).toHaveLength(2);
      expect(decisions[0].agentId).toBe('dev-1');
      expect(decisions[1].type).toBe('file_created');
    });

    test('limit 参数生效', () => {
      for (let i = 0; i < 5; i++) {
        appendSharedDecision(tmpDir, {
          agentId: `a${i}`, featureId: 'f', type: 'other', description: `d${i}`,
        });
      }
      const limited = readRecentDecisions(tmpDir, 2);
      expect(limited).toHaveLength(2);
    });

    test('空目录读取返回空数组', () => {
      expect(readRecentDecisions(tmpDir)).toEqual([]);
    });
  });

  describe('formatDecisionsForContext', () => {
    test('空数组返回空串', () => {
      expect(formatDecisionsForContext([])).toBe('');
    });

    test('格式化输出', () => {
      const decisions = [
        {
          timestamp: '2026-03-02T10:30:00.000Z',
          agentId: 'dev-1', featureId: 'F-001',
          type: 'library_chosen' as const, description: '选择 zod',
        },
      ];
      const text = formatDecisionsForContext(decisions);
      expect(text).toContain('dev-1');
      expect(text).toContain('F-001');
      expect(text).toContain('选择 zod');
      expect(text).toContain('Shared Decision Log');
    });

    test('excludeAgent 过滤', () => {
      const decisions = [
        {
          timestamp: '2026-03-02T10:30:00.000Z',
          agentId: 'dev-1', featureId: 'F-001',
          type: 'other' as const, description: 'x',
        },
      ];
      expect(formatDecisionsForContext(decisions, 'dev-1')).toBe('');
    });
  });
});

