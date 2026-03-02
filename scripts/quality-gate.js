#!/usr/bin/env node
/**
 * Quality Gate — 自测门禁脚本
 *
 * 用途:
 *  1. pre-commit hook 调用
 *  2. CI/CD pipeline 调用
 *  3. Meta-Agent 自改后的验证步骤
 *
 * 步骤:
 *  1. TypeScript 类型检查 (tsc --noEmit)
 *  2. 单元测试 (vitest run)
 *  3. 覆盖率门槛检查 (vitest --coverage)
 *
 * 退出码: 0=全部通过, 1=有失败
 */

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const opts = { cwd: ROOT, stdio: 'inherit', timeout: 300_000 };

let failed = false;

function run(label, cmd) {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`🔍 ${label}`);
  console.log('═'.repeat(50));
  try {
    execSync(cmd, opts);
    console.log(`✅ ${label} — PASSED`);
  } catch (err) {
    console.error(`❌ ${label} — FAILED`);
    failed = true;
  }
}

// ── Step 1: TypeScript ──
run('TypeScript 类型检查', 'npx tsc --noEmit');

// ── Step 2: Unit Tests ──
run('单元测试', 'npx vitest run');

// ── Step 3: Coverage (只在非 quick 模式下) ──
const quick = process.argv.includes('--quick');
if (!quick) {
  run('覆盖率门槛', 'npx vitest run --coverage');
}

// ── Summary ──
console.log(`\n${'═'.repeat(50)}`);
if (failed) {
  console.error('🚫 Quality Gate FAILED — 请修复上述问题后再提交');
  process.exit(1);
} else {
  console.log('✅ Quality Gate PASSED — 全部检查通过');
  process.exit(0);
}
