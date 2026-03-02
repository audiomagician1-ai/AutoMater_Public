import { describe, it, expect, beforeEach } from 'vitest';
import {
  guardToolCall,
  checkReactTermination,
  toolCallSignature,
  hasToolSideEffect,
  programmaticQACheck,
  gatePMToArchitect,
  checkBudgetMulti,
  resetRateLimits,
  DEFAULT_REACT_CONFIG,
  DEFAULT_BUDGET_LIMITS,
  type ReactState,
} from '../guards';
import type { ParsedFeature } from '../types';

// ═══════════════════════════════════════
// 1. Tool Call Guard
// ═══════════════════════════════════════

describe('guardToolCall', () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it('allows valid read_file call', () => {
    const result = guardToolCall('read_file', { path: 'src/main.ts' }, true);
    expect(result.allowed).toBe(true);
  });

  it('allows absolute path for read_file (v16.0 externalRead)', () => {
    const result = guardToolCall('read_file', { path: '/etc/passwd' }, true);
    expect(result.allowed).toBe(true);
  });

  it('rejects path traversal', () => {
    const result = guardToolCall('read_file', { path: '../../secret' }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('traversal');
  });

  it('rejects missing required param', () => {
    const result = guardToolCall('write_file', { content: 'hello' }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Missing required');
  });

  it('coerces string to number for offset param', () => {
    const result = guardToolCall('read_file', { path: 'file.ts', offset: '10' }, true);
    expect(result.allowed).toBe(true);
    expect(result.repairedArgs?.offset).toBe(10);
  });

  it('clamps number to valid range', () => {
    const result = guardToolCall('read_file', { path: 'file.ts', limit: 5000 }, true);
    expect(result.allowed).toBe(true);
    expect(result.repairedArgs?.limit).toBe(1000); // max is 1000
  });

  it('rejects tool requiring workspace when no workspace', () => {
    const result = guardToolCall('read_file', { path: 'test.ts' }, false);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('workspace');
  });

  it('allows unknown tools to pass through', () => {
    const result = guardToolCall('custom_tool', { anything: 'goes' }, false);
    expect(result.allowed).toBe(true);
  });

  it('blocks dangerous hotkeys', () => {
    const result = guardToolCall('keyboard_hotkey', { combo: 'Alt+F4' }, false);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Dangerous');
  });

  it('rejects invalid enum value', () => {
    const result = guardToolCall('http_request', {
      url: 'https://example.com', method: 'PURGE',
    }, false);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not in');
  });

  it('blocks cloud metadata endpoints', () => {
    const result = guardToolCall('fetch_url', { url: 'http://169.254.169.254/metadata' }, false);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('metadata');
  });
});

// ═══════════════════════════════════════
// 2. React Guard — 终止条件
// ═══════════════════════════════════════

describe('checkReactTermination', () => {
  const makeState = (overrides: Partial<ReactState> = {}): ReactState => ({
    iteration: 0,
    totalTokens: 0,
    totalCost: 0,
    startTimeMs: Date.now(),
    consecutiveIdleCount: 0,
    consecutiveErrorCount: 0,
    recentCallSignatures: [],
    taskCompleted: false,
    filesWritten: new Set(),
    ...overrides,
  });

  it('continues when all within limits', () => {
    const result = checkReactTermination(makeState(), DEFAULT_REACT_CONFIG, false);
    expect(result.shouldContinue).toBe(true);
  });

  it('stops on abort', () => {
    const result = checkReactTermination(makeState(), DEFAULT_REACT_CONFIG, true);
    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toBe('aborted');
  });

  it('stops on task complete', () => {
    const result = checkReactTermination(
      makeState({ taskCompleted: true }), DEFAULT_REACT_CONFIG, false,
    );
    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toBe('task_complete');
  });

  it('stops on max iterations', () => {
    const result = checkReactTermination(
      makeState({ iteration: 25 }), DEFAULT_REACT_CONFIG, false,
    );
    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toBe('max_iterations');
  });

  it('stops on max tokens', () => {
    const result = checkReactTermination(
      makeState({ totalTokens: 600_000 }), DEFAULT_REACT_CONFIG, false,
    );
    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toBe('max_tokens');
  });

  it('stops on max cost', () => {
    const result = checkReactTermination(
      makeState({ totalCost: 3.0 }), DEFAULT_REACT_CONFIG, false,
    );
    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toBe('max_cost');
  });

  it('stops on idle loop', () => {
    const result = checkReactTermination(
      makeState({ consecutiveIdleCount: 5 }), DEFAULT_REACT_CONFIG, false,
    );
    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toBe('idle_loop');
  });

  it('stops on error loop', () => {
    const result = checkReactTermination(
      makeState({ consecutiveErrorCount: 3 }), DEFAULT_REACT_CONFIG, false,
    );
    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toBe('error_loop');
  });

  it('stops on repeated tool calls', () => {
    const sig = 'read_file:{"path":"same.ts"}';
    const result = checkReactTermination(
      makeState({ recentCallSignatures: [sig, sig, sig] }),
      DEFAULT_REACT_CONFIG, false,
    );
    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toBe('repeat_loop');
  });
});

// ═══════════════════════════════════════
// 3. Utility Functions
// ═══════════════════════════════════════

describe('toolCallSignature', () => {
  it('generates consistent signatures for same args', () => {
    const sig1 = toolCallSignature('read_file', { path: 'test.ts' });
    const sig2 = toolCallSignature('read_file', { path: 'test.ts' });
    expect(sig1).toBe(sig2);
  });

  it('ignores content field', () => {
    const sig1 = toolCallSignature('write_file', { path: 'a.ts', content: 'hello' });
    const sig2 = toolCallSignature('write_file', { path: 'a.ts', content: 'world' });
    expect(sig1).toBe(sig2);
  });

  it('differs for different tool names', () => {
    const sig1 = toolCallSignature('read_file', { path: 'test.ts' });
    const sig2 = toolCallSignature('write_file', { path: 'test.ts' });
    expect(sig1).not.toBe(sig2);
  });
});

describe('hasToolSideEffect', () => {
  it('returns false for read-only tools', () => {
    expect(hasToolSideEffect(['think', 'read_file', 'list_files'])).toBe(false);
  });

  it('returns true when write tool present', () => {
    expect(hasToolSideEffect(['read_file', 'write_file'])).toBe(true);
  });

  it('returns true for command execution', () => {
    expect(hasToolSideEffect(['run_command'])).toBe(true);
  });
});

// ═══════════════════════════════════════
// 4. QA Guard — Programmatic QA Check
// ═══════════════════════════════════════

describe('programmaticQACheck', () => {
  it('fails when no files written', () => {
    const result = programmaticQACheck(
      [], new Map(),
      { ran: false, passed: false, output: '' },
      { ran: false, passed: false, output: '' },
    );
    expect(result.programVerdict).toBe('fail');
    expect(result.issues[0].category).toBe('missing_file');
  });

  it('adds critical issue for failed tests', () => {
    const result = programmaticQACheck(
      ['src/app.ts'],
      new Map([['src/app.ts', 'const x = 1;']]),
      { ran: true, passed: false, output: 'FAIL: test 1' },
      { ran: false, passed: false, output: '' },
    );
    expect(result.issues.some(i => i.category === 'test')).toBe(true);
    expect(result.deductions).toBeGreaterThanOrEqual(40);
  });

  it('detects empty files', () => {
    const result = programmaticQACheck(
      ['src/empty.ts'],
      new Map([['src/empty.ts', '  \n  \n  ']]),
      { ran: false, passed: false, output: '' },
      { ran: false, passed: false, output: '' },
    );
    expect(result.issues.some(i => i.category === 'empty_file')).toBe(true);
  });

  it('detects TODO/FIXME placeholders', () => {
    const result = programmaticQACheck(
      ['src/code.ts'],
      new Map([['src/code.ts', 'function login() { // TODO: implement\n  return null;\n}']]),
      { ran: false, passed: false, output: '' },
      { ran: false, passed: false, output: '' },
    );
    expect(result.issues.some(i => i.category === 'todo_placeholder')).toBe(true);
  });

  it('detects code ellipsis patterns', () => {
    const result = programmaticQACheck(
      ['src/code.ts'],
      new Map([['src/code.ts', 'function main() {\n  // ... existing code ...\n}']]),
      { ran: false, passed: false, output: '' },
      { ran: false, passed: false, output: '' },
    );
    expect(result.issues.some(i =>
      i.category === 'todo_placeholder' && i.severity === 'critical',
    )).toBe(true);
  });

  it('defers to LLM when no critical issues', () => {
    const result = programmaticQACheck(
      ['src/app.ts'],
      new Map([['src/app.ts', 'export function greet(name: string) {\n  return `Hello, ${name}!`;\n}']]),
      { ran: false, passed: false, output: '' },
      { ran: false, passed: false, output: '' },
    );
    expect(result.programVerdict).toBe('defer_to_llm');
  });
});

// ═══════════════════════════════════════
// 5. Pipeline Gate
// ═══════════════════════════════════════

describe('gatePMToArchitect', () => {
  it('passes with valid features', () => {
    const result = gatePMToArchitect([
      { id: 'F-1', title: 'Login', description: 'Auth' },
      { id: 'F-2', title: 'Dashboard', description: 'Main view' },
    ] as unknown as ParsedFeature[]);
    expect(result.passed).toBe(true);
  });

  it('fails with empty features array', () => {
    const result = gatePMToArchitect([]);
    expect(result.passed).toBe(false);
  });

  it('fails when >50% features lack id/description', () => {
    const result = gatePMToArchitect([
      { id: '', title: '' },
      { id: '', description: '' },
      { id: 'F-1', title: 'Valid', description: 'OK' },
    ] as unknown as ParsedFeature[]);
    expect(result.passed).toBe(false);
  });

  it('detects circular dependencies', () => {
    const result = gatePMToArchitect([
      { id: 'A', title: 'A', description: 'A', dependsOn: ['B'] },
      { id: 'B', title: 'B', description: 'B', dependsOn: ['A'] },
    ] as unknown as ParsedFeature[]);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Circular');
  });
});

// ═══════════════════════════════════════
// 6. Budget Controller
// ═══════════════════════════════════════

describe('checkBudgetMulti', () => {
  it('passes when all within limits', () => {
    const result = checkBudgetMulti(1.0, 0.5, 100_000, Date.now(), DEFAULT_BUDGET_LIMITS);
    expect(result.ok).toBe(true);
  });

  it('blocks on daily cost exceeded', () => {
    const result = checkBudgetMulti(11.0, 0.5, 100_000, Date.now(), DEFAULT_BUDGET_LIMITS);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe('daily_cost');
  });

  it('blocks on feature cost exceeded', () => {
    const result = checkBudgetMulti(1.0, 3.0, 100_000, Date.now(), DEFAULT_BUDGET_LIMITS);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe('feature_cost');
  });

  it('blocks on feature tokens exceeded', () => {
    const result = checkBudgetMulti(1.0, 0.5, 600_000, Date.now(), DEFAULT_BUDGET_LIMITS);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe('feature_tokens');
  });

  it('blocks on feature time exceeded', () => {
    const longAgo = Date.now() - 20 * 60 * 1000; // 20 minutes ago
    const result = checkBudgetMulti(1.0, 0.5, 100_000, longAgo, DEFAULT_BUDGET_LIMITS);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe('feature_time');
  });

  it('skips check when limit is 0', () => {
    const noLimits = { ...DEFAULT_BUDGET_LIMITS, dailyBudgetUsd: 0 };
    const result = checkBudgetMulti(999, 0.5, 100_000, Date.now(), noLimits);
    expect(result.ok).toBe(true);
  });
});
