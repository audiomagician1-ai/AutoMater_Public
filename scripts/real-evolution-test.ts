/**
 * 真实环境集成测试 — 自我进化引擎
 *
 * ⚠️ 此测试在 AgentForge 真实仓库上运行，会:
 *   - 创建/删除 git 分支
 *   - 修改/恢复文件
 *   - 运行真实的 tsc 和 vitest
 *
 * 运行方式:
 *   npx vitest run scripts/real-evolution-test.ts
 *
 * 前提:
 *   - git 工作区必须干净 (已提交所有变更)
 *   - 当前在 self-evolution 分支上
 *
 * 测试场景:
 *   1. preflight() — 真实 tsc + vitest 基线评估
 *   2. 安全修改 → fitness 通过 → 合并 → 回退
 *   3. 修改 immutable 文件 → 引擎拦截
 *   4. 导致 tsc 失败的修改 → 自动回滚
 *   5. 导致测试失败的修改 → 自动回滚
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import {
  SelfEvolutionEngine,
  SafeGitOps,
  ImmutableGuard,
  FitnessEvaluator,
  DEFAULT_IMMUTABLE_FILES,
  DEFAULT_PROTECTED_FILES,
  type EvolutionConfig,
  type FitnessResult,
} from '../electron/engine/self-evolution-engine';
import { checkEvolutionPaths } from '../electron/engine/guards';

// ═══════════════════════════════════════
// Constants
// ═══════════════════════════════════════

const SOURCE_ROOT = path.resolve(__dirname, '..');
const ORIGINAL_BRANCH = 'self-evolution';

// 用于安全修改的目标文件 (一个不影响任何测试的常量文件)
const SAFE_TARGET = 'electron/engine/constants.ts';
// 用于 tsc 破坏的文件
const TSC_BREAK_TARGET = 'electron/engine/constants.ts';
// 用于测试破坏的文件 (一个被测试覆盖的模块)
const TEST_BREAK_TARGET = 'electron/engine/decision-log.ts';

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

function git(args: string): string {
  return execSync(`git ${args}`, {
    cwd: SOURCE_ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function getCurrentBranch(): string {
  return git('branch --show-current');
}

function isClean(): boolean {
  return !git('status --porcelain');
}

function getHead(): string {
  return git('rev-parse HEAD');
}

/** 清理所有 evo/* 分支和 evo-snapshot-* tags */
function cleanupEvoBranches(): void {
  try {
    const branches = git('branch --list "evo/*"')
      .split('\n')
      .map(b => b.trim().replace('* ', ''))
      .filter(Boolean);
    for (const b of branches) {
      try {
        git(`branch -D "${b}"`);
      } catch {
        // ignore
      }
    }
  } catch {
    // no evo branches
  }
  try {
    const tags = git('tag --list "evo-snapshot-*"')
      .split('\n')
      .filter(Boolean);
    for (const t of tags) {
      try {
        git(`tag -d "${t}"`);
      } catch {
        // ignore
      }
    }
  } catch {
    // no tags
  }
}

// ═══════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════

describe('Real Evolution Engine Integration', { timeout: 600_000 }, () => {
  let headBefore: string;

  beforeAll(() => {
    // 前置条件检查
    expect(SelfEvolutionEngine.isAgentForgeRoot(SOURCE_ROOT)).toBe(true);
    expect(getCurrentBranch()).toBe(ORIGINAL_BRANCH);
    expect(isClean()).toBe(true);
    headBefore = getHead();
    console.log(`\n📍 Starting real integration tests`);
    console.log(`   Source: ${SOURCE_ROOT}`);
    console.log(`   Branch: ${ORIGINAL_BRANCH}`);
    console.log(`   HEAD:   ${headBefore.slice(0, 8)}`);
  });

  afterEach(() => {
    // 每个测试后确保回到原始分支且工作区干净
    const currentBranch = getCurrentBranch();
    if (currentBranch !== ORIGINAL_BRANCH) {
      console.warn(`⚠️ afterEach: on branch ${currentBranch}, switching back to ${ORIGINAL_BRANCH}`);
      git(`checkout ${ORIGINAL_BRANCH}`);
    }
    // 如果有未提交更改，丢弃
    if (!isClean()) {
      console.warn(`⚠️ afterEach: dirty working tree, resetting`);
      git(`checkout -- .`);
      git(`clean -fd`);
    }
    // 清理 evo 分支/tags
    cleanupEvoBranches();
  });

  afterAll(() => {
    // 最终保护：确保 HEAD 回到最初状态
    const headAfter = getHead();
    const branch = getCurrentBranch();
    console.log(`\n📍 Final state: branch=${branch}, HEAD=${headAfter.slice(0, 8)}`);
    if (branch !== ORIGINAL_BRANCH) {
      git(`checkout ${ORIGINAL_BRANCH}`);
    }
    // 如果 HEAD 往前了 (因为场景2的合并)，回退
    if (headAfter !== headBefore) {
      console.log(`📍 Resetting HEAD from ${headAfter.slice(0, 8)} back to ${headBefore.slice(0, 8)}`);
      git(`reset --hard ${headBefore}`);
    }
    cleanupEvoBranches();
  });

  // ─── 场景 1: Preflight (真实 tsc + vitest) ─────────────

  it('Scenario 1: preflight passes with real tsc + vitest', async () => {
    console.log('\n🔬 Scenario 1: Preflight with real tsc + vitest');
    const engine = new SelfEvolutionEngine({ sourceRoot: SOURCE_ROOT });

    const result = await engine.preflight();

    console.log(`   preflight ok: ${result.ok}`);
    console.log(`   errors: ${result.errors.length ? result.errors.join('; ') : 'none'}`);
    if (result.baselineFitness) {
      const f = result.baselineFitness;
      console.log(`   baseline fitness: ${f.score.toFixed(4)}`);
      console.log(`   tsc: ${f.tscPassed ? 'PASS' : 'FAIL'} (${f.tscErrors} errors, ${f.durations.tsc}ms)`);
      console.log(`   tests: ${f.passedTests}/${f.totalTests} passed (${f.durations.vitest}ms)`);
      console.log(`   coverage: ${f.statementCoverage}%`);
    }

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.baselineFitness).toBeDefined();
    expect(result.baselineFitness!.tscPassed).toBe(true);
    expect(result.baselineFitness!.passedTests).toBeGreaterThan(900);
    expect(result.baselineFitness!.failedTests).toBe(0);
    expect(result.baselineFitness!.score).toBeGreaterThan(0.5);
  });

  // ─── 场景 2: 安全修改 → fitness 通过 → 合并 ─────────────

  it('Scenario 2: safe modification → fitness pass → merge', async () => {
    console.log('\n🔬 Scenario 2: Safe modification → merge');
    const engine = new SelfEvolutionEngine({ sourceRoot: SOURCE_ROOT });

    // 先执行 preflight 以建立基线
    const pre = await engine.preflight();
    expect(pre.ok).toBe(true);
    console.log(`   baseline fitness: ${pre.baselineFitness!.score.toFixed(4)}`);

    // 执行一次安全修改 — 仅添加一行注释到 constants.ts
    const result = await engine.runSingleIteration(
      'Add harmless comment to constants.ts',
      async (workingDir: string) => {
        const targetPath = path.join(workingDir, SAFE_TARGET);
        const original = fs.readFileSync(targetPath, 'utf-8');
        const modified = `// [evo-test] Safe modification timestamp: ${Date.now()}\n${original}`;
        fs.writeFileSync(targetPath, modified, 'utf-8');
        return [SAFE_TARGET];
      },
    );

    console.log(`   success: ${result.success}`);
    console.log(`   rolledBack: ${result.rolledBack}`);
    if (result.entry) {
      console.log(`   fitness: ${result.entry.fitnessScore.toFixed(4)}`);
      console.log(`   status: ${result.entry.status}`);
      console.log(`   branch: ${result.entry.branch}`);
    }
    if (result.error) {
      console.log(`   error: ${result.error}`);
    }

    expect(result.success).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(result.entry).toBeDefined();
    expect(result.entry!.status).toBe('accepted');
    expect(result.entry!.fitness.tscPassed).toBe(true);
    expect(result.entry!.fitness.failedTests).toBe(0);

    // 验证修改已合并 (文件开头有注释)
    const content = fs.readFileSync(path.join(SOURCE_ROOT, SAFE_TARGET), 'utf-8');
    expect(content).toContain('[evo-test] Safe modification timestamp');

    console.log('   ✅ Safe modification accepted and merged');

    // 注意: afterAll 会 reset --hard 回到原始 HEAD
  });

  // ─── 场景 3: 修改 immutable 文件 → 拦截 ─────────────

  it('Scenario 3: modifying immutable file → blocked', async () => {
    console.log('\n🔬 Scenario 3: Immutable file protection');
    const engine = new SelfEvolutionEngine({ sourceRoot: SOURCE_ROOT });

    // preflight
    const pre = await engine.preflight();
    expect(pre.ok).toBe(true);

    // 尝试修改 immutable 文件 (vitest.config.ts)
    const immutableTarget = 'vitest.config.ts';
    const result = await engine.runSingleIteration(
      'Attempt to modify vitest.config.ts (SHOULD FAIL)',
      async (workingDir: string) => {
        const targetPath = path.join(workingDir, immutableTarget);
        const original = fs.readFileSync(targetPath, 'utf-8');
        fs.writeFileSync(targetPath, `// HACKED\n${original}`, 'utf-8');
        return [immutableTarget];
      },
    );

    console.log(`   success: ${result.success}`);
    console.log(`   rolledBack: ${result.rolledBack}`);
    console.log(`   error: ${result.error || 'none'}`);

    // 应该被拦截
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('IMMUTABLE');

    // 验证文件未被修改
    const content = fs.readFileSync(path.join(SOURCE_ROOT, immutableTarget), 'utf-8');
    expect(content).not.toContain('HACKED');

    // 同时验证 guards.ts 的 checkEvolutionPaths
    const guardCheck = checkEvolutionPaths(DEFAULT_IMMUTABLE_FILES);
    expect(guardCheck.ok).toBe(false);
    expect(guardCheck.immutable.length).toBe(DEFAULT_IMMUTABLE_FILES.length);

    console.log('   ✅ Immutable file protection working correctly');
  });

  // ─── 场景 4: tsc 失败 → 回滚 ─────────────

  it('Scenario 4: tsc-breaking modification → rejection/rollback', async () => {
    console.log('\n🔬 Scenario 4: tsc-breaking modification');
    const engine = new SelfEvolutionEngine({ sourceRoot: SOURCE_ROOT });

    const pre = await engine.preflight();
    expect(pre.ok).toBe(true);

    // 注入一个 TypeScript 错误
    const result = await engine.runSingleIteration(
      'Inject TypeScript error into constants.ts',
      async (workingDir: string) => {
        const targetPath = path.join(workingDir, TSC_BREAK_TARGET);
        const original = fs.readFileSync(targetPath, 'utf-8');
        // 添加一个明显的类型错误
        const broken = `${original}\n\n// Injected tsc error\nconst ___evoTest: number = "not a number";\n`;
        fs.writeFileSync(targetPath, broken, 'utf-8');
        return [TSC_BREAK_TARGET];
      },
    );

    console.log(`   success: ${result.success}`);
    console.log(`   rolledBack: ${result.rolledBack}`);
    if (result.entry) {
      console.log(`   fitness: ${result.entry.fitnessScore.toFixed(4)}`);
      console.log(`   tsc passed: ${result.entry.fitness.tscPassed}`);
      console.log(`   tsc errors: ${result.entry.fitness.tscErrors}`);
      console.log(`   status: ${result.entry.status}`);
    }

    // 应该被拒绝 (tsc 失败 → shouldAccept returns false → rejected)
    expect(result.success).toBe(false);
    // 拒绝但不一定是 rollback (拒绝走 rejected 路径，不是 throw 路径)
    // 引擎会 checkout 回原始分支
    expect(result.entry).toBeDefined();
    expect(result.entry!.status).toBe('rejected');
    expect(result.entry!.fitness.tscPassed).toBe(false);

    // 验证工作区干净且文件未被改动
    const content = fs.readFileSync(path.join(SOURCE_ROOT, TSC_BREAK_TARGET), 'utf-8');
    expect(content).not.toContain('___evoTest');
    expect(getCurrentBranch()).toBe(ORIGINAL_BRANCH);

    console.log('   ✅ tsc-breaking modification correctly rejected');
  });

  // ─── 场景 5: 测试失败 → 回滚 ─────────────

  it('Scenario 5: test-breaking modification → rejection', async () => {
    console.log('\n🔬 Scenario 5: test-breaking modification');

    // 首先检查 decision-log.ts 是否存在且被测试覆盖
    const testBreakTargetPath = path.join(SOURCE_ROOT, TEST_BREAK_TARGET);
    if (!fs.existsSync(testBreakTargetPath)) {
      console.log(`   ⚠️ ${TEST_BREAK_TARGET} not found, skipping`);
      return;
    }

    const engine = new SelfEvolutionEngine({ sourceRoot: SOURCE_ROOT });

    const pre = await engine.preflight();
    expect(pre.ok).toBe(true);

    // 注入一个会让现有测试失败的修改:
    // 在 claimFiles() 函数体开头注入 return [], 使其不写 claim 记录
    // 这样 decision-log.test.ts 的 "单 worker claim 后可查到活跃声明" 会失败
    // 因为 expect(claims.size).toBe(2) 会得到 0
    const result = await engine.runSingleIteration(
      'Break test by neutering claimFiles() in decision-log.ts',
      async (workingDir: string) => {
        const targetPath = path.join(workingDir, TEST_BREAK_TARGET);
        const original = fs.readFileSync(targetPath, 'utf-8');

        // 在 claimFiles 函数体开头注入 early return
        // 查找 claimFiles 函数体内的第一行: "const normalizedFiles = ..."
        const needle = 'const normalizedFiles = plannedFiles.map';
        const idx = original.indexOf(needle);

        if (idx !== -1) {
          const broken = original.slice(0, idx)
            + '/* [evo-test] Neutered */ return [];\n  '
            + original.slice(idx);
          fs.writeFileSync(targetPath, broken, 'utf-8');
        } else {
          // 备选: 在文件末尾添加一个会在 import 时 throw 的语句
          console.log('   ⚠️ Primary injection failed, using fallback');
          const fallback = original + '\n\nthrow new Error("EVO_TEST_BREAK");\n';
          fs.writeFileSync(targetPath, fallback, 'utf-8');
        }

        return [TEST_BREAK_TARGET];
      },
    );

    console.log(`   success: ${result.success}`);
    console.log(`   rolledBack: ${result.rolledBack}`);
    if (result.entry) {
      console.log(`   fitness: ${result.entry.fitnessScore.toFixed(4)}`);
      console.log(`   tsc: ${result.entry.fitness.tscPassed}`);
      console.log(`   tests: ${result.entry.fitness.passedTests}/${result.entry.fitness.totalTests}`);
      console.log(`   failed: ${result.entry.fitness.failedTests}`);
      console.log(`   status: ${result.entry.status}`);
    }
    if (result.error) {
      console.log(`   error: ${result.error}`);
    }

    // 结果应该是 rejected (测试失败)
    expect(result.success).toBe(false);
    if (result.entry) {
      expect(result.entry.status).toBe('rejected');
      // 测试应该有失败
      expect(result.entry.fitness.failedTests).toBeGreaterThan(0);
    } else {
      // 也可能走了 error 路径 (例如 import 时 throw)
      expect(result.rolledBack).toBe(true);
    }

    // 验证工作区恢复
    const content = fs.readFileSync(testBreakTargetPath, 'utf-8');
    expect(content).not.toContain('evo-test');
    expect(content).not.toContain('EVO_TEST_BREAK');
    expect(getCurrentBranch()).toBe(ORIGINAL_BRANCH);

    console.log('   ✅ test-breaking modification correctly rejected');
  });

  // ─── 补充场景: ImmutableGuard hash 验证 ─────────────

  it('Scenario 3b: stealth immutable modification detected by hash verification', async () => {
    console.log('\n🔬 Scenario 3b: Hash-based immutable detection');
    const engine = new SelfEvolutionEngine({ sourceRoot: SOURCE_ROOT });

    const pre = await engine.preflight();
    expect(pre.ok).toBe(true);

    // 修改 immutable 文件但不在 modifiedFiles 列表中报告 (stealth attack)
    const immutableTarget = 'vitest.config.ts';
    const result = await engine.runSingleIteration(
      'Stealth modify vitest.config.ts without reporting',
      async (workingDir: string) => {
        // 偷偷修改 immutable 文件
        const targetPath = path.join(workingDir, immutableTarget);
        const original = fs.readFileSync(targetPath, 'utf-8');
        fs.writeFileSync(targetPath, `${original}\n// stealth hack\n`, 'utf-8');
        // 但只报告修改了一个安全文件
        const safePath = path.join(workingDir, SAFE_TARGET);
        const safeOriginal = fs.readFileSync(safePath, 'utf-8');
        fs.writeFileSync(safePath, `// harmless\n${safeOriginal}`, 'utf-8');
        return [SAFE_TARGET]; // 故意不报告 immutable 文件
      },
    );

    console.log(`   success: ${result.success}`);
    console.log(`   rolledBack: ${result.rolledBack}`);
    console.log(`   error: ${result.error || 'none'}`);

    // 应该被 hash 验证拦截
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('IMMUTABLE');

    // 验证文件恢复
    const content = fs.readFileSync(path.join(SOURCE_ROOT, immutableTarget), 'utf-8');
    expect(content).not.toContain('stealth hack');

    console.log('   ✅ Stealth immutable modification detected by SHA256 hash verification');
  });

  // ─── 补充场景: guards.ts checkEvolutionPaths ─────────────

  it('Scenario 6: guards.ts correctly classifies file paths', () => {
    console.log('\n🔬 Scenario 6: guards.ts path classification');

    // Immutable files
    const immutableCheck = checkEvolutionPaths([
      'vitest.config.ts',
      'tsconfig.json',
      'electron/engine/self-evolution-engine.ts',
    ]);
    expect(immutableCheck.ok).toBe(false);
    expect(immutableCheck.immutable.length).toBe(3);
    console.log(`   Immutable: ${immutableCheck.immutable.length} files correctly identified`);

    // Protected files
    const protectedCheck = checkEvolutionPaths([
      'electron/main.ts',
      'electron/db.ts',
      'package.json',
    ]);
    expect(protectedCheck.ok).toBe(true); // protected is allowed but flagged
    expect(protectedCheck.protected_.length).toBe(3);
    console.log(`   Protected: ${protectedCheck.protected_.length} files correctly identified`);

    // Allowed files
    const allowedCheck = checkEvolutionPaths([
      'electron/engine/constants.ts',
      'electron/engine/prompts.ts',
      'src/pages/GuidePage.tsx',
    ]);
    expect(allowedCheck.ok).toBe(true);
    expect(allowedCheck.allowed.length).toBe(3);
    expect(allowedCheck.immutable.length).toBe(0);
    console.log(`   Allowed: ${allowedCheck.allowed.length} files correctly identified`);

    // Mixed
    const mixedCheck = checkEvolutionPaths([
      'electron/engine/constants.ts',   // allowed
      'electron/main.ts',              // protected
      'vitest.config.ts',              // immutable
    ]);
    expect(mixedCheck.ok).toBe(false);
    expect(mixedCheck.immutable.length).toBe(1);
    expect(mixedCheck.protected_.length).toBe(1);
    expect(mixedCheck.allowed.length).toBe(1);
    console.log(`   Mixed: correctly classified (1 immutable, 1 protected, 1 allowed)`);

    console.log('   ✅ guards.ts path classification working correctly');
  });
});
