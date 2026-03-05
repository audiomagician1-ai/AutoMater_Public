/**
 * Tests for v31.0 prompt enhancements — resolvePrompt + getStatusGuidance
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { resolvePrompt, getStatusGuidance, DEVELOPER_REACT_PROMPT, PM_SYSTEM_PROMPT } from '../prompts';
import { clearWorkflowCache } from '../workflow-config';

describe('resolvePrompt', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rp-test-'));
    clearWorkflowCache();
  });

  afterEach(() => {
    clearWorkflowCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return built-in prompt when no workspace and no team prompt', () => {
    const prompt = resolvePrompt(null, 'developer', null);
    expect(prompt).toBe(DEVELOPER_REACT_PROMPT);
  });

  it('should return built-in PM prompt', () => {
    const prompt = resolvePrompt(null, 'pm', null);
    expect(prompt).toBe(PM_SYSTEM_PROMPT);
  });

  it('should return team prompt when provided (layer 2)', () => {
    const customPrompt = 'You are a custom developer with special instructions for this project.';
    const prompt = resolvePrompt(null, 'developer', customPrompt);
    expect(prompt).toBe(customPrompt);
  });

  it('should ignore short team prompts (< 10 chars)', () => {
    const prompt = resolvePrompt(null, 'developer', 'short');
    expect(prompt).toBe(DEVELOPER_REACT_PROMPT);
  });

  it('should prefer WORKFLOW.md over team prompt (layer 1)', () => {
    const dir = path.join(tmpDir, '.automater');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'WORKFLOW.md'),
      `---
name: Test
---

## Role: Developer
WORKFLOW developer prompt — this should be preferred over team_members.
`,
      'utf-8',
    );

    const prompt = resolvePrompt(tmpDir, 'developer', 'Team member custom prompt here, which is long enough.');
    expect(prompt).toContain('WORKFLOW developer prompt');
  });

  it('should fallback to team prompt when WORKFLOW.md has no role section', () => {
    const dir = path.join(tmpDir, '.automater');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), '---\nname: Test\n---\n', 'utf-8');

    const teamPrompt = 'You are a specialized developer for this specific project with many instructions.';
    const prompt = resolvePrompt(tmpDir, 'developer', teamPrompt);
    expect(prompt).toBe(teamPrompt);
  });

  it('should apply variable interpolation on WORKFLOW.md prompts', () => {
    const dir = path.join(tmpDir, '.automater');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'WORKFLOW.md'),
      `---
name: Test
---

## Role: Developer
Working on {{project_name}}, feature {{feature_id}}.
`,
      'utf-8',
    );

    const prompt = resolvePrompt(tmpDir, 'developer', null, {
      project_name: 'MyApp',
      feature_id: 'F001',
    });
    expect(prompt).toContain('Working on MyApp, feature F001.');
  });

  it('should fallback to DEVELOPER_REACT_PROMPT for unknown roles', () => {
    const prompt = resolvePrompt(null, 'unknown_role', null);
    expect(prompt).toBe(DEVELOPER_REACT_PROMPT);
  });
});

describe('getStatusGuidance', () => {
  it('should return empty for first-time in_progress', () => {
    expect(getStatusGuidance('in_progress', 1)).toBe('');
  });

  it('should return rework guidance for rework status', () => {
    const guidance = getStatusGuidance('rework', 2, 'Missing error handling');
    expect(guidance).toContain('重做');
    expect(guidance).toContain('第 2 次');
    expect(guidance).toContain('Missing error handling');
    expect(guidance).toContain('edit_file');
  });

  it('should return rework guidance for in_progress with qaAttempt > 1', () => {
    const guidance = getStatusGuidance('in_progress', 3);
    expect(guidance).toContain('重做');
    expect(guidance).toContain('第 3 次');
  });

  it('should return pause guidance for paused status', () => {
    const guidance = getStatusGuidance('paused', 1);
    expect(guidance).toContain('恢复执行');
    expect(guidance).toContain('scratchpad_read');
  });

  it('should return pause guidance for resumed status', () => {
    const guidance = getStatusGuidance('resumed', 1);
    expect(guidance).toContain('恢复执行');
  });

  it('should return empty for unknown status', () => {
    expect(getStatusGuidance('unknown', 1)).toBe('');
  });

  it('should truncate qaFeedback to 500 chars', () => {
    const longFeedback = 'x'.repeat(1000);
    const guidance = getStatusGuidance('rework', 2, longFeedback);
    // The guidance includes the feedback but truncated
    expect(guidance.length).toBeLessThan(1200); // some overhead + 500 chars max
  });
});
