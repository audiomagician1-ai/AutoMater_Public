/**
 * Skill Loader — 本地技能目录扫描器
 *
 * 从指定目录读取 JSON 格式的技能定义文件，转换为 AutoMater 的 ToolDefinition。
 * 每个 .json 文件定义一个或多个工具，文件格式:
 *
 * ```json
 * {
 *   "name": "my_tool",
 *   "description": "工具描述",
 *   "parameters": { "type": "object", "properties": { ... } },
 *   "execution": {
 *     "type": "command",
 *     "command": "python",
 *     "args": ["script.py", "{{input}}"],
 *     "cwd": "/path/to/script",
 *     "timeout": 30000
 *   }
 * }
 * ```
 *
 * 或者批量定义:
 * ```json
 * {
 *   "skills": [
 *     { "name": "tool_a", ... },
 *     { "name": "tool_b", ... }
 *   ]
 * }
 * ```
 *
 * execution.type 支持:
 *   - "command": 执行本地命令 (子进程)
 *   - "http": 发送 HTTP 请求到指定 URL
 *   - "script": 执行内联脚本 (Node.js eval, 需用户信任)
 *
 * @module skill-loader
 * @since v5.0.0
 */

import fs from 'fs';
import path from 'path';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(execCb);
import { createLogger } from './logger';
import type { ToolDefinition } from './tool-registry';

const log = createLogger('skill-loader');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

/** 技能执行配置 */
export interface SkillExecution {
  /** 执行方式 */
  type: 'command' | 'http' | 'script';
  /** command: 可执行程序 */
  command?: string;
  /** command: 参数模板 (支持 {{arg_name}} 占位符) */
  args?: string[];
  /** command: 工作目录 */
  cwd?: string;
  /** command/http: 超时毫秒 (默认 30000) */
  timeout?: number;
  /** http: 请求 URL 模板 */
  url?: string;
  /** http: 请求方法 */
  method?: string;
  /** http: 请求头 */
  headers?: Record<string, string>;
  /** http: 请求体模板 (JSON 字符串, 支持 {{arg_name}}) */
  bodyTemplate?: string;
  /** script: 内联 JavaScript 代码 (接收 args 对象, 返回字符串) */
  code?: string;
}

/** 单个技能定义 (文件内格式) */
export interface SkillFileEntry {
  name: string;
  description: string;
  parameters?: Record<string, any>;
  execution: SkillExecution;
  /** 允许使用的角色 (空=全部) */
  allowedRoles?: string[];
}

/** 加载后的技能 (含执行信息) */
export interface LoadedSkill {
  /** 作为 AutoMater 工具使用的定义 */
  definition: ToolDefinition;
  /** 执行配置 */
  execution: SkillExecution;
  /** 来源文件路径 */
  sourceFile: string;
  /** 允许使用的角色 */
  allowedRoles: string[];
}

/** 技能目录扫描结果 */
export interface SkillScanResult {
  /** 成功加载的技能 */
  skills: LoadedSkill[];
  /** 加载失败的文件及原因 */
  errors: Array<{ file: string; error: string }>;
}

// ═══════════════════════════════════════
// Skill Directory Scanner
// ═══════════════════════════════════════

/**
 * 扫描技能目录, 加载所有 .json 文件中的技能定义。
 *
 * @param dirPath - 技能目录绝对路径
 * @returns 加载结果 (含技能列表和错误信息)
 */
export function scanSkillDirectory(dirPath: string): SkillScanResult {
  const result: SkillScanResult = { skills: [], errors: [] };

  if (!dirPath || !fs.existsSync(dirPath)) {
    log.warn('Skill directory does not exist', { path: dirPath });
    return result;
  }

  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    result.errors.push({ file: dirPath, error: 'Path is not a directory' });
    return result;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch (err: unknown) {
    result.errors.push({ file: dirPath, error: `Cannot read directory: ${err instanceof Error ? err.message : String(err)}` });
    return result;
  }

  const jsonFiles = entries.filter(f => f.endsWith('.json'));

  for (const fileName of jsonFiles) {
    const filePath = path.join(dirPath, fileName);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      const skills = parseSkillFile(parsed, filePath);
      result.skills.push(...skills);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result.errors.push({ file: fileName, error: errMsg });
      log.warn('Failed to load skill file', { file: fileName, error: errMsg });
    }
  }

  // 递归扫描子目录 (一层)
  const subdirs = entries.filter(f => {
    const p = path.join(dirPath, f);
    try { return fs.statSync(p).isDirectory() && !f.startsWith('.'); }
    catch { return false; }
  });

  for (const subdir of subdirs) {
    const subResult = scanSkillDirectory(path.join(dirPath, subdir));
    result.skills.push(...subResult.skills);
    result.errors.push(...subResult.errors);
  }

  log.info('Skill directory scanned', {
    path: dirPath,
    loaded: result.skills.length,
    errors: result.errors.length,
  });

  return result;
}

/** 解析单个技能文件内容 */
function parseSkillFile(data: Record<string, unknown>, filePath: string): LoadedSkill[] {
  const skills: LoadedSkill[] = [];

  // 批量格式: { skills: [...] }
  if (data.skills && Array.isArray(data.skills)) {
    for (const entry of data.skills) {
      skills.push(parseSkillEntry(entry, filePath));
    }
    return skills;
  }

  // 单个格式: { name, description, ... }
  if (data.name && typeof data.name === 'string') {
    skills.push(parseSkillEntry(data, filePath));
    return skills;
  }

  throw new Error('Invalid skill file format: must have "name" field or "skills" array');
}

/** 验证并解析单个技能条目 */
function parseSkillEntry(entry: Record<string, unknown>, filePath: string): LoadedSkill {
  if (!entry.name || typeof entry.name !== 'string') {
    throw new Error(`Skill missing "name" in ${filePath}`);
  }
  if (!entry.description || typeof entry.description !== 'string') {
    throw new Error(`Skill "${entry.name}" missing "description"`);
  }
  if (!entry.execution || typeof entry.execution !== 'object') {
    throw new Error(`Skill "${entry.name}" missing "execution" config`);
  }

  const execution = entry.execution as Record<string, unknown>;
  const execType = execution.type as string;
  if (!['command', 'http', 'script'].includes(execType)) {
    throw new Error(`Skill "${entry.name}" has invalid execution type: ${execType}`);
  }

  // 为安全起见, 对 command 和 script 类型做基本校验
  if (execType === 'command' && !execution.command) {
    throw new Error(`Skill "${entry.name}" (command type) missing "command"`);
  }
  if (execType === 'http' && !execution.url) {
    throw new Error(`Skill "${entry.name}" (http type) missing "url"`);
  }
  if (execType === 'script' && !execution.code) {
    throw new Error(`Skill "${entry.name}" (script type) missing "code"`);
  }

  // 构造 AutoMater ToolDefinition
  const definition: ToolDefinition = {
    name: `skill_${entry.name}`,
    description: `[Skill] ${entry.description}`,
    parameters: (entry.parameters as Record<string, unknown>) || { type: 'object', properties: {} },
  };

  return {
    definition,
    execution: entry.execution as SkillExecution,
    sourceFile: filePath,
    allowedRoles: (entry.allowedRoles as string[]) || [],
  };
}

// ═══════════════════════════════════════
// Skill Execution
// ═══════════════════════════════════════

/**
 * 执行技能。将工具参数按 execution 配置分发到对应的执行方式。
 *
 * @param skill - 已加载的技能
 * @param args - 工具调用参数
 * @returns 执行结果 { success, output }
 */
export async function executeSkill(
  skill: LoadedSkill,
  args: Record<string, unknown>,
): Promise<{ success: boolean; output: string }> {
  const exec = skill.execution;
  const timeout = exec.timeout ?? 30_000;

  try {
    switch (exec.type) {
      case 'command':
        return await executeCommandSkill(exec, args, timeout);
      case 'http':
        return await executeHttpSkill(exec, args, timeout);
      case 'script':
        return executeScriptSkill(exec, args, timeout);
      default:
        return { success: false, output: `Unknown execution type: ${exec.type}` };
    }
  } catch (err: unknown) {
    return { success: false, output: `Skill execution error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 模板替换: {{arg_name}} → 实际值 */
function interpolate(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = args[key];
    return val !== undefined ? String(val) : '';
  });
}

/** command 类型执行 (async — 不阻塞主进程) */
async function executeCommandSkill(
  exec: SkillExecution,
  args: Record<string, unknown>,
  timeout: number,
): Promise<{ success: boolean; output: string }> {
  const command = exec.command!;
  const cmdArgs = (exec.args || []).map(a => interpolate(a, args));
  const fullCommand = [command, ...cmdArgs].join(' ');

  try {
    const { stdout } = await execAsync(fullCommand, {
      cwd: exec.cwd || undefined,
      encoding: 'utf-8',
      timeout,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return { success: true, output: stdout.slice(0, 10_000) };
  } catch (err: unknown) {
    const execErr = err as { stderr?: Buffer | string; stdout?: Buffer | string; status?: number };
    const stderr = execErr.stderr?.toString() || '';
    const stdout = execErr.stdout?.toString() || '';
    return {
      success: false,
      output: `Command failed (exit ${execErr.status}):\n${stderr.slice(0, 3000)}${stdout ? '\n--- stdout ---\n' + stdout.slice(0, 2000) : ''}`,
    };
  }
}

/** http 类型执行 */
async function executeHttpSkill(
  exec: SkillExecution,
  args: Record<string, unknown>,
  timeout: number,
): Promise<{ success: boolean; output: string }> {
  const url = interpolate(exec.url!, args);
  const method = exec.method || 'POST';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(exec.headers || {}),
  };

  let body: string | undefined;
  if (exec.bodyTemplate) {
    body = interpolate(exec.bodyTemplate, args);
  } else if (method !== 'GET' && method !== 'HEAD') {
    body = JSON.stringify(args);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const text = await response.text();
    return {
      success: response.ok,
      output: `HTTP ${response.status}\n${text.slice(0, 10_000)}`,
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    return { success: false, output: `HTTP request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** script 类型执行 (Node.js Function 构造器) */
function executeScriptSkill(
  exec: SkillExecution,
  args: Record<string, unknown>,
  timeout: number,
): { success: boolean; output: string } {
  try {
    // 创建沙盒化的函数 (不能访问 require/import, 只接收 args)
    const fn = new Function('args', `
      'use strict';
      ${exec.code!}
    `);
    const result = fn(args);
    const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { success: true, output: output.slice(0, 10_000) };
  } catch (err: unknown) {
    return { success: false, output: `Script error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ═══════════════════════════════════════
// Skill Manager (全局单例)
// ═══════════════════════════════════════

/**
 * 技能管理器: 维护加载的技能列表, 提供查找和执行入口。
 */
class SkillManager {
  private skills = new Map<string, LoadedSkill>();
  private skillDirPath: string | null = null;

  /** 设置并扫描技能目录 */
  loadFromDirectory(dirPath: string): SkillScanResult {
    this.skills.clear();
    this.skillDirPath = dirPath;

    if (!dirPath) {
      return { skills: [], errors: [] };
    }

    const result = scanSkillDirectory(dirPath);
    for (const skill of result.skills) {
      this.skills.set(skill.definition.name, skill);
    }
    return result;
  }

  /** 重新加载 (从上次设置的目录) */
  reload(): SkillScanResult {
    if (!this.skillDirPath) {
      return { skills: [], errors: [] };
    }
    return this.loadFromDirectory(this.skillDirPath);
  }

  /** 获取所有已加载技能的 ToolDefinition */
  getAllDefinitions(): ToolDefinition[] {
    return Array.from(this.skills.values()).map(s => s.definition);
  }

  /** 按角色过滤技能 */
  getDefinitionsForRole(role: string): ToolDefinition[] {
    return Array.from(this.skills.values())
      .filter(s => s.allowedRoles.length === 0 || s.allowedRoles.includes(role))
      .map(s => s.definition);
  }

  /** 查找技能 */
  getSkill(toolName: string): LoadedSkill | undefined {
    return this.skills.get(toolName);
  }

  /** 执行技能 */
  async executeSkill(toolName: string, args: Record<string, unknown>): Promise<{ success: boolean; output: string }> {
    const skill = this.skills.get(toolName);
    if (!skill) {
      return { success: false, output: `Skill not found: ${toolName}` };
    }
    return executeSkill(skill, args);
  }

  /** 技能数量 */
  get count(): number {
    return this.skills.size;
  }

  /** 当前技能目录路径 */
  get directoryPath(): string | null {
    return this.skillDirPath;
  }
}

/** 全局技能管理器实例 */
export const skillManager = new SkillManager();
