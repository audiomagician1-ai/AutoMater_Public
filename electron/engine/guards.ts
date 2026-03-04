/**
 * Guards — 程序化硬约束层
 *
 * 所有 LLM 无法可靠遵守的规则，在此用算法和程序逻辑强制执行。
 * 替代提示词中的"请遵守"、"请不要"、"必须"等软约束。
 *
 * 分为以下子系统:
 *  1. ToolCallGuard   — 工具调用参数校验 + 速率限制 + 副作用审计
 *  2. ReactGuard      — ReAct 循环的程序化终止条件 (不依赖 task_complete)
 *  3. QAGuard         — QA 判定的程序化规则引擎
 *  4. PipelineGate    — 阶段间的硬门控 (不依赖文本标记)
 *  5. BudgetController — Token / Cost / Time 的多维硬限制
 *
 * v3.0: 新模块 — 从"信任 LLM 遵守 prompt"升级为"程序强制执行"
 */

import fs from 'fs';
import path from 'path';
import type { ParsedFeature } from './types';

// ═══════════════════════════════════════
// 1. Tool Call Guard — 参数校验 + 速率控制
// ═══════════════════════════════════════

export interface ToolParamSpec {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  /** 字符串最大长度 */
  maxLength?: number;
  /** 数值范围 */
  min?: number;
  max?: number;
  /** 枚举值 */
  enum?: unknown[];
  /** 自定义校验函数 */
  validate?: (value: unknown) => string | null;
}

export interface ToolGuardSpec {
  name: string;
  params: ToolParamSpec[];
  /** 副作用类型: none=纯读, write=写文件, execute=运行命令, network=网络 */
  sideEffect: 'none' | 'write' | 'execute' | 'network' | 'system';
  /** 每分钟最大调用次数 (0=无限制) */
  rateLimit: number;
  /** 是否需要 workspace 路径 */
  requiresWorkspace: boolean;
}

export interface ToolGuardResult {
  allowed: boolean;
  /** 拦截原因 */
  reason?: string;
  /** 修复后的参数 (自动纠正可安全修复的问题) */
  repairedArgs?: Record<string, unknown>;
}

/** 工具的程序化参数规范 */
const TOOL_GUARD_SPECS: Record<string, ToolGuardSpec> = {
  read_file: {
    name: 'read_file',
    params: [
      { name: 'path', type: 'string', required: true, maxLength: 500, validate: validateReadPath },
      { name: 'offset', type: 'number', required: false, min: 1, max: 100000 },
      { name: 'limit', type: 'number', required: false, min: 1, max: 500 },
    ],
    sideEffect: 'none',
    rateLimit: 60,
    requiresWorkspace: true,
  },
  write_file: {
    name: 'write_file',
    params: [
      { name: 'path', type: 'string', required: true, maxLength: 500, validate: validateRelativePath },
      { name: 'content', type: 'string', required: true, maxLength: 1_000_000 },
    ],
    sideEffect: 'write',
    rateLimit: 30,
    requiresWorkspace: true,
  },
  edit_file: {
    name: 'edit_file',
    params: [
      { name: 'path', type: 'string', required: true, maxLength: 500, validate: validateRelativePath },
      { name: 'old_string', type: 'string', required: true, maxLength: 100_000 },
      { name: 'new_string', type: 'string', required: true, maxLength: 200_000 },
    ],
    sideEffect: 'write',
    rateLimit: 30,
    requiresWorkspace: true,
  },
  batch_edit: {
    name: 'batch_edit',
    params: [
      { name: 'path', type: 'string', required: true, maxLength: 500, validate: validateRelativePath },
      { name: 'edits', type: 'array', required: true },
    ],
    sideEffect: 'write',
    rateLimit: 20,
    requiresWorkspace: true,
  },
  run_command: {
    name: 'run_command',
    params: [{ name: 'command', type: 'string', required: true, maxLength: 2000 }],
    sideEffect: 'execute',
    rateLimit: 15,
    requiresWorkspace: true,
  },
  web_search: {
    name: 'web_search',
    params: [
      { name: 'query', type: 'string', required: true, maxLength: 500 },
      { name: 'max_results', type: 'number', required: false, min: 1, max: 20 },
    ],
    sideEffect: 'network',
    rateLimit: 10,
    requiresWorkspace: false,
  },
  fetch_url: {
    name: 'fetch_url',
    params: [
      { name: 'url', type: 'string', required: true, maxLength: 2000, validate: validateUrl },
      { name: 'max_length', type: 'number', required: false, min: 100, max: 100_000 },
    ],
    sideEffect: 'network',
    rateLimit: 10,
    requiresWorkspace: false,
  },
  http_request: {
    name: 'http_request',
    params: [
      { name: 'url', type: 'string', required: true, maxLength: 2000, validate: validateUrl },
      { name: 'method', type: 'string', required: false, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
      { name: 'timeout', type: 'number', required: false, min: 1000, max: 60000 },
    ],
    sideEffect: 'network',
    rateLimit: 10,
    requiresWorkspace: false,
  },
  screenshot: {
    name: 'screenshot',
    params: [{ name: 'scale', type: 'number', required: false, min: 0.1, max: 2.0 }],
    sideEffect: 'system',
    rateLimit: 10,
    requiresWorkspace: false,
  },
  keyboard_type: {
    name: 'keyboard_type',
    params: [{ name: 'text', type: 'string', required: true, maxLength: 5000 }],
    sideEffect: 'system',
    rateLimit: 20,
    requiresWorkspace: false,
  },
  keyboard_hotkey: {
    name: 'keyboard_hotkey',
    params: [{ name: 'combo', type: 'string', required: true, maxLength: 100, validate: validateHotkey }],
    sideEffect: 'system',
    rateLimit: 20,
    requiresWorkspace: false,
  },
};

// ── Validators ──

function validateRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') return 'path must be a string';
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return 'Absolute paths not allowed';
  if (normalized.includes('..')) return 'Path traversal (..) not allowed';
  if (/[\x00-\x1f]/.test(normalized)) return 'Control characters in path not allowed';
  return null;
}

/**
 * v16.0: 读操作路径验证 — 允许绝对路径（权限由 tool-executor 层检查）
 */
function validateReadPath(value: unknown): string | null {
  if (typeof value !== 'string') return 'path must be a string';
  const normalized = value.replace(/\\/g, '/');
  // 绝对路径允许通过（externalRead 权限在 tool-executor 中检查）
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  if (normalized.includes('..')) return 'Path traversal (..) not allowed';
  if (/[\x00-\x1f]/.test(normalized)) return 'Control characters in path not allowed';
  return null;
}

function validateUrl(value: unknown): string | null {
  if (typeof value !== 'string') return 'url must be a string';
  if (!value.match(/^https?:\/\//i)) return 'URL must start with http:// or https://';
  // Block internal/sensitive URLs
  const lower = value.toLowerCase();
  if (lower.includes('localhost') || lower.includes('127.0.0.1') || lower.includes('0.0.0.0')) {
    // Allow localhost for testing purposes but warn
    return null;
  }
  if (lower.includes('169.254.') || lower.includes('metadata.google') || lower.includes('metadata.aws')) {
    return 'Cloud metadata endpoints not allowed';
  }
  return null;
}

function validateHotkey(value: unknown): string | null {
  if (typeof value !== 'string') return 'combo must be a string';
  // 危险快捷键黑名单
  const dangerous = ['alt+f4', 'ctrl+alt+delete', 'ctrl+alt+del'];
  if (dangerous.includes(value.toLowerCase())) return `Dangerous hotkey blocked: ${value}`;
  return null;
}

// ── Rate Limiter ──

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, RateBucket>();

function checkRateLimit(toolName: string, limit: number): boolean {
  if (limit <= 0) return true;

  const now = Date.now();
  const key = toolName;
  const bucket = rateBuckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }

  if (bucket.count >= limit) return false;
  bucket.count++;
  return true;
}

/**
 * 校验工具调用: 参数类型 + 范围 + 路径安全 + 速率限制
 * 返回: { allowed, reason?, repairedArgs? }
 */
export function guardToolCall(toolName: string, args: Record<string, unknown>, hasWorkspace: boolean): ToolGuardResult {
  const spec = TOOL_GUARD_SPECS[toolName];

  // 未注册的工具 → 允许通过 (兼容旧工具)
  if (!spec) return { allowed: true };

  // workspace 检查
  if (spec.requiresWorkspace && !hasWorkspace) {
    return { allowed: false, reason: `Tool "${toolName}" requires a workspace path` };
  }

  // 速率限制
  if (!checkRateLimit(toolName, spec.rateLimit)) {
    return { allowed: false, reason: `Rate limit exceeded for "${toolName}" (max ${spec.rateLimit}/min)` };
  }

  // 参数校验 + 修复
  const repaired = { ...args };
  for (const param of spec.params) {
    const value = repaired[param.name];

    // 缺失必填参数
    if ((value === undefined || value === null) && param.required) {
      return { allowed: false, reason: `Missing required parameter: ${toolName}.${param.name}` };
    }

    if (value === undefined || value === null) continue;

    // 类型强制转换
    if (param.type === 'number' && typeof value !== 'number') {
      const num = Number(value);
      if (isNaN(num)) {
        return { allowed: false, reason: `${toolName}.${param.name}: expected number, got "${value}"` };
      }
      repaired[param.name] = num;
    }
    if (param.type === 'string' && typeof value !== 'string') {
      repaired[param.name] = String(value);
    }
    if (param.type === 'boolean' && typeof value !== 'boolean') {
      repaired[param.name] = Boolean(value);
    }

    // 数值范围钳制
    if (param.type === 'number' && typeof repaired[param.name] === 'number') {
      if (param.min !== undefined) repaired[param.name] = Math.max(param.min, repaired[param.name] as number);
      if (param.max !== undefined) repaired[param.name] = Math.min(param.max, repaired[param.name] as number);
    }

    // 字符串长度截断
    if (param.type === 'string' && typeof repaired[param.name] === 'string' && param.maxLength) {
      if ((repaired[param.name] as string).length > param.maxLength) {
        repaired[param.name] = (repaired[param.name] as string).slice(0, param.maxLength);
      }
    }

    // 枚举校验
    if (param.enum && !param.enum.includes(repaired[param.name] as string)) {
      return {
        allowed: false,
        reason: `${toolName}.${param.name}: "${repaired[param.name]}" not in [${param.enum.join(', ')}]`,
      };
    }

    // 自定义校验
    if (param.validate) {
      const err = param.validate(repaired[param.name]);
      if (err) return { allowed: false, reason: `${toolName}.${param.name}: ${err}` };
    }
  }

  return { allowed: true, repairedArgs: repaired };
}

// ═══════════════════════════════════════
// 2. React Guard — 程序化终止条件
// ═══════════════════════════════════════

export interface ReactTerminationConfig {
  maxIterations: number;
  maxTotalTokens: number;
  maxCostUsd: number;
  maxWallTimeMs: number;
  /** 连续无副作用轮数上限 (连续只 think 不做事→强制终止) */
  maxIdleIterations: number;
  /** 连续错误轮数上限 */
  maxConsecutiveErrors: number;
  /** 连续重复工具调用上限 (同名+同参数) */
  maxRepeatCalls: number;
}

export const DEFAULT_REACT_CONFIG: ReactTerminationConfig = {
  maxIterations: 50,
  maxTotalTokens: 500_000,
  maxCostUsd: 2.0,
  maxWallTimeMs: 10 * 60 * 1000, // 10 minutes
  maxIdleIterations: 5,
  maxConsecutiveErrors: 3,
  maxRepeatCalls: 3,
};

export interface ReactState {
  iteration: number;
  totalTokens: number;
  totalCost: number;
  startTimeMs: number;
  consecutiveIdleCount: number;
  consecutiveErrorCount: number;
  /** 最近N次工具调用的签名 (name + args hash) 用于检测循环 */
  recentCallSignatures: string[];
  taskCompleted: boolean;
  filesWritten: Set<string>;
  /** v20.0: 是否执行过验证命令 (run_command/run_test/run_lint) */
  hasRunVerification: boolean;
  /** v20.0: 是否执行过写入操作 (write_file/edit_file) */
  hasWrittenFiles: boolean;
  /** v20.0: 连续纯文本回复计数 (无 tool_calls) */
  consecutivePlainTextCount: number;
  /** v20.0: 语义失败追踪 {toolName -> [{file, count}]} */
  semanticFailures: Map<string, { file: string; count: number }[]>;
}

export type TerminationReason =
  | 'task_complete'
  | 'max_iterations'
  | 'max_tokens'
  | 'max_cost'
  | 'max_time'
  | 'idle_loop'
  | 'error_loop'
  | 'repeat_loop'
  | 'semantic_loop'
  | 'aborted'
  | 'budget_exceeded';

export interface ReactCheckResult {
  shouldContinue: boolean;
  reason?: TerminationReason;
  message?: string;
}

/**
 * 在每轮 ReAct 迭代前检查是否应终止
 * 返回 { shouldContinue, reason } — 程序判定，不依赖 LLM
 */
export function checkReactTermination(
  state: ReactState,
  config: ReactTerminationConfig,
  aborted: boolean,
): ReactCheckResult {
  // 优先级从高到低

  if (aborted) {
    return { shouldContinue: false, reason: 'aborted', message: 'User/system abort signal' };
  }

  if (state.taskCompleted) {
    return { shouldContinue: false, reason: 'task_complete', message: 'Agent called task_complete' };
  }

  if (config.maxIterations > 0 && state.iteration >= config.maxIterations) {
    return { shouldContinue: false, reason: 'max_iterations', message: `Reached ${config.maxIterations} iterations` };
  }

  if (config.maxTotalTokens > 0 && state.totalTokens >= config.maxTotalTokens) {
    return { shouldContinue: false, reason: 'max_tokens', message: `Token limit ${config.maxTotalTokens} exceeded` };
  }

  if (config.maxCostUsd > 0 && state.totalCost >= config.maxCostUsd) {
    return { shouldContinue: false, reason: 'max_cost', message: `Cost limit $${config.maxCostUsd} exceeded` };
  }

  const elapsed = Date.now() - state.startTimeMs;
  if (config.maxWallTimeMs > 0 && elapsed >= config.maxWallTimeMs) {
    return {
      shouldContinue: false,
      reason: 'max_time',
      message: `Wall time ${Math.round(elapsed / 1000)}s exceeded ${config.maxWallTimeMs / 1000}s limit`,
    };
  }

  if (state.consecutiveIdleCount >= config.maxIdleIterations) {
    return {
      shouldContinue: false,
      reason: 'idle_loop',
      message: `${config.maxIdleIterations} consecutive iterations without side effects`,
    };
  }

  if (state.consecutiveErrorCount >= config.maxConsecutiveErrors) {
    return {
      shouldContinue: false,
      reason: 'error_loop',
      message: `${config.maxConsecutiveErrors} consecutive errors`,
    };
  }

  // 重复调用检测
  if (state.recentCallSignatures.length >= config.maxRepeatCalls) {
    const last = state.recentCallSignatures.slice(-config.maxRepeatCalls);
    if (last.every(sig => sig === last[0])) {
      return {
        shouldContinue: false,
        reason: 'repeat_loop',
        message: `Same tool call repeated ${config.maxRepeatCalls} times`,
      };
    }
  }

  return { shouldContinue: true };
}

// ═══════════════════════════════════════
// 2.1 Verification Gate — task_complete 前置验证
// ═══════════════════════════════════════

export interface VerificationGateResult {
  allowed: boolean;
  /** 拦截时的提示消息 (注入给 Agent) */
  message?: string;
}

/**
 * v20.0: 验证门控 — 在 Agent 调用 task_complete 前检查是否执行过验证
 *
 * 规则:
 * - 如果 Agent 写过文件但从未执行 run_command/run_test/run_lint → 拦截
 * - 如果 Agent 没有写任何文件 → 放行 (可能是分析型任务)
 * - 拦截时不终止循环，而是注入提示消息让 Agent 先验证
 */
export function checkVerificationGate(state: ReactState): VerificationGateResult {
  // 没写过文件 → 放行 (PM/Architect 等分析型角色)
  if (!state.hasWrittenFiles && state.filesWritten.size === 0) {
    return { allowed: true };
  }

  // 写过文件但没验证 → 拦截
  if (!state.hasRunVerification) {
    return {
      allowed: false,
      message:
        '⚠️ 你已经写入/修改了文件，但还没有执行任何验证命令。在调用 task_complete 之前，请先执行 run_command 验证代码能否正常编译和运行（如 `npm run build`、`tsc --noEmit`、`python -m py_compile` 等）。如果项目有测试，也请运行测试。',
    };
  }

  return { allowed: true };
}

// ═══════════════════════════════════════
// 2.2 Semantic Dead Loop Detection — 语义级死循环
// ═══════════════════════════════════════

export interface SemanticLoopResult {
  detected: boolean;
  /** 强制性策略升级指令 (注入给 Agent) */
  escalation?: string;
}

/**
 * v20.0: 语义死循环检测 — 检测 Agent 对同一文件反复使用同类工具失败
 *
 * 场景: edit_file 反复失败 (old_string 不匹配), 同一文件 run_command 反复超时等
 * 触发条件: 同一工具 + 同一目标文件 连续失败 2 次
 *
 * 与 repeat_loop 的区别: repeat_loop 检测完全相同的调用签名,
 * semantic_loop 检测同一工具+同一文件但参数不同的失败 (更宽泛)
 */
export function checkSemanticLoop(
  state: ReactState,
  toolName: string,
  targetFile: string,
  success: boolean,
): SemanticLoopResult {
  if (!state.semanticFailures) {
    state.semanticFailures = new Map();
  }

  if (success) {
    // 成功时清除该工具+文件的失败计数
    const entries = state.semanticFailures.get(toolName);
    if (entries) {
      const idx = entries.findIndex(e => e.file === targetFile);
      if (idx >= 0) entries.splice(idx, 1);
    }
    return { detected: false };
  }

  // 记录失败
  if (!state.semanticFailures.has(toolName)) {
    state.semanticFailures.set(toolName, []);
  }
  const entries = state.semanticFailures.get(toolName) ?? [];
  const existing = entries.find(e => e.file === targetFile);
  if (existing) {
    existing.count++;
  } else {
    entries.push({ file: targetFile, count: 1 });
  }

  const failCount = existing ? existing.count : 1;

  // 连续失败 2 次 → 触发策略升级
  if (failCount >= 2) {
    // 根据不同工具给出不同的策略升级指令
    let escalation: string;
    switch (toolName) {
      case 'edit_file':
      case 'batch_edit':
        escalation =
          `🔴 强制策略升级: 你已经对文件 "${targetFile}" 的 edit_file/batch_edit 操作连续失败 ${failCount} 次。\n` +
          `请立即执行以下步骤:\n` +
          `1. 使用 search_files 搜索你想修改的关键内容，获取精确行号\n` +
          `2. 使用 read_file(offset=行号-5, limit=40) 只读取目标区域的最新内容\n` +
          `3. 如果改动范围较大 (>30% 的文件内容)，直接使用 write_file 重写整个文件\n` +
          `4. 如果改动范围较小，仔细核对 old_string 确保与文件内容完全一致（包括空格和缩进）\n` +
          `⚠️ 禁止在不重新读取的情况下再次尝试 edit_file`;
        break;
      case 'run_command':
      case 'run_test':
        escalation =
          `🔴 强制策略升级: 对 "${targetFile}" 相关的命令已连续失败 ${failCount} 次。\n` +
          `建议:\n` +
          `1. 检查命令拼写和参数是否正确\n` +
          `2. 如果命令超时，添加 timeout 参数或拆成更小的命令\n` +
          `3. 如果命令找不到，检查依赖是否安装 (npm install/pip install)\n` +
          `4. 考虑换一种验证方式`;
        break;
      default:
        escalation = `🔴 ${toolName} 对 "${targetFile}" 已连续失败 ${failCount} 次。请换一种方法或跳过此步骤。`;
    }

    // 清除计数防止重复触发（给一次新的机会）
    if (existing) existing.count = 0;

    return { detected: true, escalation };
  }

  return { detected: false };
}

/** 生成工具调用签名 (用于重复检测) */
export function toolCallSignature(name: string, args: Record<string, unknown>): string {
  // 只用关键参数做签名，忽略 content 等大字段
  const keyArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'content' || k === 'thought') continue;
    keyArgs[k] = typeof v === 'string' ? v.slice(0, 100) : v;
  }
  return `${name}:${JSON.stringify(keyArgs)}`;
}

/**
 * 判断一轮工具调用是否有"副作用"
 * 用于 idle loop 检测: 只调 think/read 不做事的循环
 */
export function hasToolSideEffect(toolNames: string[]): boolean {
  const readOnlyTools = new Set([
    'think',
    'read_file',
    'read_many_files',
    'list_files',
    'glob_files',
    'search_files',
    'code_search',
    'code_graph_query',
    'todo_read',
    'scratchpad_read',
    'memory_read',
    'git_diff',
    'git_log',
    'browser_snapshot',
    'browser_network',
  ]);
  // task_complete / report_blocked / write / edit 等均算副作用
  return toolNames.some(name => !readOnlyTools.has(name));
}

// ═══════════════════════════════════════
// 3. QA Guard — 程序化规则引擎
// ═══════════════════════════════════════

export interface QACheckResult {
  /** 程序化判定 (覆盖 LLM 判定) */
  programVerdict: 'pass' | 'fail' | 'defer_to_llm';
  /** 程序发现的问题 */
  issues: QAIssue[];
  /** 程序化扣分 */
  deductions: number;
}

export interface QAIssue {
  severity: 'critical' | 'major' | 'minor';
  category: 'compile' | 'test' | 'lint' | 'empty_file' | 'missing_file' | 'import' | 'todo_placeholder';
  file?: string;
  description: string;
}

/**
 * 程序化 QA 检查 — 在 LLM 审查之前/之后运行
 *
 * 不可绕过的硬规则:
 *  1. 编译/测试失败 → 强制 fail (除非无编译器)
 *  2. 文件为空 / 只含注释 → critical
 *  3. 包含 TODO/FIXME/HACK 占位符 → major
 *  4. import 不存在的模块 → major
 *  5. 影响文件数量为 0 → fail
 */
export function programmaticQACheck(
  filesWritten: string[],
  fileContents: Map<string, string>,
  testResult: { ran: boolean; passed: boolean; output: string },
  lintResult: { ran: boolean; passed: boolean; output: string },
): QACheckResult {
  const issues: QAIssue[] = [];
  let deductions = 0;

  // Rule 1: 无文件产出
  if (filesWritten.length === 0) {
    return {
      programVerdict: 'fail',
      issues: [{ severity: 'critical', category: 'missing_file', description: 'No files were written' }],
      deductions: 100,
    };
  }

  // Rule 2: 编译/测试失败
  if (testResult.ran && !testResult.passed) {
    issues.push({
      severity: 'critical',
      category: 'test',
      description: `Tests failed:\n${testResult.output.slice(0, 500)}`,
    });
    deductions += 40;
  }

  if (lintResult.ran && !lintResult.passed) {
    issues.push({
      severity: 'major',
      category: 'lint',
      description: `Lint/type-check failed:\n${lintResult.output.slice(0, 500)}`,
    });
    deductions += 15;
  }

  // Rule 3: 逐文件检查
  for (const [filePath, content] of fileContents) {
    // 空文件
    const trimmed = content.trim();
    if (trimmed === '') {
      issues.push({ severity: 'critical', category: 'empty_file', file: filePath, description: 'File is empty' });
      deductions += 20;
      continue;
    }

    // 只含注释的文件 (去掉注释后为空)
    const withoutComments = trimmed
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/\/\/.*/g, '') // line comments
      .replace(/#.*/g, '') // python comments
      .trim();
    if (withoutComments === '' && content.length > 50) {
      issues.push({
        severity: 'major',
        category: 'empty_file',
        file: filePath,
        description: 'File contains only comments, no actual code',
      });
      deductions += 15;
    }

    // TODO/FIXME/HACK 占位符检测
    const placeholderMatches = content.match(/\b(TODO|FIXME|HACK|XXX|PLACEHOLDER)\b/gi);
    if (placeholderMatches && placeholderMatches.length > 0) {
      issues.push({
        severity: 'major',
        category: 'todo_placeholder',
        file: filePath,
        description: `Contains ${placeholderMatches.length} placeholder(s): ${placeholderMatches.slice(0, 3).join(', ')}`,
      });
      deductions += 5 * Math.min(placeholderMatches.length, 5);
    }

    // "..." 或 "// ... existing code ..." 省略模式检测
    const ellipsisPatterns = content.match(/\/\/\s*\.{3}.*|#\s*\.{3}.*|\.{3}\s*(existing|rest|more|other|remaining)/gi);
    if (ellipsisPatterns && ellipsisPatterns.length > 0) {
      issues.push({
        severity: 'critical',
        category: 'todo_placeholder',
        file: filePath,
        description: `Contains ${ellipsisPatterns.length} code ellipsis/omission: ${ellipsisPatterns[0].slice(0, 60)}`,
      });
      deductions += 30;
    }
  }

  // 综合判定
  const criticalCount = issues.filter(i => i.severity === 'critical').length;
  const majorCount = issues.filter(i => i.severity === 'major').length;

  let programVerdict: QACheckResult['programVerdict'];
  if (criticalCount > 0) {
    programVerdict = 'fail';
  } else if (majorCount >= 3) {
    programVerdict = 'fail';
  } else if (deductions >= 50) {
    programVerdict = 'fail';
  } else {
    programVerdict = 'defer_to_llm';
  }

  return { programVerdict, issues, deductions };
}

// ═══════════════════════════════════════
// 4. Pipeline Gate — 阶段间硬门控
// ═══════════════════════════════════════

export interface GateCheckResult {
  passed: boolean;
  reason?: string;
}

/** PM → Architect 门控: features 必须满足基本结构 */
export function gatePMToArchitect(features: ParsedFeature[]): GateCheckResult {
  if (!Array.isArray(features) || features.length === 0) {
    return { passed: false, reason: 'PM produced no features' };
  }

  // 检查每个 feature 有 id 和 description
  const invalidFeatures = features.filter(f => !f.id || (!f.description && !f.title));
  if (invalidFeatures.length > features.length * 0.5) {
    return { passed: false, reason: `${invalidFeatures.length}/${features.length} features lack id or description` };
  }

  // 检查循环依赖
  const depCycle = detectDependencyCycle(features);
  if (depCycle) {
    return { passed: false, reason: `Circular dependency detected: ${depCycle}` };
  }

  return { passed: true };
}

/** Architect → Developer 门控: workspace 必须有 ARCHITECTURE.md */
export function gateArchitectToDeveloper(workspacePath: string | null): GateCheckResult {
  if (!workspacePath) {
    return { passed: true }; // 无 workspace 时跳过
  }

  const archPath = path.join(workspacePath, 'ARCHITECTURE.md');
  if (!fs.existsSync(archPath)) {
    return { passed: false, reason: 'ARCHITECTURE.md not found in workspace' };
  }

  const content = fs.readFileSync(archPath, 'utf-8').trim();
  if (content.length < 100) {
    return { passed: false, reason: `ARCHITECTURE.md is too short (${content.length} chars)` };
  }

  return { passed: true };
}

/** 依赖循环检测 (拓扑排序) */
function detectDependencyCycle(features: ParsedFeature[]): string | null {
  const ids = new Set(features.map(f => f.id));
  const adj = new Map<string, string[]>();

  for (const f of features) {
    const deps: string[] = f.dependsOn || f.depends_on || [];
    adj.set(
      f.id,
      deps.filter(d => ids.has(d)),
    );
  }

  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(node: string, path: string[]): string | null {
    if (stack.has(node)) return [...path, node].join(' → ');
    if (visited.has(node)) return null;

    visited.add(node);
    stack.add(node);

    for (const dep of adj.get(node) || []) {
      const cycle = dfs(dep, [...path, node]);
      if (cycle) return cycle;
    }

    stack.delete(node);
    return null;
  }

  for (const f of features) {
    const cycle = dfs(f.id, []);
    if (cycle) return cycle;
  }

  return null;
}

// ═══════════════════════════════════════
// 5. Budget Controller — 多维硬限制
// ═══════════════════════════════════════

export interface BudgetLimits {
  dailyBudgetUsd: number;
  perFeatureMaxUsd: number;
  perFeatureMaxTokens: number;
  perFeatureMaxTimeMs: number;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  dailyBudgetUsd: 10.0,
  perFeatureMaxUsd: 2.0,
  perFeatureMaxTokens: 500_000,
  perFeatureMaxTimeMs: 15 * 60 * 1000, // 15 minutes
};

export interface BudgetStatus {
  ok: boolean;
  /** 具体被哪个维度拦截 */
  blockedBy?: 'daily_cost' | 'feature_cost' | 'feature_tokens' | 'feature_time';
  spent: number;
  limit: number;
}

/**
 * 多维度预算检查 — 任一维度超限即拦截
 * 注: limit=0 表示该维度不限制
 */
export function checkBudgetMulti(
  dailySpent: number,
  featureSpent: number,
  featureTokens: number,
  featureStartTime: number,
  limits: BudgetLimits,
): BudgetStatus {
  if (limits.dailyBudgetUsd > 0 && dailySpent >= limits.dailyBudgetUsd) {
    return { ok: false, blockedBy: 'daily_cost', spent: dailySpent, limit: limits.dailyBudgetUsd };
  }
  if (limits.perFeatureMaxUsd > 0 && featureSpent >= limits.perFeatureMaxUsd) {
    return { ok: false, blockedBy: 'feature_cost', spent: featureSpent, limit: limits.perFeatureMaxUsd };
  }
  if (limits.perFeatureMaxTokens > 0 && featureTokens >= limits.perFeatureMaxTokens) {
    return { ok: false, blockedBy: 'feature_tokens', spent: featureTokens, limit: limits.perFeatureMaxTokens };
  }
  const elapsed = Date.now() - featureStartTime;
  if (limits.perFeatureMaxTimeMs > 0 && elapsed >= limits.perFeatureMaxTimeMs) {
    return { ok: false, blockedBy: 'feature_time', spent: elapsed, limit: limits.perFeatureMaxTimeMs };
  }
  return { ok: true, spent: featureSpent, limit: limits.perFeatureMaxUsd };
}

/** 重置速率限制桶 (测试用, 或定时清理) */
export function resetRateLimits(): void {
  rateBuckets.clear();
}

// ═══════════════════════════════════════
// 6. Budget Tracker — 进度感知注入 (inspired by Google BATS)
// ═══════════════════════════════════════

/**
 * v10.1: Budget Tracker — 每轮向 agent 注入剩余预算/进度感知信号
 *
 * 核心思想 (Google BATS paper, Nov 2025):
 *   "Standard agents lack inherent budget awareness. Without explicit signals,
 *    they perform shallow searches and fail to utilize resources effectively."
 *
 * Budget Tracker 不是设硬限等着超限终止，而是让 agent 自己感知剩余资源并调整策略。
 * 在不同消耗阶段注入不同强度的引导信号:
 *   - 探索阶段 (0-50%): 轻量提示 — "你已使用 N/M 轮"
 *   - 收敛阶段 (50-80%): 中等引导 — "请开始收敛到输出"
 *   - 紧急阶段 (80%+):  强制催促 — "必须在下 N 轮内完成"
 */
export interface BudgetTrackerState {
  iteration: number;
  maxIterations: number;
  totalTokens: number;
  maxTokens: number;
  totalCost: number;
  maxCost: number;
  /** 是否已写过文件 (developer 角色专用) */
  hasWrittenFiles: boolean;
  /** 是否已执行过验证 */
  hasRunVerification: boolean;
  /** agent 角色 */
  role: string;
}

export type BudgetPhase = 'explore' | 'converge' | 'urgent' | 'final';

export interface BudgetNudge {
  phase: BudgetPhase;
  /** 是否需要注入消息 */
  shouldInject: boolean;
  /** 注入的消息文本 */
  message: string;
  /** 剩余轮次 */
  remainingIterations: number;
  /** 消耗百分比 (0-1) */
  consumedRatio: number;
}

export function computeBudgetNudge(state: BudgetTrackerState): BudgetNudge {
  const iterRatio = state.maxIterations > 0 ? state.iteration / state.maxIterations : 0;
  const tokenRatio = state.maxTokens > 0 ? state.totalTokens / state.maxTokens : 0;
  const costRatio = state.maxCost > 0 ? state.totalCost / state.maxCost : 0;
  const consumedRatio = Math.max(iterRatio, tokenRatio, costRatio);
  const remaining = state.maxIterations - state.iteration;

  // ── Determine phase ──
  let phase: BudgetPhase;
  if (consumedRatio >= 0.9 || remaining <= 2) {
    phase = 'final';
  } else if (consumedRatio >= 0.75 || remaining <= 4) {
    phase = 'urgent';
  } else if (consumedRatio >= 0.5) {
    phase = 'converge';
  } else {
    phase = 'explore';
  }

  // ── Build message ──
  const isDev = state.role === 'developer' || state.role === 'qa';
  const isPM = state.role === 'pm' || state.role === 'architect';

  if (phase === 'explore') {
    // 探索阶段: 每 5 轮轻提一次
    if (state.iteration > 0 && state.iteration % 5 === 0) {
      return {
        phase,
        shouldInject: true,
        remainingIterations: remaining,
        consumedRatio,
        message: `📊 进度: ${state.iteration}/${state.maxIterations} 轮 (${Math.round(consumedRatio * 100)}% 资源已消耗)。请确保你在朝目标推进。`,
      };
    }
    return { phase, shouldInject: false, message: '', remainingIterations: remaining, consumedRatio };
  }

  if (phase === 'converge') {
    const base = `⏳ 已使用 ${state.iteration}/${state.maxIterations} 轮 (${Math.round(consumedRatio * 100)}%)，剩余 ${remaining} 轮。`;
    if (isPM) {
      return {
        phase,
        shouldInject: true,
        remainingIterations: remaining,
        consumedRatio,
        message: `${base}请停止探索新信息，基于已有理解开始输出结构化结果。`,
      };
    }
    if (isDev && !state.hasWrittenFiles) {
      return {
        phase,
        shouldInject: true,
        remainingIterations: remaining,
        consumedRatio,
        message: `${base}你还没有写入任何文件。请立即开始编码实现，不要继续只读不写。`,
      };
    }
    return {
      phase,
      shouldInject: true,
      remainingIterations: remaining,
      consumedRatio,
      message: `${base}请从探索/分析转向产出收敛。${isDev ? '确保尽快完成编码并验证。' : ''}`,
    };
  }

  if (phase === 'urgent') {
    const base = `⚠️ 紧急: 仅剩 ${remaining} 轮 (${Math.round(consumedRatio * 100)}% 资源已消耗)！`;
    if (isPM) {
      return {
        phase,
        shouldInject: true,
        remainingIterations: remaining,
        consumedRatio,
        message: `${base}必须立即输出 Feature JSON 并调用 task_complete。不要再读取任何文件。`,
      };
    }
    if (isDev) {
      const parts = [base];
      if (!state.hasWrittenFiles) parts.push('你还没有写入任何文件！必须立即开始编码。');
      if (state.hasWrittenFiles && !state.hasRunVerification)
        parts.push('你已写入文件但还没验证。必须立即运行验证命令。');
      parts.push('完成后立即调用 task_complete。');
      return { phase, shouldInject: true, remainingIterations: remaining, consumedRatio, message: parts.join(' ') };
    }
    return {
      phase,
      shouldInject: true,
      remainingIterations: remaining,
      consumedRatio,
      message: `${base}必须立即完成当前任务并调用 task_complete。`,
    };
  }

  // phase === 'final'
  return {
    phase: 'final',
    shouldInject: true,
    remainingIterations: remaining,
    consumedRatio,
    message: `🚨 最后 ${remaining} 轮！你必须在本轮或下一轮调用 task_complete 完成任务。不要做任何新操作。如果已经完成了工作，立即 task_complete；如果未完成，输出已有成果后 task_complete。`,
  };
}

// ═══════════════════════════════════════
// 7. Stuck Detector — 行为模式检测 (inspired by OpenHands)
// ═══════════════════════════════════════

/**
 * v10.1: Stuck Detector — 检测 agent 陷入非生产性模式
 *
 * 核心思想 (OpenHands Stuck Detector):
 *   检测五种 stuck 模式，检测到后不是终止，而是注入纠正指令让 agent 自行调整。
 *
 * 检测模式:
 *   1. 重复读取同类文件 (read-only loop): 连续 N 轮都在读文件/搜索，无产出
 *   2. 相同工具+参数重复 (exact repeat): 同一个调用重复 3+ 次
 *   3. 乒乓交替 (ping-pong): 两个操作交替出现 4+ 次
 *   4. Agent 独白 (monologue): 连续纯文本无工具调用 3+ 次
 *   5. 总体无产出 (no-output stall): 已用 >40% 轮次但零文件写入 (仅 dev)
 */

export interface StuckDetectorEntry {
  toolName: string;
  argsSignature: string; // 用于精确匹配
  isReadOnly: boolean;
}

export interface StuckDetectorState {
  history: StuckDetectorEntry[];
  /** 连续只读轮数 */
  consecutiveReadOnlyRounds: number;
  /** 纯文本回复连续次数 (外部由 react loop 维护) */
  plainTextStreak: number;
}

export function createStuckDetectorState(): StuckDetectorState {
  return { history: [], consecutiveReadOnlyRounds: 0, plainTextStreak: 0 };
}

export interface StuckResult {
  isStuck: boolean;
  pattern: 'read-only-loop' | 'exact-repeat' | 'ping-pong' | 'monologue' | 'no-output-stall' | null;
  /** 注入给 agent 的纠正消息 */
  correctionMessage: string;
}

const READ_ONLY_TOOLS = new Set([
  'think',
  'read_file',
  'read_many_files',
  'list_files',
  'glob_files',
  'search_files',
  'code_search',
  'code_search_files',
  'code_graph_query',
  'repo_map',
  'todo_read',
  'scratchpad_read',
  'memory_read',
  'git_diff',
  'git_log',
  'web_search',
  'fetch_url',
  'browser_snapshot',
  'browser_network',
]);

export function recordToolCalls(
  state: StuckDetectorState,
  toolCalls: Array<{ name: string; argsSignature: string }>,
): void {
  const allReadOnly = toolCalls.every(tc => READ_ONLY_TOOLS.has(tc.name));
  if (allReadOnly) {
    state.consecutiveReadOnlyRounds++;
  } else {
    state.consecutiveReadOnlyRounds = 0;
  }

  for (const tc of toolCalls) {
    state.history.push({
      toolName: tc.name,
      argsSignature: tc.argsSignature,
      isReadOnly: READ_ONLY_TOOLS.has(tc.name),
    });
  }

  // Keep history bounded
  if (state.history.length > 60) {
    state.history = state.history.slice(-40);
  }
}

export function detectStuckPattern(state: StuckDetectorState, budgetState: BudgetTrackerState): StuckResult {
  const ok: StuckResult = { isStuck: false, pattern: null, correctionMessage: '' };

  // 1. Read-only loop: 5+ consecutive rounds of only read ops
  if (state.consecutiveReadOnlyRounds >= 5) {
    return {
      isStuck: true,
      pattern: 'read-only-loop',
      correctionMessage: `🔄 检测到连续 ${state.consecutiveReadOnlyRounds} 轮只读操作（读文件/搜索），没有产出。请停止继续阅读，基于已有信息开始产出。${budgetState.role === 'developer' ? '请开始编写/修改代码。' : '请输出你的分析结果。'}`,
    };
  }

  // 2. Exact repeat: last 3 entries are identical tool+args
  const h = state.history;
  if (h.length >= 3) {
    const last3 = h.slice(-3);
    if (last3.every(e => e.toolName === last3[0].toolName && e.argsSignature === last3[0].argsSignature)) {
      return {
        isStuck: true,
        pattern: 'exact-repeat',
        correctionMessage: `🔁 检测到你连续 3 次调用了完全相同的操作 (${last3[0].toolName})。这不会产生新信息。请换一种方法或工具来推进任务。`,
      };
    }
  }

  // 3. Ping-pong: last 8 entries alternate between two signatures
  if (h.length >= 8) {
    const last8 = h.slice(-8);
    const sigA = `${last8[0].toolName}:${last8[0].argsSignature}`;
    const sigB = `${last8[1].toolName}:${last8[1].argsSignature}`;
    if (sigA !== sigB) {
      const isPingPong = last8.every((e, i) => {
        const sig = `${e.toolName}:${e.argsSignature}`;
        return i % 2 === 0 ? sig === sigA : sig === sigB;
      });
      if (isPingPong) {
        return {
          isStuck: true,
          pattern: 'ping-pong',
          correctionMessage: `🏓 检测到你在两个操作之间反复交替 (${last8[0].toolName} ↔ ${last8[1].toolName})。请退一步，用 think 工具重新思考你的方法，然后尝试一种全新的策略。`,
        };
      }
    }
  }

  // 4. Monologue: 3+ consecutive plain text (tracked externally)
  if (state.plainTextStreak >= 3) {
    return {
      isStuck: true,
      pattern: 'monologue',
      correctionMessage:
        '💬 你已经连续 3 轮只输出文字而没有使用任何工具。请调用合适的工具来推进任务，或调用 task_complete 完成任务。',
    };
  }

  // 5. No-output stall (dev only): >40% budget used but zero files written
  if (
    budgetState.role === 'developer' &&
    budgetState.iteration > 0 &&
    budgetState.iteration / budgetState.maxIterations > 0.4 &&
    !budgetState.hasWrittenFiles
  ) {
    return {
      isStuck: true,
      pattern: 'no-output-stall',
      correctionMessage: `⚠️ 你已使用 ${budgetState.iteration}/${budgetState.maxIterations} 轮 (${Math.round((budgetState.iteration / budgetState.maxIterations) * 100)}%)，但还没有写入任何文件。请立即开始编码实现。如果你还在分析，请用 think 工具总结你的理解，然后开始写代码。`,
    };
  }

  return ok;
}

// ═══════════════════════════════════════
// 8. Self-Evolution Guard — 自我修改保护
// ═══════════════════════════════════════

/**
 * v29.2: 自我进化路径保护 — 检查目标路径是否允许被进化过程修改
 *
 * 三级分类:
 *  - immutable: 绝对禁止修改 (质量门禁、进化引擎本身、测试配置)
 *  - protected: 允许修改但需要额外标记 (核心模块: main.ts, db.ts, guards.ts)
 *  - allowed: 允许修改
 */
export interface EvolutionPathCheck {
  allowed: boolean;
  level: 'immutable' | 'protected' | 'allowed';
  reason?: string;
}

const EVOLUTION_IMMUTABLE_PATTERNS = [
  /^vitest\.config\./,
  /^tsconfig\./,
  /^scripts\/quality-gate\./,
  /^scripts\/evaluate-fitness\./,
  /^electron\/engine\/self-evolution-engine\./,
  /^electron\/engine\/__tests__\/self-evolution-engine\./,
];

const EVOLUTION_PROTECTED_PATTERNS = [
  /^electron\/main\./,
  /^electron\/db\./,
  /^electron\/preload\./,
  /^electron\/engine\/guards\./,
  /^electron\/engine\/sandbox-executor\./,
  /^package\.json$/,
  /^electron-builder\./,
];

/**
 * 检查文件路径在自我进化过程中的保护级别
 */
export function checkEvolutionPath(filePath: string): EvolutionPathCheck {
  const normalized = path.normalize(filePath).replace(/\\/g, '/');

  for (const pattern of EVOLUTION_IMMUTABLE_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        allowed: false,
        level: 'immutable',
        reason: `File ${filePath} is immutable during self-evolution`,
      };
    }
  }

  for (const pattern of EVOLUTION_PROTECTED_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        allowed: true,
        level: 'protected',
        reason: `File ${filePath} is protected — modifications require extra verification`,
      };
    }
  }

  return { allowed: true, level: 'allowed' };
}

/**
 * 批量检查文件路径列表
 */
export function checkEvolutionPaths(filePaths: string[]): {
  ok: boolean;
  immutable: string[];
  protected_: string[];
  allowed: string[];
} {
  const immutable: string[] = [];
  const protected_: string[] = [];
  const allowed: string[] = [];

  for (const fp of filePaths) {
    const check = checkEvolutionPath(fp);
    if (check.level === 'immutable') {
      immutable.push(fp);
    } else if (check.level === 'protected') {
      protected_.push(fp);
    } else {
      allowed.push(fp);
    }
  }

  return {
    ok: immutable.length === 0,
    immutable,
    protected_,
    allowed,
  };
}
