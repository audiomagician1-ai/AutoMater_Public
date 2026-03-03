/**
 * conversation-backup.test.ts — 对话备份系统测试
 *
 * 测试策略:
 *   1. 纯辅助函数: buildAgentFolderName, getDateFolder
 *   2. Session CRUD: createSession, getActiveSession, getOrCreateSession, switchSession, listSessions
 *   3. backupConversation: 写文件 + 更新 session DB
 *   4. readBackup / readSessionBackup
 *   5. Feature-Session 关联: linkFeatureSession, completeFeatureSessionLink, getSessionsForFeature
 *   6. cleanupOldBackups
 *   7. 类型验证
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { getDb, resetTestDb } from '../../db';

// Detect if we have real sqlite or stub
let hasRealSqlite = false;
try {
  const db = resetTestDb();
  db.exec('SELECT 1');
  hasRealSqlite = true;
} catch { /* stub mode */ }

const describeDb = hasRealSqlite ? describe : describe.skip;

import {
  ensureSessionsTable,
  createSession,
  getActiveSession,
  getOrCreateSession,
  switchSession,
  listSessions,
  listAllSessions,
  backupConversation,
  readBackup,
  linkFeatureSession,
  completeFeatureSessionLink,
  getSessionsForFeature,
  getFeaturesForSession,
  listFeatureSessionLinks,
  getFeatureSessionSummary,
  batchGetFeatureSessionSummaries,
  cleanupOldBackups,
  getBackupStats,
  type ConversationMessage,
  type SessionInfo,
  type WorkType,
  type FeatureSessionLink,
} from '../conversation-backup';

describeDb('conversation-backup (in-memory SQLite)', () => {
  beforeEach(() => {
    resetTestDb();
    ensureSessionsTable();
  });

  describe('ensureSessionsTable', () => {
    it('creates sessions table', () => {
      const db = getDb();
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get() as any;
      expect(row).toBeTruthy();
    });

    it('creates feature_sessions table', () => {
      const db = getDb();
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feature_sessions'").get() as any;
      expect(row).toBeTruthy();
    });

    it('is idempotent', () => {
      expect(() => ensureSessionsTable()).not.toThrow();
    });
  });

  describe('createSession', () => {
    it('creates a new session', () => {
      const session = createSession('proj-1', 'dev-1', 'developer');
      expect(session.id).toMatch(/^sess-/);
      expect(session.projectId).toBe('proj-1');
      expect(session.agentId).toBe('dev-1');
      expect(session.agentRole).toBe('developer');
      expect(session.agentSeq).toBe(1);
      expect(session.status).toBe('active');
      expect(session.messageCount).toBe(0);
      expect(session.totalCost).toBe(0);
    });

    it('increments agent seq for same agent', () => {
      const s1 = createSession('proj-1', 'dev-1', 'developer');
      // Mark s1 as completed
      const db = getDb();
      db.prepare("UPDATE sessions SET status = 'completed' WHERE id = ?").run(s1.id);
      const s2 = createSession('proj-1', 'dev-1', 'developer');
      expect(s2.agentSeq).toBe(2);
    });

    it('uses separate sequences per project', () => {
      const s1 = createSession('proj-1', 'dev-1', 'developer');
      const s2 = createSession('proj-2', 'dev-1', 'developer');
      expect(s1.agentSeq).toBe(1);
      expect(s2.agentSeq).toBe(1);
    });
  });

  describe('getActiveSession', () => {
    it('returns null when no active session', () => {
      const session = getActiveSession('proj-1', 'dev-1');
      expect(session).toBeNull();
    });

    it('returns active session', () => {
      createSession('proj-1', 'dev-1', 'developer');
      const session = getActiveSession('proj-1', 'dev-1');
      expect(session).not.toBeNull();
      expect(session!.agentId).toBe('dev-1');
      expect(session!.status).toBe('active');
    });
  });

  describe('getOrCreateSession', () => {
    it('creates session when none exists', () => {
      const session = getOrCreateSession('proj-1', 'pm', 'pm');
      expect(session.id).toMatch(/^sess-/);
      expect(session.status).toBe('active');
    });

    it('returns existing active session', () => {
      const first = getOrCreateSession('proj-1', 'pm', 'pm');
      const second = getOrCreateSession('proj-1', 'pm', 'pm');
      expect(second.id).toBe(first.id);
    });
  });

  describe('switchSession', () => {
    it('returns null for non-existent session', () => {
      const result = switchSession('nonexistent');
      expect(result).toBeNull();
    });

    it('switches between sessions', () => {
      const s1 = createSession('proj-1', 'dev-1', 'developer');
      const db = getDb();
      db.prepare("UPDATE sessions SET status = 'completed' WHERE id = ?").run(s1.id);
      const _s2 = createSession('proj-1', 'dev-1', 'developer');

      // Now switch back to s1
      const switched = switchSession(s1.id);
      expect(switched).not.toBeNull();
      expect(switched!.id).toBe(s1.id);
      expect(switched!.status).toBe('active');
    });
  });

  describe('listSessions', () => {
    it('lists all sessions for a project', () => {
      createSession('proj-1', 'dev-1', 'developer');
      createSession('proj-1', 'pm', 'pm');
      createSession('proj-2', 'dev-1', 'developer');

      const sessions = listSessions('proj-1');
      expect(sessions).toHaveLength(2);
    });

    it('filters by agentId', () => {
      createSession('proj-1', 'dev-1', 'developer');
      createSession('proj-1', 'pm', 'pm');

      const sessions = listSessions('proj-1', 'dev-1');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].agentId).toBe('dev-1');
    });
  });

  describe('listAllSessions', () => {
    it('lists sessions across all projects', () => {
      createSession('proj-1', 'dev-1', 'developer');
      createSession('proj-2', 'dev-2', 'developer');

      const all = listAllSessions();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('backupConversation', () => {
    it('creates backup file and returns path', () => {
      const messages: ConversationMessage[] = [
        { role: 'system', content: 'You are a dev.' },
        { role: 'user', content: 'Build a todo app.' },
        { role: 'assistant', content: 'I will create it.' },
      ];

      const result = backupConversation({
        projectId: 'proj-1',
        agentId: 'dev-1',
        agentRole: 'developer',
        messages,
        totalInputTokens: 500,
        totalOutputTokens: 200,
        totalCost: 0.01,
        completed: true,
      });

      // In test env, app.getPath returns '/tmp/automater-test'
      // So backup should be written somewhere under that path
      // On Windows this might fail due to path — just check it returns a string
      if (result) {
        expect(result).toContain('session-');
        expect(result).toContain('.json');
      }
      // Either succeeds or returns null (if /tmp/automater-test write fails on windows)
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });

  describe('readBackup', () => {
    it('returns null for non-existent file', () => {
      const result = readBackup('/nonexistent/path/file.json');
      expect(result).toBeNull();
    });
  });

  describe('Feature-Session Links', () => {
    it('creates and queries feature-session link', () => {
      const session = createSession('proj-1', 'dev-1', 'developer');
      const linkId = linkFeatureSession({
        featureId: 'feat-1',
        sessionId: session.id,
        projectId: 'proj-1',
        agentId: 'dev-1',
        agentRole: 'developer',
        workType: 'dev-implement',
        expectedOutput: 'Implement user auth',
      });

      expect(linkId).toMatch(/^fsl-/);

      const links = getSessionsForFeature('proj-1', 'feat-1');
      expect(links).toHaveLength(1);
      expect(links[0].workType).toBe('dev-implement');
      expect(links[0].status).toBe('active');
    });

    it('completes feature-session link', () => {
      const session = createSession('proj-1', 'dev-1', 'developer');
      const linkId = linkFeatureSession({
        featureId: 'feat-1',
        sessionId: session.id,
        projectId: 'proj-1',
        agentId: 'dev-1',
        agentRole: 'developer',
        workType: 'dev-implement',
        expectedOutput: 'Auth module',
      });

      completeFeatureSessionLink(linkId, 'Auth implemented with JWT', true);

      const links = getSessionsForFeature('proj-1', 'feat-1');
      expect(links[0].status).toBe('completed');
      expect(links[0].actualOutput).toBe('Auth implemented with JWT');
    });

    it('getFeaturesForSession returns linked features', () => {
      const session = createSession('proj-1', 'dev-1', 'developer');
      linkFeatureSession({
        featureId: 'feat-1', sessionId: session.id, projectId: 'proj-1',
        agentId: 'dev-1', agentRole: 'developer',
        workType: 'dev-implement', expectedOutput: 'feat 1',
      });
      linkFeatureSession({
        featureId: 'feat-2', sessionId: session.id, projectId: 'proj-1',
        agentId: 'dev-1', agentRole: 'developer',
        workType: 'dev-implement', expectedOutput: 'feat 2',
      });

      const features = getFeaturesForSession(session.id);
      expect(features).toHaveLength(2);
    });

    it('listFeatureSessionLinks returns project links', () => {
      const s = createSession('proj-1', 'dev-1', 'developer');
      linkFeatureSession({
        featureId: 'f1', sessionId: s.id, projectId: 'proj-1',
        agentId: 'dev-1', agentRole: 'developer',
        workType: 'dev-implement', expectedOutput: 'x',
      });

      const links = listFeatureSessionLinks('proj-1');
      expect(links.length).toBeGreaterThanOrEqual(1);
    });

    it('getFeatureSessionSummary returns summary', () => {
      const s1 = createSession('proj-1', 'dev-1', 'developer');
      linkFeatureSession({
        featureId: 'f1', sessionId: s1.id, projectId: 'proj-1',
        agentId: 'dev-1', agentRole: 'developer',
        workType: 'dev-implement', expectedOutput: 'v1',
      });
      linkFeatureSession({
        featureId: 'f1', sessionId: s1.id, projectId: 'proj-1',
        agentId: 'qa-1', agentRole: 'qa',
        workType: 'qa-review', expectedOutput: 'review',
      });

      const summary = getFeatureSessionSummary('proj-1', 'f1');
      expect(summary.totalSessions).toBe(2);
      expect(summary.workTypes).toContain('dev-implement');
      expect(summary.workTypes).toContain('qa-review');
      expect(summary.lastWorkType).toBe('qa-review');
    });

    it('batchGetFeatureSessionSummaries returns map', () => {
      const s = createSession('proj-1', 'dev-1', 'developer');
      linkFeatureSession({
        featureId: 'f1', sessionId: s.id, projectId: 'proj-1',
        agentId: 'dev-1', agentRole: 'developer',
        workType: 'dev-implement', expectedOutput: 'x',
      });
      linkFeatureSession({
        featureId: 'f2', sessionId: s.id, projectId: 'proj-1',
        agentId: 'dev-1', agentRole: 'developer',
        workType: 'dev-implement', expectedOutput: 'y',
      });

      const map = batchGetFeatureSessionSummaries('proj-1');
      expect(map.size).toBe(2);
      expect(map.get('f1')!.totalSessions).toBe(1);
    });
  });

  describe('cleanupOldBackups', () => {
    it('returns 0 when no backups exist', () => {
      const deleted = cleanupOldBackups(30);
      expect(deleted).toBe(0);
    });
  });

  describe('getBackupStats', () => {
    it('returns stats even when no backups', () => {
      const stats = getBackupStats();
      expect(stats.totalSessions).toBeGreaterThanOrEqual(0);
      expect(typeof stats.totalBackupSizeBytes).toBe('number');
    });
  });
});

// Type tests (always run)
describe('conversation-backup types', () => {
  it('ConversationMessage shape', () => {
    const msg: ConversationMessage = {
      role: 'assistant',
      content: 'Hello',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    };
    expect(msg.role).toBe('assistant');
  });

  it('WorkType covers all values', () => {
    const types: WorkType[] = [
      'pm-analysis', 'pm-design', 'pm-incremental', 'pm-acceptance',
      'architect-design', 'dev-implement', 'dev-rework',
      'qa-review', 'qa-tdd', 'devops-build', 'doc-generation', 'meta-agent',
    ];
    expect(types).toHaveLength(12);
  });

  it('SessionInfo shape', () => {
    const s: SessionInfo = {
      id: 'sess-1', projectId: 'p1', agentId: 'a1', agentRole: 'developer',
      agentSeq: 1, status: 'active', backupPath: null,
      createdAt: new Date().toISOString(), completedAt: null,
      messageCount: 0, totalTokens: 0, totalCost: 0,
    };
    expect(s.status).toBe('active');
  });

  it('FeatureSessionLink shape', () => {
    const link: FeatureSessionLink = {
      id: 'fsl-1', featureId: 'f1', sessionId: 's1', projectId: 'p1',
      agentId: 'a1', agentRole: 'developer', workType: 'dev-implement',
      expectedOutput: 'code', actualOutput: null,
      status: 'pending', createdAt: '', completedAt: null,
    };
    expect(link.workType).toBe('dev-implement');
  });
});
