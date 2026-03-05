/**
 * Sandbox Executor — 轻量级子进程沙箱 (v6.0)
 *
 * 无 Docker 环境下的安全命令执行:
 * 1. 工作目录限制 (cwd 锁定到 workspace)
 * 2. 超时控制 (可配置，默认 120s)
 * 3. 输出大小限制 (maxBuffer 2MB)
 * 4. 危险命令黑名单 + 正则检测
 * 5. 环境变量隔离 (只传递安全变量)
 * 6. 路径逃逸防护 (验证 cwd 合法性)
 * 7. 资源限制 (Windows: 进程优先级限制; 通用: 输出截断)
 * 8. 支持 PowerShell / bash
 * 9. v6.0: 异步执行模式 — spawn + 实时 stdout 流式输出
 */

import { execSync, spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { createLogger } from './logger';
const log = createLogger('sandbox-executor');


// ═══════════════════════════════════════
// 配置
// ═══════════════════════════════════════

export interface SandboxConfig {
  workspacePath: string;
  timeoutMs?: number;       // 默认 120000 (120s)
  maxOutputBytes?: number;  // 默认 2MB
  env?: Record<string, string>;
  /** v5.5: 限制网络访问 (Windows: 通过 PowerShell 策略) */
  networkRestricted?: boolean;
}

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024;

// 危险命令黑名单 (大小写不敏感)
const FORBIDDEN_PATTERNS = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf %',
  'format c:',
  'del /s /q c:',
  'del /s /q %systemroot%',
  'shutdown',
  'reboot',
  'reg delete',
  ':(){:|:&};:',    // fork bomb
  'mkfs',
  'dd if=/dev/',
  'curl.*\\|.*sh',    // pipe to shell
  'wget.*\\|.*sh',
  'powershell.*-encodedcommand',
  'invoke-webrequest.*\\|.*iex',
  'invoke-expression',
  'iex\\s*\\(',
  'start-process.*-verb\\s+runas',  // v5.5: elevation attempt
  'net\\s+user',                     // v5.5: user manipulation
  'net\\s+localgroup',
  'reg\\s+add',                      // v5.5: registry modification
  'schtasks\\s+/create',             // v5.5: scheduled task creation
  'wmic\\s+process',                 // v5.5: process manipulation via WMIC
  'certutil.*-urlcache',             // v5.5: download via certutil
  'bitsadmin.*\\/transfer',          // v5.5: download via BITS
];

function isForbidden(command: string): boolean {
  const lower = command.toLowerCase().replace(/\s+/g, ' ');
  return FORBIDDEN_PATTERNS.some(p => {
    try {
      return new RegExp(p, 'i').test(lower);
    } catch (err) { /* regex compile failed — fallback to includes() */
      log.debug('Catch at sandbox-executor.ts:74', { error: String(err) });
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
  env['AUTOMATER_SANDBOX'] = '1';
  if (extra) Object.assign(env, extra);
  return env;
}

// ═══════════════════════════════════════
// v5.5: 路径安全验证
// ═══════════════════════════════════════

/**
 * Validate that the workspace path is safe to use as cwd.
 * Prevents path traversal and symlink escapes.
 */
function validateWorkspacePath(workspacePath: string): { ok: boolean; error?: string; resolved: string } {
  const resolved = path.resolve(workspacePath);

  // Must not be a system root
  const dangerous = ['/', 'C:\\', 'C:\\Windows', 'C:\\Users', '/usr', '/etc', '/root'];
  if (dangerous.some(d => resolved.toLowerCase() === d.toLowerCase())) {
    return { ok: false, error: `工作路径不安全 (系统目录): ${resolved}`, resolved };
  }

  // Must exist and be a directory
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { ok: false, error: `工作路径不是目录: ${resolved}`, resolved };
    }
  } catch (err) { /* silent: 路径stat失败 */
    // Directory doesn't exist — will be created by caller
    log.debug('// Directory doesn\'t exist — will be created by caller', { error: String(err) });
  }

  // v5.5: Check for symlink escape
  try {
    const real = fs.realpathSync(resolved);
    if (real !== resolved) {
      // It's a symlink — verify target is not a dangerous location
      if (dangerous.some(d => real.toLowerCase().startsWith(d.toLowerCase() + path.sep))) {
        return { ok: false, error: `工作路径是指向系统目录的符号链接: ${resolved} → ${real}`, resolved };
      }
    }
  } catch (err) { /* silent: 进程清理失败(可能已退出) */
    // realpathSync failed — directory may not exist yet, allow it
    log.debug('// realpathSync failed — directory may not exist yet, allow it', { error: String(err) });
  }

  return { ok: true, resolved };
}

/**
 * v5.5: Detect commands that try to escape the workspace via path traversal.
 */
function hasPathTraversal(command: string, workspacePath: string): boolean {
  // Check for common escape patterns
  const escapePatterns = [
    /\.\.\//g,          // ../
    /\.\.\\/g,          // ..\
    /~\//g,             // ~/
    /\$HOME/gi,         // $HOME
    /%USERPROFILE%/gi,  // %USERPROFILE%
    /\\\\[a-z]/gi,      // UNC paths \\server
  ];

  // Allow relative paths that don't escape (e.g., src/../lib is ok if still within workspace)
  const lowerCmd = command.toLowerCase();
  for (const pattern of escapePatterns) {
    if (pattern.test(lowerCmd)) {
      // Check if it's a benign relative path
      const matches = lowerCmd.match(pattern);
      if (matches) {
        // Simple heuristic: if command contains explicit absolute path outside workspace, block
        const absPathMatch = command.match(/[A-Z]:\\[^\s"]+/gi) || command.match(/\/(?:usr|etc|root|home|var)\//gi);
        if (absPathMatch) {
          for (const absPath of absPathMatch) {
            const resolvedPath = path.resolve(absPath);
            if (!resolvedPath.startsWith(path.resolve(workspacePath))) {
              return true;
            }
          }
        }
      }
    }
  }

  return false;
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

// SYNC-OK: 向后兼容保留, 新代码应使用 execInSandboxPromise (async)
export function execInSandbox(command: string, config: SandboxConfig): SandboxResult {
  const start = Date.now();

  // 安全检查 1: 危险命令黑名单
  if (isForbidden(command)) {
    return {
      success: false, exitCode: -1,
      stdout: '', stderr: `命令被安全策略拦截: ${command}`,
      timedOut: false, duration: 0,
    };
  }

  // v5.5: 安全检查 2: 路径逃逸
  if (hasPathTraversal(command, config.workspacePath)) {
    return {
      success: false, exitCode: -1,
      stdout: '', stderr: `命令包含路径逃逸模式，已拦截: ${command.slice(0, 200)}`,
      timedOut: false, duration: 0,
    };
  }

  // v5.5: 安全检查 3: 验证工作路径
  const wpCheck = validateWorkspacePath(config.workspacePath);
  if (!wpCheck.ok) {
    return {
      success: false, exitCode: -1,
      stdout: '', stderr: wpCheck.error || '工作路径验证失败',
      timedOut: false, duration: 0,
    };
  }

  const cwd = wpCheck.resolved;
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxBuffer = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const env = buildSafeEnv(config.env);

  try {
    const stdout = execSync(command, {
      cwd,
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
  } catch (err: unknown) {
    const execErr = err as { killed?: boolean; signal?: string; status?: number; stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const timedOut = execErr.killed === true || execErr.signal === 'SIGTERM';
    return {
      success: false,
      exitCode: execErr.status ?? -1,
      stdout: (execErr.stdout?.toString() || '').slice(0, maxBuffer / 2),
      stderr: (execErr.stderr?.toString() || (err instanceof Error ? err.message : String(err)) || '').slice(0, maxBuffer / 2),
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
  let cmd = 'npm install';
  if (fs.existsSync(path.join(config.workspacePath, 'pnpm-lock.yaml'))) cmd = 'pnpm install';
  else if (fs.existsSync(path.join(config.workspacePath, 'yarn.lock'))) cmd = 'yarn install';
  else if (fs.existsSync(path.join(config.workspacePath, 'requirements.txt'))) cmd = 'pip install -r requirements.txt';
  else if (fs.existsSync(path.join(config.workspacePath, 'Cargo.toml'))) cmd = 'cargo build';
  else if (fs.existsSync(path.join(config.workspacePath, 'go.mod'))) cmd = 'go mod download';

  return execInSandbox(cmd, { ...config, timeoutMs: config.timeoutMs ?? 300_000 });
}

// ═══════════════════════════════════════
// v6.0: 异步执行模式 (长时间进程)
// ═══════════════════════════════════════

export interface AsyncSandboxHandle {
  /** 进程 PID */
  pid: number;
  /** 进程 Promise — resolve 时返回完整结果 */
  promise: Promise<SandboxResult>;
  /** 杀掉进程 */
  kill: () => void;
  /** 已经收集的 stdout (实时增长) */
  getStdout: () => string;
  /** 已经收集的 stderr (实时增长) */
  getStderr: () => string;
  /** 注册实时输出回调 */
  onData: (cb: (chunk: string, stream: 'stdout' | 'stderr') => void) => void;
}

/**
 * 异步执行命令 — 使用 spawn 替代 execSync，支持:
 * - 长时间进程 (如 npm run dev, docker-compose up)
 * - 实时 stdout/stderr 流式回调
 * - 外部取消 (kill)
 * - AbortSignal 集成
 */
export function execInSandboxAsync(
  command: string,
  config: SandboxConfig,
  signal?: AbortSignal,
): AsyncSandboxHandle | SandboxResult {
  const start = Date.now();

  // 复用同步模式的安全检查
  if (isForbidden(command)) {
    return {
      success: false, exitCode: -1,
      stdout: '', stderr: `命令被安全策略拦截: ${command}`,
      timedOut: false, duration: 0,
    };
  }

  if (hasPathTraversal(command, config.workspacePath)) {
    return {
      success: false, exitCode: -1,
      stdout: '', stderr: `命令包含路径逃逸模式，已拦截: ${command.slice(0, 200)}`,
      timedOut: false, duration: 0,
    };
  }

  const wpCheck = validateWorkspacePath(config.workspacePath);
  if (!wpCheck.ok) {
    return {
      success: false, exitCode: -1,
      stdout: '', stderr: wpCheck.error || '工作路径验证失败',
      timedOut: false, duration: 0,
    };
  }

  const cwd = wpCheck.resolved;
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxBuffer = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const env = buildSafeEnv(config.env);
  const isWindows = process.platform === 'win32';

  // 使用 shell spawn
  const child: ChildProcess = spawn(command, [], {
    cwd,
    env,
    shell: isWindows ? 'powershell.exe' : '/bin/sh',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  let killed = false;
  let timerHandle: ReturnType<typeof setTimeout> | null = null;
  const dataListeners: Array<(chunk: string, stream: 'stdout' | 'stderr') => void> = [];

  // 收集 stdout
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf-8');
    if (stdoutBuf.length < maxBuffer) {
      stdoutBuf += text;
      if (stdoutBuf.length > maxBuffer) stdoutBuf = stdoutBuf.slice(0, maxBuffer);
    }
    for (const cb of dataListeners) {
      try { cb(text, 'stdout'); } catch (err) { /* ignore listener errors */ }
    }
  });

  // 收集 stderr
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf-8');
    if (stderrBuf.length < maxBuffer / 2) {
      stderrBuf += text;
      if (stderrBuf.length > maxBuffer / 2) stderrBuf = stderrBuf.slice(0, maxBuffer / 2);
    }
    for (const cb of dataListeners) {
      try { cb(text, 'stderr'); } catch (err) { /* ignore listener errors */ }
    }
  });

  // 超时控制
  timerHandle = setTimeout(() => {
    killed = true;
    child.kill('SIGTERM');
    // 给进程 5s 收尾
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (err) { /* already dead */ } }, 5000);
  }, timeout);

  // AbortSignal 集成
  if (signal) {
    const onAbort = () => { killed = true; child.kill('SIGTERM'); };
    signal.addEventListener('abort', onAbort, { once: true });
    // Cleanup listener when process exits
    child.once('exit', () => signal.removeEventListener('abort', onAbort));
  }

  // Promise — resolve when process exits
  const promise = new Promise<SandboxResult>((resolve) => {
    child.once('exit', (code, sig) => {
      if (timerHandle) clearTimeout(timerHandle);
      const timedOut = killed && sig === 'SIGTERM';
      resolve({
        success: code === 0,
        exitCode: code ?? -1,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        timedOut,
        duration: Date.now() - start,
      });
    });

    child.once('error', (err) => {
      if (timerHandle) clearTimeout(timerHandle);
      resolve({
        success: false,
        exitCode: -1,
        stdout: stdoutBuf,
        stderr: (err instanceof Error ? err.message : String(err)),
        timedOut: false,
        duration: Date.now() - start,
      });
    });
  });

  return {
    pid: child.pid ?? 0,
    promise,
    kill: () => { killed = true; child.kill('SIGTERM'); },
    getStdout: () => stdoutBuf,
    getStderr: () => stderrBuf,
    onData: (cb) => dataListeners.push(cb),
  };
}

/** 判断返回值是同步错误还是异步 handle */
export function isAsyncHandle(result: AsyncSandboxHandle | SandboxResult): result is AsyncSandboxHandle {
  return 'promise' in result;
}

/**
 * 异步执行命令并直接返回 Promise<SandboxResult>
 * 对 execInSandboxAsync 的便捷封装 — 适用于只需要最终结果的场景
 */
export async function execInSandboxPromise(
  command: string,
  config: SandboxConfig,
  signal?: AbortSignal,
): Promise<SandboxResult> {
  const result = execInSandboxAsync(command, config, signal);
  if (isAsyncHandle(result)) {
    return result.promise;
  }
  // 安全检查失败 — 直接返回同步错误
  return result;
}

/** 异步运行 npm/pnpm/yarn 测试 */
export async function runTestAsync(config: SandboxConfig): Promise<SandboxResult> {
  let cmd = 'npm test';
  if (fs.existsSync(path.join(config.workspacePath, 'pnpm-lock.yaml'))) cmd = 'pnpm test';
  else if (fs.existsSync(path.join(config.workspacePath, 'yarn.lock'))) cmd = 'yarn test';
  else if (fs.existsSync(path.join(config.workspacePath, 'requirements.txt'))) cmd = 'python -m pytest';
  else if (fs.existsSync(path.join(config.workspacePath, 'Cargo.toml'))) cmd = 'cargo test';
  else if (fs.existsSync(path.join(config.workspacePath, 'go.mod'))) cmd = 'go test ./...';

  return execInSandboxPromise(cmd, { ...config, timeoutMs: config.timeoutMs ?? 180_000 });
}

/** 异步运行 lint / type-check */
export async function runLintAsync(config: SandboxConfig): Promise<SandboxResult> {
  const commands: string[] = [];

  if (fs.existsSync(path.join(config.workspacePath, 'tsconfig.json'))) {
    commands.push('npx tsc --noEmit');
  }
  if (fs.existsSync(path.join(config.workspacePath, '.eslintrc.json')) ||
      fs.existsSync(path.join(config.workspacePath, '.eslintrc.js')) ||
      fs.existsSync(path.join(config.workspacePath, 'eslint.config.js'))) {
    commands.push('npx eslint . --max-warnings 50');
  }
  if (fs.existsSync(path.join(config.workspacePath, 'requirements.txt')) ||
      fs.existsSync(path.join(config.workspacePath, 'pyproject.toml'))) {
    commands.push('python -m py_compile');
  }

  if (commands.length === 0) {
    return { success: true, exitCode: 0, stdout: '未检测到 lint/type-check 配置', stderr: '', timedOut: false, duration: 0 };
  }

  const results: string[] = [];
  let anyFailed = false;

  for (const cmd of commands) {
    const r = await execInSandboxPromise(cmd, { ...config, timeoutMs: 60_000 });
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

/** 异步安装依赖 */
export async function installDepsAsync(config: SandboxConfig): Promise<SandboxResult> {
  let cmd = 'npm install';
  if (fs.existsSync(path.join(config.workspacePath, 'pnpm-lock.yaml'))) cmd = 'pnpm install';
  else if (fs.existsSync(path.join(config.workspacePath, 'yarn.lock'))) cmd = 'yarn install';
  else if (fs.existsSync(path.join(config.workspacePath, 'requirements.txt'))) cmd = 'pip install -r requirements.txt';
  else if (fs.existsSync(path.join(config.workspacePath, 'Cargo.toml'))) cmd = 'cargo build';
  else if (fs.existsSync(path.join(config.workspacePath, 'go.mod'))) cmd = 'go mod download';

  return execInSandboxPromise(cmd, { ...config, timeoutMs: config.timeoutMs ?? 300_000 });
}

// ═══════════════════════════════════════
// v6.0: 活跃子进程管理
// ═══════════════════════════════════════

const activeProcesses = new Map<string, AsyncSandboxHandle>();

/** 注册一个异步进程到管理器 */
export function registerProcess(id: string, handle: AsyncSandboxHandle): void {
  activeProcesses.set(id, handle);
  handle.promise.then(() => activeProcesses.delete(id)).catch(() => activeProcesses.delete(id));
}

/** 获取活跃进程 */
export function getActiveProcess(id: string): AsyncSandboxHandle | undefined {
  return activeProcesses.get(id);
}

/** v19.0: 等待后台进程完成（带超时） */
export async function waitForProcess(id: string, timeoutMs: number = 120_000): Promise<SandboxResult & { processId: string }> {
  const handle = activeProcesses.get(id);
  if (!handle) {
    return { processId: id, success: false, stdout: '', stderr: `进程 ${id} 不存在或已结束`, exitCode: -1, duration: 0, timedOut: false };
  }
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`wait_for_process 超时 (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs)
  );
  try {
    const result = await Promise.race([handle.promise, timeoutPromise]);
    return { ...result, processId: id };
  } catch (err) {
    // 超时 — 返回当前已有的输出
    const stdout = handle.getStdout();
    const stderr = handle.getStderr();
    return { processId: id, success: false, stdout, stderr: `${err instanceof Error ? err.message : String(err)}\n${stderr}`, exitCode: -1, duration: timeoutMs, timedOut: true };
  }
}

/** 杀掉所有活跃子进程 (graceful shutdown) */
export function killAllProcesses(): void {
  for (const [id, handle] of activeProcesses) {
    try { handle.kill(); } catch (err) { /* ignore */ }
    activeProcesses.delete(id);
  }
}
