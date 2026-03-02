#!/usr/bin/env node
/**
 * release-build.js — 干净的发布构建脚本
 *
 * 产出:
 *   1. release/win-unpacked/    解压即用的目录版
 *   2. release/AutoMater-{version}-win-x64.zip   便携压缩包
 *   3. release/AutoMater-{version}-win-x64-setup.exe  NSIS 安装包 (可选)
 *
 * 特性:
 *   - 构建前清理所有缓存 / 旧产物 / sourcemap
 *   - 不打包任何用户数据 / 隐私文件
 *   - 可通过 --no-installer 跳过安装包生成
 *   - 可通过 --keep-sourcemap 保留 sourcemap
 *
 * 用法:
 *   node scripts/release-build.js
 *   node scripts/release-build.js --no-installer
 *   node scripts/release-build.js --keep-sourcemap
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DIST_ELECTRON = path.join(ROOT, 'dist-electron');
const RELEASE = path.join(ROOT, 'release');

// ── 参数解析 ──
const args = process.argv.slice(2);
const noInstaller = args.includes('--no-installer');
const keepSourcemap = args.includes('--keep-sourcemap');

// ── 读取版本号 ──
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const productName = pkg.build?.productName || pkg.name;

function log(msg) { console.log(`\x1b[36m▸\x1b[0m ${msg}`); }
function ok(msg)  { console.log(`\x1b[32m✓\x1b[0m ${msg}`); }
function warn(msg){ console.log(`\x1b[33m⚠\x1b[0m ${msg}`); }
function run(cmd, env = {}) {
  log(`$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
}

// ════════════════════════════════════════════
// Phase 1: 清理旧产物
// ════════════════════════════════════════════
log('Phase 1: 清理旧构建产物...');

// 清理 dist (前端)
if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true, force: true });
  ok('已清理 dist/');
}

// 清理 dist-electron (Electron 主进程)
if (fs.existsSync(DIST_ELECTRON)) {
  fs.rmSync(DIST_ELECTRON, { recursive: true, force: true });
  ok('已清理 dist-electron/');
}

// 清理 release 目录
if (fs.existsSync(RELEASE)) {
  fs.rmSync(RELEASE, { recursive: true, force: true });
  ok('已清理 release/');
}

// ════════════════════════════════════════════
// Phase 2: 构建前端 + Electron
// ════════════════════════════════════════════
log('Phase 2: Vite 构建...');
run('npx vite build', { RELEASE_BUILD: '1' });
ok('Vite 构建完成');

// ════════════════════════════════════════════
// Phase 3: 清理构建残留
// ════════════════════════════════════════════
log('Phase 3: 清理构建产物中的无用文件...');

// 删除 sourcemap（除非 --keep-sourcemap）
if (!keepSourcemap) {
  let mapCount = 0;
  for (const dir of [DIST, DIST_ELECTRON]) {
    if (!fs.existsSync(dir)) continue;
    const walk = (d) => {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) { walk(p); continue; }
        if (f.endsWith('.js.map') || f.endsWith('.css.map')) {
          fs.unlinkSync(p);
          mapCount++;
        }
      }
    };
    walk(dir);
  }
  if (mapCount > 0) ok(`已删除 ${mapCount} 个 sourcemap 文件`);
}

// 验证 dist-electron 只有当前构建的文件（无旧哈希文件）
const electronFiles = fs.existsSync(DIST_ELECTRON) ? fs.readdirSync(DIST_ELECTRON) : [];
ok(`dist-electron/ 共 ${electronFiles.length} 个文件: ${electronFiles.join(', ')}`);

// ════════════════════════════════════════════
// Phase 4: 准备 node_modules（替换 pnpm 符号链接）
// ════════════════════════════════════════════
log('Phase 4: 准备 node_modules...');
run('node scripts/prepare-build.js');

// ════════════════════════════════════════════
// Phase 5: electron-builder 打包
// ════════════════════════════════════════════
log('Phase 5: electron-builder 打包...');

// 先打 dir 格式（解压即用）
run('npx electron-builder --win dir');
ok('dir 格式打包完成');

// ════════════════════════════════════════════
// Phase 6: 生成便携 ZIP
// ════════════════════════════════════════════
log('Phase 6: 生成便携 ZIP 压缩包...');

const unpackedDir = path.join(RELEASE, 'win-unpacked');
const zipName = `AutoMater-${version}-win-x64.zip`;
const zipPath = path.join(RELEASE, zipName);

if (fs.existsSync(unpackedDir)) {
  // 打包前再做一轮清理：删除 unpacked 目录中不需要的文件
  const cruftPatterns = [
    // Electron 调试/开发残留
    'LICENSE.electron.txt',
    'LICENSES.chromium.html',
  ];
  // 不删除 LICENSE 文件，保留合规性

  // 使用 PowerShell 的 Compress-Archive 生成 zip
  run(`powershell -NoProfile -Command "Compress-Archive -Path '${unpackedDir}\\*' -DestinationPath '${zipPath}' -Force"`);

  if (fs.existsSync(zipPath)) {
    const zipSize = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
    ok(`便携 ZIP 已生成: ${zipName} (${zipSize} MB)`);
  }
} else {
  warn('win-unpacked 目录不存在，跳过 ZIP 生成');
}

// ════════════════════════════════════════════
// Phase 7: 生成 NSIS 安装包（可选）
// ════════════════════════════════════════════
if (!noInstaller) {
  log('Phase 7: 生成 NSIS 安装包...');
  try {
    run('npx electron-builder --win nsis --prepackaged release/win-unpacked');
    ok('NSIS 安装包生成完成');
  } catch (e) {
    warn(`NSIS 安装包生成失败: ${e.message}`);
    warn('可能需要安装 NSIS: choco install nsis');
  }
} else {
  log('Phase 7: 跳过 NSIS 安装包 (--no-installer)');
}

// ════════════════════════════════════════════
// Phase 8: 最终校验
// ════════════════════════════════════════════
log('Phase 8: 最终校验...');

// 检查隐私/敏感文件泄露
const sensitivePatterns = ['.env', '.sqlite', '.db', 'apikey', 'secret', 'password', '.log'];
let leakFound = false;

function scanDir(dir, prefix = '') {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + '/' + entry.name;
    if (entry.isDirectory()) {
      // 跳过 node_modules 深层扫描（太慢）
      if (entry.name === 'node_modules') continue;
      scanDir(path.join(dir, entry.name), rel);
    } else {
      const lower = entry.name.toLowerCase();
      for (const pat of sensitivePatterns) {
        if (lower === pat || (pat.startsWith('.') && lower.endsWith(pat))) {
          warn(`可能的敏感文件: ${rel}`);
          leakFound = true;
        }
      }
    }
  }
}

scanDir(unpackedDir);
if (!leakFound) ok('未发现敏感文件');

// 统计最终产物大小
const releaseEntries = fs.existsSync(RELEASE) ? fs.readdirSync(RELEASE) : [];
console.log('\n═══════════════════════════════════════');
console.log(`  ${productName} v${version} — 构建完成`);
console.log('═══════════════════════════════════════');
for (const entry of releaseEntries) {
  const p = path.join(RELEASE, entry);
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    // 计算目录总大小
    let total = 0;
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, f.name);
        if (f.isDirectory()) walk(fp); else total += fs.statSync(fp).size;
      }
    };
    walk(p);
    console.log(`  📁 ${entry}/  ${(total / 1024 / 1024).toFixed(1)} MB`);
  } else {
    console.log(`  📦 ${entry}  ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  }
}
console.log('═══════════════════════════════════════\n');
