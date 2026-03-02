/**
 * Tests for react-resilience.ts — 工具重试 + LLM 退避 + 上下文预算 + 模型降级
 */
import { describe, it, expect } from 'vitest';
import {
  isRetryableTool,
  isRetryableError,
  getBackoffDelayMs,
  getModelContextLimit,
  checkContextBudget,
  compressToolOutputs,
  suggestModelDowngrade,
  buildRecoveryHint,
} from '../react-resilience';

// ═══════════════════════════════════════
// isRetryableTool
// ═══════════════════════════════════════

describe('isRetryableTool', () => {
  it('returns true for read-only tools', () => {
    const retryable = ['read_file', 'list_files', 'search_files', 'glob_files',
      'web_search', 'fetch_url', 'think', 'memory_read', 'todo_read',
      'browser_screenshot', 'browser_snapshot', 'sandbox_read',
      'analyze_image', 'compare_screenshots', 'visual_assert'];
    for (const t of retryable) {
      expect(isRetryableTool(t), `${t} should be retryable`).toBe(true);
    }
  });

  it('returns false for write/side-effect tools', () => {
    const nonRetryable = ['write_file', 'edit_file', 'run_command', 'git_commit',
      'task_complete', 'sandbox_exec', 'mouse_click', 'keyboard_type',
      'browser_click', 'spawn_agent'];
    for (const t of nonRetryable) {
      expect(isRetryableTool(t), `${t} should not be retryable`).toBe(false);
    }
  });
});

// ═══════════════════════════════════════
// isRetryableError
// ═══════════════════════════════════════

describe('isRetryableError', () => {
  it('identifies transient network errors', () => {
    expect(isRetryableError('Connection timeout after 30s')).toBe(true);
    expect(isRetryableError('ECONNRESET: socket hang up')).toBe(true);
    expect(isRetryableError('ECONNREFUSED 127.0.0.1:8080')).toBe(true);
    expect(isRetryableError('ETIMEDOUT')).toBe(true);
    expect(isRetryableError('fetch failed')).toBe(true);
    expect(isRetryableError('network error occurred')).toBe(true);
  });

  it('identifies HTTP error codes', () => {
    expect(isRetryableError('rate limit exceeded 429')).toBe(true);
    expect(isRetryableError('HTTP 500 Internal Server Error')).toBe(true);
    expect(isRetryableError('HTTP 502 Bad Gateway')).toBe(true);
    expect(isRetryableError('HTTP 503 Service Unavailable')).toBe(true);
    expect(isRetryableError('HTTP 504 Gateway Timeout')).toBe(true);
  });

  it('identifies Chinese error messages', () => {
    expect(isRetryableError('搜索失败：无法连接')).toBe(true);
    expect(isRetryableError('抓取失败：超时')).toBe(true);
  });

  it('returns false for non-transient errors', () => {
    expect(isRetryableError('File not found: foo.ts')).toBe(false);
    expect(isRetryableError('SyntaxError: unexpected token')).toBe(false);
    expect(isRetryableError('Permission denied')).toBe(false);
  });
});

// ═══════════════════════════════════════
// getBackoffDelayMs
// ═══════════════════════════════════════

describe('getBackoffDelayMs', () => {
  it('returns ~2s for first error', () => {
    const delay = getBackoffDelayMs(1);
    expect(delay).toBeGreaterThanOrEqual(2000);
    expect(delay).toBeLessThanOrEqual(2400); // 2000 + 20% jitter
  });

  it('doubles each time', () => {
    const d2 = getBackoffDelayMs(2);
    expect(d2).toBeGreaterThanOrEqual(4000);
    expect(d2).toBeLessThanOrEqual(4800);

    const d3 = getBackoffDelayMs(3);
    expect(d3).toBeGreaterThanOrEqual(8000);
    expect(d3).toBeLessThanOrEqual(9600);
  });

  it('caps at 30s', () => {
    const d10 = getBackoffDelayMs(10);
    expect(d10).toBeLessThanOrEqual(36000); // 30000 + 20% jitter
    expect(d10).toBeGreaterThanOrEqual(30000);
  });
});

// ═══════════════════════════════════════
// getModelContextLimit
// ═══════════════════════════════════════

describe('getModelContextLimit', () => {
  it('returns known limits for exact matches', () => {
    expect(getModelContextLimit('gpt-4o')).toBe(128_000);
    expect(getModelContextLimit('gpt-4')).toBe(8_192);
    expect(getModelContextLimit('claude-3-5-sonnet')).toBe(200_000);
    expect(getModelContextLimit('deepseek-chat')).toBe(64_000);
  });

  it('matches model prefixes', () => {
    expect(getModelContextLimit('gpt-4o-2024-08-06')).toBe(128_000);
    expect(getModelContextLimit('claude-3-5-sonnet-20241022')).toBe(200_000);
  });

  it('returns default for unknown models', () => {
    expect(getModelContextLimit('llama-3.1-70b')).toBe(32_000);
    expect(getModelContextLimit('unknown-model')).toBe(32_000);
  });
});

// ═══════════════════════════════════════
// checkContextBudget
// ═══════════════════════════════════════

describe('checkContextBudget', () => {
  it('returns ok when usage < 50%', () => {
    const result = checkContextBudget(10_000, 'gpt-4o');
    expect(result.status).toBe('ok');
    expect(result.limit).toBe(128_000);
    expect(result.headroom).toBe(118_000);
  });

  it('returns warning when usage 50-75%', () => {
    const result = checkContextBudget(80_000, 'gpt-4o'); // 80k/128k ≈ 62.5%
    expect(result.status).toBe('warning');
  });

  it('returns critical when usage 75-90%', () => {
    const result = checkContextBudget(105_000, 'gpt-4o'); // 105k/128k ≈ 82%
    expect(result.status).toBe('critical');
  });

  it('returns overflow when usage > 90%', () => {
    const result = checkContextBudget(120_000, 'gpt-4o'); // 120k/128k ≈ 93.8%
    expect(result.status).toBe('overflow');
  });

  it('calculates ratio correctly', () => {
    const result = checkContextBudget(64_000, 'gpt-4o');
    expect(result.ratio).toBeCloseTo(0.5, 1);
  });
});

// ═══════════════════════════════════════
// suggestModelDowngrade
// ═══════════════════════════════════════

describe('suggestModelDowngrade', () => {
  it('returns null for fewer than 3 errors', () => {
    expect(suggestModelDowngrade(1, 'strong')).toBeNull();
    expect(suggestModelDowngrade(2, 'strong')).toBeNull();
  });

  it('downgrades strong → worker at 3+ errors', () => {
    expect(suggestModelDowngrade(3, 'strong')).toBe('worker');
    expect(suggestModelDowngrade(5, 'strong')).toBe('worker');
  });

  it('downgrades worker → mini at 5+ errors', () => {
    expect(suggestModelDowngrade(5, 'worker')).toBe('mini');
  });

  it('returns null when already mini', () => {
    expect(suggestModelDowngrade(10, 'mini')).toBeNull();
  });

  it('returns null for worker with <5 errors', () => {
    expect(suggestModelDowngrade(3, 'worker')).toBeNull();
    expect(suggestModelDowngrade(4, 'worker')).toBeNull();
  });
});

// ═══════════════════════════════════════
// buildRecoveryHint
// ═══════════════════════════════════════

describe('buildRecoveryHint', () => {
  it('returns empty string for first failure', () => {
    expect(buildRecoveryHint('read_file', 1, 'err')).toBe('');
  });

  it('suggests checking params at 2 failures', () => {
    const hint = buildRecoveryHint('read_file', 2, 'not found');
    expect(hint).toContain('第 2 次失败');
    expect(hint).toContain('替代方案');
  });

  it('strongly advises switching at 3+ failures', () => {
    const hint = buildRecoveryHint('web_search', 3, 'timeout error');
    expect(hint).toContain('连续失败 3 次');
    expect(hint).toContain('不要继续重试');
  });

  it('truncates long error messages', () => {
    const longErr = 'x'.repeat(500);
    const hint = buildRecoveryHint('tool', 3, longErr);
    expect(hint.length).toBeLessThan(longErr.length);
  });
});

// ═══════════════════════════════════════
// compressToolOutputs
// ═══════════════════════════════════════

describe('compressToolOutputs', () => {
  function makeMsgs(count: number, contentLen: number = 1000) {
    return [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: count }, (_, i) => {
        if (i % 3 === 0) return { role: 'assistant', content: 'a'.repeat(contentLen), tool_calls: [{}] };
        if (i % 3 === 1) return { role: 'tool', content: 'b'.repeat(contentLen) };
        return { role: 'user', content: 'u'.repeat(contentLen) };
      }),
    ];
  }

  it('compresses tool outputs at warning level (500 chars)', () => {
    const msgs = makeMsgs(20, 2000);
    const { compressedCount, estimatedSaved } = compressToolOutputs(msgs, 'warning', 4);
    expect(compressedCount).toBeGreaterThan(0);
    expect(estimatedSaved).toBeGreaterThan(0);
    // Check that old tool messages are truncated
    const toolMsg = msgs.find((m, i) => m.role === 'tool' && i < msgs.length - 4);
    if (toolMsg && typeof toolMsg.content === 'string') {
      expect(toolMsg.content.length).toBeLessThanOrEqual(600); // 500 + truncation notice
    }
  });

  it('compresses more aggressively at critical level (200 chars)', () => {
    const msgs = makeMsgs(20, 2000);
    const { compressedCount } = compressToolOutputs(msgs, 'critical', 4);
    expect(compressedCount).toBeGreaterThan(0);
    const toolMsg = msgs.find((m, i) => m.role === 'tool' && i < msgs.length - 4);
    if (toolMsg && typeof toolMsg.content === 'string') {
      expect(toolMsg.content.length).toBeLessThanOrEqual(300);
    }
  });

  it('removes oldest tool rounds at overflow level', () => {
    const msgs = makeMsgs(30, 2000);
    const origLen = msgs.length;
    compressToolOutputs(msgs, 'overflow', 4);
    expect(msgs.length).toBeLessThan(origLen);
  });

  it('preserves recent messages', () => {
    const msgs = makeMsgs(20, 2000);
    const lastContent = msgs[msgs.length - 1].content;
    compressToolOutputs(msgs, 'critical', 4);
    expect(msgs[msgs.length - 1].content).toBe(lastContent);
  });

  it('preserves system message', () => {
    const msgs = makeMsgs(20, 2000);
    compressToolOutputs(msgs, 'overflow', 4);
    expect(msgs[0].content).toBe('system prompt');
  });
});
