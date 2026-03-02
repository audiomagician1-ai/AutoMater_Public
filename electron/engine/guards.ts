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
  repairedArgs?: Record<string, any>;
}

/** 工具的程序化参数规范 */
const TOOL_GUARD_SPECS: Record<string, ToolGuardSpec> = {
  read_file: {
    name: 'read_file',
    params: [
      { name: 'path', type: 'string', required: true, maxLength: 500, validate: validateRelativePath },
      { name: 'offset', type: 'number', required: false, min: 1, max: 100000 },
      { name: 'limit', type: 'number', required: false, min: 1, max: 1000 },
    ],
    sideEffect: 'none', rateLimit: 60, requiresWorkspace: true,
  },
  write_file: {
    name: 'write_file',
    params: [
      { name: 'path', type: 'string', required: true, maxLength: 500, validate: validateRelativePath },
      { name: 'content', type: 'string', required: true, maxLength: 1_000_000 },
    ],
    sideEffect: 'write', rateLimit: 30, requiresWorkspace: true,
  },
  edit_file: {
    name: 'edit_file',
    params: [
      { name: 'path', type: 'string', required: true, maxLength: 500, validate: validateRelativePath },
      { name: 'old_string', type: 'string', required: true, maxLength: 100_000 },
      { name: 'new_string', type: 'string', required: true, maxLength: 200_000 },
    ],
    sideEffect: 'write', rateLimit: 30, requiresWorkspace: true,
  },
  batch_edit: {
    name: 'batch_edit',
    params: [
      { name: 'path', type: 'string', required: true, maxLength: 500, validate: validateRelativePath },
      { name: 'edits', type: 'array', required: true },
    ],
    sideEffect: 'write', rateLimit: 20, requiresWorkspace: true,
  },
  run_command: {
    name: 'run_command',
    params: [
      { name: 'command', type: 'string', required: true, maxLength: 2000 },
    ],
    sideEffect: 'execute', rateLimit: 15, requiresWorkspace: true,
  },
  web_search: {
    name: 'web_search',
    params: [
      { name: 'query', type: 'string', required: true, maxLength: 500 },
      { name: 'max_results', type: 'number', required: false, min: 1, max: 20 },
    ],
    sideEffect: 'network', rateLimit: 10, requiresWorkspace: false,
  },
  fetch_url: {
    name: 'fetch_url',
    params: [
      { name: 'url', type: 'string', required: true, maxLength: 2000, validate: validateUrl },
      { name: 'max_length', type: 'number', required: false, min: 100, max: 100_000 },
    ],
    sideEffect: 'network', rateLimit: 10, requiresWorkspace: false,
  },
  http_request: {
    name: 'http_request',
    params: [
      { name: 'url', type: 'string', required: true, maxLength: 2000, validate: validateUrl },
      { name: 'method', type: 'string', required: false, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
      { name: 'timeout', type: 'number', required: false, min: 1000, max: 60000 },
    ],
    sideEffect: 'network', rateLimit: 10, requiresWorkspace: false,
  },
  screenshot: {
    name: 'screenshot',
    params: [
      { name: 'scale', type: 'number', required: false, min: 0.1, max: 2.0 },
    ],
    sideEffect: 'system', rateLimit: 10, requiresWorkspace: false,
  },
  keyboard_type: {
    name: 'keyboard_type',
    params: [
      { name: 'text', type: 'string', required: true, maxLength: 5000 },
    ],
    sideEffect: 'system', rateLimit: 20, requiresWorkspace: false,
  },
  keyboard_hotkey: {
    name: 'keyboard_hotkey',
    params: [
      { name: 'combo', type: 'string', required: true, maxLength: 100, validate: validateHotkey },
    ],
    sideEffect: 'system', rateLimit: 20, requiresWorkspace: false,
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
export function guardToolCall(
  toolName: string,
  args: Record<string, any>,
  hasWorkspace: boolean,
): ToolGuardResult {
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
      if (param.min !== undefined) repaired[param.name] = Math.max(param.min, repaired[param.name]);
      if (param.max !== undefined) repaired[param.name] = Math.min(param.max, repaired[param.name]);
    }

    // 字符串长度截断
    if (param.type === 'string' && typeof repaired[param.name] === 'string' && param.maxLength) {
      if (repaired[param.name].length > param.maxLength) {
        repaired[param.name] = repaired[param.name].slice(0, param.maxLength);
      }
    }

    // 枚举校验
    if (param.enum && !param.enum.includes(repaired[param.name])) {
      return { allowed: false, reason: `${toolName}.${param.name}: "${repaired[param.name]}" not in [${param.enum.join(', ')}]` };
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
  maxIterations: 25,
  maxTotalTokens: 500_000,
  maxCostUsd: 2.0,
  maxWallTimeMs: 10 * 60 * 1000,  // 10 minutes
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
    return { shouldContinue: false, reason: 'max_time', message: `Wall time ${Math.round(elapsed / 1000)}s exceeded ${config.maxWallTimeMs / 1000}s limit` };
  }

  if (state.consecutiveIdleCount >= config.maxIdleIterations) {
    return { shouldContinue: false, reason: 'idle_loop', message: `${config.maxIdleIterations} consecutive iterations without side effects` };
  }

  if (state.consecutiveErrorCount >= config.maxConsecutiveErrors) {
    return { shouldContinue: false, reason: 'error_loop', message: `${config.maxConsecutiveErrors} consecutive errors` };
  }

  // 重复调用检测
  if (state.recentCallSignatures.length >= config.maxRepeatCalls) {
    const last = state.recentCallSignatures.slice(-config.maxRepeatCalls);
    if (last.every(sig => sig === last[0])) {
      return { shouldContinue: false, reason: 'repeat_loop', message: `Same tool call repeated ${config.maxRepeatCalls} times` };
    }
  }

  return { shouldContinue: true };
}

/** 生成工具调用签名 (用于重复检测) */
export function toolCallSignature(name: string, args: Record<string, any>): string {
  // 只用关键参数做签名，忽略 content 等大字段
  const keyArgs: Record<string, any> = {};
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
    'think', 'read_file', 'list_files', 'glob_files', 'search_files',
    'todo_read', 'memory_read', 'git_diff', 'git_log',
    'browser_snapshot', 'browser_network',
  ]);
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
      severity: 'critical', category: 'test',
      description: `Tests failed:\n${testResult.output.slice(0, 500)}`,
    });
    deductions += 40;
  }

  if (lintResult.ran && !lintResult.passed) {
    issues.push({
      severity: 'major', category: 'lint',
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
      .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
      .replace(/\/\/.*/g, '')             // line comments
      .replace(/#.*/g, '')                // python comments
      .trim();
    if (withoutComments === '' && content.length > 50) {
      issues.push({ severity: 'major', category: 'empty_file', file: filePath, description: 'File contains only comments, no actual code' });
      deductions += 15;
    }

    // TODO/FIXME/HACK 占位符检测
    const placeholderMatches = content.match(/\b(TODO|FIXME|HACK|XXX|PLACEHOLDER)\b/gi);
    if (placeholderMatches && placeholderMatches.length > 0) {
      issues.push({
        severity: 'major', category: 'todo_placeholder', file: filePath,
        description: `Contains ${placeholderMatches.length} placeholder(s): ${placeholderMatches.slice(0, 3).join(', ')}`,
      });
      deductions += 5 * Math.min(placeholderMatches.length, 5);
    }

    // "..." 或 "// ... existing code ..." 省略模式检测
    const ellipsisPatterns = content.match(/\/\/\s*\.{3}.*|#\s*\.{3}.*|\.{3}\s*(existing|rest|more|other|remaining)/gi);
    if (ellipsisPatterns && ellipsisPatterns.length > 0) {
      issues.push({
        severity: 'critical', category: 'todo_placeholder', file: filePath,
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
export function gatePMToArchitect(features: any[]): GateCheckResult {
  if (!Array.isArray(features) || features.length === 0) {
    return { passed: false, reason: 'PM produced no features' };
  }

  // 检查每个 feature 有 id 和 description
  const invalidFeatures = features.filter(f =>
    !f.id || (!f.description && !f.title)
  );
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
function detectDependencyCycle(features: any[]): string | null {
  const ids = new Set(features.map(f => f.id));
  const adj = new Map<string, string[]>();

  for (const f of features) {
    const deps: string[] = f.dependsOn || f.depends_on || [];
    adj.set(f.id, deps.filter(d => ids.has(d)));
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
  perFeatureMaxTimeMs: 15 * 60 * 1000,  // 15 minutes
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
