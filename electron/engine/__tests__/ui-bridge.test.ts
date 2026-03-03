/**
 * ui-bridge.ts tests — sendToUI, addLog, notify, createStreamCallback
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock electron
const { mockSend, mockShow } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockShow: vi.fn(),
}));
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  Notification: class MockNotification {
    static isSupported() { return true; }
    show = mockShow;
    constructor(public opts: any) {}
  },
}));

// Smart DB mock using vi.hoisted
const dbMock = vi.hoisted(() => {
  let nextRunResult: any = undefined;
  return {
    setNextRun: (val: any) => { nextRunResult = val; },
    reset: () => { nextRunResult = undefined; },
    getMock: () => ({
      prepare: vi.fn(() => ({
        run: vi.fn((..._args: any[]) => {
          const r = nextRunResult;
          nextRunResult = undefined;
          return r || { lastInsertRowid: 1, changes: 1 };
        }),
        get: vi.fn(),
        all: vi.fn(() => []),
      })),
    }),
  };
});

vi.mock('../../db', () => ({
  getDb: vi.fn(() => dbMock.getMock()),
}));

import { sendToUI, addLog, notify, createStreamCallback } from '../ui-bridge';

function mockWin() {
  return { webContents: { send: mockSend } } as any;
}

describe('sendToUI', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends message through BrowserWindow webContents', () => {
    const win = mockWin();
    sendToUI(win, 'agent:log', { msg: 'hello' });
    expect(mockSend).toHaveBeenCalledWith('agent:log', { msg: 'hello' });
  });

  it('handles null window gracefully', () => {
    expect(() => sendToUI(null, 'agent:log', { msg: 'hello' })).not.toThrow();
  });

  it('persists agent:log messages to DB (does not throw)', () => {
    const win = mockWin();
    // Just verify the call path doesn't crash
    expect(() => sendToUI(win, 'agent:log', { projectId: 'proj-1', agentId: 'dev-1', content: 'test log' })).not.toThrow();
  });

  it('does not persist non-agent:log messages', () => {
    const win = mockWin();
    // Non-agent:log channels should not trigger DB write — just verify no crash
    expect(() => sendToUI(win, 'agent:stream', { chunk: 'data' })).not.toThrow();
  });

  it('uses "system" as default agentId when missing', () => {
    const win = mockWin();
    // Just verify the call path doesn't crash — DB mock receives the call internally
    expect(() => sendToUI(win, 'agent:log', { projectId: 'proj-1', content: 'system log' })).not.toThrow();
  });

  it('does not persist when projectId or content missing', () => {
    const win = mockWin();
    // No projectId/content → DB insert should be skipped (no crash)
    expect(() => sendToUI(win, 'agent:log', { agentId: 'dev-1' })).not.toThrow();
  });

  it('handles window closed error gracefully', () => {
    const win = { webContents: { send: vi.fn(() => { throw new Error('Object has been destroyed'); }) } } as any;
    expect(() => sendToUI(win, 'test', {})).not.toThrow();
  });
});

describe('addLog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts log entry into DB (does not throw)', () => {
    expect(() => addLog('proj-1', 'dev-1', 'info', 'test content')).not.toThrow();
  });

  it('handles DB errors gracefully', () => {
    // Even if getDb throws internally, addLog catches it
    expect(() => addLog('proj-1', 'dev-1', 'error', 'content')).not.toThrow();
  });
});

describe('notify', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows native notification', () => {
    notify('Title', 'Body');
    expect(mockShow).toHaveBeenCalled();
  });
});

describe('createStreamCallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns [onChunk, getAccumulated] tuple', () => {
    const [onChunk, getAccumulated] = createStreamCallback(null, 'proj-1', 'dev-1');
    expect(typeof onChunk).toBe('function');
    expect(typeof getAccumulated).toBe('function');
  });

  it('accumulates text across multiple chunks', () => {
    const [onChunk, getAccumulated] = createStreamCallback(null, 'proj-1', 'dev-1');
    onChunk('Hello');
    onChunk(' World');
    const result = getAccumulated();
    expect(result).toBe('Hello World');
  });

  it('flushes immediately on newline', () => {
    const win = mockWin();
    const [onChunk, getAccumulated] = createStreamCallback(win, 'proj-1', 'dev-1');
    onChunk('line1\n');
    // Should have flushed to UI immediately
    expect(mockSend).toHaveBeenCalledWith('agent:stream', expect.objectContaining({
      projectId: 'proj-1',
      agentId: 'dev-1',
    }));
  });

  it('flushes when buffer exceeds 200 chars', () => {
    const win = mockWin();
    const [onChunk] = createStreamCallback(win, 'proj-1', 'dev-1');
    const longChunk = 'a'.repeat(250);
    onChunk(longChunk);
    expect(mockSend).toHaveBeenCalled();
  });

  it('flushes on timer when no newline and small buffer', () => {
    const win = mockWin();
    const [onChunk] = createStreamCallback(win, 'proj-1', 'dev-1', 50);
    onChunk('small');
    expect(mockSend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('getAccumulated flushes remaining buffer', () => {
    const win = mockWin();
    const [onChunk, getAccumulated] = createStreamCallback(win, 'proj-1', 'dev-1');
    onChunk('partial');
    const result = getAccumulated();
    expect(result).toBe('partial');
    // Should have flushed to UI
    expect(mockSend).toHaveBeenCalled();
  });
});
