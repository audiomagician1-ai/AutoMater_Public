#!/usr/bin/env node
/**
 * Install Git Hooks — 将 pre-commit hook 安装到 .git/hooks/
 *
 * 用法: node scripts/install-hooks.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const hookDir = path.join(ROOT, '.git', 'hooks');
const hookFile = path.join(hookDir, 'pre-commit');

const hookContent = `#!/bin/sh
# AutoMater Quality Gate — pre-commit hook
# 安装方式: node scripts/install-hooks.js

echo "🔍 Running quality gate (quick mode)..."
node scripts/quality-gate.js --quick
`;

if (!fs.existsSync(hookDir)) {
  console.log('⚠️  .git/hooks 目录不存在, 跳过安装');
  process.exit(0);
}

fs.writeFileSync(hookFile, hookContent, { mode: 0o755 });
console.log(`✅ pre-commit hook 已安装到 ${hookFile}`);
