/**
 * Tests for feature-workpad.ts — per-Feature persistent progress (v31.0)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  loadWorkpad,
  workpadDevStart,
  workpadDevDone,
  workpadQAResult,
  workpadPaused,
  workpadResumed,
  workpadRecordDecision,
  workpadRecordIssue,
  formatWorkpadForPrompt,
  buildContinuationDirective,
  clearWorkpad,
  listWorkpads,
} from '../feature-workpad';

describe('feature-workpad', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wp-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════
  // Basic CRUD
  // ═══════════════════════════════════════

  it('loadWorkpad should return null for non-existent feature', () => {
    expect(loadWorkpad(tmpDir, 'F001')).toBeNull();
  });

  it('workpadDevStart should create workpad on first call', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 1);
    const pad = loadWorkpad(tmpDir, 'F001');
    expect(pad).not.toBeNull();
    expect(pad!.featureId).toBe('F001');
    expect(pad!.projectId).toBe('proj-1');
    expect(pad!.qaAttempt).toBe(1);
    expect(pad!.status).toBe('dev');
    expect(pad!.timeline).toHaveLength(1);
    expect(pad!.timeline[0].content).toContain('dev:start');
  });

  it('workpadDevStart with qaAttempt > 1 should set rework status', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 1);
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 2, 'Fix the button');
    const pad = loadWorkpad(tmpDir, 'F001');
    expect(pad!.qaAttempt).toBe(2);
    expect(pad!.status).toBe('rework');
    expect(pad!.lastQAFeedback).toBe('Fix the button');
    expect(pad!.timeline).toHaveLength(2);
  });

  // ═══════════════════════════════════════
  // Dev Done + QA Result
  // ═══════════════════════════════════════

  it('workpadDevDone should record files and cost', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 1);
    workpadDevDone(tmpDir, 'F001', ['src/a.ts', 'src/b.ts'], 15, 0.05);
    const pad = loadWorkpad(tmpDir, 'F001');
    expect(pad!.status).toBe('reviewing');
    expect(pad!.filesWritten).toEqual(['src/a.ts', 'src/b.ts']);
    expect(pad!.timeline.length).toBeGreaterThanOrEqual(2);
  });

  it('workpadDevDone should merge files across retries (deduplicate)', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 1);
    workpadDevDone(tmpDir, 'F001', ['src/a.ts'], 10, 0.02);
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 2, 'Fix A');
    workpadDevDone(tmpDir, 'F001', ['src/a.ts', 'src/c.ts'], 8, 0.03);
    const pad = loadWorkpad(tmpDir, 'F001');
    expect(pad!.filesWritten).toEqual(['src/a.ts', 'src/c.ts']);
  });

  it('workpadQAResult pass should set done status', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 1);
    workpadDevDone(tmpDir, 'F001', ['src/a.ts'], 5, 0.01);
    workpadQAResult(tmpDir, 'F001', 'pass', 92, 'All good');
    const pad = loadWorkpad(tmpDir, 'F001');
    expect(pad!.status).toBe('done');
    expect(pad!.lastQAScore).toBe(92);
  });

  it('workpadQAResult fail should set rework status', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 1);
    workpadDevDone(tmpDir, 'F001', ['src/a.ts'], 5, 0.01);
    workpadQAResult(tmpDir, 'F001', 'fail', 45, 'Missing error handling');
    const pad = loadWorkpad(tmpDir, 'F001');
    expect(pad!.status).toBe('rework');
    expect(pad!.lastQAScore).toBe(45);
    expect(pad!.lastQAFeedback).toBe('Missing error handling');
  });

  // ═══════════════════════════════════════
  // Pause/Resume
  // ═══════════════════════════════════════

  it('workpadPaused + workpadResumed should update status', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 1);
    workpadPaused(tmpDir, 'F001', 50, 'max_iterations');
    let pad = loadWorkpad(tmpDir, 'F001');
    expect(pad!.status).toBe('paused');

    workpadResumed(tmpDir, 'F001', 'dev-2');
    pad = loadWorkpad(tmpDir, 'F001');
    expect(pad!.status).toBe('dev'); // qaAttempt=1, so back to dev
  });

  // ═══════════════════════════════════════
  // Agent record functions
  // ═══════════════════════════════════════

  it('workpadRecordDecision should add to decisions list', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 1);
    workpadRecordDecision(tmpDir, 'F001', 'Use React instead of Vue');
    const pad = loadWorkpad(tmpDir, 'F001');
    expect(pad!.decisions).toContain('Use React instead of Vue');
  });

  it('workpadRecordIssue should add to knownIssues list', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 1);
    workpadRecordIssue(tmpDir, 'F001', 'CSS grid not supported in IE11');
    const pad = loadWorkpad(tmpDir, 'F001');
    expect(pad!.knownIssues).toContain('CSS grid not supported in IE11');
  });

  // ═══════════════════════════════════════
  // Context generation
  // ═══════════════════════════════════════

  it('formatWorkpadForPrompt should return null for non-existent feature', () => {
    expect(formatWorkpadForPrompt(tmpDir, 'F999')).toBeNull();
  });

  it('formatWorkpadForPrompt should return null for fresh feature', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 1);
    // Only 1 timeline entry, qaAttempt=1 → no useful context to inject
    expect(formatWorkpadForPrompt(tmpDir, 'F001')).toBeNull();
  });

  it('formatWorkpadForPrompt should return context for rework', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 1);
    workpadDevDone(tmpDir, 'F001', ['src/a.ts'], 10, 0.05);
    workpadQAResult(tmpDir, 'F001', 'fail', 50, 'Missing validation');
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 2, 'Missing validation');

    const context = formatWorkpadForPrompt(tmpDir, 'F001');
    expect(context).not.toBeNull();
    expect(context).toContain('Feature Workpad');
    expect(context).toContain('QA 反馈');
    expect(context).toContain('Missing validation');
    expect(context).toContain('src/a.ts');
  });

  it('buildContinuationDirective should return empty for first attempt', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 1);
    expect(buildContinuationDirective(tmpDir, 'F001', 1)).toBe('');
  });

  it('buildContinuationDirective should return rework directive for qaAttempt > 1', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 2, 'Fix bugs');
    const directive = buildContinuationDirective(tmpDir, 'F001', 2);
    expect(directive).toContain('第 2 次 QA 尝试');
    expect(directive).toContain('修复 QA 反馈');
  });

  it('buildContinuationDirective should return paused directive', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 1);
    workpadPaused(tmpDir, 'F001', 50, 'max_iterations');
    const directive = buildContinuationDirective(tmpDir, 'F001', 1);
    expect(directive).toContain('恢复的任务');
  });

  // ═══════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════

  it('clearWorkpad should remove workpad file', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 1);
    expect(loadWorkpad(tmpDir, 'F001')).not.toBeNull();
    clearWorkpad(tmpDir, 'F001');
    expect(loadWorkpad(tmpDir, 'F001')).toBeNull();
  });

  it('listWorkpads should list all feature workpads', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 1);
    workpadDevStart(tmpDir, 'F002', 'proj-1', 'dev-1', 1);
    workpadDevStart(tmpDir, 'F003', 'proj-1', 'dev-2', 1);
    const list = listWorkpads(tmpDir);
    expect(list).toHaveLength(3);
    expect(list).toContain('F001');
    expect(list).toContain('F002');
    expect(list).toContain('F003');
  });

  // ═══════════════════════════════════════
  // Edge cases
  // ═══════════════════════════════════════

  it('workpadDevDone on non-existent workpad should be no-op', () => {
    workpadDevDone(tmpDir, 'F999', ['src/a.ts'], 5, 0.01);
    expect(loadWorkpad(tmpDir, 'F999')).toBeNull();
  });

  it('timeline should be limited to 50 entries', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 1);
    for (let i = 0; i < 60; i++) {
      workpadRecordDecision(tmpDir, 'F001', `Decision ${i}`);
    }
    const pad = loadWorkpad(tmpDir, 'F001');
    expect(pad!.timeline.length).toBeLessThanOrEqual(50);
  });

  it('decisions should be limited to 20 entries', () => {
    workpadDevStart(tmpDir, 'F001', 'proj-1', 'dev-1', 1);
    for (let i = 0; i < 30; i++) {
      workpadRecordDecision(tmpDir, 'F001', `Decision ${i}`);
    }
    const pad = loadWorkpad(tmpDir, 'F001');
    expect(pad!.decisions.length).toBeLessThanOrEqual(20);
  });
});
