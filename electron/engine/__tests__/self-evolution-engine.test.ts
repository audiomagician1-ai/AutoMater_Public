/// <reference types="vitest" />
/**
 * Unit tests for Self-Evolution Engine
 *
 * Tests cover:
 *  1. ImmutableGuard — hash capture, verification, path checking
 *  2. SafeGitOps — basic operations (mocked where needed)
 *  3. FitnessEvaluator — score calculation
 *  4. SelfEvolutionEngine — config, preflight checks, static utilities
 *  5. Guards — checkEvolutionPath, checkEvolutionPaths
 *
 * Note: These are unit tests — git/file operations use temp dirs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  ImmutableGuard,
  SafeGitOps,
  SelfEvolutionEngine,
  DEFAULT_IMMUTABLE_FILES,
  DEFAULT_PROTECTED_FILES,
  DEFAULT_EVOLUTION_CONFIG,
  type FitnessWeights,
  type HashManifest,
} from '../self-evolution-engine';
import { checkEvolutionPath, checkEvolutionPaths } from '../guards';

// ═══════════════════════════════════════
// Helper: Temp directory
// ═══════════════════════════════════════

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evo-test-'));
}

function cleanup(): void {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════
// 1. ImmutableGuard Tests
// ═══════════════════════════════════════

describe('ImmutableGuard', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    // Create some files
    fs.writeFileSync(path.join(tmpDir, 'vitest.config.ts'), 'export default {}');
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{"compilerOptions":{}}');
    fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'scripts', 'quality-gate.js'), '// gate');
  });

  afterEach(cleanup);

  it('should capture baseline hashes', () => {
    const guard = new ImmutableGuard(tmpDir, ['vitest.config.ts', 'tsconfig.json', 'scripts/quality-gate.js']);
    const manifest = guard.captureBaseline();

    expect(Object.keys(manifest)).toHaveLength(3);
    expect(manifest['vitest.config.ts']).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest['tsconfig.json']).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest['scripts/quality-gate.js']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should verify unchanged files as OK', () => {
    const guard = new ImmutableGuard(tmpDir, ['vitest.config.ts']);
    guard.captureBaseline();
    const result = guard.verify();
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('should detect modified files', () => {
    const guard = new ImmutableGuard(tmpDir, ['vitest.config.ts']);
    guard.captureBaseline();

    // Modify the file
    fs.writeFileSync(path.join(tmpDir, 'vitest.config.ts'), 'MODIFIED CONTENT');

    const result = guard.verify();
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('IMMUTABLE VIOLATION');
    expect(result.violations[0]).toContain('vitest.config.ts');
  });

  it('should detect deleted files', () => {
    const guard = new ImmutableGuard(tmpDir, ['vitest.config.ts']);
    guard.captureBaseline();

    fs.unlinkSync(path.join(tmpDir, 'vitest.config.ts'));

    const result = guard.verify();
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
  });

  it('should check paths against immutable list', () => {
    const guard = new ImmutableGuard(tmpDir, ['vitest.config.ts', 'tsconfig.json']);

    const check1 = guard.checkPaths(['vitest.config.ts', 'src/app.ts']);
    expect(check1.ok).toBe(false);
    expect(check1.blockedFiles).toContain('vitest.config.ts');

    const check2 = guard.checkPaths(['src/app.ts', 'src/utils.ts']);
    expect(check2.ok).toBe(true);
    expect(check2.blockedFiles).toHaveLength(0);
  });

  it('should restore from saved manifest', () => {
    const guard = new ImmutableGuard(tmpDir, ['vitest.config.ts']);
    const manifest = guard.captureBaseline();

    // Create new guard instance and restore
    const guard2 = new ImmutableGuard(tmpDir, ['vitest.config.ts']);
    guard2.restoreManifest(manifest);
    const result = guard2.verify();
    expect(result.ok).toBe(true);
  });

  it('should handle non-existent files in immutable list', () => {
    const guard = new ImmutableGuard(tmpDir, ['nonexistent.ts']);
    const manifest = guard.captureBaseline();
    expect(manifest['nonexistent.ts']).toBe('FILE_NOT_FOUND');
  });
});

// ═══════════════════════════════════════
// 2. SafeGitOps Tests (requires git)
// ═══════════════════════════════════════

describe('SafeGitOps', () => {
  let gitDir: string;

  beforeEach(() => {
    gitDir = createTmpDir();
    tmpDir = gitDir;
    // Init git repo
    const { execSync } = require('child_process');
    execSync('git init', { cwd: gitDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: gitDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: gitDir, stdio: 'pipe' });
    // Initial commit
    fs.writeFileSync(path.join(gitDir, 'README.md'), '# Test');
    execSync('git add -A && git commit -m "init"', { cwd: gitDir, stdio: 'pipe' });
  });

  afterEach(cleanup);

  it('should get current branch', () => {
    const ops = new SafeGitOps(gitDir);
    const branch = ops.getCurrentBranch();
    // Default branch could be 'main' or 'master'
    expect(['main', 'master']).toContain(branch);
  });

  it('should check branch existence', () => {
    const ops = new SafeGitOps(gitDir);
    const branch = ops.getCurrentBranch();
    expect(ops.branchExists(branch)).toBe(true);
    expect(ops.branchExists('nonexistent')).toBe(false);
  });

  it('should create and switch branches', () => {
    const ops = new SafeGitOps(gitDir);
    const originalBranch = ops.getCurrentBranch();

    ops.createBranch('test-branch', originalBranch);
    expect(ops.getCurrentBranch()).toBe('test-branch');

    ops.checkout(originalBranch);
    expect(ops.getCurrentBranch()).toBe(originalBranch);
  });

  it('should commit changes', () => {
    const ops = new SafeGitOps(gitDir);
    fs.writeFileSync(path.join(gitDir, 'new-file.ts'), 'console.log("hello")');

    const hash = ops.commitAll('test commit');
    expect(hash).toMatch(/^[a-f0-9]{40}$/);
    expect(ops.isClean()).toBe(true);
  });

  it('should get changed files between commits', () => {
    const ops = new SafeGitOps(gitDir);
    const before = ops.getHead();

    fs.writeFileSync(path.join(gitDir, 'new-file.ts'), 'content');
    ops.commitAll('add file');

    const changed = ops.getChangedFiles(before);
    expect(changed).toContain('new-file.ts');
  });

  it('should create and rollback snapshots', () => {
    const ops = new SafeGitOps(gitDir);
    const originalContent = fs.readFileSync(path.join(gitDir, 'README.md'), 'utf-8');

    ops.createSnapshot('test-snapshot');

    // Make changes
    fs.writeFileSync(path.join(gitDir, 'README.md'), 'MODIFIED');
    ops.commitAll('modify readme');

    // Rollback
    ops.rollbackToSnapshot('test-snapshot');
    const restoredContent = fs.readFileSync(path.join(gitDir, 'README.md'), 'utf-8');
    expect(restoredContent).toBe(originalContent);
  });

  it('should detect clean/dirty state', () => {
    const ops = new SafeGitOps(gitDir);
    expect(ops.isClean()).toBe(true);

    fs.writeFileSync(path.join(gitDir, 'dirty.txt'), 'dirty');
    expect(ops.isClean()).toBe(false);
  });

  it('should throw on duplicate branch creation', () => {
    const ops = new SafeGitOps(gitDir);
    const branch = ops.getCurrentBranch();
    ops.createBranch('dup-test', branch);
    ops.checkout(branch);
    expect(() => ops.createBranch('dup-test', branch)).toThrow('already exists');
  });

  it('should merge branches', () => {
    const ops = new SafeGitOps(gitDir);
    const main = ops.getCurrentBranch();

    // Create feature branch with changes
    ops.createBranch('feature', main);
    fs.writeFileSync(path.join(gitDir, 'feature.ts'), 'feature code');
    ops.commitAll('add feature');

    // Switch back and merge
    ops.checkout(main);
    const merged = ops.merge('feature', 'merge feature');
    expect(merged).toBe(true);
    expect(fs.existsSync(path.join(gitDir, 'feature.ts'))).toBe(true);
  });
});

// ═══════════════════════════════════════
// 3. SelfEvolutionEngine Static Tests
// ═══════════════════════════════════════

describe('SelfEvolutionEngine', () => {
  it('should detect AutoMater root correctly', () => {
    const tmpRoot = createTmpDir();
    tmpDir = tmpRoot;

    // Not an AutoMater root
    expect(SelfEvolutionEngine.isAutoMaterRoot(tmpRoot)).toBe(false);

    // Create marker files
    fs.mkdirSync(path.join(tmpRoot, 'electron', 'engine'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    fs.writeFileSync(path.join(tmpRoot, 'electron', 'main.ts'), '');
    fs.writeFileSync(path.join(tmpRoot, 'electron', 'engine', 'react-loop.ts'), '');
    fs.writeFileSync(path.join(tmpRoot, 'electron', 'engine', 'orchestrator.ts'), '');
    fs.writeFileSync(path.join(tmpRoot, 'src', 'App.tsx'), '');

    expect(SelfEvolutionEngine.isAutoMaterRoot(tmpRoot)).toBe(true);
  });

  it('should read version from package.json', () => {
    const tmpRoot = createTmpDir();
    tmpDir = tmpRoot;
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }));

    expect(SelfEvolutionEngine.getVersion(tmpRoot)).toBe('1.2.3');
  });

  it('should return unknown for missing package.json', () => {
    expect(SelfEvolutionEngine.getVersion('/nonexistent/path')).toBe('unknown');
  });
});

// ═══════════════════════════════════════
// 4. Default Config Tests
// ═══════════════════════════════════════

describe('Default Configuration', () => {
  it('should have expected immutable files', () => {
    expect(DEFAULT_IMMUTABLE_FILES).toContain('vitest.config.ts');
    expect(DEFAULT_IMMUTABLE_FILES).toContain('tsconfig.json');
    expect(DEFAULT_IMMUTABLE_FILES).toContain('scripts/quality-gate.js');
    expect(DEFAULT_IMMUTABLE_FILES).toContain('scripts/evaluate-fitness.js');
    expect(DEFAULT_IMMUTABLE_FILES).toContain('electron/engine/self-evolution-engine.ts');
  });

  it('should have expected protected files', () => {
    expect(DEFAULT_PROTECTED_FILES).toContain('electron/main.ts');
    expect(DEFAULT_PROTECTED_FILES).toContain('electron/db.ts');
    expect(DEFAULT_PROTECTED_FILES).toContain('electron/engine/guards.ts');
  });

  it('should have fitness weights summing close to 1', () => {
    const w = DEFAULT_EVOLUTION_CONFIG.fitnessWeights;
    const sum = w.testPassRate + w.coverageDelta + w.tscClean + w.regressionPenalty;
    expect(sum).toBeCloseTo(1.0, 1);
  });
});

// ═══════════════════════════════════════
// 5. Evolution Path Guards Tests
// ═══════════════════════════════════════

describe('checkEvolutionPath', () => {
  it('should block immutable files', () => {
    const result = checkEvolutionPath('vitest.config.ts');
    expect(result.allowed).toBe(false);
    expect(result.level).toBe('immutable');
  });

  it('should block immutable files with various extensions', () => {
    expect(checkEvolutionPath('vitest.config.mts').level).toBe('immutable');
    expect(checkEvolutionPath('tsconfig.json').level).toBe('immutable');
    expect(checkEvolutionPath('scripts/quality-gate.js').level).toBe('immutable');
    expect(checkEvolutionPath('scripts/evaluate-fitness.js').level).toBe('immutable');
  });

  it('should mark protected files as protected but allowed', () => {
    const result = checkEvolutionPath('electron/main.ts');
    expect(result.allowed).toBe(true);
    expect(result.level).toBe('protected');
  });

  it('should allow normal source files', () => {
    const result = checkEvolutionPath('electron/engine/react-loop.ts');
    expect(result.allowed).toBe(true);
    expect(result.level).toBe('allowed');
  });

  it('should allow UI source files', () => {
    expect(checkEvolutionPath('src/App.tsx').level).toBe('allowed');
    expect(checkEvolutionPath('src/components/SomeComponent.tsx').level).toBe('allowed');
  });
});

describe('checkEvolutionPaths', () => {
  it('should categorize mixed file lists', () => {
    const result = checkEvolutionPaths([
      'vitest.config.ts', // immutable
      'electron/main.ts', // protected
      'src/App.tsx', // allowed
      'electron/engine/foo.ts', // allowed
    ]);

    expect(result.ok).toBe(false); // has immutable
    expect(result.immutable).toContain('vitest.config.ts');
    expect(result.protected_).toContain('electron/main.ts');
    expect(result.allowed).toContain('src/App.tsx');
    expect(result.allowed).toContain('electron/engine/foo.ts');
  });

  it('should pass when no immutable files present', () => {
    const result = checkEvolutionPaths(['electron/main.ts', 'src/App.tsx']);
    expect(result.ok).toBe(true);
    expect(result.immutable).toHaveLength(0);
  });

  it('should handle empty list', () => {
    const result = checkEvolutionPaths([]);
    expect(result.ok).toBe(true);
  });
});
