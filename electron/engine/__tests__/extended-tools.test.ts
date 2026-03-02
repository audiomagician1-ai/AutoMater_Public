/// <reference types="vitest" />
/**
 * extended-tools.ts — think + todo + batch_edit 测试
 *
 * think/todo: 纯内存操作
 * batchEdit: 需要真实 FS (temp dir)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  think,
  todoWrite,
  todoRead,
  todoClear,
  batchEdit,
  type TodoItem,
  type EditOperation,
} from '../extended-tools';

describe('extended-tools', () => {
  // ── think ──

  describe('think', () => {
    test('纯 echo: 输入什么返回什么', () => {
      expect(think('hello')).toBe('hello');
      expect(think('')).toBe('');
    });

    test('支持多行文本', () => {
      const text = 'line1\nline2\nline3';
      expect(think(text)).toBe(text);
    });
  });

  // ── todo ──

  describe('todoWrite / todoRead / todoClear', () => {
    const agentId = 'test-agent-' + Date.now();

    afterEach(() => {
      todoClear(agentId);
    });

    test('空列表', () => {
      expect(todoRead(agentId)).toContain('无任务');
    });

    test('写入并读取', () => {
      const todos: TodoItem[] = [
        { id: '1', content: 'Task A', status: 'pending' },
        { id: '2', content: 'Task B', status: 'in_progress' },
        { id: '3', content: 'Task C', status: 'completed' },
      ];
      const result = todoWrite(agentId, todos);
      expect(result).toContain('3 项');
      expect(result).toContain('1 完成');

      const readResult = todoRead(agentId);
      expect(readResult).toContain('Task A');
      expect(readResult).toContain('Task B');
      expect(readResult).toContain('Task C');
      expect(readResult).toContain('✅');
      expect(readResult).toContain('🔄');
      expect(readResult).toContain('⬜');
    });

    test('priority 显示', () => {
      const todos: TodoItem[] = [
        { id: '1', content: 'Urgent', status: 'pending', priority: 'high' },
        { id: '2', content: 'Low', status: 'pending', priority: 'low' },
      ];
      todoWrite(agentId, todos);
      const result = todoRead(agentId);
      expect(result).toContain('🔴'); // high
      expect(result).toContain('🟢'); // low
    });

    test('todoClear 清除列表', () => {
      todoWrite(agentId, [{ id: '1', content: 'X', status: 'pending' }]);
      todoClear(agentId);
      expect(todoRead(agentId)).toContain('无任务');
    });
  });

  // ── batchEdit ──

  describe('batchEdit', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('单次替换成功', () => {
      const file = 'test.ts';
      fs.writeFileSync(path.join(tmpDir, file), 'const a = 1;\nconst b = 2;\n');
      const edits: EditOperation[] = [
        { old_string: 'const a = 1;', new_string: 'const a = 10;' },
      ];
      const result = batchEdit(tmpDir, file, edits);
      expect(result.success).toBe(true);
      expect(result.output).toContain('1/1');
      expect(fs.readFileSync(path.join(tmpDir, file), 'utf-8')).toContain('const a = 10;');
    });

    test('多次替换', () => {
      const file = 'multi.ts';
      fs.writeFileSync(path.join(tmpDir, file), 'aaa\nbbb\nccc\n');
      const edits: EditOperation[] = [
        { old_string: 'aaa', new_string: 'AAA' },
        { old_string: 'bbb', new_string: 'BBB' },
      ];
      const result = batchEdit(tmpDir, file, edits);
      expect(result.success).toBe(true);
      expect(result.output).toContain('2/2');
      const content = fs.readFileSync(path.join(tmpDir, file), 'utf-8');
      expect(content).toContain('AAA');
      expect(content).toContain('BBB');
      expect(content).toContain('ccc');
    });

    test('追加模式 (old_string 为空)', () => {
      const file = 'append.ts';
      fs.writeFileSync(path.join(tmpDir, file), 'existing\n');
      const edits: EditOperation[] = [
        { old_string: '', new_string: 'appended\n' },
      ];
      const result = batchEdit(tmpDir, file, edits);
      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, file), 'utf-8')).toBe('existing\nappended\n');
    });

    test('匹配不到时不写入', () => {
      const file = 'nomatch.ts';
      fs.writeFileSync(path.join(tmpDir, file), 'hello');
      const edits: EditOperation[] = [
        { old_string: 'NONEXISTENT', new_string: 'x' },
      ];
      const result = batchEdit(tmpDir, file, edits);
      expect(result.success).toBe(false);
      expect(result.output).toContain('0/1');
    });

    test('路径穿越拒绝', () => {
      const result = batchEdit(tmpDir, '../../../etc/passwd', []);
      expect(result.success).toBe(false);
      expect(result.output).toContain('不安全');
    });

    test('文件不存在', () => {
      const result = batchEdit(tmpDir, 'ghost.ts', []);
      expect(result.success).toBe(false);
      expect(result.output).toContain('不存在');
    });

    test('多处匹配拒绝替换', () => {
      const file = 'dup.ts';
      fs.writeFileSync(path.join(tmpDir, file), 'aaa\naaa\n');
      const edits: EditOperation[] = [
        { old_string: 'aaa', new_string: 'bbb' },
      ];
      const result = batchEdit(tmpDir, file, edits);
      // 匹配 2 处, 拒绝
      expect(result.output).toContain('2 处');
    });
  });
});

