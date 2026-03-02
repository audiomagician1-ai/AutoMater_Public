/**
 * Docker Sandbox — 容器化隔离执行环境
 *
 * 通过本地 Docker CLI (docker exec / docker cp) 实现：
 *   - 完全隔离的执行环境 (无需安装 dockerode 等 npm 包)
 *   - 多镜像支持 (node/python/rust/go 等)
 *   - 文件双向传输 (宿主 ↔ 容器)
 *   - 端口暴露
 *   - 容器生命周期管理
 *
 * 零 npm 依赖 — 仅通过 child_process 调用本地 docker CLI。
 * LAN 友好 — 唯一前置条件是用户机器安装了 Docker。
 *
 * @module docker-sandbox
 * @since v7.0.0
 */

import { exec as execCb, execSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from './logger';

const execAsync = promisify(execCb);
const log = createLogger('docker-sandbox');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface SandboxConfig {
  /** Docker 镜像 (如 'node:20-slim', 'python:3.12-slim') */
  image: string;
  /** 容器内环境变量 */
  env?: Record<string, string>;
  /** 容器内工作目录 */
  workDir?: string;
  /** 是否挂载宿主 workspace 到容器 */
  mountWorkspace?: boolean;
  /** 宿主 workspace 路径 (mountWorkspace=true 时必须) */
  hostWorkspacePath?: string;
  /** CPU 限制 (核数, 如 2) */
  cpuLimit?: number;
  /** 内存限制 (如 '512m', '2g') */
  memoryLimit?: string;
}

export interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

interface ContainerInfo {
  containerId: string;
  image: string;
  createdAt: number;
  config: SandboxConfig;
}

// ═══════════════════════════════════════
// Container Registry
// ═══════════════════════════════════════

const containers = new Map<string, ContainerInfo>();

// ═══════════════════════════════════════
// Docker Availability Check
// ═══════════════════════════════════════

let _dockerAvailable: boolean | null = null;

/** 检查 Docker 是否可用 */
export function isDockerAvailable(): boolean {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }
  return _dockerAvailable;
}

/** 重新检测 Docker 可用性 (例如用户安装 Docker 后) */
export function resetDockerCheck(): void {
  _dockerAvailable = null;
}

// ═══════════════════════════════════════
// Preset Images
// ═══════════════════════════════════════

export const SANDBOX_PRESETS: Record<string, SandboxConfig> = {
  'node': { image: 'node:20-slim', workDir: '/workspace', memoryLimit: '1g' },
  'python': { image: 'python:3.12-slim', workDir: '/workspace', memoryLimit: '1g' },
  'rust': { image: 'rust:1.77-slim', workDir: '/workspace', memoryLimit: '2g' },
  'go': { image: 'golang:1.22-alpine', workDir: '/workspace', memoryLimit: '1g' },
  'ubuntu': { image: 'ubuntu:22.04', workDir: '/workspace', memoryLimit: '1g' },
};

// ═══════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════

/**
 * 初始化一个沙箱容器。
 * 返回容器 ID (短格式 12 字符)。
 */
export async function initSandbox(config: SandboxConfig): Promise<{ success: boolean; containerId?: string; error?: string }> {
  if (!isDockerAvailable()) {
    return { success: false, error: 'Docker 未安装或未启动。请确保本机已安装 Docker 并且 Docker daemon 正在运行。' };
  }

  try {
    const args: string[] = ['docker', 'run', '-d', '--rm'];

    // 工作目录
    const workDir = config.workDir || '/workspace';
    args.push('-w', workDir);

    // 环境变量
    if (config.env) {
      for (const [k, v] of Object.entries(config.env)) {
        args.push('-e', `${k}=${v}`);
      }
    }

    // 资源限制
    if (config.cpuLimit) args.push('--cpus', String(config.cpuLimit));
    if (config.memoryLimit) args.push('-m', config.memoryLimit);

    // 挂载宿主 workspace
    if (config.mountWorkspace && config.hostWorkspacePath) {
      const hostPath = path.resolve(config.hostWorkspacePath);
      args.push('-v', `${hostPath}:${workDir}`);
    }

    // 镜像 + 保持运行的 entrypoint
    args.push(config.image, 'tail', '-f', '/dev/null');

    const cmd = args.join(' ');
    log.info(`Creating sandbox: ${cmd}`);

    const { stdout } = await execAsync(cmd, { timeout: 60_000 });
    const containerId = stdout.trim().slice(0, 12);

    if (!containerId) {
      return { success: false, error: '容器创建失败：未返回容器 ID' };
    }

    containers.set(containerId, {
      containerId,
      image: config.image,
      createdAt: Date.now(),
      config,
    });

    log.info(`Sandbox created: ${containerId} (${config.image})`);
    return { success: true, containerId };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Sandbox init failed: ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * 在沙箱容器内执行命令。
 */
export async function execInContainer(
  containerId: string,
  command: string,
  opts?: { timeout?: number; workDir?: string },
): Promise<ExecResult> {
  const startTime = Date.now();
  const timeoutMs = (opts?.timeout ?? 60) * 1000;

  if (!containers.has(containerId)) {
    return { success: false, stdout: '', stderr: `容器 ${containerId} 不存在或已销毁`, exitCode: -1, timedOut: false, durationMs: 0 };
  }

  try {
    const args: string[] = ['docker', 'exec'];
    if (opts?.workDir) args.push('-w', opts.workDir);
    args.push(containerId, 'sh', '-c', command);

    const { stdout, stderr } = await execAsync(args.join(' '), {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });

    return {
      success: true,
      stdout: stdout.slice(0, 50_000),
      stderr: stderr.slice(0, 10_000),
      exitCode: 0,
      timedOut: false,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    const timedOut = err.killed === true;
    return {
      success: false,
      stdout: (err.stdout || '').slice(0, 50_000),
      stderr: (err.stderr || err.message || '').slice(0, 10_000),
      exitCode: err.code ?? -1,
      timedOut,
      durationMs: Date.now() - startTime,
    };
  }
}

// ═══════════════════════════════════════
// File I/O
// ═══════════════════════════════════════

/** 向容器写入文件 */
export async function writeToContainer(
  containerId: string,
  containerPath: string,
  content: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // 通过临时文件 + docker cp 实现
    const tmpFile = path.join(os.tmpdir(), `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.writeFileSync(tmpFile, content, 'utf-8');

    // 确保容器内目录存在
    const containerDir = path.posix.dirname(containerPath);
    await execAsync(`docker exec ${containerId} mkdir -p ${containerDir}`, { timeout: 5000 });

    // docker cp
    await execAsync(`docker cp "${tmpFile}" ${containerId}:${containerPath}`, { timeout: 10_000 });

    // 清理临时文件
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 从容器读取文件 */
export async function readFromContainer(
  containerId: string,
  containerPath: string,
): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    const { stdout } = await execAsync(
      `docker exec ${containerId} cat ${containerPath}`,
      { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
    );
    return { success: true, content: stdout };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 宿主文件 → 容器 */
export async function copyToContainer(
  containerId: string,
  hostPath: string,
  containerPath: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const absHost = path.resolve(hostPath);
    const containerDir = path.posix.dirname(containerPath);
    await execAsync(`docker exec ${containerId} mkdir -p ${containerDir}`, { timeout: 5000 });
    await execAsync(`docker cp "${absHost}" ${containerId}:${containerPath}`, { timeout: 30_000 });
    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 容器文件 → 宿主 */
export async function copyFromContainer(
  containerId: string,
  containerPath: string,
  hostPath: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const absHost = path.resolve(hostPath);
    fs.mkdirSync(path.dirname(absHost), { recursive: true });
    await execAsync(`docker cp ${containerId}:${containerPath} "${absHost}"`, { timeout: 30_000 });
    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ═══════════════════════════════════════
// Port Exposure
// ═══════════════════════════════════════

/**
 * 暴露容器端口。
 * 注: 必须在 initSandbox 时就指定 -p 端口映射，
 * 或者使用 host network (--network host)。
 * 当前实现: 返回容器 IP + 端口供 LAN 访问。
 */
export async function getContainerPort(
  containerId: string,
  containerPort: number,
): Promise<{ success: boolean; host?: string; port?: number; error?: string }> {
  try {
    const { stdout } = await execAsync(
      `docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerId}`,
      { timeout: 5000 },
    );
    const ip = stdout.trim().replace(/'/g, '');
    if (!ip) return { success: false, error: '无法获取容器 IP' };
    return { success: true, host: ip, port: containerPort };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ═══════════════════════════════════════
// Lifecycle — Destroy
// ═══════════════════════════════════════

/** 销毁单个容器 */
export async function destroySandbox(containerId: string): Promise<{ success: boolean; error?: string }> {
  try {
    await execAsync(`docker rm -f ${containerId}`, { timeout: 10_000 });
    containers.delete(containerId);
    log.info(`Sandbox destroyed: ${containerId}`);
    return { success: true };
  } catch (err: unknown) {
    containers.delete(containerId); // 从注册表中移除
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 销毁所有沙箱容器 (应用退出时调用) */
export async function destroyAllSandboxes(): Promise<void> {
  const ids = [...containers.keys()];
  log.info(`Destroying all sandboxes: ${ids.length}`);
  await Promise.allSettled(ids.map(id => destroySandbox(id)));
}

/** 列出当前存活的沙箱容器 */
export function listSandboxes(): Array<{ containerId: string; image: string; createdAt: number; ageMs: number }> {
  const now = Date.now();
  return [...containers.values()].map(c => ({
    containerId: c.containerId,
    image: c.image,
    createdAt: c.createdAt,
    ageMs: now - c.createdAt,
  }));
}

// ═══════════════════════════════════════
// Smart Routing — 判断命令是否应该走沙箱
// ═══════════════════════════════════════

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+[\/~]/,       // rm -rf / or ~
  /mkfs/,                     // format disk
  /dd\s+if=/,                 // raw disk write
  /curl\s.*\|\s*(ba)?sh/,    // curl | bash
  /wget\s.*\|\s*(ba)?sh/,    // wget | bash
  /chmod\s+777/,              // overly permissive
  />\s*\/dev\/sd/,            // write to device
];

const ISOLATION_RECOMMENDED = [
  /npm\s+install/,
  /pip\s+install/,
  /cargo\s+build/,
  /go\s+build/,
  /make\s+install/,
  /apt(-get)?\s+install/,
  /brew\s+install/,
];

/**
 * 判断命令是否建议路由到沙箱执行。
 * 返回 'block' | 'sandbox' | 'allow'
 */
export function classifyCommand(command: string): 'block' | 'sandbox' | 'allow' {
  for (const re of DANGEROUS_PATTERNS) {
    if (re.test(command)) return 'block';
  }
  for (const re of ISOLATION_RECOMMENDED) {
    if (re.test(command)) return 'sandbox';
  }
  return 'allow';
}
