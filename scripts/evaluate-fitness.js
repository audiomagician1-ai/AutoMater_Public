#!/usr/bin/env node
/**
 * Fitness Evaluator — 综合适应度评估脚本
 *
 * 用途:
 *  1. 自我进化循环的适应度评估
 *  2. CI/CD 的定量质量报告
 *  3. 进化代际间的对比基准
 *
 * 评估维度:
 *  1. TypeScript 类型检查 (tsc --noEmit)      → tsc_passed, tsc_errors
 *  2. 单元测试通过率 (vitest run)             → test_pass_rate, tests_*
 *  3. 覆盖率 (vitest --coverage)              → statement_coverage
 *  4. 代码质量 (文件数量、行数统计)            → code_quality_score
 *
 * 输出: JSON 格式的适应度报告 (stdout)
 * 退出码: 0=评估完成(不论通过与否), 1=评估脚本自身故障
 *
 * 使用: node scripts/evaluate-fitness.js [--quick] [--json] [--baseline <path>]
 *
 * 不可变性: 本文件在自我进化过程中禁止修改 (SHA256 hash 校验)
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const JSON_ONLY = args.includes('--json');
const baselineIdx = args.indexOf('--baseline');
const BASELINE_PATH = baselineIdx >= 0 ? args[baselineIdx + 1] : null;

// ── Helpers ──

function exec(cmd, timeoutMs = 120000) {
  const start = Date.now();
  try {
    const stdout = execSync(cmd, {
      cwd: ROOT,
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
    });
    return { stdout, stderr: '', exitCode: 0, duration: Date.now() - start };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status || 1,
      duration: Date.now() - start,
    };
  }
}

function log(msg) {
  if (!JSON_ONLY) {
    console.error(msg); // stderr so JSON on stdout is clean
  }
}

// ── Step 1: TypeScript ──

log('🔍 Step 1/4: TypeScript type check...');
const tscResult = exec('npx tsc --noEmit');
const tscErrors = (tscResult.stdout + tscResult.stderr)
  .split('\n')
  .filter(l => /error TS\d+/.test(l)).length;
const tscPassed = tscResult.exitCode === 0;
log(`   ${tscPassed ? '✅' : '❌'} tsc: ${tscErrors} errors (${tscResult.duration}ms)`);

// ── Step 2: Unit Tests ──

log('🔍 Step 2/4: Unit tests...');
const testResult = exec('npx vitest run --reporter=json 2>&1', 300000);
const testOutput = testResult.stdout + testResult.stderr;

let totalTests = 0, passedTests = 0, failedTests = 0, skippedTests = 0;
try {
  const jsonMatch = testOutput.match(/\{[\s\S]*"numTotalTests"[\s\S]*\}/);
  if (jsonMatch) {
    const json = JSON.parse(jsonMatch[0]);
    totalTests = json.numTotalTests || 0;
    passedTests = json.numPassedTests || 0;
    failedTests = json.numFailedTests || 0;
    skippedTests = json.numPendingTests || 0;
  }
} catch {
  // Fallback: parse from text
  const passMatch = testOutput.match(/(\d+)\s+passed/);
  const failMatch = testOutput.match(/(\d+)\s+failed/);
  const skipMatch = testOutput.match(/(\d+)\s+skipped/);
  if (passMatch) passedTests = parseInt(passMatch[1], 10);
  if (failMatch) failedTests = parseInt(failMatch[1], 10);
  if (skipMatch) skippedTests = parseInt(skipMatch[1], 10);
  totalTests = passedTests + failedTests;
}
const testPassRate = totalTests > 0 ? passedTests / totalTests : 0;
log(`   ${failedTests === 0 ? '✅' : '❌'} tests: ${passedTests}/${totalTests} passed, ${failedTests} failed (${testResult.duration}ms)`);

// ── Step 3: Coverage (skip in quick mode) ──

let statementCoverage = 0;
let coverageDuration = 0;

if (!QUICK) {
  log('🔍 Step 3/4: Coverage...');
  const covResult = exec('npx vitest run --coverage --reporter=json 2>&1', 300000);
  coverageDuration = covResult.duration;

  try {
    const coveragePath = path.join(ROOT, 'coverage', 'coverage-summary.json');
    if (fs.existsSync(coveragePath)) {
      const coverageData = JSON.parse(fs.readFileSync(coveragePath, 'utf-8'));
      statementCoverage = coverageData?.total?.statements?.pct || 0;
    }
  } catch {
    const covOutput = covResult.stdout + covResult.stderr;
    const covMatch = covOutput.match(/Statements\s*:\s*([\d.]+)%/);
    if (covMatch) statementCoverage = parseFloat(covMatch[1]);
  }
  log(`   📊 coverage: ${statementCoverage}% statements (${coverageDuration}ms)`);
} else {
  log('🔍 Step 3/4: Coverage... SKIPPED (--quick mode)');
}

// ── Step 4: Code Quality Metrics ──

log('🔍 Step 4/4: Code quality metrics...');
let totalFiles = 0, totalLines = 0;
try {
  const tsFiles = execSync(
    'git ls-files "*.ts" "*.tsx" | wc -l',
    { cwd: ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
  totalFiles = parseInt(tsFiles, 10) || 0;

  const lineCount = execSync(
    'git ls-files "*.ts" "*.tsx" | xargs wc -l 2>/dev/null | tail -1',
    { cwd: ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
  const lineMatch = lineCount.match(/(\d+)/);
  totalLines = lineMatch ? parseInt(lineMatch[1], 10) : 0;
} catch {
  // Fallback for Windows
  try {
    const files = execSync(
      'git ls-files -- "*.ts" "*.tsx"',
      { cwd: ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim().split('\n').filter(Boolean);
    totalFiles = files.length;
    totalLines = files.reduce((sum, f) => {
      try {
        return sum + fs.readFileSync(path.join(ROOT, f), 'utf-8').split('\n').length;
      } catch { return sum; }
    }, 0);
  } catch {
    // Give up on line counting
  }
}

const codeQualityScore = tscPassed ? 1.0 : 0.0; // Simplistic for Phase 0
log(`   📁 ${totalFiles} TS/TSX files, ${totalLines} lines`);

// ── Compute Fitness Score ──

const weights = {
  testPassRate: 0.40,
  coverageDelta: 0.20,
  tscClean: 0.30,
  regressionPenalty: 0.10,
};

// Load baseline for delta
let baselineCoverage = 0;
if (BASELINE_PATH && fs.existsSync(BASELINE_PATH)) {
  try {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    baselineCoverage = baseline.statementCoverage || 0;
  } catch { /* ignore */ }
}

const coverageDelta = statementCoverage - baselineCoverage;
const normalizedCoverageDelta = Math.max(0, Math.min(1, coverageDelta / 10));

const fitnessScore = Math.max(0, Math.min(1,
  weights.tscClean * (tscPassed ? 1.0 : 0.0) +
  weights.testPassRate * testPassRate +
  weights.coverageDelta * normalizedCoverageDelta -
  weights.regressionPenalty * (failedTests / Math.max(1, totalTests))
));

// ── Output ──

const report = {
  timestamp: new Date().toISOString(),
  fitnessScore: Math.round(fitnessScore * 10000) / 10000,
  tscPassed,
  tscErrors,
  testPassRate: Math.round(testPassRate * 10000) / 10000,
  totalTests,
  passedTests,
  failedTests,
  skippedTests,
  statementCoverage: Math.round(statementCoverage * 100) / 100,
  baselineCoverage,
  codeQualityScore,
  totalFiles,
  totalLines,
  durations: {
    tsc: tscResult.duration,
    vitest: testResult.duration,
    coverage: coverageDuration,
    total: tscResult.duration + testResult.duration + coverageDuration,
  },
  weights,
  quick: QUICK,
};

if (JSON_ONLY) {
  process.stdout.write(JSON.stringify(report));
} else {
  log('\n' + '═'.repeat(50));
  log(`📊 Fitness Score: ${report.fitnessScore}`);
  log(`   tsc: ${tscPassed ? 'PASS' : 'FAIL'} (${tscErrors} errors)`);
  log(`   tests: ${passedTests}/${totalTests} (${(testPassRate * 100).toFixed(1)}%)`);
  log(`   coverage: ${statementCoverage}%`);
  log(`   code: ${totalFiles} files / ${totalLines} lines`);
  log('═'.repeat(50));
  console.log(JSON.stringify(report, null, 2));
}
