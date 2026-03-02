/**
 * Tests for event-store.ts — 事件存储 (SQLite)
 *
 * Uses __mocks__/db.ts which provides in-memory better-sqlite3.
 * If native module unavailable, tests are skipped gracefully.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, resetTestDb } from '../../db';

// Check if real SQLite is available
let sqliteAvailable = false;
try {
  const db = resetTestDb();
  db.exec('SELECT 1');
  // Check if this is the real DB or stub (stub.exec returns undefined but doesn't throw)
  const result = db.prepare('SELECT 1 as v').get();
  sqliteAvailable = result?.v === 1;
} catch {
  sqliteAvailable = false;
}

// Import event-store functions (they use getDb internally)
import {
  ensureEventTable,
  emitEvent,
  emitEvents,
  queryEvents,
  getFeatureTimeline,
  getRecentEvents,
  getProjectEventStats,
  exportEventsNDJSON,
  type AgentEvent,
} from '../event-store';

describe.skipIf(!sqliteAvailable)('event-store (SQLite)', () => {
  beforeEach(() => {
    resetTestDb();
    ensureEventTable();
  });

  // ── Write ──

  it('ensureEventTable creates events table', () => {
    const db = getDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get() as any;
    expect(row?.name).toBe('events');
  });

  it('emitEvent inserts and returns rowid', () => {
    const id = emitEvent({
      projectId: 'P1',
      agentId: 'A1',
      featureId: 'F1',
      type: 'tool:call',
      data: { tool: 'read_file', path: 'src/main.ts' },
      durationMs: 42,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
    });
    expect(id).toBeGreaterThan(0);
  });

  it('emitEvent handles missing optional fields', () => {
    const id = emitEvent({
      projectId: 'P1',
      agentId: 'A1',
      type: 'react:iteration',
      data: {},
    });
    expect(id).toBeGreaterThan(0);
  });

  it('emitEvents batch inserts', () => {
    const events: AgentEvent[] = Array.from({ length: 10 }, (_, i) => ({
      projectId: 'P1',
      agentId: 'A1',
      featureId: 'F1',
      type: 'tool:call',
      data: { index: i },
    }));
    emitEvents(events);
    const all = queryEvents({ projectId: 'P1' });
    expect(all.length).toBe(10);
  });

  // ── Query ──

  it('queryEvents returns events matching projectId', () => {
    emitEvent({ projectId: 'P1', agentId: 'A1', type: 'tool:call', data: {} });
    emitEvent({ projectId: 'P2', agentId: 'A1', type: 'tool:call', data: {} });
    const results = queryEvents({ projectId: 'P1' });
    expect(results.length).toBe(1);
    expect(results[0].projectId).toBe('P1');
  });

  it('queryEvents filters by featureId', () => {
    emitEvent({ projectId: 'P1', agentId: 'A1', featureId: 'F1', type: 'tool:call', data: {} });
    emitEvent({ projectId: 'P1', agentId: 'A1', featureId: 'F2', type: 'tool:call', data: {} });
    const results = queryEvents({ projectId: 'P1', featureId: 'F1' });
    expect(results.length).toBe(1);
  });

  it('queryEvents filters by type', () => {
    emitEvent({ projectId: 'P1', agentId: 'A1', type: 'tool:call', data: {} });
    emitEvent({ projectId: 'P1', agentId: 'A1', type: 'llm:call', data: {} });
    emitEvent({ projectId: 'P1', agentId: 'A1', type: 'tool:result', data: {} });
    const results = queryEvents({ projectId: 'P1', types: ['tool:call', 'tool:result'] });
    expect(results.length).toBe(2);
  });

  it('queryEvents respects limit and offset', () => {
    for (let i = 0; i < 20; i++) {
      emitEvent({ projectId: 'P1', agentId: 'A1', type: 'tool:call', data: { i } });
    }
    const page1 = queryEvents({ projectId: 'P1', limit: 5, offset: 0 });
    expect(page1.length).toBe(5);
    const page2 = queryEvents({ projectId: 'P1', limit: 5, offset: 5 });
    expect(page2.length).toBe(5);
    expect(page2[0].data.i).toBe(5);
  });

  it('queryEvents parses data JSON correctly', () => {
    emitEvent({
      projectId: 'P1', agentId: 'A1', type: 'tool:call',
      data: { tool: 'write_file', path: 'test.ts', nested: { key: 'value' } },
    });
    const results = queryEvents({ projectId: 'P1' });
    expect(results[0].data.tool).toBe('write_file');
    expect(results[0].data.nested.key).toBe('value');
  });

  // ── Convenience ──

  it('getFeatureTimeline returns events for a feature', () => {
    emitEvent({ projectId: 'P1', agentId: 'A1', featureId: 'F1', type: 'feature:locked', data: {} });
    emitEvent({ projectId: 'P1', agentId: 'A1', featureId: 'F1', type: 'tool:call', data: {} });
    emitEvent({ projectId: 'P1', agentId: 'A1', featureId: 'F1', type: 'feature:passed', data: {} });
    const timeline = getFeatureTimeline('P1', 'F1');
    expect(timeline.length).toBe(3);
    // Ordered by id ASC
    expect(timeline[0].type).toBe('feature:locked');
    expect(timeline[2].type).toBe('feature:passed');
  });

  it('getRecentEvents returns events in chronological order', () => {
    for (let i = 0; i < 5; i++) {
      emitEvent({ projectId: 'P1', agentId: 'A1', type: 'react:iteration', data: { i } });
    }
    const recent = getRecentEvents('P1', 3);
    expect(recent.length).toBe(3);
    // Should be chronological (oldest first after reverse)
    expect(recent[0].data.i).toBe(2);
    expect(recent[2].data.i).toBe(4);
  });

  // ── Aggregation ──

  it('getProjectEventStats aggregates correctly', () => {
    emitEvent({ projectId: 'P1', agentId: 'A1', featureId: 'F1', type: 'tool:call', data: { tool: 'read_file', success: 1 }, durationMs: 10, inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
    emitEvent({ projectId: 'P1', agentId: 'A1', featureId: 'F1', type: 'tool:call', data: { tool: 'read_file', success: 1 }, durationMs: 20, inputTokens: 200, outputTokens: 100, costUsd: 0.02 });
    emitEvent({ projectId: 'P1', agentId: 'A1', featureId: 'F1', type: 'llm:call', data: {}, durationMs: 500, inputTokens: 1000, outputTokens: 500, costUsd: 0.1 });
    emitEvent({ projectId: 'P1', agentId: 'A1', featureId: 'F2', type: 'tool:call', data: { tool: 'write_file', success: 1 }, durationMs: 5 });

    const stats = getProjectEventStats('P1');
    expect(stats.totalEvents).toBe(4);
    expect(stats.totalDurationMs).toBe(535);
    expect(stats.totalInputTokens).toBe(1300);
    expect(stats.totalOutputTokens).toBe(650);
    expect(stats.totalCostUsd).toBeCloseTo(0.13);
    expect(stats.eventsByType['tool:call']).toBe(3);
    expect(stats.eventsByType['llm:call']).toBe(1);
    expect(stats.featureStats.length).toBe(2);
    expect(stats.featureStats.find(f => f.featureId === 'F1')?.toolCalls).toBe(2);
    expect(stats.featureStats.find(f => f.featureId === 'F1')?.llmCalls).toBe(1);
  });

  // ── Export ──

  it('exportEventsNDJSON produces valid NDJSON', () => {
    emitEvent({ projectId: 'P1', agentId: 'A1', type: 'tool:call', data: { foo: 'bar' } });
    emitEvent({ projectId: 'P1', agentId: 'A1', type: 'llm:result', data: { tokens: 42 } });
    const ndjson = exportEventsNDJSON('P1');
    const lines = ndjson.split('\n').filter(l => l.trim());
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.projectId).toBe('P1');
    }
  });
});

describe.skipIf(sqliteAvailable)('event-store (stub fallback)', () => {
  it('emitEvent returns -1 with stub', () => {
    const id = emitEvent({ projectId: 'P1', agentId: 'A1', type: 'tool:call', data: {} });
    expect(id).toBe(-1);
  });
});
