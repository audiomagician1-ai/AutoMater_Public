/**
 * prepare-build.js — Pre-packaging step for electron-builder
 *
 * pnpm uses symlinks in node_modules which electron-builder doesn't
 * follow when building the asar. This script replaces symlinks with
 * real copies for packages that must be in the final bundle.
 *
 * Run after `vite build`, before `electron-builder`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODE_MODULES = path.join(ROOT, 'node_modules');

/**
 * Packages that are externalized from the Vite bundle and must be
 * physically present in node_modules for the Electron app to work.
 */
const EXTERNAL_PACKAGES = [
  'playwright-core',
];

function resolveRealPath(linkPath) {
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      return fs.realpathSync(linkPath);
    }
    return linkPath;
  } catch {
    return null;
  }
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

let fixed = 0;

for (const pkg of EXTERNAL_PACKAGES) {
  const pkgPath = path.join(NODE_MODULES, pkg);

  if (!fs.existsSync(pkgPath)) {
    console.warn(`⚠️  ${pkg} not found in node_modules, skipping`);
    continue;
  }

  const stat = fs.lstatSync(pkgPath);
  if (!stat.isSymbolicLink()) {
    console.log(`✓  ${pkg} is already a real directory`);
    continue;
  }

  const realPath = resolveRealPath(pkgPath);
  if (!realPath) {
    console.error(`✗  ${pkg} symlink target not found`);
    continue;
  }

  console.log(`📦 ${pkg}: replacing symlink with copy`);
  console.log(`   from: ${realPath}`);
  console.log(`   to:   ${pkgPath}`);

  // Remove symlink
  fs.rmSync(pkgPath, { recursive: true, force: true });

  // Copy real directory
  copyDirSync(realPath, pkgPath);

  // Verify
  const pkgJson = path.join(pkgPath, 'package.json');
  if (fs.existsSync(pkgJson)) {
    const version = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version;
    console.log(`   ✓ copied ${pkg}@${version}`);
    fixed++;
  }
}

console.log(`\n✅ prepare-build: ${fixed} symlink(s) replaced`);
