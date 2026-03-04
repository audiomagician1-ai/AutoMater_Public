/**
 * Self-Evolution Engine — 自我迭代基础设施 (Phase 0)
 *
 * 实现 AutoMater 自我修改源代码的安全基础设施:
 *
 *  1. SafeGitOps        — 安全 git 操作 (分支、提交、回滚、diff)
 *  2. ImmutableGuard     — 不可变文件保护 (SHA256 hash 校验)
 *  3. FitnessEvaluator   — 综合适应度评估 (tsc + vitest + coverage)
 *  4. SelfEvolutionEngine — 编排自我修改的完整循环
 *
 * 安全原则:
 *  - 所有修改在独立 git 分支上进行
 *  - 修改前创建安全快照 (git tag)
 *  - 禁止修改的文件通过 SHA256 hash 校验
 *  - Quality Gate 通过后才合并到基线分支
 *  - 失败时自动回滚到快照
 *
 * @module self-evolution-engine
 * @version 0.1.0
 */

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createLogger } from './logger';

const log = createLogger('self-evolution');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface EvolutionConfig {
  /** AutoMater 源码根目录 */
  sourceRoot: string;
  /** 基线分支 (默认 'self-evolution') */
  baseBranch: string;
  /** 进化分支前缀 (默认 'evo/') */
  branchPrefix: string;
  /** 最大进化代数 (默认 50) */
  maxGenerations: number;
  /** 适应度权重 */
  fitnessWeights: FitnessWeights;
  /** 禁止修改的文件列表 (相对于 sourceRoot) */
  immutableFiles: string[];
  /** 安全保护的核心文件列表 (修改需要额外审查) */
  protectedFiles: string[];
  /** 超时设置 (ms) */
  timeouts: {
    tsc: number;
    vitest: number;
    build: number;
  };
}

export interface FitnessWeights {
  testPassRate: number; // 测试通过率权重 (0-1)
  coverageDelta: number; // 覆盖率变化权重 (0-1)
  tscClean: number; // 类型检查通过权重 (0-1)
  regressionPenalty: number; // 退化惩罚权重 (0-1)
}

export interface FitnessResult {
  /** 综合适应度得分 (0-1) */
  score: number;
  /** tsc 是否通过 */
  tscPassed: boolean;
  /** tsc 错误数 */
  tscErrors: number;
  /** 测试通过率 (0-1) */
  testPassRate: number;
  /** 总测试数 */
  totalTests: number;
  /** 通过测试数 */
  passedTests: number;
  /** 失败测试数 */
  failedTests: number;
  /** 语句覆盖率 (0-100) */
  statementCoverage: number;
  /** 基线覆盖率 (用于计算 delta) */
  baselineCoverage: number;
  /** 各步骤耗时 (ms) */
  durations: {
    tsc: number;
    vitest: number;
    total: number;
  };
  /** 详细输出 (用于调试) */
  details: string;
}

export interface EvolutionEntry {
  id: string;
  parentId: string | null;
  generation: number;
  branch: string;
  fitnessScore: number;
  fitness: FitnessResult;
  description: string;
  modifiedFiles: string[];
  timestamp: number;
  status: 'pending' | 'evaluating' | 'accepted' | 'rejected' | 'rolled_back';
}

export interface EvolutionMemoryEntry {
  pattern: string;
  outcome: 'success' | 'failure';
  module: string;
  description: string;
  fitnessImpact: number;
  timestamp: number;
}

export interface EvolutionRunResult {
  success: boolean;
  entry?: EvolutionEntry;
  error?: string;
  rolledBack: boolean;
}

export interface HashManifest {
  /** 文件路径 → SHA256 hash */
  [filePath: string]: string;
}

// ═══════════════════════════════════════
// Default Configuration
// ═══════════════════════════════════════

/** 禁止修改的文件 (进化过程中绝对不可触碰) */
export const DEFAULT_IMMUTABLE_FILES = [
  'vitest.config.ts',
  'tsconfig.json',
  'scripts/quality-gate.js',
  'scripts/evaluate-fitness.js',
  'electron/engine/self-evolution-engine.ts',
  'electron/engine/__tests__/self-evolution-engine.test.ts',
];

/** 安全保护的核心文件 (修改需要更严格的验证) */
export const DEFAULT_PROTECTED_FILES = [
  'electron/main.ts',
  'electron/db.ts',
  'electron/preload.ts',
  'electron/engine/guards.ts',
  'electron/engine/sandbox-executor.ts',
  'electron/engine/tool-executor.ts',
  'package.json',
  'electron-builder.yml',
];

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  sourceRoot: '',
  baseBranch: 'self-evolution',
  branchPrefix: 'evo/',
  maxGenerations: 50,
  fitnessWeights: {
    testPassRate: 0.4,
    coverageDelta: 0.2,
    tscClean: 0.3,
    regressionPenalty: 0.1,
  },
  immutableFiles: DEFAULT_IMMUTABLE_FILES,
  protectedFiles: DEFAULT_PROTECTED_FILES,
  timeouts: {
    tsc: 120_000,
    vitest: 300_000,
    build: 300_000,
  },
};

// ═══════════════════════════════════════
// 1. SafeGitOps — 安全 Git 操作
// ═══════════════════════════════════════

export class SafeGitOps {
  constructor(private readonly repoPath: string) {}

  /** 执行 git 命令 (同步) */
  private git(args: string, timeoutMs = 30_000): string {
    try {
      return execSync(`git ${args}`, {
        cwd: this.repoPath,
        timeout: timeoutMs,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
      throw new Error(`git ${args.split(' ')[0]} failed: ${msg}`);
    }
  }

  /** 获取当前分支名 */
  getCurrentBranch(): string {
    return this.git('branch --show-current');
  }

  /** 分支是否存在 */
  branchExists(branch: string): boolean {
    try {
      this.git(`rev-parse --verify ${branch}`);
      return true;
    } catch {
      return false;
    }
  }

  /** 创建并切换到新分支 (从指定基础分支) */
  createBranch(name: string, from: string): void {
    if (this.branchExists(name)) {
      throw new Error(`Branch ${name} already exists`);
    }
    this.git(`checkout -b ${name} ${from}`);
    log.info(`Created branch ${name} from ${from}`);
  }

  /** 切换到已有分支 */
  checkout(branch: string): void {
    this.git(`checkout ${branch}`);
  }

  /** 创建安全快照 tag */
  createSnapshot(tag: string): void {
    try {
      this.git(`tag -d ${tag}`);
    } catch {
      // tag 不存在，忽略
    }
    this.git(`tag ${tag}`);
    log.info(`Created snapshot tag: ${tag}`);
  }

  /** 回滚到快照 tag */
  rollbackToSnapshot(tag: string): void {
    this.git(`reset --hard ${tag}`);
    log.info(`Rolled back to snapshot: ${tag}`);
  }

  /** 删除 tag */
  deleteTag(tag: string): void {
    try {
      this.git(`tag -d ${tag}`);
    } catch {
      // 已不存在
    }
  }

  /** 暂存所有更改并提交 */
  commitAll(message: string): string {
    this.git('add -A');
    // 检查是否有东西要提交
    try {
      const status = this.git('status --porcelain');
      if (!status) {
        log.info('Nothing to commit');
        return this.getHead();
      }
    } catch {
      // status 失败，继续尝试提交
    }
    // --no-verify: 跳过 pre-commit hooks (lint-staged / typecheck)
    // 进化引擎自己通过 FitnessEvaluator 做更全面的质量评估
    // 如果让 hooks 先拦截，引擎就无法走到 fitness → accept/reject 决策路径
    this.git(`commit --no-verify -m "${message.replace(/"/g, '\\"')}"`);
    return this.getHead();
  }

  /** 获取 HEAD commit hash */
  getHead(): string {
    return this.git('rev-parse HEAD');
  }

  /** 获取两个 commit 之间修改的文件列表 */
  getChangedFiles(from: string, to = 'HEAD'): string[] {
    try {
      const output = this.git(`diff --name-only ${from} ${to}`);
      return output ? output.split('\n').filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  /** 获取工作区是否干净 */
  isClean(): boolean {
    const status = this.git('status --porcelain');
    return !status;
  }

  /** 合并分支到当前分支 (fast-forward only for safety) */
  mergeFastForward(branch: string): boolean {
    try {
      this.git(`merge --ff-only ${branch}`);
      return true;
    } catch {
      log.warn(`Fast-forward merge of ${branch} failed`);
      return false;
    }
  }

  /** 合并分支 (允许 merge commit) */
  merge(branch: string, message: string): boolean {
    try {
      this.git(`merge --no-verify --no-ff -m "${message.replace(/"/g, '\\"')}" ${branch}`);
      return true;
    } catch {
      // 合并冲突 — 中止
      try {
        this.git('merge --abort');
      } catch {
        // 已经没有在合并中
      }
      log.warn(`Merge of ${branch} failed (conflicts)`);
      return false;
    }
  }

  /** 删除本地分支 */
  deleteBranch(branch: string): void {
    try {
      this.git(`branch -D ${branch}`);
    } catch {
      // 分支可能不存在
    }
  }

  /** 获取 diff 统计 */
  getDiffStat(from: string, to = 'HEAD'): string {
    try {
      return this.git(`diff --stat ${from} ${to}`);
    } catch {
      return '(diff unavailable)';
    }
  }

  /** 获取最近 N 个 commit log */
  getLog(count = 5): string {
    return this.git(`log --oneline -${count}`);
  }
}

// ═══════════════════════════════════════
// 2. ImmutableGuard — 不可变文件保护
// ═══════════════════════════════════════

export class ImmutableGuard {
  private manifest: HashManifest = {};

  constructor(
    private readonly sourceRoot: string,
    private readonly immutableFiles: string[],
  ) {}

  /** 计算文件的 SHA256 hash */
  private hashFile(filePath: string): string {
    const absPath = path.resolve(this.sourceRoot, filePath);
    if (!fs.existsSync(absPath)) {
      return 'FILE_NOT_FOUND';
    }
    const content = fs.readFileSync(absPath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /** 拍摄当前不可变文件的 hash 快照 (基线) */
  captureBaseline(): HashManifest {
    this.manifest = {};
    for (const file of this.immutableFiles) {
      this.manifest[file] = this.hashFile(file);
    }
    log.info(`Immutable baseline captured: ${Object.keys(this.manifest).length} files`);
    return { ...this.manifest };
  }

  /** 验证不可变文件是否被修改 */
  verify(): { ok: boolean; violations: string[] } {
    const violations: string[] = [];
    for (const [file, expectedHash] of Object.entries(this.manifest)) {
      const currentHash = this.hashFile(file);
      if (currentHash !== expectedHash) {
        violations.push(
          `IMMUTABLE VIOLATION: ${file} — expected ${expectedHash.slice(0, 12)}..., got ${currentHash.slice(0, 12)}...`,
        );
      }
    }
    if (violations.length > 0) {
      log.error(`Immutable guard violations: ${violations.length}`, { violations });
    }
    return { ok: violations.length === 0, violations };
  }

  /** 检查一组文件路径是否包含不可变文件 */
  checkPaths(filePaths: string[]): { ok: boolean; blockedFiles: string[] } {
    const normalizedImmutable = new Set(this.immutableFiles.map(f => path.normalize(f).replace(/\\/g, '/')));
    const blockedFiles: string[] = [];
    for (const fp of filePaths) {
      const normalized = path.normalize(fp).replace(/\\/g, '/');
      if (normalizedImmutable.has(normalized)) {
        blockedFiles.push(fp);
      }
    }
    return { ok: blockedFiles.length === 0, blockedFiles };
  }

  /** 获取当前 manifest */
  getManifest(): HashManifest {
    return { ...this.manifest };
  }

  /** 从已保存的 manifest 恢复 */
  restoreManifest(manifest: HashManifest): void {
    this.manifest = { ...manifest };
  }
}

// ═══════════════════════════════════════
// 3. FitnessEvaluator — 适应度评估器
// ═══════════════════════════════════════

export class FitnessEvaluator {
  constructor(
    private readonly sourceRoot: string,
    private readonly weights: FitnessWeights,
    private readonly timeouts: EvolutionConfig['timeouts'],
  ) {}

  /** 执行命令并捕获输出 */
  private exec(cmd: string, timeoutMs: number): { stdout: string; stderr: string; exitCode: number; duration: number } {
    const start = Date.now();
    try {
      const stdout = execSync(cmd, {
        cwd: this.sourceRoot,
        timeout: timeoutMs,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
      });
      return { stdout, stderr: '', exitCode: 0, duration: Date.now() - start };
    } catch (err: unknown) {
      const duration = Date.now() - start;
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return {
        stdout: e.stdout || '',
        stderr: e.stderr || '',
        exitCode: e.status ?? 1,
        duration,
      };
    }
  }

  /** 运行 tsc --noEmit */
  evaluateTypeCheck(): { passed: boolean; errorCount: number; duration: number; output: string } {
    log.info('Running tsc --noEmit...');
    const result = this.exec('npx tsc --noEmit', this.timeouts.tsc);
    const errorCount = (result.stdout + result.stderr).split('\n').filter(l => /error TS\d+/.test(l)).length;
    return {
      passed: result.exitCode === 0,
      errorCount,
      duration: result.duration,
      output: (result.stdout + result.stderr).slice(0, 5000),
    };
  }

  /** 运行 vitest run --reporter=json */
  evaluateTests(): {
    passRate: number;
    total: number;
    passed: number;
    failed: number;
    duration: number;
    output: string;
  } {
    log.info('Running vitest run...');
    const result = this.exec('npx vitest run --reporter=json 2>&1', this.timeouts.vitest);
    const combined = result.stdout + result.stderr;

    // 解析 JSON 输出
    let total = 0,
      passed = 0,
      failed = 0;
    try {
      // vitest JSON reporter 输出可能混杂在其他输出中
      const jsonMatch = combined.match(/\{[\s\S]*"numTotalTests"[\s\S]*\}/);
      if (jsonMatch) {
        const json = JSON.parse(jsonMatch[0]);
        total = json.numTotalTests || 0;
        passed = json.numPassedTests || 0;
        failed = json.numFailedTests || 0;
      }
    } catch {
      // JSON 解析失败 — 尝试从文本输出解析
      const testsMatch = combined.match(/(\d+)\s+passed/);
      const failedMatch = combined.match(/(\d+)\s+failed/);
      if (testsMatch) passed = parseInt(testsMatch[1], 10);
      if (failedMatch) failed = parseInt(failedMatch[1], 10);
      total = passed + failed;
    }

    return {
      passRate: total > 0 ? passed / total : 0,
      total,
      passed,
      failed,
      duration: result.duration,
      output: combined.slice(0, 5000),
    };
  }

  /** 运行 vitest --coverage 并解析覆盖率 */
  evaluateCoverage(): { statementCoverage: number; duration: number; output: string } {
    log.info('Running vitest coverage...');
    const result = this.exec('npx vitest run --coverage --reporter=json 2>&1', this.timeouts.vitest);
    const combined = result.stdout + result.stderr;

    // 解析覆盖率
    let statementCoverage = 0;
    try {
      // 尝试读取 coverage JSON 文件
      const coveragePath = path.join(this.sourceRoot, 'coverage', 'coverage-summary.json');
      if (fs.existsSync(coveragePath)) {
        const coverageData = JSON.parse(fs.readFileSync(coveragePath, 'utf-8'));
        statementCoverage = coverageData?.total?.statements?.pct || 0;
      }
    } catch {
      // 回退: 从输出中解析
      const covMatch = combined.match(/Statements\s*:\s*([\d.]+)%/);
      if (covMatch) statementCoverage = parseFloat(covMatch[1]);
    }

    return {
      statementCoverage,
      duration: result.duration,
      output: combined.slice(0, 3000),
    };
  }

  /** 综合适应度评估 */
  evaluate(baselineCoverage = 0): FitnessResult {
    const startTime = Date.now();
    const details: string[] = [];

    // Step 1: TypeScript
    const tsc = this.evaluateTypeCheck();
    details.push(`[tsc] ${tsc.passed ? 'PASS' : `FAIL (${tsc.errorCount} errors)`} (${tsc.duration}ms)`);

    // Step 2: Tests
    const tests = this.evaluateTests();
    details.push(
      `[vitest] ${tests.passed}/${tests.total} passed (rate: ${(tests.passRate * 100).toFixed(1)}%) (${tests.duration}ms)`,
    );

    // Step 3: Coverage (only if tests pass)
    let coverage = { statementCoverage: 0, duration: 0, output: '' };
    if (tests.passRate >= 0.95) {
      // Only run coverage if tests mostly pass (avoid wasting time)
      coverage = this.evaluateCoverage();
      details.push(`[coverage] statements: ${coverage.statementCoverage}% (baseline: ${baselineCoverage}%)`);
    }

    // Compute fitness score
    const coverageDelta = coverage.statementCoverage - baselineCoverage;
    const normalizedCoverageDelta = Math.max(0, Math.min(1, coverageDelta / 10)); // +10% coverage = 1.0

    const score =
      this.weights.tscClean * (tsc.passed ? 1.0 : 0.0) +
      this.weights.testPassRate * tests.passRate +
      this.weights.coverageDelta * normalizedCoverageDelta -
      this.weights.regressionPenalty * (tests.failed / Math.max(1, tests.total));

    const clampedScore = Math.max(0, Math.min(1, score));

    const totalDuration = Date.now() - startTime;
    details.push(`[fitness] score: ${clampedScore.toFixed(4)} (${totalDuration}ms total)`);

    return {
      score: clampedScore,
      tscPassed: tsc.passed,
      tscErrors: tsc.errorCount,
      testPassRate: tests.passRate,
      totalTests: tests.total,
      passedTests: tests.passed,
      failedTests: tests.failed,
      statementCoverage: coverage.statementCoverage,
      baselineCoverage,
      durations: {
        tsc: tsc.duration,
        vitest: tests.duration,
        total: totalDuration,
      },
      details: details.join('\n'),
    };
  }
}

// ═══════════════════════════════════════
// 4. SelfEvolutionEngine — 主引擎
// ═══════════════════════════════════════

export type EvolutionStatus =
  | 'idle'
  | 'preparing'
  | 'evaluating_baseline'
  | 'evolving'
  | 'verifying'
  | 'merging'
  | 'rolling_back'
  | 'completed'
  | 'failed';

export interface EvolutionProgress {
  status: EvolutionStatus;
  generation: number;
  maxGenerations: number;
  currentBranch: string;
  baselineFitness: number;
  currentFitness: number;
  /** 进化历史记录 */
  archive: EvolutionEntry[];
  /** 进化记忆 (成功/失败模式) */
  memories: EvolutionMemoryEntry[];
  /** 最后更新时间 */
  updatedAt: number;
  /** 运行日志 */
  logs: string[];
}

export class SelfEvolutionEngine {
  private config: EvolutionConfig;
  private gitOps: SafeGitOps;
  private guard: ImmutableGuard;
  private evaluator: FitnessEvaluator;
  private progress: EvolutionProgress;
  private abortSignal = false;

  constructor(config: Partial<EvolutionConfig> & { sourceRoot: string }) {
    this.config = { ...DEFAULT_EVOLUTION_CONFIG, ...config };
    this.gitOps = new SafeGitOps(this.config.sourceRoot);
    this.guard = new ImmutableGuard(this.config.sourceRoot, this.config.immutableFiles);
    this.evaluator = new FitnessEvaluator(this.config.sourceRoot, this.config.fitnessWeights, this.config.timeouts);
    this.progress = {
      status: 'idle',
      generation: 0,
      maxGenerations: this.config.maxGenerations,
      currentBranch: '',
      baselineFitness: 0,
      currentFitness: 0,
      archive: [],
      memories: [],
      updatedAt: Date.now(),
      logs: [],
    };
  }

  // ── Accessors ──

  getProgress(): EvolutionProgress {
    return { ...this.progress };
  }

  getConfig(): EvolutionConfig {
    return { ...this.config };
  }

  abort(): void {
    this.abortSignal = true;
    this.log('Abort signal received');
  }

  isAborted(): boolean {
    return this.abortSignal;
  }

  // ── Logging ──

  private log(msg: string): void {
    const ts = new Date().toISOString().slice(11, 19);
    const entry = `[${ts}] ${msg}`;
    this.progress.logs.push(entry);
    // 只保留最近 500 条
    if (this.progress.logs.length > 500) {
      this.progress.logs = this.progress.logs.slice(-300);
    }
    this.progress.updatedAt = Date.now();
    log.info(msg);
  }

  // ── Pre-flight Checks ──

  /**
   * 执行进化前的安全预检
   * - 检查 git 状态
   * - 验证不可变文件
   * - 建立基线适应度
   */
  async preflight(): Promise<{ ok: boolean; errors: string[]; baselineFitness?: FitnessResult }> {
    const errors: string[] = [];
    this.progress.status = 'preparing';
    this.log('Starting preflight checks...');

    // 1. 源码目录存在
    if (!fs.existsSync(this.config.sourceRoot)) {
      errors.push(`Source root does not exist: ${this.config.sourceRoot}`);
      return { ok: false, errors };
    }

    // 2. Git 仓库
    try {
      this.gitOps.getCurrentBranch();
    } catch {
      errors.push('Not a git repository');
      return { ok: false, errors };
    }

    // 3. 工作区干净
    if (!this.gitOps.isClean()) {
      errors.push('Git working directory is not clean. Commit or stash changes first.');
    }

    // 4. 不可变文件基线 hash
    this.guard.captureBaseline();
    const guardCheck = this.guard.verify();
    if (!guardCheck.ok) {
      errors.push(`Immutable guard baseline failed: ${guardCheck.violations.join(', ')}`);
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    // 5. 基线适应度评估
    this.progress.status = 'evaluating_baseline';
    this.log('Evaluating baseline fitness...');
    const baselineFitness = this.evaluator.evaluate(0);
    this.progress.baselineFitness = baselineFitness.score;
    this.log(
      `Baseline fitness: ${baselineFitness.score.toFixed(4)} ` +
        `(tsc: ${baselineFitness.tscPassed ? 'PASS' : 'FAIL'}, ` +
        `tests: ${baselineFitness.passedTests}/${baselineFitness.totalTests}, ` +
        `coverage: ${baselineFitness.statementCoverage}%)`,
    );

    // 基线必须 tsc 通过
    if (!baselineFitness.tscPassed) {
      errors.push('Baseline TypeScript compilation failed. Fix errors before starting evolution.');
    }

    this.progress.status = errors.length > 0 ? 'failed' : 'idle';
    return { ok: errors.length === 0, errors, baselineFitness };
  }

  /**
   * 在独立分支上执行一次进化迭代
   *
   * @param description - 本次进化的描述 (由 LLM 或人工提供)
   * @param applyChanges - 回调函数: 在进化分支上应用修改。返回修改的文件列表。
   * @returns 进化结果
   */
  async runSingleIteration(
    description: string,
    applyChanges: (workingDir: string) => Promise<string[]>,
  ): Promise<EvolutionRunResult> {
    this.abortSignal = false;
    const generation = this.progress.generation + 1;
    const branchName = `${this.config.branchPrefix}gen-${generation}-${Date.now().toString(36)}`;
    const snapshotTag = `evo-snapshot-${generation}`;
    const originalBranch = this.gitOps.getCurrentBranch();

    this.progress.status = 'evolving';
    this.progress.generation = generation;
    this.progress.currentBranch = branchName;
    this.log(`=== Generation ${generation}: ${description} ===`);

    try {
      // Step 1: 创建快照
      this.gitOps.createSnapshot(snapshotTag);

      // Step 2: 创建进化分支
      this.gitOps.createBranch(branchName, originalBranch);
      this.log(`Created evolution branch: ${branchName}`);

      // Step 3: 应用修改
      if (this.abortSignal) throw new Error('Aborted before applying changes');
      this.log('Applying changes...');
      const modifiedFiles = await applyChanges(this.config.sourceRoot);
      this.log(`Modified ${modifiedFiles.length} files: ${modifiedFiles.join(', ')}`);

      // Step 4: 不可变文件保护检查
      const pathCheck = this.guard.checkPaths(modifiedFiles);
      if (!pathCheck.ok) {
        throw new Error(
          `IMMUTABLE VIOLATION: Attempted to modify protected files: ${pathCheck.blockedFiles.join(', ')}`,
        );
      }

      // Step 5: Hash 验证 (防止绕过路径检查)
      const hashCheck = this.guard.verify();
      if (!hashCheck.ok) {
        throw new Error(`IMMUTABLE HASH VIOLATION: ${hashCheck.violations.join('; ')}`);
      }

      // Step 6: 提交修改
      const commitHash = this.gitOps.commitAll(`evo(gen-${generation}): ${description}`);
      this.log(`Committed: ${commitHash.slice(0, 8)}`);

      // Step 7: 适应度评估
      if (this.abortSignal) throw new Error('Aborted before fitness evaluation');
      this.progress.status = 'verifying';
      this.log('Evaluating fitness...');
      const fitness = this.evaluator.evaluate(
        this.progress.archive.length > 0
          ? this.progress.archive[this.progress.archive.length - 1].fitness.statementCoverage
          : 0,
      );
      this.progress.currentFitness = fitness.score;
      this.log(
        `Fitness: ${fitness.score.toFixed(4)} ` +
          `(baseline: ${this.progress.baselineFitness.toFixed(4)}) ` +
          `[tsc: ${fitness.tscPassed ? '✓' : '✗'}, tests: ${fitness.passedTests}/${fitness.totalTests}]`,
      );

      // Step 8: 接受/拒绝判定
      const entry: EvolutionEntry = {
        id: `evo-${generation}-${Date.now().toString(36)}`,
        parentId: this.progress.archive.length > 0 ? this.progress.archive[this.progress.archive.length - 1].id : null,
        generation,
        branch: branchName,
        fitnessScore: fitness.score,
        fitness,
        description,
        modifiedFiles,
        timestamp: Date.now(),
        status: 'pending',
      };

      const accepted = this.shouldAccept(fitness);

      if (accepted) {
        // 合并到基线分支
        this.progress.status = 'merging';
        this.gitOps.checkout(originalBranch);
        const merged = this.gitOps.merge(branchName, `evo: merge gen-${generation} — ${description}`);
        if (merged) {
          entry.status = 'accepted';
          this.progress.archive.push(entry);
          this.addMemory({
            pattern: 'accepted',
            outcome: 'success',
            module: modifiedFiles.join(', '),
            description,
            fitnessImpact: fitness.score - this.progress.baselineFitness,
            timestamp: Date.now(),
          });
          this.log(`✅ Generation ${generation} ACCEPTED and merged`);
          // 更新基线
          this.progress.baselineFitness = fitness.score;
        } else {
          // 合并冲突 — 回退
          entry.status = 'rejected';
          this.progress.archive.push(entry);
          this.log(`⚠️ Generation ${generation} passed fitness but merge failed (conflicts)`);
        }
      } else {
        // 拒绝 — 回到原始分支
        entry.status = 'rejected';
        this.progress.archive.push(entry);
        this.gitOps.checkout(originalBranch);
        this.addMemory({
          pattern: 'rejected',
          outcome: 'failure',
          module: modifiedFiles.join(', '),
          description: `${description} — fitness ${fitness.score.toFixed(4)} < baseline ${this.progress.baselineFitness.toFixed(4)}`,
          fitnessImpact: fitness.score - this.progress.baselineFitness,
          timestamp: Date.now(),
        });
        this.log(`❌ Generation ${generation} REJECTED (fitness too low or regressions)`);
      }

      // 清理进化分支 (保留用于审查)
      this.gitOps.deleteTag(snapshotTag);
      this.progress.status = 'completed';
      return { success: entry.status === 'accepted', entry, rolledBack: false };
    } catch (err: unknown) {
      // 灾难恢复 — 回滚到快照
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log(`❌ Error in generation ${generation}: ${errMsg}`);
      this.progress.status = 'rolling_back';

      try {
        this.gitOps.checkout(originalBranch);
        this.gitOps.rollbackToSnapshot(snapshotTag);
        this.log('Rolled back to pre-evolution snapshot');
      } catch (rollbackErr) {
        log.error('CRITICAL: Rollback also failed', rollbackErr);
        this.log(`CRITICAL: Rollback failed: ${rollbackErr}`);
      }

      this.gitOps.deleteTag(snapshotTag);
      this.progress.status = 'failed';

      return { success: false, error: errMsg, rolledBack: true };
    }
  }

  // ── Decision Logic ──

  /**
   * 判断进化结果是否应被接受
   *
   * 规则:
   *  1. tsc 必须通过
   *  2. 测试通过率不低于基线
   *  3. 综合适应度 >= 基线 (允许微小退化 0.01)
   */
  private shouldAccept(fitness: FitnessResult): boolean {
    // Hard requirements
    if (!fitness.tscPassed) {
      this.log('Reject: tsc failed');
      return false;
    }
    if (fitness.failedTests > 0) {
      this.log(`Reject: ${fitness.failedTests} tests failed`);
      return false;
    }

    // Fitness threshold (allow tiny regression of 0.01)
    const threshold = this.progress.baselineFitness - 0.01;
    if (fitness.score < threshold) {
      this.log(`Reject: fitness ${fitness.score.toFixed(4)} < threshold ${threshold.toFixed(4)}`);
      return false;
    }

    return true;
  }

  // ── Memory System ──

  private addMemory(memory: EvolutionMemoryEntry): void {
    this.progress.memories.push(memory);
    // 只保留最近 200 条
    if (this.progress.memories.length > 200) {
      this.progress.memories = this.progress.memories.slice(-150);
    }
  }

  /** 获取进化记忆摘要 (供 LLM 参考) */
  getMemorySummary(): string {
    const successes = this.progress.memories.filter(m => m.outcome === 'success');
    const failures = this.progress.memories.filter(m => m.outcome === 'failure');
    const lines: string[] = [];

    if (successes.length > 0) {
      lines.push('## Successful Patterns');
      for (const s of successes.slice(-10)) {
        lines.push(`- [+${s.fitnessImpact.toFixed(3)}] ${s.description} (${s.module})`);
      }
    }
    if (failures.length > 0) {
      lines.push('## Failed Patterns');
      for (const f of failures.slice(-10)) {
        lines.push(`- [${f.fitnessImpact.toFixed(3)}] ${f.description} (${f.module})`);
      }
    }

    return lines.join('\n');
  }

  /** 获取 Archive 摘要 (供 LLM 参考) */
  getArchiveSummary(): string {
    const lines = ['## Evolution Archive'];
    for (const entry of this.progress.archive.slice(-20)) {
      const icon = entry.status === 'accepted' ? '✅' : entry.status === 'rejected' ? '❌' : '⏳';
      lines.push(
        `${icon} Gen ${entry.generation}: ${entry.description} — fitness ${entry.fitnessScore.toFixed(4)} [${entry.modifiedFiles.length} files]`,
      );
    }
    return lines.join('\n');
  }

  // ── Static Utilities ──

  /**
   * 检查一个目录是否是 AutoMater 源码根目录
   * (通过检查标志文件)
   */
  static isAutoMaterRoot(dir: string): boolean {
    const markers = [
      'package.json',
      'electron/main.ts',
      'electron/engine/react-loop.ts',
      'electron/engine/orchestrator.ts',
      'src/App.tsx',
    ];
    return markers.every(m => fs.existsSync(path.join(dir, m)));
  }

  /**
   * 从 package.json 获取当前版本
   */
  static getVersion(sourceRoot: string): string {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf-8'));
      return pkg.version || 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
