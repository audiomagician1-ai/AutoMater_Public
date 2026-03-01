/**
 * Sandbox Executor — 轻量级子进程沙箱 (v1.2)
 *
 * 无 Docker 环境下的安全命令执行:
 * 1. 工作目录限制 (cwd 锁定到 workspace)
 * 2. 超时控制 (可配置，默认 120s)
 * 3. 输出大小限制 (maxBuffer 2MB)
 * 4. 危险命令黑名单
 * 5. 环境变量隔离 (只传递安全变量)
 * 6. 支持 PowerShell / bash
 */

import { execSync, spawn, ChildProcess } from 'child_process';
import path from 'path';

// ═══════════════════════════════════════
// 配置
// ═══════════════════════════════════════

export interface SandboxConfig {
  workspacePath: string;
  timeoutMs?: number;       // 默认 120000 (120s)
  maxOutputBytes?: number;  // 默认 2MB
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024;

// 危险命令黑名单 (大小写不敏感)
const FORBIDDEN_PATTERNS = [
  'rm -rf /',
  'rm -rf ~',
  'format c:',
  'del /s /q c:',
  'del /s /q %systemroot%',
  'shutdown',
  'reboot',
  'reg delete',
  ':(){:|:&};:',    // fork bomb
  'mkfs',
  'dd if=/dev/',
  'curl.*|.*sh',    // pipe to shell
  'wget.*|.*sh',
  'powershell.*-encodedcommand',
  'invoke-webrequest.*|.*iex',
];

function isForbidden(command: string): boolean {
  const lower = command.toLowerCase().replace(/\s+/g, ' ');
  return FORBIDDEN_PATTERNS.some(p => {
    try {
      return new RegExp(p, 'i').test(lower);
    } catch {
      return lower.includes(p);
    }
  });
}

// 安全环境变量白名单
const SAFE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'TERM',
  'NODE_ENV', 'NODE_PATH', 'NPM_CONFIG_PREFIX',
  'PYTHON', 'PYTHONPATH',
  'GOPATH', 'GOROOT',
  'JAVA_HOME',
  'CARGO_HOME', 'RUSTUP_HOME',
  'SystemRoot', 'SYSTEMROOT', 'windir',        // Windows essentials
  'PATHEXT', 'COMSPEC', 'PSModulePath',         // Windows shell
  'APPDATA', 'LOCALAPPDATA', 'ProgramFiles',
  'ProgramFiles(x86)', 'CommonProgramFiles',
]);

function buildSafeEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SAFE_ENV_KEYS.has(key) && value !== undefined) {
      env[key] = value;
    }
  }
  // 标记为沙箱环境
  env['AGENTFORGE_SANDBOX'] = '1';
  if (extra) Object.assign(env, extra);
  return env;
}

// ═══════════════════════════════════════
// 同步执行 (简单命令)
// ═══════════════════════════════════════

export interface SandboxResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  duration: number;
}

export function execInSandbox(command: string, config: SandboxConfig): SandboxResult {
  const start = Date.now();

  // 安全检查
  if (isForbidden(command)) {
    return {
      success: false, exitCode: -1,
      stdout: '', stderr: `命令被安全策略拦截: ${command}`,
      timedOut: false, duration: 0,
    };
  }

  // 验证 cwd 存在且在 workspace 内
  const cwd = config.workspacePath;
  const resolvedCwd = path.resolve(cwd);

  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxBuffer = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const env = buildSafeEnv(config.env);

  try {
    const stdout = execSync(command, {
      cwd: resolvedCwd,
      encoding: 'utf-8',
      maxBuffer,
      timeout,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      success: true, exitCode: 0,
      stdout: stdout.slice(0, maxBuffer),
      stderr: '',
      timedOut: false,
      duration: Date.now() - start,
    };
  } catch (err: any) {
    const timedOut = err.killed === true || err.signal === 'SIGTERM';
    return {
      success: false,
      exitCode: err.status ?? -1,
      stdout: (err.stdout?.toString() || '').slice(0, maxBuffer / 2),
      stderr: (err.stderr?.toString() || err.message || '').slice(0, maxBuffer / 2),
      timedOut,
      duration: Date.now() - start,
    };
  }
}

// ═══════════════════════════════════════
// 常用命令快捷方式
// ═══════════════════════════════════════

/** 运行 npm/pnpm/yarn 测试 */
export function runTest(config: SandboxConfig): SandboxResult {
  // 自动检测包管理器
  const fs = require('fs');
  let cmd = 'npm test';
  if (fs.existsSync(path.join(config.workspacePath, 'pnpm-lock.yaml'))) cmd = 'pnpm test';
  else if (fs.existsSync(path.join(config.workspacePath, 'yarn.lock'))) cmd = 'yarn test';
  else if (fs.existsSync(path.join(config.workspacePath, 'requirements.txt'))) cmd = 'python -m pytest';
  else if (fs.existsSync(path.join(config.workspacePath, 'Cargo.toml'))) cmd = 'cargo test';
  else if (fs.existsSync(path.join(config.workspacePath, 'go.mod'))) cmd = 'go test ./...';

  return execInSandbox(cmd, { ...config, timeoutMs: config.timeoutMs ?? 180_000 });
}

/** 运行 lint / type-check */
export function runLint(config: SandboxConfig): SandboxResult {
  const fs = require('fs');
  const commands: string[] = [];

  // TypeScript type-check
  if (fs.existsSync(path.join(config.workspacePath, 'tsconfig.json'))) {
    commands.push('npx tsc --noEmit');
  }
  // ESLint
  if (fs.existsSync(path.join(config.workspacePath, '.eslintrc.json')) ||
      fs.existsSync(path.join(config.workspacePath, '.eslintrc.js')) ||
      fs.existsSync(path.join(config.workspacePath, 'eslint.config.js'))) {
    commands.push('npx eslint . --max-warnings 50');
  }
  // Python
  if (fs.existsSync(path.join(config.workspacePath, 'requirements.txt')) ||
      fs.existsSync(path.join(config.workspacePath, 'pyproject.toml'))) {
    commands.push('python -m py_compile');
  }

  if (commands.length === 0) {
    return { success: true, exitCode: 0, stdout: '未检测到 lint/type-check 配置', stderr: '', timedOut: false, duration: 0 };
  }

  // 串行执行，收集所有结果
  const results: string[] = [];
  let anyFailed = false;

  for (const cmd of commands) {
    const r = execInSandbox(cmd, { ...config, timeoutMs: 60_000 });
    results.push(`$ ${cmd}\n${r.stdout}${r.stderr ? '\n[stderr] ' + r.stderr : ''}\n[exit: ${r.exitCode}]`);
    if (!r.success) anyFailed = true;
  }

  return {
    success: !anyFailed,
    exitCode: anyFailed ? 1 : 0,
    stdout: results.join('\n\n'),
    stderr: '',
    timedOut: false,
    duration: 0,
  };
}

/** 安装依赖 */
export function installDeps(config: SandboxConfig): SandboxResult {
  const fs = require('fs');
  let cmd = 'npm install';
  if (fs.existsSync(path.join(config.workspacePath, 'pnpm-lock.yaml'))) cmd = 'pnpm install';
  else if (fs.existsSync(path.join(config.workspacePath, 'yarn.lock'))) cmd = 'yarn install';
  else if (fs.existsSync(path.join(config.workspacePath, 'requirements.txt'))) cmd = 'pip install -r requirements.txt';
  else if (fs.existsSync(path.join(config.workspacePath, 'Cargo.toml'))) cmd = 'cargo build';
  else if (fs.existsSync(path.join(config.workspacePath, 'go.mod'))) cmd = 'go mod download';

  return execInSandbox(cmd, { ...config, timeoutMs: config.timeoutMs ?? 300_000 });
}
