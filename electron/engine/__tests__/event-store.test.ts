/**
 * event-store.test.ts — 事件存储完整测试
 *
 * 测试策略: 使用 __mocks__/db.ts 的内存 SQLite
 *   1. ensureEventTable — 创建表结构
 *   2. emitEvent / emitEvents — 写入事件
 *   3. queryEvents — 多条件查询
 *   4. getFeatureTimeline / getRecentEvents
 *   5. getProjectEventStats — 聚合统计
 *   6. exportEventsNDJSON — 导出
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { getDb, resetTestDb } from '../../db';
import {
  ensureEventTable,
  emitEvent,
  emitEvents,
  queryEvents,
  getFeatureTimeline,
  getRecentEvents,
  getProjectEventStats,
  exportEventsNDJSON,
  resetEventStoreCache,
  type AgentEvent,
  type EventType,
} from '../event-store';

// Detect if we have real sqlite or stub
let hasRealSqlite = false;
try {
  const db = resetTestDb();
  db.exec('SELECT 1');
  hasRealSqlite = true;
} catch { /* stub mode */ }

const describeDb = hasRealSqlite ? describe : describe.skip;

describeDb('event-store (in-memory SQLite)', () => {
  beforeEach(() => {
    resetTestDb();
    resetEventStoreCache(); // Clear cached prepared statements after DB reset
    ensureEventTable();
  });

  describe('ensureEventTable', () => {
    it('creates events table without error', () => {
      // Table should already exist from beforeEach
      const db = getDb();
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get() as any;
      expect(row).toBeTruthy();
      expect(row.name).toBe('events');
    });

    it('is idempotent', () => {
      expect(() => ensureEventTable()).not.toThrow();
      expect(() => ensureEventTable()).not.toThrow();
    });
  });

  describe('emitEvent', () => {
    it('inserts event and returns rowid', () => {
      const id = emitEvent({
        projectId: 'proj-1',
        agentId: 'dev-1',
        type: 'tool:call',
        data: { tool: 'read_file', success: true },
      });
      expect(id).toBeGreaterThan(0);
    });

    it('inserts event with all optional fields', () => {
      const id = emitEvent({
        projectId: 'proj-1',
        agentId: 'dev-1',
        featureId: 'feat-1',
        type: 'llm:call',
        data: { model: 'gpt-4' },
        durationMs: 1500,
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.05,
      });
      expect(id).toBeGreaterThan(0);
    });

    it('handles null/undefined optional fields', () => {
      const id = emitEvent({
        projectId: 'proj-1',
        agentId: '',
        type: 'project:start',
        data: {},
      });
      expect(id).toBeGreaterThan(0);
    });
  });

  describe('emitEvents (batch)', () => {
    it('inserts multiple events in transaction', () => {
      const events: AgentEvent[] = [
        { projectId: 'proj-1', agentId: 'dev-1', type: 'tool:call', data: { tool: 'a' } },
        { projectId: 'proj-1', agentId: 'dev-1', type: 'tool:call', data: { tool: 'b' } },
        { projectId: 'proj-1', agentId: 'dev-2', type: 'tool:result', data: { ok: true } },
      ];
      expect(() => emitEvents(events)).not.toThrow();

      const all = queryEvents({ projectId: 'proj-1' });
      expect(all).toHaveLength(3);
    });
  });

  describe('queryEvents', () => {
    beforeEach(() => {
      // Seed data
      emitEvent({ projectId: 'proj-1', agentId: 'dev-1', featureId: 'feat-1', type: 'tool:call', data: { tool: 'read_file' } });
      emitEvent({ projectId: 'proj-1', agentId: 'dev-1', featureId: 'feat-1', type: 'tool:call', data: { tool: 'write_file' } });
      emitEvent({ projectId: 'proj-1', agentId: 'dev-2', featureId: 'feat-2', type: 'llm:call', data: { model: 'gpt-4' } });
      emitEvent({ projectId: 'proj-1', agentId: 'pm', type: 'phase:pm:start', data: {} });
      emitEvent({ projectId: 'proj-2', agentId: 'dev-1', type: 'tool:call', data: { tool: 'search' } });
    });

    it('filters by projectId', () => {
      const events = queryEvents({ projectId: 'proj-1' });
      expect(events).toHaveLength(4);
    });

    it('filters by featureId', () => {
      const events = queryEvents({ projectId: 'proj-1', featureId: 'feat-1' });
      expect(events).toHaveLength(2);
    });

    it('filters by agentId', () => {
      const events = queryEvents({ projectId: 'proj-1', agentId: 'dev-1' });
      expect(events).toHaveLength(2);
    });

    it('filters by event types', () => {
      const events = queryEvents({ projectId: 'proj-1', types: ['llm:call'] });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('llm:call');
    });

    it('filters by multiple types', () => {
      const events = queryEvents({ projectId: 'proj-1', types: ['tool:call', 'llm:call'] });
      expect(events).toHaveLength(3);
    });

    it('respects limit', () => {
      const events = queryEvents({ projectId: 'proj-1', limit: 2 });
      expect(events).toHaveLength(2);
    });

    it('respects offset', () => {
      const events = queryEvents({ projectId: 'proj-1', limit: 2, offset: 2 });
      expect(events).toHaveLength(2);
    });

    it('caps limit at 1000', () => {
      const events = queryEvents({ projectId: 'proj-1', limit: 5000 });
      // Should work (capped internally) — just verify no error
      expect(events.length).toBeLessThanOrEqual(1000);
    });

    it('returns events sorted by id ASC', () => {
      const events = queryEvents({ projectId: 'proj-1' });
      for (let i = 1; i < events.length; i++) {
        expect(events[i].id).toBeGreaterThan(events[i - 1].id);
      }
    });

    it('parses data JSON correctly', () => {
      const events = queryEvents({ projectId: 'proj-1', types: ['llm:call'] });
      expect(events[0].data).toEqual({ model: 'gpt-4' });
    });
  });

  describe('getFeatureTimeline', () => {
    it('returns all events for a feature', () => {
      emitEvent({ projectId: 'proj-1', agentId: 'dev-1', featureId: 'feat-x', type: 'feature:locked', data: {} });
      emitEvent({ projectId: 'proj-1', agentId: 'dev-1', featureId: 'feat-x', type: 'tool:call', data: { tool: 'a' } });
      emitEvent({ projectId: 'proj-1', agentId: 'dev-1', featureId: 'feat-x', type: 'feature:passed', data: {} });

      const timeline = getFeatureTimeline('proj-1', 'feat-x');
      expect(timeline).toHaveLength(3);
      expect(timeline[0].type).toBe('feature:locked');
      expect(timeline[2].type).toBe('feature:passed');
    });
  });

  describe('getRecentEvents', () => {
    it('returns events in chronological order', () => {
      emitEvent({ projectId: 'proj-r', agentId: 'a', type: 'project:start', data: {} });
      emitEvent({ projectId: 'proj-r', agentId: 'a', type: 'tool:call', data: {} });
      emitEvent({ projectId: 'proj-r', agentId: 'a', type: 'project:complete', data: {} });

      const recent = getRecentEvents('proj-r', 10);
      expect(recent).toHaveLength(3);
      // Should be in chronological order (oldest first)
      expect(recent[0].type).toBe('project:start');
      expect(recent[2].type).toBe('project:complete');
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        emitEvent({ projectId: 'proj-rl', agentId: 'a', type: 'tool:call', data: { i } });
      }
      const recent = getRecentEvents('proj-rl', 3);
      expect(recent).toHaveLength(3);
    });
  });

  describe('getProjectEventStats', () => {
    beforeEach(() => {
      emitEvent({ projectId: 'stats-proj', agentId: 'dev-1', featureId: 'f1', type: 'tool:call', data: { tool: 'read_file', success: true }, durationMs: 100, inputTokens: 500, outputTokens: 200, costUsd: 0.01 });
      emitEvent({ projectId: 'stats-proj', agentId: 'dev-1', featureId: 'f1', type: 'tool:call', data: { tool: 'write_file', success: true }, durationMs: 50, costUsd: 0.005 });
      emitEvent({ projectId: 'stats-proj', agentId: 'dev-1', featureId: 'f1', type: 'llm:call', data: { model: 'gpt-4' }, inputTokens: 1000, outputTokens: 500, costUsd: 0.03 });
      emitEvent({ projectId: 'stats-proj', agentId: 'dev-2', featureId: 'f2', type: 'tool:call', data: { tool: 'read_file', success: false }, durationMs: 200 });
    });

    it('returns correct total counts', () => {
      const stats = getProjectEventStats('stats-proj');
      expect(stats.totalEvents).toBe(4);
      expect(stats.totalInputTokens).toBe(1500);
      expect(stats.totalOutputTokens).toBe(700);
    });

    it('aggregates by event type', () => {
      const stats = getProjectEventStats('stats-proj');
      expect(stats.eventsByType['tool:call']).toBe(3);
      expect(stats.eventsByType['llm:call']).toBe(1);
    });

    it('aggregates by feature', () => {
      const stats = getProjectEventStats('stats-proj');
      expect(stats.featureStats.length).toBeGreaterThanOrEqual(1);
      const f1 = stats.featureStats.find(f => f.featureId === 'f1');
      expect(f1).toBeDefined();
      expect(f1?.events).toBe(3);
      expect(f1?.toolCalls).toBe(2);
      expect(f1?.llmCalls).toBe(1);
    });

    it('aggregates tool stats', () => {
      const stats = getProjectEventStats('stats-proj');
      expect(stats.toolStats.length).toBeGreaterThanOrEqual(1);
      const readFile = stats.toolStats.find(t => t.toolName === 'read_file');
      expect(readFile).toBeDefined();
      expect(readFile?.calls).toBe(2);
    });
  });

  describe('exportEventsNDJSON', () => {
    it('exports events as newline-delimited JSON', () => {
      emitEvent({ projectId: 'export-proj', agentId: 'a', type: 'project:start', data: { x: 1 } });
      emitEvent({ projectId: 'export-proj', agentId: 'a', type: 'project:complete', data: { x: 2 } });

      const ndjson = exportEventsNDJSON('export-proj');
      const lines = ndjson.split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);

      const first = JSON.parse(lines[0]);
      expect(first.projectId).toBe('export-proj');
      expect(first.type).toBe('project:start');
      expect(first.data.x).toBe(1);
    });

    it('returns empty string for project with no events', () => {
      const ndjson = exportEventsNDJSON('no-events');
      expect(ndjson).toBe('');
    });
  });
});

// Type tests (always run)
describe('event-store types', () => {
  it('EventType covers all expected values', () => {
    const types: EventType[] = [
      'project:start', 'project:stop', 'project:complete',
      'phase:pm:start', 'phase:pm:end', 'phase:dev:start', 'phase:dev:end',
      'feature:locked', 'feature:passed', 'feature:failed',
      'tool:call', 'tool:result', 'llm:call', 'llm:result',
      'error',
    ];
    expect(types).toHaveLength(15);
  });

  it('AgentEvent interface shape', () => {
    const event: AgentEvent = {
      projectId: 'p1',
      agentId: 'a1',
      type: 'tool:call',
      data: {},
    };
    expect(event.projectId).toBe('p1');
  });
});
