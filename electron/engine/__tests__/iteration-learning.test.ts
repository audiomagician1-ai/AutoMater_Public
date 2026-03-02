/**
 * iteration-learning tests
 */
import { describe, it, expect } from 'vitest';
import {
  createLearningState, recordFailure, formatLessonsForPrompt,
  hasNewLessons, injectLessons,
} from '../iteration-learning';

describe('createLearningState', () => {
  it('creates empty state', () => {
    const state = createLearningState();
    expect(state.failures).toEqual([]);
    expect(state.lessons).toEqual([]);
    expect(state.appliedCount).toBe(0);
  });
});

describe('recordFailure', () => {
  it('extracts lesson from known failure pattern', () => {
    const state = createLearningState();
    const lesson = recordFailure(state, {
      toolName: 'read_file',
      errorOutput: 'Error: ENOENT: no such file or directory',
      arguments: { path: 'src/nonexistent.ts' },
      timestamp: Date.now(),
    });
    expect(lesson).not.toBeNull();
    expect(lesson?.type).toBe('param_fix');
    expect(lesson?.description).toContain('list_files');
  });

  it('extracts lesson from edit_file mismatch', () => {
    const state = createLearningState();
    const lesson = recordFailure(state, {
      toolName: 'edit_file',
      errorOutput: 'old_string not found in file',
      arguments: { path: 'src/a.ts', old_string: 'wrong' },
      timestamp: Date.now(),
    });
    expect(lesson?.type).toBe('param_fix');
    expect(lesson?.description).toContain('read_file');
  });

  it('extracts lesson from search no results', () => {
    const state = createLearningState();
    const lesson = recordFailure(state, {
      toolName: 'web_search',
      errorOutput: '无匹配结果',
      arguments: { query: 'xyz' },
      timestamp: Date.now(),
    });
    expect(lesson?.type).toBe('strategy_change');
  });

  it('detects repeated failures of same tool', () => {
    const state = createLearningState();
    recordFailure(state, { toolName: 'run_command', errorOutput: 'error 1', arguments: {}, timestamp: 1 });
    recordFailure(state, { toolName: 'run_command', errorOutput: 'error 2', arguments: {}, timestamp: 2 });
    const lesson = recordFailure(state, { toolName: 'run_command', errorOutput: 'error 3', arguments: {}, timestamp: 3 });
    // Should detect repeated failure
    expect(state.lessons.length).toBeGreaterThanOrEqual(1);
  });

  it('does not duplicate lessons for same pattern', () => {
    const state = createLearningState();
    recordFailure(state, {
      toolName: 'read_file',
      errorOutput: 'ENOENT not found',
      arguments: { path: 'a.ts' },
      timestamp: 1,
    });
    recordFailure(state, {
      toolName: 'read_file',
      errorOutput: 'ENOENT not found',
      arguments: { path: 'b.ts' },
      timestamp: 2,
    });
    expect(state.lessons.length).toBe(1); // deduplicated
  });
});

describe('formatLessonsForPrompt', () => {
  it('returns empty for no lessons', () => {
    const state = createLearningState();
    expect(formatLessonsForPrompt(state)).toBe('');
  });

  it('formats lessons as numbered list', () => {
    const state = createLearningState();
    recordFailure(state, {
      toolName: 'read_file',
      errorOutput: 'ENOENT',
      arguments: {},
      timestamp: Date.now(),
    });
    const text = formatLessonsForPrompt(state);
    expect(text).toContain('⚠️');
    expect(text).toContain('1.');
  });
});

describe('hasNewLessons / injectLessons', () => {
  it('detects new lessons', () => {
    const state = createLearningState();
    expect(hasNewLessons(state)).toBe(false);
    recordFailure(state, {
      toolName: 'edit_file',
      errorOutput: 'old_string not found',
      arguments: {},
      timestamp: Date.now(),
    });
    expect(hasNewLessons(state)).toBe(true);
  });

  it('injects lessons into messages', () => {
    const state = createLearningState();
    recordFailure(state, {
      toolName: 'edit_file',
      errorOutput: 'old_string not found',
      arguments: {},
      timestamp: Date.now(),
    });

    const messages: Array<{ role: string; content: string | unknown }> = [
      { role: 'system', content: 'You are a dev' },
      { role: 'user', content: 'Fix the bug' },
    ];

    const injected = injectLessons(messages, state);
    expect(injected).toBe(true);
    expect(messages.length).toBe(3); // system + user + lessons
    expect(messages[2].role).toBe('user');
    expect(messages[2].content as string).toContain('教训');
  });

  it('updates existing lesson message instead of duplicating', () => {
    const state = createLearningState();
    recordFailure(state, {
      toolName: 'edit_file',
      errorOutput: 'old_string not found',
      arguments: {},
      timestamp: Date.now(),
    });

    const messages: Array<{ role: string; content: string | unknown }> = [
      { role: 'system', content: 'You are a dev' },
      { role: 'user', content: 'Fix the bug' },
    ];

    injectLessons(messages, state);
    const len1 = messages.length;

    recordFailure(state, {
      toolName: 'read_file',
      errorOutput: 'ENOENT',
      arguments: {},
      timestamp: Date.now(),
    });
    injectLessons(messages, state);
    expect(messages.length).toBe(len1); // same count, updated in-place
  });
});
