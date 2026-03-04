/// <reference types="vitest" />
/**
 * Self-Evolution E2E Integration Tests
 *
 * Creates a realistic mini project (with vitest + tsc) in a temp directory
 * and exercises the full evolution lifecycle:
 *
 *  1. preflight() — baseline capture
 *  2. runSingleIteration() with a valid change → ACCEPT → merge
 *  3. runSingleIteration() with a change that breaks tests → REJECT → rollback
 *  4. runSingleIteration() that touches immutable file → BLOCK → rollback
 *  5. abort() during iteration
 *  6. getProgress/getMemorySummary/getArchiveSummary after multiple iterations
 *
 * These tests use real git + real file system but mock the FitnessEvaluator
 * to avoid running actual `npx tsc/vitest` (which would require the full project).
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import {
  SelfEvolutionEngine,
  SafeGitOps,
  ImmutableGuard,
  FitnessEvaluator,
  DEFAULT_EVOLUTION_CONFIG,
  type FitnessResult,
  type EvolutionConfig,
} from '../self-evolution-engine';

// ═══════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════

let tmpDir: string;

function createTmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-e2e-'));

  // Create AutoMater marker structure so isAutoMaterRoot passes
  fs.mkdirSync(path.join(dir, 'electron', 'engine'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'test-forge', version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, 'electron', 'main.ts'), '// main');
  fs.writeFileSync(path.join(dir, 'electron', 'engine', 'react-loop.ts'), '// loop');
  fs.writeFileSync(path.join(dir, 'electron', 'engine', 'orchestrator.ts'), '// orch');
  fs.writeFileSync(path.join(dir, 'src', 'App.tsx'), '// app');

  // Immutable files
  fs.writeFileSync(path.join(dir, 'vitest.config.ts'), 'export default { test: {} }');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{"compilerOptions":{}}');
  fs.writeFileSync(path.join(dir, 'scripts', 'quality-gate.js'), '// gate');
  fs.writeFileSync(path.join(dir, 'scripts', 'evaluate-fitness.js'), '// fitness');

  // Source files for modification
  fs.writeFileSync(path.join(dir, 'src', 'utils.ts'), 'export const add = (a: number, b: number) => a + b;\n');
  fs.writeFileSync(path.join(dir, 'electron', 'engine', 'helper.ts'), 'export function helper() { return 42; }\n');

  // Init git
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "evo-test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Evolution Test"', { cwd: dir, stdio: 'pipe' });
  execSync('git add -A && git commit -m "init: test project"', { cwd: dir, stdio: 'pipe' });

  return dir;
}

function cleanup(): void {
  if (tmpDir && fs.existsSync(tmpDir)) {
    // Ensure we're not inside the dir (on Windows this can lock)
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}

/** Create a mock FitnessResult with sane defaults */
function mockFitness(overrides: Partial<FitnessResult> = {}): FitnessResult {
  return {
    score: 0.7,
    tscPassed: true,
    tscErrors: 0,
    testPassRate: 1.0,
    totalTests: 100,
    passedTests: 100,
    failedTests: 0,
    statementCoverage: 30,
    baselineCoverage: 25,
    durations: { tsc: 1000, vitest: 2000, total: 3000 },
    details: 'mocked fitness result',
    ...overrides,
  };
}

// ═══════════════════════════════════════
// E2E Tests
// ═══════════════════════════════════════

describe('SelfEvolutionEngine E2E', () => {
  let mockEvaluate: Mock;

  beforeEach(() => {
    tmpDir = createTmpProject();

    // Mock FitnessEvaluator.prototype.evaluate to avoid running real tsc/vitest
    mockEvaluate = vi.fn().mockReturnValue(mockFitness());
    vi.spyOn(FitnessEvaluator.prototype, 'evaluate').mockImplementation(mockEvaluate);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('should complete full preflight successfully', async () => {
    const engine = new SelfEvolutionEngine({ sourceRoot: tmpDir });

    const result = await engine.preflight();
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.baselineFitness).toBeDefined();
    expect(result.baselineFitness!.score).toBe(0.7);

    // Progress should reflect baseline
    const progress = engine.getProgress();
    expect(progress.baselineFitness).toBe(0.7);
    expect(progress.status).toBe('idle');
  });

  it('should reject preflight when workdir is dirty', async () => {
    // Dirty the workdir
    fs.writeFileSync(path.join(tmpDir, 'dirty.txt'), 'uncommitted file');

    const engine = new SelfEvolutionEngine({ sourceRoot: tmpDir });
    const result = await engine.preflight();

    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('not clean'))).toBe(true);
  });

  it('should ACCEPT a valid iteration and merge', async () => {
    const engine = new SelfEvolutionEngine({ sourceRoot: tmpDir });
    await engine.preflight();

    // Mock: the new fitness is better than baseline
    mockEvaluate.mockReturnValueOnce(mockFitness({ score: 0.75, passedTests: 105, totalTests: 105 }));

    const result = await engine.runSingleIteration('Add multiply function', async workingDir => {
      // Apply a valid change
      const utilsPath = path.join(workingDir, 'src', 'utils.ts');
      const content = fs.readFileSync(utilsPath, 'utf-8');
      fs.writeFileSync(utilsPath, content + '\nexport const multiply = (a: number, b: number) => a * b;\n');
      return ['src/utils.ts'];
    });

    expect(result.success).toBe(true);
    expect(result.entry).toBeDefined();
    expect(result.entry!.status).toBe('accepted');
    expect(result.entry!.generation).toBe(1);
    expect(result.entry!.modifiedFiles).toContain('src/utils.ts');
    expect(result.rolledBack).toBe(false);

    // Verify the change was merged to original branch
    const gitOps = new SafeGitOps(tmpDir);
    const branch = gitOps.getCurrentBranch();
    // Should be back on the original branch (master/main)
    expect(['main', 'master']).toContain(branch);

    // The file should have the new content (merged)
    const utils = fs.readFileSync(path.join(tmpDir, 'src', 'utils.ts'), 'utf-8');
    expect(utils).toContain('multiply');

    // Progress should be updated
    const progress = engine.getProgress();
    expect(progress.generation).toBe(1);
    expect(progress.archive).toHaveLength(1);
    expect(progress.archive[0].status).toBe('accepted');
    expect(progress.baselineFitness).toBe(0.75); // updated to new fitness
    expect(progress.memories.length).toBeGreaterThanOrEqual(1);
  });

  it('should REJECT an iteration with failing tests', async () => {
    const engine = new SelfEvolutionEngine({ sourceRoot: tmpDir });
    await engine.preflight();

    // Mock: fitness has test failures
    mockEvaluate.mockReturnValueOnce(
      mockFitness({
        score: 0.45,
        tscPassed: true,
        failedTests: 5,
        passedTests: 95,
        totalTests: 100,
        testPassRate: 0.95,
      }),
    );

    const result = await engine.runSingleIteration('Introduce a bug', async workingDir => {
      fs.writeFileSync(
        path.join(workingDir, 'src', 'utils.ts'),
        'export const add = (a: number, b: number) => a - b; // oops\n',
      );
      return ['src/utils.ts'];
    });

    expect(result.success).toBe(false);
    expect(result.entry).toBeDefined();
    expect(result.entry!.status).toBe('rejected');
    expect(result.rolledBack).toBe(false); // Rejected != rolled back (just didn't merge)

    // Verify original file is intact (we should be on original branch, file unchanged)
    const gitOps = new SafeGitOps(tmpDir);
    expect(['main', 'master']).toContain(gitOps.getCurrentBranch());

    // File should have original content (since rejected change was not merged)
    const utils = fs.readFileSync(path.join(tmpDir, 'src', 'utils.ts'), 'utf-8');
    expect(utils).toContain('a + b');
    expect(utils).not.toContain('a - b');

    // Memory should record failure
    const progress = engine.getProgress();
    expect(progress.memories.some(m => m.outcome === 'failure')).toBe(true);
  });

  it('should BLOCK modifications to immutable files', async () => {
    const engine = new SelfEvolutionEngine({ sourceRoot: tmpDir });
    await engine.preflight();

    const result = await engine.runSingleIteration('Try to hack vitest config', async workingDir => {
      // Try to modify an immutable file
      fs.writeFileSync(path.join(workingDir, 'vitest.config.ts'), 'HACKED');
      return ['vitest.config.ts'];
    });

    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true); // Should have rolled back
    expect(result.error).toContain('IMMUTABLE');

    // Immutable file should be intact
    const vitestConfig = fs.readFileSync(path.join(tmpDir, 'vitest.config.ts'), 'utf-8');
    expect(vitestConfig).toBe('export default { test: {} }');
  });

  it('should BLOCK stealth modifications to immutable files (path not reported but file changed)', async () => {
    const engine = new SelfEvolutionEngine({ sourceRoot: tmpDir });
    await engine.preflight();

    const result = await engine.runSingleIteration('Stealth attack on tsconfig', async workingDir => {
      // Modify immutable file but DON'T report it in the returned list
      fs.writeFileSync(path.join(workingDir, 'tsconfig.json'), '{"hacked": true}');
      // Report only a benign file
      fs.writeFileSync(
        path.join(workingDir, 'src', 'utils.ts'),
        'export const add = (a: number, b: number) => a + b;\n',
      );
      return ['src/utils.ts']; // tsconfig not reported!
    });

    // The hash-based guard should catch this even if the path wasn't reported
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('HASH VIOLATION');

    // Immutable file should be restored
    const tsconfig = fs.readFileSync(path.join(tmpDir, 'tsconfig.json'), 'utf-8');
    expect(tsconfig).toBe('{"compilerOptions":{}}');
  });

  it('should handle abort signal during iteration', async () => {
    const engine = new SelfEvolutionEngine({ sourceRoot: tmpDir });
    await engine.preflight();

    // The abort check in runSingleIteration happens at two points:
    // 1. Before applying changes  2. Before fitness evaluation
    // We abort during the applyChanges callback to guarantee it fires between checks.
    mockEvaluate.mockReturnValueOnce(mockFitness({ score: 0.75 }));

    const result = await engine.runSingleIteration('Will be aborted mid-flight', async workingDir => {
      fs.writeFileSync(path.join(workingDir, 'src', 'utils.ts'), 'export const aborted = true;\n');
      // Abort DURING the callback — the check happens AFTER applyChanges returns
      engine.abort();
      return ['src/utils.ts'];
    });

    // After aborting, the iteration should fail and roll back
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('Aborted');

    // Verify we're back on original branch in a clean state
    const gitOps = new SafeGitOps(tmpDir);
    expect(['main', 'master']).toContain(gitOps.getCurrentBranch());
  });

  it('should support multiple sequential iterations with accumulating archive', async () => {
    const engine = new SelfEvolutionEngine({ sourceRoot: tmpDir });
    await engine.preflight();

    // Iteration 1: accepted
    mockEvaluate.mockReturnValueOnce(mockFitness({ score: 0.72 }));
    const r1 = await engine.runSingleIteration('Improvement A', async dir => {
      const p = path.join(dir, 'electron', 'engine', 'helper.ts');
      fs.writeFileSync(p, 'export function helper() { return 100; }\n');
      return ['electron/engine/helper.ts'];
    });
    expect(r1.success).toBe(true);

    // Iteration 2: rejected (worse fitness)
    mockEvaluate.mockReturnValueOnce(mockFitness({ score: 0.3, tscPassed: false, failedTests: 10 }));
    const r2 = await engine.runSingleIteration('Bad change', async dir => {
      fs.writeFileSync(path.join(dir, 'src', 'utils.ts'), 'broken code here\n');
      return ['src/utils.ts'];
    });
    expect(r2.success).toBe(false);

    // Iteration 3: accepted
    mockEvaluate.mockReturnValueOnce(mockFitness({ score: 0.78 }));
    const r3 = await engine.runSingleIteration('Improvement B', async dir => {
      fs.writeFileSync(
        path.join(dir, 'src', 'utils.ts'),
        'export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\n',
      );
      return ['src/utils.ts'];
    });
    expect(r3.success).toBe(true);

    const progress = engine.getProgress();
    expect(progress.generation).toBe(3);
    expect(progress.archive).toHaveLength(3);
    expect(progress.archive[0].status).toBe('accepted');
    expect(progress.archive[1].status).toBe('rejected');
    expect(progress.archive[2].status).toBe('accepted');

    // Memories should record both successes and failures
    expect(progress.memories.filter(m => m.outcome === 'success')).toHaveLength(2);
    expect(progress.memories.filter(m => m.outcome === 'failure')).toHaveLength(1);

    // Summary methods should return meaningful content
    const archiveSummary = engine.getArchiveSummary();
    expect(archiveSummary).toContain('Gen 1');
    expect(archiveSummary).toContain('Gen 3');
    expect(archiveSummary).toContain('✅');
    expect(archiveSummary).toContain('❌');

    const memorySummary = engine.getMemorySummary();
    expect(memorySummary).toContain('Successful Patterns');
    expect(memorySummary).toContain('Failed Patterns');
  });

  it('should provide correct config', () => {
    const engine = new SelfEvolutionEngine({ sourceRoot: tmpDir, maxGenerations: 10 });
    const config = engine.getConfig();

    expect(config.sourceRoot).toBe(tmpDir);
    expect(config.maxGenerations).toBe(10);
    expect(config.baseBranch).toBe('self-evolution');
    expect(config.branchPrefix).toBe('evo/');
    expect(config.immutableFiles).toEqual(DEFAULT_EVOLUTION_CONFIG.immutableFiles);
  });

  it('should maintain branch hygiene after accept/reject cycles', async () => {
    const engine = new SelfEvolutionEngine({ sourceRoot: tmpDir });
    await engine.preflight();

    const gitOps = new SafeGitOps(tmpDir);
    const mainBranch = gitOps.getCurrentBranch();

    // Run an accepted iteration
    mockEvaluate.mockReturnValueOnce(mockFitness({ score: 0.75 }));
    await engine.runSingleIteration('Feature A', async dir => {
      fs.writeFileSync(path.join(dir, 'src', 'utils.ts'), '// v2\n');
      return ['src/utils.ts'];
    });

    // Should be back on main branch
    expect(gitOps.getCurrentBranch()).toBe(mainBranch);
    // Workspace should be clean
    expect(gitOps.isClean()).toBe(true);

    // Run a rejected iteration
    mockEvaluate.mockReturnValueOnce(mockFitness({ score: 0.2, tscPassed: false, failedTests: 50 }));
    await engine.runSingleIteration('Bad Feature', async dir => {
      fs.writeFileSync(path.join(dir, 'src', 'utils.ts'), '// bad\n');
      return ['src/utils.ts'];
    });

    // Should still be on main branch
    expect(gitOps.getCurrentBranch()).toBe(mainBranch);
    // Workspace should be clean
    expect(gitOps.isClean()).toBe(true);
  });

  it('should reject when tsc fails even if score is high', async () => {
    const engine = new SelfEvolutionEngine({ sourceRoot: tmpDir });
    await engine.preflight();

    // High score but tsc fails
    mockEvaluate.mockReturnValueOnce(mockFitness({ score: 0.9, tscPassed: false, tscErrors: 5 }));
    const result = await engine.runSingleIteration('Type errors', async dir => {
      fs.writeFileSync(path.join(dir, 'src', 'utils.ts'), 'export const x: string = 42; // type error\n');
      return ['src/utils.ts'];
    });

    expect(result.success).toBe(false);
    expect(result.entry?.status).toBe('rejected');
  });
});

// ═══════════════════════════════════════
// ImmutableGuard E2E
// ═══════════════════════════════════════

describe('ImmutableGuard E2E — full file lifecycle', () => {
  beforeEach(() => {
    tmpDir = createTmpProject();
  });

  afterEach(cleanup);

  it('should protect multiple files through modify/verify cycles', () => {
    const guard = new ImmutableGuard(tmpDir, ['vitest.config.ts', 'tsconfig.json', 'scripts/quality-gate.js']);

    // Capture baseline
    const manifest = guard.captureBaseline();
    expect(Object.keys(manifest)).toHaveLength(3);

    // Verify all clean
    expect(guard.verify().ok).toBe(true);

    // Modify one file
    fs.writeFileSync(path.join(tmpDir, 'vitest.config.ts'), 'HACKED');
    const r1 = guard.verify();
    expect(r1.ok).toBe(false);
    expect(r1.violations).toHaveLength(1);
    expect(r1.violations[0]).toContain('vitest.config.ts');

    // Restore it
    fs.writeFileSync(path.join(tmpDir, 'vitest.config.ts'), 'export default { test: {} }');
    expect(guard.verify().ok).toBe(true);

    // Delete one file
    fs.unlinkSync(path.join(tmpDir, 'tsconfig.json'));
    const r2 = guard.verify();
    expect(r2.ok).toBe(false);
    expect(r2.violations[0]).toContain('tsconfig.json');
  });

  it('should support manifest save/restore across instances', () => {
    const guard1 = new ImmutableGuard(tmpDir, ['vitest.config.ts']);
    const manifest = guard1.captureBaseline();

    // Simulate persistence (JSON round-trip)
    const serialized = JSON.stringify(manifest);
    const restored = JSON.parse(serialized);

    const guard2 = new ImmutableGuard(tmpDir, ['vitest.config.ts']);
    guard2.restoreManifest(restored);

    expect(guard2.verify().ok).toBe(true);

    // Modify file
    fs.writeFileSync(path.join(tmpDir, 'vitest.config.ts'), 'CHANGED');
    expect(guard2.verify().ok).toBe(false);
  });
});

// ═══════════════════════════════════════
// SafeGitOps E2E — branch/merge lifecycle
// ═══════════════════════════════════════

describe('SafeGitOps E2E — multi-branch workflow', () => {
  let gitDir: string;

  beforeEach(() => {
    gitDir = createTmpProject();
    tmpDir = gitDir;
  });

  afterEach(cleanup);

  it('should handle feature branch create → modify → merge → delete cycle', () => {
    const ops = new SafeGitOps(gitDir);
    const main = ops.getCurrentBranch();

    // Create feature branch
    ops.createBranch('evo/feature-1', main);
    expect(ops.getCurrentBranch()).toBe('evo/feature-1');

    // Make changes
    fs.writeFileSync(path.join(gitDir, 'src', 'feature.ts'), 'export const feature = true;');
    const hash = ops.commitAll('add feature');
    expect(hash).toMatch(/^[a-f0-9]{40}$/);

    // Switch back and merge
    ops.checkout(main);
    expect(fs.existsSync(path.join(gitDir, 'src', 'feature.ts'))).toBe(false); // Not on main yet

    const merged = ops.merge('evo/feature-1', 'merge feature-1');
    expect(merged).toBe(true);
    expect(fs.existsSync(path.join(gitDir, 'src', 'feature.ts'))).toBe(true); // Now on main

    // Delete branch
    ops.deleteBranch('evo/feature-1');
    expect(ops.branchExists('evo/feature-1')).toBe(false);
  });

  it('should snapshot and rollback correctly', () => {
    const ops = new SafeGitOps(gitDir);

    // Snapshot current state
    ops.createSnapshot('safe-point');

    // Make changes
    fs.writeFileSync(path.join(gitDir, 'src', 'utils.ts'), 'MODIFIED CONTENT');
    ops.commitAll('break things');
    expect(fs.readFileSync(path.join(gitDir, 'src', 'utils.ts'), 'utf-8')).toBe('MODIFIED CONTENT');

    // Rollback
    ops.rollbackToSnapshot('safe-point');
    const restored = fs.readFileSync(path.join(gitDir, 'src', 'utils.ts'), 'utf-8');
    expect(restored).toContain('export const add');
    expect(restored).not.toContain('MODIFIED CONTENT');
  });

  it('should report diff stats and changed files', () => {
    const ops = new SafeGitOps(gitDir);
    const before = ops.getHead();

    fs.writeFileSync(path.join(gitDir, 'src', 'new.ts'), 'new file');
    fs.writeFileSync(path.join(gitDir, 'src', 'utils.ts'), 'modified');
    ops.commitAll('multiple changes');

    const changed = ops.getChangedFiles(before);
    expect(changed).toContain('src/new.ts');
    expect(changed).toContain('src/utils.ts');

    const stat = ops.getDiffStat(before);
    expect(stat).toContain('src/new.ts');
  });
});
