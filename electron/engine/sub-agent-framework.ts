/**
 * Sub-Agent Framework — 通用多能力子 Agent 系统
 *
 * 从 spawn_researcher (只读8轮) 升级为:
 *   - 6 个预设角色 (researcher/coder/reviewer/tester/doc_writer/deployer)
 *   - 可读可写 (按角色权限控制)
 *   - 并行执行 (spawn_parallel → Promise.allSettled)
 *   - 共享 workspace + 记忆 + file-lock
 *   - 最多 25 轮工具调用 (与主 ReAct 循环对齐)
 *
 * 零外部依赖 — 复用已有 tool-executor / llm-client / file-lock。
 *
 * @module sub-agent-framework
 * @since v7.0.0
 */

import { callLLMWithTools, calcCost, NonRetryableError, type StreamCallback } from './llm-client';
import { TOOL_DEFINITIONS, isAsyncTool, type ToolContext, type ToolCall, type ToolResult } from './tool-registry';
import { executeTool, executeToolAsync } from './tool-executor';
import { resolveModel } from './model-selector';
import { acquireFileLock, releaseWorkerLocks } from './file-lock';
import { sendToUI, addLog } from './ui-bridge';
import { createLogger } from './logger';
import type { AppSettings, LLMMessage } from './types';

const log = createLogger('sub-agent');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

/** 子 Agent 预设角色 */
export type SubAgentPresetId = 'researcher' | 'coder' | 'reviewer' | 'tester' | 'doc_writer' | 'deployer';

/** 子 Agent 配置 */
export interface SubAgentConfig {
  /** 预设角色 ID */
  preset: SubAgentPresetId;
  /** 自定义 system prompt 片段 (追加到预设 prompt 之后) */
  extraPrompt?: string;
  /** 覆盖最大迭代轮次 */
  maxIterations?: number;
  /** 覆盖模型层级 */
  modelTier?: 'strong' | 'worker' | 'mini';
  /** 子 Agent 标识符 (用于 file-lock 和日志) */
  agentId?: string;
}

/** 子 Agent 执行结果 */
export interface SubAgentResult {
  success: boolean;
  /** LLM 给出的最终结论/摘要 */
  conclusion: string;
  /** 创建的文件列表 */
  filesCreated: string[];
  /** 修改的文件列表 */
  filesModified: string[];
  /** 工具调用历史摘要 (节省 token) */
  actionSummary: string;
  /** 总迭代轮次 */
  iterations: number;
  /** token 消耗 */
  inputTokens: number;
  outputTokens: number;
  /** 总成本 USD */
  cost: number;
  /** 耗时 ms */
  durationMs: number;
}

/** 并行执行的单个任务 */
export interface ParallelTask {
  /** 任务 ID (用于结果匹配) */
  id: string;
  /** 子 Agent 配置 */
  config: SubAgentConfig;
  /** 任务描述 */
  task: string;
}

/** 并行执行结果 */
export interface ParallelResult {
  id: string;
  result: SubAgentResult;
}

// ═══════════════════════════════════════
// Preset Definitions
// ═══════════════════════════════════════

interface PresetDef {
  name: string;
  systemPrompt: string;
  /** 工具白名单 — 直接复用 tool-registry 的工具名 */
  tools: string[];
  canWrite: boolean;
  maxIterations: number;
  modelTier: 'strong' | 'worker' | 'mini';
}

const PRESETS: Record<SubAgentPresetId, PresetDef> = {
  researcher: {
    name: '研究员',
    systemPrompt: `你是一位代码与技术研究助手。你的任务是调研问题并给出精确、有引用的结论。

## 规则
- 你只能读取和搜索，不能修改任何文件
- 先用 list_files 了解结构，再 read_file / search_files 深入
- 使用 deep_research 进行复杂问题的多轮深度调研
- 使用 web_search_boost 进行多引擎并行搜索获取更全面结果
- 结论必须具体，引用文件名和行号
- 调用 task_complete 结束并给出结论`,
    tools: [
      'read_file', 'list_files', 'search_files', 'glob_files',
      'web_search', 'web_search_boost', 'deep_research', 'fetch_url',
      'memory_read', 'think', 'task_complete',
    ],
    canWrite: false,
    maxIterations: 12,
    modelTier: 'worker',
  },

  coder: {
    name: '编码员',
    systemPrompt: `你是一位编码实现专家。你的任务是根据需求编写或修改代码。

## 规则
- 先阅读相关代码理解上下文，再动手修改
- 使用 edit_file 精确编辑，避免 write_file 覆盖已有文件
- 修改后用 run_command 或 run_test 验证
- 调用 task_complete 结束并列出改动的文件`,
    tools: [
      'read_file', 'write_file', 'edit_file', 'batch_edit',
      'list_files', 'search_files', 'glob_files',
      'run_command', 'run_test', 'run_lint',
      'memory_read', 'think', 'task_complete',
    ],
    canWrite: true,
    maxIterations: 20,
    modelTier: 'worker',
  },

  reviewer: {
    name: '审查员',
    systemPrompt: `你是一位代码审查专家。你的任务是审查代码质量并给出改进建议。

## 审查维度
- 正确性：逻辑是否正确，边界条件是否处理
- 可维护性：命名、结构、耦合度
- 安全性：注入、XSS、权限检查
- 性能：明显的性能问题
- 测试：是否有对应测试

## 规则
- 只读操作，不修改代码
- 给出具体的行号和改进建议
- 区分 must-fix 和 nice-to-have
- 调用 task_complete 输出完整审查报告`,
    tools: [
      'read_file', 'list_files', 'search_files', 'glob_files',
      'memory_read', 'think', 'task_complete',
    ],
    canWrite: false,
    maxIterations: 12,
    modelTier: 'strong',
  },

  tester: {
    name: '测试员',
    systemPrompt: `你是一位测试工程师。你的任务是编写和运行测试。

## 规则
- 先阅读被测代码，理解接口和行为
- 编写单元测试或集成测试
- 使用 run_test 执行测试并验证通过
- 可使用 browser_* 工具做 E2E 测试
- 使用 run_blackbox_tests 进行自动化黑盒测试 + 迭代修复
- 调用 task_complete 报告测试结果`,
    tools: [
      'read_file', 'write_file', 'edit_file',
      'list_files', 'search_files', 'glob_files',
      'run_command', 'run_test', 'run_lint',
      'run_blackbox_tests',
      'browser_launch', 'browser_navigate', 'browser_screenshot', 'browser_snapshot',
      'browser_click', 'browser_type', 'browser_evaluate', 'browser_wait',
      'browser_network', 'browser_close',
      'screenshot', 'analyze_image',
      'memory_read', 'think', 'task_complete',
    ],
    canWrite: true,
    maxIterations: 15,
    modelTier: 'worker',
  },

  doc_writer: {
    name: '文档作者',
    systemPrompt: `你是一位技术文档作者。你的任务是编写清晰准确的技术文档。

## 规则
- 先阅读代码和已有文档理解系统
- 文档结构清晰: 概述 → 快速开始 → API 参考 → 示例
- 代码示例必须可运行
- 调用 task_complete 结束`,
    tools: [
      'read_file', 'write_file', 'edit_file',
      'list_files', 'search_files', 'glob_files',
      'web_search', 'fetch_url',
      'memory_read', 'think', 'task_complete',
    ],
    canWrite: true,
    maxIterations: 10,
    modelTier: 'worker',
  },

  deployer: {
    name: '运维员',
    systemPrompt: `你是一位运维工程师。你的任务是执行构建、部署和运维操作。

## 规则
- 执行命令前先检查前置条件
- 使用 http_request 验证服务状态
- 记录每一步操作和结果
- 调用 task_complete 报告部署结果`,
    tools: [
      'run_command', 'check_process', 'http_request',
      'read_file', 'write_file', 'edit_file',
      'list_files', 'search_files',
      'git_commit', 'git_diff', 'git_log',
      'memory_read', 'memory_append',
      'think', 'task_complete',
    ],
    canWrite: true,
    maxIterations: 12,
    modelTier: 'worker',
  },
};

// ═══════════════════════════════════════
// Active Sub-Agents Tracking
// ═══════════════════════════════════════

interface ActiveSubAgent {
  id: string;
  preset: SubAgentPresetId;
  task: string;
  startedAt: number;
  abortController: AbortController;
  promise: Promise<SubAgentResult>;
}

const activeAgents = new Map<string, ActiveSubAgent>();

/** 获取所有活跃子 Agent */
export function getActiveSubAgents(): Array<{ id: string; preset: string; task: string; runningMs: number }> {
  const now = Date.now();
  return [...activeAgents.values()].map(a => ({
    id: a.id,
    preset: a.preset,
    task: a.task.slice(0, 100),
    runningMs: now - a.startedAt,
  }));
}

/** 取消指定子 Agent */
export function cancelSubAgent(agentId: string): boolean {
  const agent = activeAgents.get(agentId);
  if (!agent) return false;
  agent.abortController.abort();
  activeAgents.delete(agentId);
  return true;
}

// ═══════════════════════════════════════
// Core: Single Sub-Agent Execution
// ═══════════════════════════════════════

/**
 * 启动单个子 Agent。
 *
 * 复用已有的 callLLMWithTools / executeTool / executeToolAsync，
 * 不引入任何新依赖。
 */
export async function spawnSubAgent(
  task: string,
  config: SubAgentConfig,
  ctx: ToolContext,
  settings: AppSettings,
  /** 可选: 父 Agent 向 UI 发送日志的回调 */
  onLog?: (msg: string) => void,
): Promise<SubAgentResult> {
  const startTime = Date.now();
  const preset = PRESETS[config.preset];
  if (!preset) {
    return makeFailResult(`未知预设: ${config.preset}`, startTime);
  }

  const agentId = config.agentId || `sub-${config.preset}-${Date.now().toString(36)}`;
  const maxIter = config.maxIterations ?? preset.maxIterations;
  const modelTier = config.modelTier ?? preset.modelTier;
  const model = resolveModel(modelTier as any, settings);

  const abortController = new AbortController();
  const signal = abortController.signal;

  const logMsg = (msg: string) => {
    log.info(`[${agentId}] ${msg}`);
    onLog?.(`[${preset.name}:${agentId}] ${msg}`);
  };

  logMsg(`启动 — 任务: ${task.slice(0, 80)}... 模型: ${model} 最大轮次: ${maxIter}`);

  // 构建 system prompt
  const systemPrompt = [
    preset.systemPrompt,
    config.extraPrompt ? `\n## 额外指令\n${config.extraPrompt}` : '',
    `\n## 环境信息\n- 工作区: ${ctx.workspacePath}\n- 子Agent ID: ${agentId}\n- 最大轮次: ${maxIter}`,
  ].join('');

  // 构建工具列表 (从已注册的 TOOL_DEFINITIONS 中过滤)
  const allowedTools = new Set(preset.tools);
  const toolsForLLM = TOOL_DEFINITIONS
    .filter(t => allowedTools.has(t.name))
    .map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

  // 消息历史
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  // 追踪
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const filesCreated: string[] = [];
  const filesModified: string[] = [];
  const actionLog: string[] = [];

  // 注册为活跃子 Agent (必须在 Promise 创建之前, 避免竞态)
  const activeEntry: ActiveSubAgent = {
    id: agentId,
    preset: config.preset,
    task,
    startedAt: startTime,
    abortController,
    promise: null as any, // 临时占位, 下面立即赋值
  };
  activeAgents.set(agentId, activeEntry);

  const resultPromise = (async (): Promise<SubAgentResult> => {
    try {
      for (let iter = 0; iter < maxIter; iter++) {
        if (signal.aborted) {
          return makeResult(false, '被取消', iter, startTime);
        }

        // 调用 LLM
        let llmResult;
        try {
          llmResult = await callLLMWithTools(
            settings,
            model,
            messages,
            toolsForLLM,
            signal,
          );
        } catch (err: unknown) {
          if (err instanceof NonRetryableError) {
            return makeResult(false, `LLM 不可恢复错误: ${err.message}`, iter, startTime);
          }
          throw err;
        }

        totalInputTokens += llmResult.inputTokens;
        totalOutputTokens += llmResult.outputTokens;

        const msg = llmResult.message;

        // 无 tool_calls → 结束
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          return makeResult(true, msg.content || '任务完成', iter + 1, startTime);
        }

        // 记录 assistant 消息
        messages.push({
          role: 'assistant',
          content: msg.content,
          tool_calls: msg.tool_calls,
        } as any);

        // 执行工具调用
        for (const tc of msg.tool_calls) {
          if (signal.aborted) break;

          let toolArgs: Record<string, any>;
          try {
            toolArgs = typeof tc.function.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function.arguments;
          } catch { /* silent: tool args JSON parse failed */
            toolArgs = {};
          }

          const toolName = tc.function.name;

          // task_complete → 结束
          if (toolName === 'task_complete') {
            const summary = toolArgs.summary || '任务完成';
            const changedFiles = toolArgs.files_changed || [];
            actionLog.push(`✅ task_complete: ${summary}`);
            return makeResult(true, summary, iter + 1, startTime, changedFiles);
          }

          // 工具权限检查
          if (!allowedTools.has(toolName)) {
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `❌ 权限不足: 子Agent(${config.preset}) 不允许使用 ${toolName}`,
            } as any);
            continue;
          }

          // 写操作权限检查
          if (!preset.canWrite && isWriteTool(toolName)) {
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `❌ 权限不足: 子Agent(${config.preset}) 为只读角色，不能执行写操作`,
            } as any);
            continue;
          }

          // 注入子 Agent 信息到 context
          const subCtx: ToolContext = {
            ...ctx,
            workerId: agentId,
            featureId: ctx.featureId || 'sub-agent-task',
          };

          // 执行
          const call: ToolCall = { name: toolName, arguments: toolArgs };
          let toolResult: ToolResult;

          if (isAsyncTool(toolName)) {
            toolResult = await executeToolAsync(call, subCtx);
          } else {
            toolResult = executeTool(call, subCtx);
          }

          // 追踪文件变更
          if (toolResult.success) {
            const filePath = toolArgs.path || toolArgs.file || '';
            if (toolName === 'write_file' && filePath) filesCreated.push(filePath);
            if ((toolName === 'edit_file' || toolName === 'batch_edit') && filePath) filesModified.push(filePath);
          }

          actionLog.push(`${toolResult.success ? '✓' : '✗'} ${toolName}(${summarizeArgs(toolArgs)})`);
          logMsg(`[${iter + 1}/${maxIter}] ${toolName} → ${toolResult.success ? 'OK' : 'FAIL'}`);

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: (toolResult.output || '').slice(0, 4000),
          } as any);
        }
      }

      return makeResult(true, '达到最大轮次', maxIter, startTime);
    } catch (err: unknown) {
      return makeResult(false, `异常: ${err instanceof Error ? err.message : String(err)}`, 0, startTime);
    } finally {
      // 释放 file-lock
      releaseWorkerLocks(agentId);
      activeAgents.delete(agentId);
      logMsg(`结束 — 耗时 ${Date.now() - startTime}ms`);
    }
  })();

  // 更新 promise 引用 (已经在 Map 中)
  activeEntry.promise = resultPromise;

  // helper: 构造结果
  function makeResult(
    success: boolean, conclusion: string, iterations: number, start: number, extraFiles?: string[],
  ): SubAgentResult {
    if (extraFiles) {
      for (const f of extraFiles) {
        if (!filesCreated.includes(f) && !filesModified.includes(f)) filesModified.push(f);
      }
    }
    const cost = calcCost(model, totalInputTokens, totalOutputTokens);
    return {
      success,
      conclusion,
      filesCreated: [...new Set(filesCreated)],
      filesModified: [...new Set(filesModified)],
      actionSummary: actionLog.join('\n'),
      iterations,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cost,
      durationMs: Date.now() - start,
    };
  }

  return resultPromise;
}

// ═══════════════════════════════════════
// Parallel Execution
// ═══════════════════════════════════════

/**
 * 并行启动多个子 Agent，等待全部完成。
 *
 * 使用 Promise.allSettled 确保单个失败不影响其他。
 * 文件冲突通过 file-lock 自动防护。
 */
export async function spawnParallel(
  tasks: ParallelTask[],
  ctx: ToolContext,
  settings: AppSettings,
  onLog?: (msg: string) => void,
): Promise<ParallelResult[]> {
  onLog?.(`并行启动 ${tasks.length} 个子 Agent...`);

  const promises = tasks.map(async (t): Promise<ParallelResult> => {
    const result = await spawnSubAgent(t.task, t.config, ctx, settings, onLog);
    return { id: t.id, result };
  });

  const settled = await Promise.allSettled(promises);

  return settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    return {
      id: tasks[i].id,
      result: makeFailResult(`并行执行异常: ${s.reason}`, Date.now()),
    };
  });
}

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

function makeFailResult(reason: string, startTime: number): SubAgentResult {
  return {
    success: false,
    conclusion: reason,
    filesCreated: [],
    filesModified: [],
    actionSummary: '',
    iterations: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    durationMs: Date.now() - startTime,
  };
}

/** 判断工具是否有写副作用 */
function isWriteTool(name: string): boolean {
  return ['write_file', 'edit_file', 'batch_edit', 'run_command', 'git_commit'].includes(name);
}

/** 缩写工具参数 (用于日志) */
function summarizeArgs(args: Record<string, any>): string {
  const parts: string[] = [];
  if (args.path) parts.push(args.path);
  if (args.pattern) parts.push(`"${args.pattern}"`);
  if (args.query) parts.push(`"${args.query}"`);
  if (args.command) parts.push(args.command.slice(0, 40));
  if (args.url) parts.push(args.url.slice(0, 60));
  if (args.summary) parts.push(args.summary.slice(0, 40));
  return parts.join(', ') || '...';
}

/** 导出预设名列表 (供工具描述) */
export function getPresetNames(): SubAgentPresetId[] {
  return Object.keys(PRESETS) as SubAgentPresetId[];
}

/** 获取预设的描述信息 */
export function getPresetInfo(id: SubAgentPresetId): { name: string; canWrite: boolean; maxIterations: number; toolCount: number } | null {
  const p = PRESETS[id];
  if (!p) return null;
  return { name: p.name, canWrite: p.canWrite, maxIterations: p.maxIterations, toolCount: p.tools.length };
}
