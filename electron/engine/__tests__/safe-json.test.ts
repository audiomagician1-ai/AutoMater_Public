import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { safeJsonParse, safeParseToolArgs } from '../safe-json';
import { setLogLevel } from '../logger';

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
    setLogLevel('warn'); // enable warn output in test env
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    safeJsonParse('broken', {}, 'test-label');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // logger formats: "HH:mm:ss.SSS WARN  [safe-json] test-label: invalid JSON, ..."
    expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining('test-label'));
    warnSpy.mockRestore();
    setLogLevel('error');
  });

  it('does not log when label is omitted', () => {
    setLogLevel('warn');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    safeJsonParse('broken', {});
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    setLogLevel('error');
  });

  it('truncates long invalid input in warning', () => {
    setLogLevel('warn');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const longText = 'x'.repeat(500);
    safeJsonParse(longText, {}, 'truncate-test');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // The preview is sliced to 200 chars in safe-json.ts
    const loggedLine = warnSpy.mock.calls[0][0] as string;
    expect(loggedLine).toEqual(expect.stringContaining('truncate-test'));
    warnSpy.mockRestore();
    setLogLevel('error');
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
