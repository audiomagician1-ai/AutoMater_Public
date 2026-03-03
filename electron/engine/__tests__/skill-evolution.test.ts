/**
 * Tests for skill-evolution.ts — 技能进化引擎
 *
 * Tests pure functions: buildSkillExtractionPrompt, maturityLevel (indirect),
 * and the SkillEvolutionManager via FS mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock FS state ──
const mockFiles: Record<string, string> = {};
const mockDirs: Record<string, string[]> = {};
function resetMockFs() {
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  for (const k of Object.keys(mockDirs)) delete mockDirs[k];
}

vi.mock('fs', () => ({
  default: {
    existsSync: (p: string) => p in mockFiles || p in mockDirs,
    readFileSync: (p: string) => { if (p in mockFiles) return mockFiles[p]; throw new Error(`ENOENT: ${p}`); },
    writeFileSync: (p: string, c: string) => { mockFiles[p] = c; },
    mkdirSync: () => {},
    readdirSync: (p: string) => mockDirs[p] || [],
  },
  existsSync: (p: string) => p in mockFiles || p in mockDirs,
  readFileSync: (p: string) => { if (p in mockFiles) return mockFiles[p]; throw new Error(`ENOENT: ${p}`); },
  writeFileSync: (p: string, c: string) => { mockFiles[p] = c; },
  mkdirSync: () => {},
  readdirSync: (p: string) => mockDirs[p] || [],
}));

vi.mock('path', () => ({
  default: { join: (...p: string[]) => p.join('/'), dirname: (p: string) => p.split('/').slice(0, -1).join('/') },
  join: (...p: string[]) => p.join('/'),
  dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/mock-user-data' },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: class { webContents = { send() {} }; loadURL() {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  Notification: class { show() {} static isSupported() { return false; } },
}));

import {
  buildSkillExtractionPrompt,
  buildSkillContext,
  skillEvolution,
} from '../skill-evolution';

beforeEach(() => {
  resetMockFs();
  // Reset the singleton's loaded state by forcing re-init
  (skillEvolution as any).loaded = false;
  (skillEvolution as any).index = [];
});

// ═══════════════════════════════════════
// buildSkillExtractionPrompt — pure function
// ═══════════════════════════════════════

describe('buildSkillExtractionPrompt', () => {
  it('generates prompt with all fields', () => {
    const prompt = buildSkillExtractionPrompt({
      featureTitle: 'Add user authentication',
      qaFeedback: 'Missing password validation',
      fixSummary: 'Added zod schema for password',
      filesChanged: ['src/auth.ts', 'src/validators.ts'],
      lessonsLearned: ['Always validate input with zod', 'Add password strength check'],
    });
    expect(prompt).toContain('Add user authentication');
    expect(prompt).toContain('Missing password validation');
    expect(prompt).toContain('Added zod schema');
    expect(prompt).toContain('src/auth.ts');
    expect(prompt).toContain('Always validate input');
    expect(prompt).toContain('should_create');
    expect(prompt).toContain('JSON');
  });

  it('omits optional fields when not provided', () => {
    const prompt = buildSkillExtractionPrompt({
      featureTitle: 'Basic feature',
      filesChanged: ['main.ts'],
      lessonsLearned: ['Keep it simple'],
    });
    expect(prompt).toContain('Basic feature');
    expect(prompt).not.toContain('QA 反馈');
    expect(prompt).not.toContain('修复摘要');
  });

  it('truncates long feedback', () => {
    const prompt = buildSkillExtractionPrompt({
      featureTitle: 'Test',
      qaFeedback: 'x'.repeat(2000),
      fixSummary: 'y'.repeat(2000),
      filesChanged: [],
      lessonsLearned: [],
    });
    // Original 2000 char strings should be truncated to 500
    expect(prompt.length).toBeLessThan(2000 + 2000 + 500);
  });
});

// ═══════════════════════════════════════
// SkillEvolutionManager basics
// ═══════════════════════════════════════

describe('skillEvolution (manager)', () => {
  it('ensureInitialized creates directories', () => {
    skillEvolution.ensureInitialized();
    // Should have saved an empty index
    const indexPath = '/mock-user-data/evolved-skills/skill-index.json';
    expect(mockFiles[indexPath]).toBeDefined();
    const parsed = JSON.parse(mockFiles[indexPath]);
    expect(parsed.skills).toEqual([]);
  });

  it('acquire creates a new skill with SK-001 ID', () => {
    const skill = skillEvolution.acquire({
      name: 'TypeScript strict mode',
      description: 'Enable strict in tsconfig',
      trigger: 'New TypeScript project setup',
      tags: ['typescript', 'config'],
      execution: { type: 'prompt', promptTemplate: 'Enable strict mode in tsconfig.json' },
      knowledge: '# TypeScript Strict Mode\nAlways enable strict.',
      source: { type: 'agent_acquired', agentId: 'dev-1', timestamp: new Date().toISOString() },
    });
    expect(skill.id).toBe('SK-001');
    expect(skill.name).toBe('TypeScript strict mode');
    expect(skill.maturity).toBe('draft');
    expect(skill.version).toBe(1);
    expect(skill.tags).toContain('typescript');
  });

  it('acquire auto-increments IDs', () => {
    skillEvolution.acquire({
      name: 'Skill A', description: 'A', trigger: 'A', execution: { type: 'prompt' },
      source: { type: 'agent_acquired', timestamp: new Date().toISOString() },
    });
    const skill2 = skillEvolution.acquire({
      name: 'Skill B', description: 'B', trigger: 'B', execution: { type: 'prompt' },
      source: { type: 'agent_acquired', timestamp: new Date().toISOString() },
    });
    expect(skill2.id).toBe('SK-002');
  });

  it('searchSkills finds matching skills by trigger keywords', () => {
    skillEvolution.acquire({
      name: 'React Testing', description: 'Testing React components', trigger: 'Testing React components with vitest',
      tags: ['react', 'testing'], execution: { type: 'prompt' },
      source: { type: 'agent_acquired', timestamp: new Date().toISOString() },
    });
    skillEvolution.acquire({
      name: 'Docker Deploy', description: 'Deploy with Docker', trigger: 'Docker compose deployment',
      tags: ['docker'], execution: { type: 'command' },
      source: { type: 'agent_acquired', timestamp: new Date().toISOString() },
    });

    const matches = skillEvolution.searchSkills('write React component tests');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].skill.name).toBe('React Testing');
  });

  it('recordUsage updates stats', () => {
    const skill = skillEvolution.acquire({
      name: 'Test Skill', description: 'desc', trigger: 'test', execution: { type: 'prompt' },
      source: { type: 'agent_acquired', timestamp: new Date().toISOString() },
    });
    skillEvolution.recordUsage(skill.id, 'project-1', true, 'Worked well');
    skillEvolution.recordUsage(skill.id, 'project-1', true);
    skillEvolution.recordUsage(skill.id, 'project-2', false, 'Failed');

    // Check via loadSkill (the full definition includes stats)
    const loaded = skillEvolution.loadSkill(skill.id);
    expect(loaded).toBeDefined();
    expect(loaded?.stats.usedCount).toBe(3);
    expect(loaded?.stats.successCount).toBe(2);
  });

  it('getIndex returns index entries', () => {
    skillEvolution.acquire({
      name: 'S1', description: 'd', trigger: 't', execution: { type: 'prompt' },
      source: { type: 'agent_acquired', timestamp: new Date().toISOString() },
    });
    const all = skillEvolution.getIndex();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe('S1');
  });

  it('event listener fires on acquire', () => {
    const events: any[] = [];
    const unsub = skillEvolution.on(e => events.push(e));

    skillEvolution.acquire({
      name: 'Evented Skill', description: 'd', trigger: 't', execution: { type: 'prompt' },
      source: { type: 'agent_acquired', timestamp: new Date().toISOString() },
    });

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('acquired');
    unsub();
  });
});

// ═══════════════════════════════════════
// buildSkillContext — depends on skillEvolution
// ═══════════════════════════════════════

describe('buildSkillContext', () => {
  it('returns empty when no skills match', () => {
    expect(buildSkillContext('something totally unrelated xyz')).toBe('');
  });

  it('returns skill context when matching skills exist', () => {
    skillEvolution.acquire({
      name: 'Vitest Setup', description: 'Setting up vitest', trigger: 'vitest testing configuration',
      tags: ['testing'], execution: { type: 'prompt' },
      knowledge: 'Install vitest and configure vitest.config.ts',
      source: { type: 'agent_acquired', timestamp: new Date().toISOString() },
    });

    const ctx = buildSkillContext('Configure vitest for this project');
    expect(ctx).toContain('相关技能');
    expect(ctx).toContain('Vitest Setup');
  });
});
