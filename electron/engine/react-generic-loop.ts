/**
 * Generic ReAct Agent Loop — 通用 ReAct 循环 (任意角色)
 *
 * 从 react-loop.ts 拆出 (v30.2)
 * 使用场景: PM 需求分析 / Architect 架构设计 / Phase 3 文档生成 / QA 审查
 */

import { BrowserWindow } from 'electron';
import { callLLMWithTools, calcCost, sleep, NonRetryableError } from './llm-client';
import { sendToUI, addLog } from './ui-bridge';
import { updateAgentStats } from './agent-manager';
import type { AppSettings, LLMMessage, LLMToolCall } from './types';
import {
  getToolsForRole,
  executeTool,
  executeToolAsync,
  isAsyncTool,
  type ToolContext,
  type ToolCall,
  type ToolResult,
} from './tool-system';
import { parseFileBlocks, writeFileBlocks } from './file-writer';
import {
  guardToolCall,
  checkReactTermination,
  toolCallSignature,
  hasToolSideEffect,
  checkSemanticLoop,
  DEFAULT_REACT_CONFIG,
  type ReactState as GuardReactState,
  computeBudgetNudge,
  type BudgetTrackerState,
  createStuckDetectorState,
  recordToolCalls as recordStuckToolCalls,
  detectStuckPattern,
} from './guards';
import { withContextDiscipline } from './prompts';
import { emitEvent } from './event-store';
import { createLogger } from './logger';
import { backupConversation } from './conversation-backup';
import {
  isRetryableTool,
  isRetryableError,
  getBackoffDelayMs,
  checkContextBudget,
  compressToolOutputs,
} from './react-resilience';
import {
  recordFileChange,
  recordToolError,
  maskOldToolOutputs,
  buildScratchpadAnchor,
} from './scratchpad';
import { summarizeToolResult } from './tool-result-summarizer';
import { buildExecutionPlan, type ToolCallInfo } from './parallel-tools';
import { createLearningState, recordFailure, injectLessons, type LearningState } from './iteration-learning';
import { computeMessageBreakdown } from './react-helpers';
import { generateTerminationSummary } from './react-helpers';
import { compressMessageHistorySmart } from './react-compression';

const log = createLogger('react-generic-loop');
export interface GenericReactConfig {
  projectId: string;
  agentId: string;
  role: import('./tool-registry').AgentRole;
  systemPrompt: string;
  userMessage: string;
  settings: AppSettings;
  workspacePath: string | null;
  gitConfig: import('./git-provider').GitProviderConfig;
  win: BrowserWindow | null;
  signal: AbortSignal;
  maxIterations?: number;
  model?: string;
  timeoutMs?: number;
  streamLabel?: string;
  /** v16.0: 项目级权限开关 */
  permissions?: import('./tool-registry').AgentPermissions;
}

export interface GenericReactResult {
  completed: boolean;
  blocked: boolean;
  blockReason?: string;
  blockSuggestions?: string[];
  finalText: string;
  filesWritten: string[];
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  iterations: number;
}

export async function reactAgentLoop(config: GenericReactConfig): Promise<GenericReactResult> {
  const {
    projectId,
    agentId,
    role,
    systemPrompt,
    userMessage,
    settings,
    workspacePath,
    gitConfig,
    win,
    signal,
    maxIterations = 15,
    model = settings.strongModel,
    timeoutMs = 180000,
    permissions,
  } = config;

  const tools = getToolsForRole(role, gitConfig.mode);
  const toolCtx: ToolContext = { workspacePath: workspacePath || '', projectId, gitConfig, permissions };

  let totalCost = 0,
    totalIn = 0,
    totalOut = 0;
  let completed = false,
    blocked = false;
  let blockReason = '',
    blockSuggestions: string[] = [];
  let finalText = '';
  let terminationReason: string | undefined;
  const filesWritten = new Set<string>();

  const guardState: GuardReactState = {
    iteration: 0,
    totalTokens: 0,
    totalCost: 0,
    startTimeMs: Date.now(),
    consecutiveIdleCount: 0,
    consecutiveErrorCount: 0,
    recentCallSignatures: [],
    taskCompleted: false,
    filesWritten: new Set<string>(),
    // v20.0: 新增验证追踪
    hasRunVerification: false,
    hasWrittenFiles: false,
    consecutivePlainTextCount: 0,
    semanticFailures: new Map(),
  };

  // v18.0: 迭代间学习
  const learningState: LearningState = createLearningState();

  // v10.1: Budget Tracker + Stuck Detector
  const stuckState = createStuckDetectorState();
  const budgetTrackerBase: BudgetTrackerState = {
    iteration: 0,
    maxIterations: maxIterations,
    totalTokens: 0,
    maxTokens: DEFAULT_REACT_CONFIG.maxTotalTokens,
    totalCost: 0,
    maxCost: DEFAULT_REACT_CONFIG.maxCostUsd,
    hasWrittenFiles: false,
    hasRunVerification: false,
    role,
  };

  // v10.2: 全局上下文管理纪律
  const enhancedSystemPrompt = withContextDiscipline(systemPrompt);

  const messages: LLMMessage[] = [
    { role: 'system', content: enhancedSystemPrompt },
    { role: 'user', content: userMessage },
  ];

  sendToUI(win, 'agent:log', {
    projectId,
    agentId,
    content: `🔄 开始 ReAct 工具循环 (最多 ${maxIterations} 轮, 角色: ${role})`,
  });

  for (let iter = 1; iter <= maxIterations && !signal.aborted; iter++) {
    guardState.iteration = iter;
    const termCheck = checkReactTermination(
      guardState,
      {
        ...DEFAULT_REACT_CONFIG,
        maxIterations,
        maxWallTimeMs: maxIterations * timeoutMs,
        // PM / Architect 角色以分析为主，天然只读不写，适度放宽空转检测
        // v10.1: 从 50 降至 15 — 防止 PM 无限制读代码导致 token 膨胀
        maxIdleIterations: role === 'pm' || role === 'architect' ? 15 : DEFAULT_REACT_CONFIG.maxIdleIterations,
      },
      signal.aborted,
    );
    if (!termCheck.shouldContinue) {
      terminationReason = termCheck.reason;
      sendToUI(win, 'agent:log', { projectId, agentId, content: `🛑 终止: ${termCheck.reason}` });
      break;
    }

    try {
      // v18.0: 注入从失败中学到的教训
      injectLessons(messages, learningState);

      // v10.1: Budget Tracker — 注入进度感知信号
      budgetTrackerBase.iteration = iter;
      budgetTrackerBase.totalTokens = totalIn + totalOut;
      budgetTrackerBase.totalCost = totalCost;
      budgetTrackerBase.hasWrittenFiles = guardState.hasWrittenFiles;
      budgetTrackerBase.hasRunVerification = guardState.hasRunVerification;

      const nudge = computeBudgetNudge(budgetTrackerBase);
      if (nudge.shouldInject) {
        messages.push({ role: 'user', content: nudge.message });
        if (nudge.phase === 'urgent' || nudge.phase === 'final') {
          sendToUI(win, 'agent:log', { projectId, agentId, content: nudge.message });
        }
      }

      // v10.1: Stuck Detector — 检测并纠正非生产性模式
      stuckState.plainTextStreak = guardState.consecutivePlainTextCount;
      const stuckResult = detectStuckPattern(stuckState, budgetTrackerBase);
      if (stuckResult.isStuck) {
        messages.push({ role: 'user', content: stuckResult.correctionMessage });
        sendToUI(win, 'agent:log', {
          projectId,
          agentId,
          content: `🔍 Stuck 检测 [${stuckResult.pattern}]: ${stuckResult.correctionMessage.slice(0, 100)}`,
        });
      }

      const result = await callLLMWithTools(settings, model, messages, tools, signal, 16384);
      const cost = calcCost(model, result.inputTokens, result.outputTokens);
      totalCost += cost;
      totalIn += result.inputTokens;
      totalOut += result.outputTokens;
      updateAgentStats(agentId, projectId, result.inputTokens, result.outputTokens, cost);
      guardState.totalTokens = totalIn + totalOut;
      guardState.totalCost = totalCost;

      const msg = result.message;
      if (msg.content) {
        finalText = msg.content;
        const short = msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content;
        sendToUI(win, 'agent:log', { projectId, agentId, content: `💭 [${iter}] ${short}` });
      }

      // 无 tool_calls → 结束
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        if (msg.content && workspacePath) {
          const blocks = parseFileBlocks(msg.content);
          if (blocks.length > 0) {
            const written = writeFileBlocks(workspacePath, blocks);
            for (const w of written) filesWritten.add(w.relativePath);
            sendToUI(win, 'agent:log', { projectId, agentId, content: `📁 [兼容] 写入 ${written.length} 文件` });
            sendToUI(win, 'workspace:changed', { projectId });
          }
        }

        // v20.0: 纯文本回复容忍
        guardState.consecutivePlainTextCount++;
        if (guardState.consecutivePlainTextCount < 3) {
          messages.push({ role: 'assistant', content: msg.content });
          messages.push({
            role: 'user',
            content: '你需要使用工具来完成任务。请调用合适的工具。如果任务已全部完成，请调用 task_complete。',
          });
          continue;
        }
        terminationReason = 'consecutive_plain_text';
        break;
      }

      // v20.0: 有 tool_calls 时重置纯文本计数
      guardState.consecutivePlainTextCount = 0;

      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

      // v18.0: 并行工具执行分析
      const toolCallInfos: ToolCallInfo[] = msg.tool_calls.map((tc: LLMToolCall) => {
        let args: Record<string, unknown>;
        try {
          args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
        } catch (err) {
          log.debug('Catch at react-loop.ts:1817', { error: String(err) });
          args = {};
        }
        return { id: tc.id, name: tc.function.name, arguments: args };
      });
      const execPlan = buildExecutionPlan(toolCallInfos);
      if (execPlan.hasParallelism) {
        sendToUI(win, 'agent:log', {
          projectId,
          agentId,
          content: `⚡ 并行执行: ${execPlan.batches.length} 批次 (预估节省 ${execPlan.estimatedTimeSavedMs}ms)`,
        });
      }

      // 按批次执行 — 批次内并行，批次间串行
      for (const batch of execPlan.batches) {
        const batchResults = await Promise.all(
          batch.map(async tcInfo => {
            // 找到原始 tool_call (保留 id)
            const tc = msg.tool_calls?.find((t: LLMToolCall) => t.id === tcInfo.id);
            const toolArgs = tcInfo.arguments as Record<string, any>; // accepted: ToolCall.arguments type
            const toolCall: ToolCall = { name: tcInfo.name, arguments: toolArgs };

            // guard 检查
            const guard = guardToolCall(tcInfo.name, toolArgs, !!workspacePath);
            if (!guard.allowed) {
              guardState.consecutiveErrorCount++;
              return { tc, toolArgs, result: null as ToolResult | null, guardReason: guard.reason };
            }
            if (guard.repairedArgs) {
              toolCall.arguments = guard.repairedArgs;
            }

            guardState.recentCallSignatures.push(toolCallSignature(tcInfo.name, toolArgs));
            if (guardState.recentCallSignatures.length > 10)
              guardState.recentCallSignatures = guardState.recentCallSignatures.slice(-10);

            if (
              tcInfo.name === 'todo_write' ||
              tcInfo.name === 'todo_read' ||
              tcInfo.name === 'scratchpad_write' ||
              tcInfo.name === 'scratchpad_read'
            )
              toolArgs._agentId = agentId;

            // 特殊处理: task_complete / report_blocked
            if (tcInfo.name === 'task_complete') {
              completed = true;
              guardState.taskCompleted = true;
              // v10.1: summary 同步到 finalText — PM 等角色依赖 finalText 提取结构化输出
              if (toolArgs.summary) finalText = String(toolArgs.summary);
              return {
                tc,
                toolArgs,
                result: { success: true, output: `任务已完成: ${toolArgs.summary}`, action: 'complete' } as ToolResult,
                special: 'complete',
              };
            }
            if (tcInfo.name === 'report_blocked') {
              blocked = true;
              blockReason = toolArgs.reason || '未说明原因';
              blockSuggestions = toolArgs.suggestions || [];
              return {
                tc,
                toolArgs,
                result: { success: true, output: '已报告阻塞', action: 'blocked' } as ToolResult,
                special: 'blocked',
              };
            }

            // 执行工具
            const isAsync = isAsyncTool(tcInfo.name);
            let toolResult: ToolResult = isAsync
              ? await executeToolAsync(toolCall, toolCtx)
              : executeTool(toolCall, toolCtx);

            // 自动重试
            if (!toolResult.success && isRetryableTool(tcInfo.name) && isRetryableError(toolResult.output || '')) {
              await sleep(1500);
              toolResult = isAsync ? await executeToolAsync(toolCall, toolCtx) : executeTool(toolCall, toolCtx);
            }

            return { tc, toolArgs, result: toolResult };
          }),
        );

        // 将批次结果按原始顺序加入 messages
        for (const { tc, toolArgs, result, guardReason, special } of batchResults) {
          if (!tc) continue;
          if (guardReason) {
            messages.push({ role: 'tool', tool_call_id: tc.id, content: `拦截: ${guardReason}` });
            continue;
          }
          if (!result) continue;

          if (special === 'complete') {
            sendToUI(win, 'agent:log', {
              projectId,
              agentId,
              content: `✅ task_complete: ${toolArgs.summary || '完成'}`,
            });
            addLog(projectId, agentId, 'output', `Completed: ${toolArgs.summary || '完成'}`);
            messages.push({ role: 'tool', tool_call_id: tc.id, content: result.output });
            continue;
          }
          if (special === 'blocked') {
            sendToUI(win, 'agent:log', { projectId, agentId, content: `🚫 BLOCKED: ${blockReason}` });
            addLog(projectId, agentId, 'warning', `BLOCKED: ${blockReason}`);
            sendToUI(win, 'agent:blocked', { projectId, agentId, reason: blockReason, suggestions: blockSuggestions });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: result.output });
            continue;
          }

          // 日志
          const argsSummary =
            tc.function.name === 'write_file'
              ? `path=${toolArgs.path}, ${Buffer.byteLength(toolArgs.content || '', 'utf-8')}B`
              : JSON.stringify(toolArgs).slice(0, 120);
          sendToUI(win, 'agent:log', {
            projectId,
            agentId,
            content: `🔧 ${tc.function.name}(${argsSummary}) → ${result.success ? '✅' : '❌'} ${result.output.slice(0, 100)}`,
          });
          emitEvent({
            projectId,
            agentId,
            type: 'tool:call',
            data: { tool: tc.function.name, success: result.success },
          });

          if ((tc.function.name === 'write_file' || tc.function.name === 'edit_file') && result.success) {
            filesWritten.add(toolArgs.path);
            guardState.hasWrittenFiles = true;
            sendToUI(win, 'workspace:changed', { projectId });
            // v19.0: Harness 自动收集文件变更到 scratchpad
            if (workspacePath) {
              recordFileChange(
                workspacePath,
                agentId,
                toolArgs.path,
                tc.function.name === 'write_file' ? 'created' : 'modified',
              );
            }
          }

          // v20.0: 追踪验证命令执行
          if (['run_command', 'run_test', 'run_lint'].includes(tc.function.name)) {
            guardState.hasRunVerification = true;
          }

          // v20.0: 语义死循环检测
          const targetFile = toolArgs.path || toolArgs.command || '';
          if (typeof targetFile === 'string' && targetFile && !result.success) {
            const semLoop = checkSemanticLoop(guardState, tc.function.name, targetFile, result.success);
            if (semLoop.detected && semLoop.escalation) {
              messages.push({ role: 'user', content: semLoop.escalation });
            }
          }

          // v18.0: 迭代间学习 — 记录失败
          if (!result.success) {
            recordFailure(learningState, {
              toolName: tc.function.name,
              errorOutput: result.output.slice(0, 500),
              arguments: toolArgs,
              timestamp: Date.now(),
            });
            // v19.0: Harness 自动收集工具错误到 scratchpad
            if (workspacePath) {
              recordToolError(workspacePath, agentId, tc.function.name, result.output.slice(0, 300));
            }
          }

          // v18.0: 智能摘要
          const summary = summarizeToolResult(tc.function.name, result.output, {
            success: result.success,
            budgetStatus: 'normal',
          });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: summary.text });
        }
      }

      const toolCallsThisIter = (msg.tool_calls || []).map((tc: LLMToolCall) => tc.function.name);
      if (hasToolSideEffect(toolCallsThisIter)) guardState.consecutiveIdleCount = 0;
      else guardState.consecutiveIdleCount++;
      guardState.consecutiveErrorCount = 0;

      // v10.1: Record tool calls for stuck detection
      recordStuckToolCalls(
        stuckState,
        (msg.tool_calls || []).map((tc: LLMToolCall) => ({
          name: tc.function.name,
          argsSignature: toolCallSignature(
            tc.function.name,
            (() => {
              try {
                return JSON.parse(tc.function.arguments as string);
              } catch (err) {
                log.debug('Catch at react-loop.ts:2015', { error: String(err) });
                return {};
              }
            })(),
          ),
        })),
      );

      if (completed || blocked) {
        sendToUI(win, 'agent:log', {
          projectId,
          agentId,
          content: `🔚 ReAct 结束 (${iter} 轮, $${totalCost.toFixed(4)})${blocked ? ' [BLOCKED]' : ''}`,
        });
        break;
      }

      // ── v10.2 渐进式上下文压缩 (Proactive Compaction) ──
      const { total: ctxTokens } = computeMessageBreakdown(messages);
      const budget = checkContextBudget(ctxTokens, model);

      if (budget.status !== 'ok') {
        // Step 1: Observation Masking — 所有非 ok 状态都执行
        const keepRecentCount = budget.status === 'overflow' ? 6 : budget.status === 'critical' ? 8 : 10;
        maskOldToolOutputs(messages, keepRecentCount);

        // Step 2: 深度压缩 — 仅 critical/overflow 时
        if (budget.status === 'overflow' || budget.status === 'critical') {
          compressToolOutputs(messages, budget.status);
          await compressMessageHistorySmart(messages, settings, signal);
        } else if (messages.length > 25) {
          compressToolOutputs(messages, 'warning');
        }

        // Step 3: 注入 Scratchpad 锚点
        if (workspacePath) {
          const anchor = buildScratchpadAnchor(workspacePath, agentId);
          if (anchor) {
            const insertIdx = Math.min(2, messages.length);
            messages.splice(insertIdx, 0, anchor);
          }
        }
      }
    } catch (err: unknown) {
      if (signal.aborted) break;
      // v5.6: 不可重试错误立即终止
      if (err instanceof NonRetryableError) {
        sendToUI(win, 'agent:log', {
          projectId,
          agentId,
          content: `🛑 不可重试错误 (${err.statusCode}): ${err.message}`,
        });
        addLog(projectId, agentId, 'error', `NonRetryable: ${err.message}`);
        terminationReason = `non_retryable_error: ${err.message}`;
        break;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      guardState.consecutiveErrorCount++;
      const backoffMs = getBackoffDelayMs(guardState.consecutiveErrorCount);
      sendToUI(win, 'agent:log', {
        projectId,
        agentId,
        content: `⚠️ 迭代 ${iter} 错误 (第${guardState.consecutiveErrorCount}次): ${errMsg} — 等待 ${Math.round(backoffMs / 1000)}s`,
      });
      addLog(projectId, agentId, 'error', `iter ${iter}: ${errMsg}`);
      await sleep(backoffMs);
    }
  }

  // v24.0: 终止总结 — 非正常结束时生成最终总结
  if (!completed && !blocked && !signal.aborted && !terminationReason) {
    terminationReason = 'max_iterations';
  }
  if (!completed && !blocked && !signal.aborted && terminationReason) {
    const summary = await generateTerminationSummary({
      projectId,
      agentId,
      role,
      terminationReason,
      iterations: guardState.iteration,
      totalCost,
      totalIn,
      totalOut,
      filesWritten,
      messages,
      settings,
      model,
      signal,
      win,
      workspacePath: workspacePath || null,
    });
    // 将终止总结写入 finalText — 供调用方使用
    if (summary) {
      finalText = summary;
    }
  }

  // ── v8.0: 对话备份 ──
  backupConversation({
    projectId,
    agentId,
    agentRole: role,
    messages: messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content ? JSON.stringify(m.content) : null,
      tool_calls: m.tool_calls,
    })),
    reactIterations: guardState.iteration,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    totalCost,
    model,
    completed,
    metadata: {
      blocked,
      blockReason: blocked ? blockReason : undefined,
      filesWritten: [...filesWritten],
    },
  });

  return {
    completed,
    blocked,
    blockReason: blocked ? blockReason : undefined,
    blockSuggestions: blocked ? blockSuggestions : undefined,
    finalText,
    filesWritten: [...filesWritten],
    totalCost,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    iterations: guardState.iteration,
  };
}