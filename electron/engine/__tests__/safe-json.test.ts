import { describe, it, expect, vi } from 'vitest';
import { safeJsonParse, safeParseToolArgs } from '../safe-json';

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
    expect(safeJsonParse('[1,2,3]', [])).toEqual([1, 2, 3]);
    expect(safeJsonParse('"hello"', '')).toBe('hello');
    expect(safeJsonParse('42', 0)).toBe(42);
    expect(safeJsonParse('true', false)).toBe(true);
    expect(safeJsonParse('null', 'default')).toBeNull();
  });

  it('returns fallback for invalid JSON', () => {
    expect(safeJsonParse('{broken', {})).toEqual({});
    expect(safeJsonParse('', [])).toEqual([]);
    expect(safeJsonParse('undefined', 'fallback')).toBe('fallback');
    expect(safeJsonParse('not json at all', 42)).toBe(42);
  });

  it('returns fallback for empty/whitespace input', () => {
    expect(safeJsonParse('', 'default')).toBe('default');
    expect(safeJsonParse('   ', 'default')).toBe('default');
  });

  it('logs warning when label is provided and parse fails', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    safeJsonParse('broken', {}, 'test-label');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[safeJsonParse] test-label'),
      expect.any(String)
    );
    warnSpy.mockRestore();
  });

  it('does not log when label is omitted', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    safeJsonParse('broken', {});
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('truncates long invalid input in warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const longText = 'x'.repeat(500);
    safeJsonParse(longText, {}, 'truncate-test');
    const [, logged] = warnSpy.mock.calls[0];
    expect(logged.length).toBeLessThanOrEqual(200);
    warnSpy.mockRestore();
  });
});

describe('safeParseToolArgs', () => {
  it('returns object args as-is', () => {
    const args = { path: '/test', content: 'hello' };
    expect(safeParseToolArgs(args)).toBe(args);
  });

  it('parses valid JSON string args', () => {
    expect(safeParseToolArgs('{"path":"/test"}')).toEqual({ path: '/test' });
  });

  it('returns empty object for invalid JSON string', () => {
    expect(safeParseToolArgs('broken')).toEqual({});
  });

  it('returns empty object for empty string', () => {
    expect(safeParseToolArgs('')).toEqual({});
  });
});
