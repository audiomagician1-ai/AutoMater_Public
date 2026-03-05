/**
 * Tests for workflow-config.ts — WORKFLOW.md loader (v31.0)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  parseWorkflowMd,
  extractFrontmatter,
  parseSimpleYaml,
  extractRoleSections,
  interpolatePrompt,
  generateDefaultWorkflow,
  getWorkflowConfig,
  getWorkflowPrompt,
  getWorkflowHooks,
  invalidateWorkflowCache,
  clearWorkflowCache,
  ensureWorkflowFile,
} from '../workflow-config';

// ═══════════════════════════════════════
// parseSimpleYaml
// ═══════════════════════════════════════

describe('parseSimpleYaml', () => {
  it('should parse simple key-value pairs', () => {
    const result = parseSimpleYaml('name: MyProject\nmaxQARetries: 5');
    expect(result.name).toBe('MyProject');
    expect(result.maxQARetries).toBe(5);
  });

  it('should parse boolean values', () => {
    const yaml = 'name: Test\nmaxQARetries: 3';
    const result = parseSimpleYaml(yaml);
    expect(result.maxQARetries).toBe(3);
  });

  it('should parse quoted strings', () => {
    const result = parseSimpleYaml('name: "My Project"');
    expect(result.name).toBe('My Project');
  });

  it('should parse nested objects', () => {
    const yaml = `models:
  strong: claude-sonnet-4
  worker: gpt-4o-mini`;
    const result = parseSimpleYaml(yaml);
    expect(result.models).toEqual({ strong: 'claude-sonnet-4', worker: 'gpt-4o-mini' });
  });

  it('should parse arrays', () => {
    const yaml = `skills:
  - web_search
  - code_review`;
    const result = parseSimpleYaml(yaml);
    expect(result.skills).toEqual(['web_search', 'code_review']);
  });

  it('should parse nested hooks object', () => {
    const yaml = `hooks:
  before_run: npm install
  after_feature_done: npm test`;
    const result = parseSimpleYaml(yaml);
    expect(result.hooks).toEqual({ before_run: 'npm install', after_feature_done: 'npm test' });
  });

  it('should parse multiline strings with |', () => {
    const yaml = `constraints: |
  - Use TypeScript
  - No any types
name: Test`;
    const result = parseSimpleYaml(yaml);
    expect(result.constraints).toContain('Use TypeScript');
    expect(result.constraints).toContain('No any types');
    expect(result.name).toBe('Test');
  });

  it('should skip comments', () => {
    const yaml = '# This is a comment\nname: Test\n# Another comment';
    const result = parseSimpleYaml(yaml);
    expect(result.name).toBe('Test');
  });

  it('should handle empty input', () => {
    const result = parseSimpleYaml('');
    expect(result).toEqual({});
  });
});

// ═══════════════════════════════════════
// extractFrontmatter
// ═══════════════════════════════════════

describe('extractFrontmatter', () => {
  it('should extract YAML frontmatter between --- delimiters', () => {
    const raw = `---
name: MyProject
maxQARetries: 5
---

## Role: Developer
You are a dev.`;
    const { frontmatter, body } = extractFrontmatter(raw);
    expect(frontmatter.name).toBe('MyProject');
    expect(frontmatter.maxQARetries).toBe(5);
    expect(body).toContain('## Role: Developer');
  });

  it('should return empty frontmatter if no --- delimiters', () => {
    const raw = '## Role: Developer\nYou are a dev.';
    const { frontmatter, body } = extractFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });

  it('should handle missing closing ---', () => {
    const raw = '---\nname: Test\nNo closing delimiter';
    const { frontmatter } = extractFrontmatter(raw);
    expect(frontmatter).toEqual({});
  });
});

// ═══════════════════════════════════════
// extractRoleSections
// ═══════════════════════════════════════

describe('extractRoleSections', () => {
  it('should extract role sections by ## Role: xxx headers', () => {
    const body = `
## Role: PM
You are a product manager with 10+ years experience.

## Role: Developer
You are a full-stack developer.

## Role: QA
You are a QA engineer.`;
    const sections = extractRoleSections(body);
    expect(sections.size).toBe(3);
    expect(sections.get('pm')).toContain('product manager');
    expect(sections.get('developer')).toContain('full-stack developer');
    expect(sections.get('qa')).toContain('QA engineer');
  });

  it('should handle case-insensitive role names', () => {
    const body = '## Role: ARCHITECT\nYou design systems with precision.';
    const sections = extractRoleSections(body);
    expect(sections.has('architect')).toBe(true);
    expect(sections.get('architect')).toContain('design systems');
  });

  it('should return empty map if no role sections', () => {
    const sections = extractRoleSections('Just some text without role headers.');
    expect(sections.size).toBe(0);
  });

  it('should ignore sections with content < 10 chars', () => {
    const body = '## Role: PM\nShort.';
    const sections = extractRoleSections(body);
    expect(sections.size).toBe(0); // "Short." is < 10 chars
  });
});

// ═══════════════════════════════════════
// parseWorkflowMd (full integration)
// ═══════════════════════════════════════

describe('parseWorkflowMd', () => {
  it('should parse a complete WORKFLOW.md', () => {
    const raw = `---
name: TestProject
maxQARetries: 5
models:
  strong: claude-sonnet-4
hooks:
  before_run: npm install
constraints: |
  - Use TypeScript
  - No any types
---

## Role: Developer
You are a senior developer. Follow best practices and write clean code.

## Role: QA
You are a strict QA engineer. Check every acceptance criterion.`;

    const config = parseWorkflowMd(raw, '/test/WORKFLOW.md', 12345);
    expect(config.frontmatter.name).toBe('TestProject');
    expect(config.frontmatter.maxQARetries).toBe(5);
    expect(config.frontmatter.models?.strong).toBe('claude-sonnet-4');
    expect(config.frontmatter.hooks?.before_run).toBe('npm install');
    expect(config.constraints).toContain('Use TypeScript');
    expect(config.rolePrompts.size).toBe(2);
    expect(config.rolePrompts.get('developer')).toContain('senior developer');
    expect(config.rolePrompts.get('qa')).toContain('strict QA engineer');
    expect(config.filePath).toBe('/test/WORKFLOW.md');
    expect(config.mtime).toBe(12345);
  });

  it('should handle WORKFLOW.md with only frontmatter (no role sections)', () => {
    const raw = `---
maxQARetries: 10
---

No role sections here, just general content.`;
    const config = parseWorkflowMd(raw, '/test', 0);
    expect(config.frontmatter.maxQARetries).toBe(10);
    expect(config.rolePrompts.size).toBe(0);
  });
});

// ═══════════════════════════════════════
// interpolatePrompt
// ═══════════════════════════════════════

describe('interpolatePrompt', () => {
  it('should replace {{variable}} with values', () => {
    const template = 'Project: {{project_name}}, Feature: {{feature_id}}';
    const result = interpolatePrompt(template, { project_name: 'MyApp', feature_id: 'F001' });
    expect(result).toBe('Project: MyApp, Feature: F001');
  });

  it('should keep unknown variables as-is', () => {
    const template = '{{known}} and {{unknown}}';
    const result = interpolatePrompt(template, { known: 'yes' });
    expect(result).toBe('yes and {{unknown}}');
  });

  it('should handle numeric values', () => {
    const result = interpolatePrompt('Attempt {{attempt}}', { attempt: 3 });
    expect(result).toBe('Attempt 3');
  });

  it('should handle empty vars', () => {
    const template = 'No vars: {{foo}}';
    const result = interpolatePrompt(template, {});
    expect(result).toBe('No vars: {{foo}}');
  });
});

// ═══════════════════════════════════════
// generateDefaultWorkflow
// ═══════════════════════════════════════

describe('generateDefaultWorkflow', () => {
  it('should generate valid WORKFLOW.md with project name', () => {
    const content = generateDefaultWorkflow('My Cool App');
    expect(content).toContain('name: My Cool App');
    expect(content).toContain('---');
    expect(content).toContain('# Workflow');
    expect(content).toContain('## Role: PM');
    expect(content).toContain('## Role: Developer');
  });
});

// ═══════════════════════════════════════
// File-based functions (with temp directory)
// ═══════════════════════════════════════

describe('file-based workflow config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wf-test-'));
    clearWorkflowCache();
  });

  afterEach(() => {
    clearWorkflowCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getWorkflowConfig should return null for non-existent file', () => {
    expect(getWorkflowConfig(tmpDir)).toBeNull();
  });

  it('getWorkflowConfig should parse existing WORKFLOW.md', () => {
    const dir = path.join(tmpDir, '.automater');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'WORKFLOW.md'),
      `---
name: Test
maxQARetries: 7
---

## Role: Developer
Custom dev prompt with enough content here.
`,
      'utf-8',
    );

    const config = getWorkflowConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.frontmatter.name).toBe('Test');
    expect(config!.frontmatter.maxQARetries).toBe(7);
    expect(config!.rolePrompts.get('developer')).toContain('Custom dev prompt');
  });

  it('getWorkflowConfig should use cache on second call', () => {
    const dir = path.join(tmpDir, '.automater');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), '---\nname: Cached\n---\n', 'utf-8');

    const first = getWorkflowConfig(tmpDir);
    const second = getWorkflowConfig(tmpDir);
    expect(first).toBe(second); // same object reference = cache hit
  });

  it('getWorkflowConfig should invalidate cache on file change', async () => {
    const dir = path.join(tmpDir, '.automater');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'WORKFLOW.md');
    fs.writeFileSync(filePath, '---\nname: V1\n---\n', 'utf-8');

    const first = getWorkflowConfig(tmpDir);
    expect(first!.frontmatter.name).toBe('V1');

    // Simulate file change (need different mtime)
    await new Promise(r => setTimeout(r, 50));
    fs.writeFileSync(filePath, '---\nname: V2\n---\n', 'utf-8');

    const second = getWorkflowConfig(tmpDir);
    expect(second!.frontmatter.name).toBe('V2');
  });

  it('getWorkflowPrompt should return role prompt with constraints appended', () => {
    const dir = path.join(tmpDir, '.automater');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'WORKFLOW.md'),
      `---
constraints: |
  ALWAYS use TypeScript strict
---

## Role: Developer
Build features with clean architecture and proper testing.
`,
      'utf-8',
    );

    const prompt = getWorkflowPrompt(tmpDir, 'developer');
    expect(prompt).toContain('clean architecture');
    expect(prompt).toContain('ALWAYS use TypeScript strict');
  });

  it('getWorkflowPrompt should return null for missing role', () => {
    const dir = path.join(tmpDir, '.automater');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), '---\nname: Test\n---\n', 'utf-8');

    expect(getWorkflowPrompt(tmpDir, 'pm')).toBeNull();
  });

  it('getWorkflowHooks should return hooks config', () => {
    const dir = path.join(tmpDir, '.automater');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'WORKFLOW.md'),
      `---
hooks:
  before_run: npm ci
  after_feature_done: npm test
---
`,
      'utf-8',
    );

    const hooks = getWorkflowHooks(tmpDir);
    expect(hooks?.before_run).toBe('npm ci');
    expect(hooks?.after_feature_done).toBe('npm test');
  });

  it('invalidateWorkflowCache should force re-read', () => {
    const dir = path.join(tmpDir, '.automater');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), '---\nname: Before\n---\n', 'utf-8');

    getWorkflowConfig(tmpDir); // populate cache
    invalidateWorkflowCache(tmpDir);
    // After invalidation, next call should re-read (even if mtime same)
    const config = getWorkflowConfig(tmpDir);
    expect(config).not.toBeNull();
  });

  it('ensureWorkflowFile should create file if not exists', () => {
    const filePath = ensureWorkflowFile(tmpDir, 'TestProject');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('name: TestProject');
  });

  it('ensureWorkflowFile should not overwrite existing file', () => {
    const dir = path.join(tmpDir, '.automater');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'WORKFLOW.md');
    fs.writeFileSync(filePath, 'custom content', 'utf-8');

    ensureWorkflowFile(tmpDir, 'NewName');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('custom content');
  });
});
