/**
 * Tests for doc-manager.ts — 文档管理 CRUD + 一致性检查
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

// Use real FS with temp dir (like other Layer 2 tests)
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docmgr-test-'));
});

import {
  readDoc,
  writeDoc,
  getDocVersion,
  getChangelog,
  listDocs,
  checkConsistency,
} from '../doc-manager';

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════
// writeDoc + readDoc
// ═══════════════════════════════════════

describe('writeDoc + readDoc', () => {
  // writeDoc signature: (workspacePath, type, content, agentId, summary, id?)
  it('writes and reads design doc', () => {
    writeDoc(tmpDir, 'design', '# Design\nOverview.', 'system', 'Initial design');
    const content = readDoc(tmpDir, 'design');
    expect(content).toContain('# Design');
    expect(content).toContain('Overview.');
  });

  it('writes and reads requirement doc', () => {
    writeDoc(tmpDir, 'requirement', '# REQ-001\nUser login', 'pm-agent', 'Add login req', 'REQ-001');
    const content = readDoc(tmpDir, 'requirement', 'REQ-001');
    expect(content).toContain('REQ-001');
    expect(content).toContain('User login');
  });

  it('writes and reads test spec doc', () => {
    writeDoc(tmpDir, 'test_spec', '# TEST-001\nLogin tests', 'qa-agent', 'Add test spec', 'TEST-001');
    const content = readDoc(tmpDir, 'test_spec', 'TEST-001');
    expect(content).toContain('Login tests');
  });

  it('returns null for non-existent doc', () => {
    expect(readDoc(tmpDir, 'design')).toBeNull();
    expect(readDoc(tmpDir, 'requirement', 'NONE')).toBeNull();
  });

  it('overwrites existing doc', () => {
    writeDoc(tmpDir, 'design', 'Version 1', 'agent', 'v1');
    writeDoc(tmpDir, 'design', 'Version 2', 'agent', 'v2');
    expect(readDoc(tmpDir, 'design')).toContain('Version 2');
  });
});

// ═══════════════════════════════════════
// getDocVersion
// ═══════════════════════════════════════

describe('getDocVersion', () => {
  it('returns 0 for non-existent doc', () => {
    expect(getDocVersion(tmpDir, 'design')).toBe(0);
  });

  it('increments version on each write', () => {
    writeDoc(tmpDir, 'design', 'v1', 'agent', 'first');
    expect(getDocVersion(tmpDir, 'design')).toBe(1);
    writeDoc(tmpDir, 'design', 'v2', 'agent', 'second');
    expect(getDocVersion(tmpDir, 'design')).toBe(2);
  });
});

// ═══════════════════════════════════════
// getChangelog
// ═══════════════════════════════════════

describe('getChangelog', () => {
  it('returns empty for fresh workspace', () => {
    expect(getChangelog(tmpDir)).toEqual([]);
  });

  it('records changes on write', () => {
    writeDoc(tmpDir, 'design', 'Content', 'agent', 'init design');
    writeDoc(tmpDir, 'requirement', 'REQ content', 'pm', 'add req', 'REQ-001');
    const log = getChangelog(tmpDir);
    expect(log.length).toBe(2);
    expect(log[0].type).toBe('design');
    expect(log[0].agentId).toBe('agent');
    expect(log[1].type).toBe('requirement');
    expect(log[1].id).toBe('REQ-001');
  });
});

// ═══════════════════════════════════════
// listDocs
// ═══════════════════════════════════════

describe('listDocs', () => {
  it('returns empty for fresh workspace', () => {
    expect(listDocs(tmpDir, 'requirement')).toEqual([]);
  });

  it('lists requirement docs', () => {
    writeDoc(tmpDir, 'requirement', 'R1', 'pm', 'req 1', 'REQ-001');
    writeDoc(tmpDir, 'requirement', 'R2', 'pm', 'req 2', 'REQ-002');
    const docs = listDocs(tmpDir, 'requirement');
    expect(docs.length).toBe(2);
    expect(docs.map(d => d.id).sort()).toEqual(['REQ-001', 'REQ-002']);
  });

  it('lists test spec docs', () => {
    writeDoc(tmpDir, 'test_spec', 'T1', 'qa', 'test 1', 'TEST-001');
    const docs = listDocs(tmpDir, 'test_spec');
    expect(docs.length).toBe(1);
    expect(docs[0].id).toBe('TEST-001');
  });
});

// ═══════════════════════════════════════
// checkConsistency
// ═══════════════════════════════════════

describe('checkConsistency', () => {
  it('reports ok when all docs exist', () => {
    writeDoc(tmpDir, 'design', '# Design with REQ-001', 'pm', 'design');
    writeDoc(tmpDir, 'requirement', '# REQ-001', 'pm', 'req', 'REQ-001');
    writeDoc(tmpDir, 'test_spec', '# TEST for REQ-001', 'qa', 'test', 'REQ-001');
    const report = checkConsistency(tmpDir, ['REQ-001']);
    expect(report.ok).toBe(true);
    expect(report.issues.length).toBe(0);
  });

  it('reports missing requirement doc as warning', () => {
    writeDoc(tmpDir, 'design', '# Design', 'pm', 'design');
    const report = checkConsistency(tmpDir, ['REQ-001']);
    // ok=true because missing req is only a warning, not error
    expect(report.ok).toBe(true);
    expect(report.issues.some(i => i.description.includes('REQ-001') && i.severity === 'warning')).toBe(true);
  });

  it('reports missing design doc as error', () => {
    const report = checkConsistency(tmpDir, ['REQ-001']);
    expect(report.ok).toBe(false);
    expect(report.issues.some(i => i.severity === 'error' && i.description.includes('设计文档'))).toBe(true);
  });

  it('reports missing test spec', () => {
    writeDoc(tmpDir, 'design', '# Design', 'pm', 'design');
    writeDoc(tmpDir, 'requirement', '# REQ-001', 'pm', 'req', 'REQ-001');
    const report = checkConsistency(tmpDir, ['REQ-001']);
    // Missing test spec should be a warning
    expect(report.issues.some(i => i.severity === 'warning')).toBe(true);
  });
});
