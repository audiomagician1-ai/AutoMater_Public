/**
 * ReAct Developer Loop — 多轮工具调用核心
 *
 * 思考 → 行动 → 观察 循环，最多 25 轮
 * 支持 function-calling (OpenAI/Anthropic)、兼容 <<<FILE>>> 模式
 * 消息历史智能压缩 (LLM Summarizer + fallback truncation)
 *
 * 从 orchestrator.ts 拆出 (v2.5)
 */

import { BrowserWindow } from 'electron';
import { getDb } from '../db';
import { callLLM, callLLMWithTools, calcCost, sleep, NonRetryableError, type StreamCallback } from './llm-client';
import { sendToUI, addLog } from './ui-bridge';
import { updateAgentStats, checkBudget, getTeamPrompt, getTeamMemberLLMConfig } from './agent-manager';
import type { AppSettings } from './types';
import { collectDeveloperContext, collectLightContext, type ContextSnapshot } from './context-collector';
import { getToolsForRole, executeTool, executeToolAsync, type ToolContext, type ToolCall, type ToolResult } from './tool-system';
import { parsePlanFromLLM, getPlanSummary, type FeaturePlan } from './planner';
import { DEVELOPER_REACT_PROMPT } from './prompts';
import { parseFileBlocks, writeFileBlocks } from './file-writer';
import { parseStructuredOutput, PLAN_STEPS_SCHEMA } from './output-parser';
import {
  guardToolCall, checkReactTermination, toolCallSignature, hasToolSideEffect,
  DEFAULT_REACT_CONFIG, type ReactState as GuardReactState, type TerminationReason,
} from './guards';
import { selectModelTier, resolveModel, estimateFeatureComplexity, type TaskComplexity } from './model-selector';
import { runResearcher } from './sub-agent';
import { buildCodeGraph, graphSummary } from './code-graph';
import { readRecentDecisions, formatDecisionsForContext, appendSharedDecision } from './memory-system';
import { emitEvent } from './event-store';
import { createLogger } from './logger';
import { backupConversation } from './conversation-backup';
import type { GitProviderConfig } from './git-provider';

const log = createLogger('react-loop');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface ReactResult {
  completed: boolean;
  filesWritten: string[];
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  iterations: number;
}

export interface MessageTokenBreakdown {
  role: 'system' | 'user' | 'assistant' | 'tool';
  tokens: number;
  count: number;
}

export interface ReactIterationState {
  iteration: number;
  timestamp: number;
  messageCount: number;
  totalContextTokens: number;
  breakdown: MessageTokenBreakdown[];
  inputTokensThisCall: number;
  outputTokensThisCall: number;
  costThisCall: number;
  cumulativeCost: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  filesWritten: string[];
  toolCallsThisIteration: string[];
  completed: boolean;
}

export interface AgentReactState {
  agentId: string;
  featureId: string;
  iterations: ReactIterationState[];
  maxContextWindow: number;
}

// ═══════════════════════════════════════
// ReAct State Cache (for UI monitoring)
// ═══════════════════════════════════════

const agentReactStateCache = new Map<string, Map<string, AgentReactState>>();

export function getAgentReactStates(projectId: string): Map<string, AgentReactState> {
  return agentReactStateCache.get(projectId) ?? new Map();
}

function cacheAgentReactState(projectId: string, state: AgentReactState) {
  if (!agentReactStateCache.has(projectId)) {
    agentReactStateCache.set(projectId, new Map());
  }
  agentReactStateCache.get(projectId)!.set(state.agentId, state);
}

// ═══════════════════════════════════════
// Context Snapshot Cache
// ═══════════════════════════════════════

const contextSnapshotCache = new Map<string, Map<string, ContextSnapshot>>();

export function getContextSnapshots(projectId: string): Map<string, ContextSnapshot> {
  return contextSnapshotCache.get(projectId) ?? new Map();
}

function cacheContextSnapshot(projectId: string, snapshot: ContextSnapshot) {
  if (!contextSnapshotCache.has(projectId)) {
    contextSnapshotCache.set(projectId, new Map());
  }
  contextSnapshotCache.get(projectId)!.set(snapshot.agentId, snapshot);
}

// ═══════════════════════════════════════
// Token Estimation Utilities
// ═══════════════════════════════════════

function estimateMsgTokens(content: any): number {
  if (!content) return 0;
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return Math.ceil(text.length / 1.5);
}

function computeMessageBreakdown(messages: Array<{ role: string; content: any }>): { breakdown: MessageTokenBreakdown[]; total: number } {
  const map: Record<string, { tokens: number; count: number }> = {};
  let total = 0;
  for (const m of messages) {
    const role = m.role as string;
    const t = estimateMsgTokens(m.content);
    if (!map[role]) map[role] = { tokens: 0, count: 0 };
    map[role].tokens += t;
    map[role].count += 1;
    total += t;
  }
  const breakdown: MessageTokenBreakdown[] = Object.entries(map).map(([role, v]) => ({
    role: role as any,
    tokens: v.tokens,
    count: v.count,
  }));
  return { breakdown, total };
}

// ═══════════════════════════════════════
// ReAct Developer Loop
// ═══════════════════════════════════════

export async function reactDeveloperLoop(
  projectId: string, workerId: string, settings: AppSettings,
  win: BrowserWindow | null, signal: AbortSignal,
  workspacePath: string | null, gitConfig: GitProviderConfig,
  feature: any, qaFeedback: string
): Promise<ReactResult> {
  const db = getDb();
  const MAX_ITERATIONS = 25;

  // v3.0: 程序化终止控制器 (替代依赖 LLM 调用 task_complete)
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
  };

  // v11.0: 从 workerId 提取 worker 索引 (用于成员级配置)
  const workerIndex = parseInt(workerId.replace('dev-', ''), 10) - 1 || 0;

  // ── v1.3: Dynamic Model Selection ──
  const featureComplexity = estimateFeatureComplexity(feature);
  let depCount = 0;
  try { depCount = JSON.parse(feature.depends_on || '[]').length; } catch { /* malformed JSON in depends_on */ }
  const taskComplexity: TaskComplexity = {
    type: 'development',
    featureComplexity,
    dependencyCount: depCount,
    hasQAFeedback: !!qaFeedback,
    qaAttempt: qaFeedback ? 2 : 1,
  };
  const modelSelection = selectModelTier(taskComplexity);
  // v11.0: 成员级模型优先 > model-selector 动态选择
  const memberConfig = getTeamMemberLLMConfig(projectId, 'developer', workerIndex, settings);
  const memberHasModel = memberConfig.model !== settings.workerModel && memberConfig.model !== settings.strongModel;
  const model = memberHasModel ? memberConfig.model : resolveModel(modelSelection.tier, settings);
  sendToUI(win, 'agent:log', {
    projectId, agentId: workerId,
    content: memberHasModel
      ? `🤖 ${feature.id} 成员模型: ${model} (独立配置)`
      : `🤖 ${feature.id} 模型选择: ${model} (${modelSelection.tier}) — ${modelSelection.reason}`,
  });

  const tools = getToolsForRole('developer', gitConfig.mode);

  const toolCtx: ToolContext = {
    workspacePath: workspacePath || '',
    projectId,
    gitConfig,
    callVision: async (prompt: string, imageBase64: string, mimeType?: string) => {
      const visionModel = resolveModel('strong', settings);
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimeType || 'image/png'};base64,${imageBase64}` } },
          ],
        },
      ];
      const result = await callLLM(settings, visionModel, messages as any, signal, 4096);
      return result.content;
    },
  };

  let totalCost = 0;
  let totalIn = 0;
  let totalOut = 0;
  let completed = false;
  const filesWritten = new Set<string>();

  // ── v5.0: planning 内嵌到 ReAct think 步骤, 不再独立调用 ──
  // 生成轻量默认计划 (纯本地, 零 token), ReAct 的第一个 think 会自行细化
  const plan: FeaturePlan = parsePlanFromLLM('', feature.id, feature.title || feature.description);
  sendToUI(win, 'agent:log', {
    projectId, agentId: workerId,
    content: `📋 ${feature.id} 使用内嵌规划 (ReAct think 步骤自行细化)`,
  });

  // ── Code Graph ──
  if (workspacePath) {
    try {
      const graph = await buildCodeGraph(workspacePath, 300);
      const summary = graphSummary(graph);
      sendToUI(win, 'agent:log', {
        projectId, agentId: workerId,
        content: `📊 ${feature.id} ${summary}`,
      });
    } catch (err) {
      log.debug('Code graph build skipped', { featureId: feature.id });
    }
  }

  // 构建初始消息列表
  const initialContext = workspacePath
    ? await collectDeveloperContext(workspacePath, projectId, feature, 5000, workerId)
    : { contextText: '', estimatedTokens: 0, filesIncluded: 0 };

  if (initialContext.snapshot) {
    cacheContextSnapshot(projectId, initialContext.snapshot);
    sendToUI(win, 'agent:context-snapshot', {
      projectId,
      snapshot: initialContext.snapshot,
    });
  }

  const planText = plan ? getPlanSummary(plan) : '';

  let sharedDecisionsText = '';
  if (workspacePath) {
    const decisions = readRecentDecisions(workspacePath, 20);
    sharedDecisionsText = formatDecisionsForContext(decisions, workerId);
  }

  // v5.1: 技能自动匹配 — 搜索与当前任务相关的已习得技能
  let skillContextText = '';
  try {
    const { buildSkillContext } = await import('./skill-evolution');
    const taskDesc = `${feature.title} ${feature.description} ${feature.acceptance_criteria || ''}`;
    skillContextText = buildSkillContext(taskDesc, 2);
    if (skillContextText) {
      log.debug('Matched skills for feature', { featureId: feature.id, length: skillContextText.length });
    }
  } catch {
    // skill-evolution 模块可能未初始化, 跳过
  }

  // v4.0: 从 team_members 读取自定义 prompt, fallback 到内置 prompt
  const devSystemPrompt = getTeamPrompt(projectId, 'developer', workerIndex) ?? DEVELOPER_REACT_PROMPT;

  const messages: Array<{ role: string; content: any; tool_calls?: any; tool_call_id?: string }> = [
    { role: 'system', content: devSystemPrompt },
    {
      role: 'user',
      content: `## 任务\nFeature: ${feature.id}\n标题: ${feature.title}\n描述: ${feature.description}\n验收标准: ${feature.acceptance_criteria}\n${qaFeedback ? `\n## QA 审查反馈（必须修复）\n${qaFeedback}` : ''}${feature._docContext ? `\n\n## 需求与测试文档\n${feature._docContext}` : ''}\n\n${planText}\n\n${sharedDecisionsText ? sharedDecisionsText + '\n\n' : ''}${skillContextText ? skillContextText + '\n\n' : ''}## 项目上下文\n${initialContext.contextText}`,
    },
  ];

  sendToUI(win, 'agent:log', {
    projectId, agentId: workerId,
    content: `🔄 ${feature.id} 开始 ReAct 工具循环 (最多 ${MAX_ITERATIONS} 轮)`,
  });

  const reactState: AgentReactState = {
    agentId: workerId,
    featureId: feature.id,
    iterations: [],
    maxContextWindow: 128000,
  };

  for (let iter = 1; iter <= MAX_ITERATIONS && !signal.aborted; iter++) {
    // v3.0: 程序化终止检查 (每轮迭代前)
    guardState.iteration = iter;
    const termCheck = checkReactTermination(guardState, DEFAULT_REACT_CONFIG, signal.aborted);
    if (!termCheck.shouldContinue) {
      sendToUI(win, 'agent:log', {
        projectId, agentId: workerId,
        content: `🛑 ${feature.id} 程序化终止: ${termCheck.reason} — ${termCheck.message}`,
      });
      if (termCheck.reason !== 'task_complete') {
        addLog(projectId, workerId, 'warning', `[${feature.id}] Terminated: ${termCheck.reason} — ${termCheck.message}`);
      }
      break;
    }

    const budget = checkBudget(projectId, settings);
    if (!budget.ok) break;

    try {
      const result = await callLLMWithTools(settings, model, messages, tools, signal, 16384);
      const cost = calcCost(model, result.inputTokens, result.outputTokens);
      totalCost += cost;
      totalIn += result.inputTokens;
      totalOut += result.outputTokens;
      updateAgentStats(workerId, projectId, result.inputTokens, result.outputTokens, cost);

      // v3.0: 更新 guard 状态
      guardState.totalTokens = totalIn + totalOut;
      guardState.totalCost = totalCost;

      const msg = result.message;

      if (msg.content) {
        const shortThought = msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content;
        sendToUI(win, 'agent:log', {
          projectId, agentId: workerId,
          content: `💭 ${feature.id} [${iter}] ${shortThought}`,
        });
      }

      // ── 无 tool_calls → 纯文本回复 ──
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        if (msg.content && workspacePath) {
          const fileBlocks = parseFileBlocks(msg.content);
          if (fileBlocks.length > 0) {
            const written = writeFileBlocks(workspacePath, fileBlocks);
            for (const w of written) filesWritten.add(w.relativePath);
            sendToUI(win, 'agent:log', {
              projectId, agentId: workerId,
              content: `📁 ${feature.id} [兼容模式] 写入 ${written.length} 文件`,
            });
            sendToUI(win, 'workspace:changed', { projectId });
          }
          if (msg.content.toUpperCase().includes('COMPLETED')) {
            completed = true;
          }
        }
        sendToUI(win, 'agent:log', {
          projectId, agentId: workerId,
          content: `🔚 ${feature.id} ReAct 循环结束 (${iter} 轮, ${totalIn + totalOut} tokens, $${totalCost.toFixed(4)})`,
        });
        break;
      }

      // ── 执行 tool calls ──
      messages.push({
        role: 'assistant',
        content: msg.content,
        tool_calls: msg.tool_calls,
      });

      for (const tc of msg.tool_calls) {
        let toolArgs: Record<string, any>;
        try {
          toolArgs = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
        } catch (err) {
          log.warn('Failed to parse tool arguments as JSON, using empty object', { tool: tc.function.name });
          toolArgs = {};
        }

        const toolCall: ToolCall = { name: tc.function.name, arguments: toolArgs };

        // v3.0: 程序化参数校验 + 速率限制
        const guard = guardToolCall(tc.function.name, toolArgs, !!workspacePath);
        if (!guard.allowed) {
          sendToUI(win, 'agent:log', {
            projectId, agentId: workerId,
            content: `🚫 ${tc.function.name} 被 Guard 拦截: ${guard.reason}`,
          });
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `工具调用被拦截: ${guard.reason}。请修正参数后重试。`,
          });
          guardState.consecutiveErrorCount++;
          continue;
        }
        // 使用修复后的参数
        if (guard.repairedArgs) {
          toolCall.arguments = guard.repairedArgs;
          toolArgs = guard.repairedArgs;
        }

        // v3.0: 记录调用签名 (用于重复检测)
        guardState.recentCallSignatures.push(toolCallSignature(tc.function.name, toolArgs));
        if (guardState.recentCallSignatures.length > 10) {
          guardState.recentCallSignatures = guardState.recentCallSignatures.slice(-10);
        }

        if (tc.function.name === 'todo_write' || tc.function.name === 'todo_read') {
          toolArgs._agentId = workerId;
        }

        // ── task_complete ──
        if (tc.function.name === 'task_complete') {
          completed = true;
          guardState.taskCompleted = true;
          const summary = toolArgs.summary || '完成';
          const changedFiles = toolArgs.files_changed || [...filesWritten];

          sendToUI(win, 'agent:log', {
            projectId, agentId: workerId,
            content: `✅ ${feature.id} task_complete: ${summary}`,
          });
          addLog(projectId, workerId, 'output', `[${feature.id}] Completed: ${summary}\nFiles: ${changedFiles.join(', ')}`);

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `任务已标记完成: ${summary}`,
          });
          continue;
        }

        // 执行工具
        let toolResult: ToolResult;
        const isAsync = tc.function.name.startsWith('github_') || tc.function.name.startsWith('browser_') || tc.function.name.startsWith('mcp_') || tc.function.name.startsWith('skill_') || ['web_search', 'fetch_url', 'http_request', 'analyze_image', 'compare_screenshots', 'visual_assert'].includes(tc.function.name);

        // ── spawn_researcher 子 Agent ──
        if (tc.function.name === 'spawn_researcher') {
          sendToUI(win, 'agent:log', {
            projectId, agentId: workerId,
            content: `🔬 ${feature.id} 启动研究子 Agent: ${(toolArgs.question || '').slice(0, 80)}...`,
          });

          try {
            const researchModel = resolveModel('worker', settings);
            const researchResult = await runResearcher(
              toolArgs.question || '',
              toolCtx,
              async (msgs, tools) => {
                return await callLLMWithTools(settings, researchModel, msgs, tools, signal, 8192);
              },
              signal,
            );

            const resCost = calcCost(researchModel, researchResult.inputTokens, researchResult.outputTokens);
            totalCost += resCost;
            totalIn += researchResult.inputTokens;
            totalOut += researchResult.outputTokens;
            updateAgentStats(workerId, projectId, researchResult.inputTokens, researchResult.outputTokens, resCost);

            sendToUI(win, 'agent:log', {
              projectId, agentId: workerId,
              content: `🔬 ${feature.id} 研究子 Agent 完成 (读取 ${researchResult.filesRead.length} 文件, $${resCost.toFixed(4)})`,
            });

            toolResult = {
              success: researchResult.success,
              output: `研究结论:\n${researchResult.conclusion}\n\n参考文件: ${researchResult.filesRead.join(', ') || '无'}`,
              action: 'read',
            };
          } catch (resErr: any) {
            toolResult = { success: false, output: `研究子 Agent 失败: ${resErr.message}`, action: 'read' };
          }
        } else if (isAsync) {
          toolResult = await executeToolAsync(toolCall, toolCtx);
        } else {
          toolResult = executeTool(toolCall, toolCtx);
        }

        // 推送工具调用日志
        const argsSummary = tc.function.name === 'write_file'
          ? `path=${toolArgs.path}, ${Buffer.byteLength(toolArgs.content || '', 'utf-8')} bytes`
          : tc.function.name === 'edit_file'
          ? `path=${toolArgs.path}, replace ${(toolArgs.old_string || '').length}→${(toolArgs.new_string || '').length} chars`
          : JSON.stringify(toolArgs).slice(0, 150);
        sendToUI(win, 'agent:tool-call', {
          projectId, agentId: workerId,
          tool: tc.function.name,
          args: argsSummary,
          success: toolResult.success,
          outputPreview: toolResult.output.slice(0, 200),
        });
        emitEvent({
          projectId, agentId: workerId, featureId: feature.id,
          type: 'tool:call',
          data: { tool: tc.function.name, args: argsSummary, success: toolResult.success },
        });
        sendToUI(win, 'agent:log', {
          projectId, agentId: workerId,
          content: `🔧 ${tc.function.name}(${argsSummary}) → ${toolResult.success ? '✅' : '❌'} ${toolResult.output.slice(0, 100)}`,
        });

        // 记录写入/编辑的文件
        if ((tc.function.name === 'write_file' || tc.function.name === 'edit_file') && toolResult.success) {
          filesWritten.add(toolArgs.path);
          sendToUI(win, 'workspace:changed', { projectId });
          if (workspacePath) {
            appendSharedDecision(workspacePath, {
              agentId: workerId,
              featureId: feature.id,
              type: tc.function.name === 'write_file' ? 'file_created' : 'other',
              description: `${tc.function.name} ${toolArgs.path}`,
            });
          }
        }

        // 将工具结果加入消息历史
        if ((tc.function.name === 'screenshot' || tc.function.name === 'browser_screenshot') && (toolResult as any)._imageBase64) {
          const base64 = (toolResult as any)._imageBase64;
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: [
              { type: 'text', text: toolResult.output },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
            ] as any,
          });
        } else {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: toolResult.output.slice(0, 4000),
          });
        }
      }

      // ═══ 推送 Agent ReAct 迭代状态 ═══
      const toolCallsThisIter = (msg.tool_calls || []).map((tc: any) => tc.function.name);

      // v3.0: 更新 guard 的 idle/error 追踪
      if (hasToolSideEffect(toolCallsThisIter)) {
        guardState.consecutiveIdleCount = 0;
      } else {
        guardState.consecutiveIdleCount++;
      }
      // 成功执行了工具 → 重置连续错误计数
      guardState.consecutiveErrorCount = 0;
      for (const f of filesWritten) guardState.filesWritten.add(f);

      const { breakdown, total: contextTokens } = computeMessageBreakdown(messages);
      const iterState: ReactIterationState = {
        iteration: iter,
        timestamp: Date.now(),
        messageCount: messages.length,
        totalContextTokens: contextTokens,
        breakdown,
        inputTokensThisCall: result.inputTokens,
        outputTokensThisCall: result.outputTokens,
        costThisCall: cost,
        cumulativeCost: totalCost,
        cumulativeInputTokens: totalIn,
        cumulativeOutputTokens: totalOut,
        filesWritten: [...filesWritten],
        toolCallsThisIteration: toolCallsThisIter,
        completed,
      };
      reactState.iterations.push(iterState);
      cacheAgentReactState(projectId, reactState);
      sendToUI(win, 'agent:react-state', {
        projectId,
        agentId: workerId,
        state: reactState,
        latestIteration: iterState,
      });

      if (completed) {
        sendToUI(win, 'agent:log', {
          projectId, agentId: workerId,
          content: `🔚 ${feature.id} ReAct 完成 (${iter} 轮, ${totalIn + totalOut} tokens, $${totalCost.toFixed(4)})`,
        });
        break;
      }

      // ── 消息窗口压缩 ──
      if (messages.length > 30) {
        await compressMessageHistorySmart(messages, settings, signal);
      }

    } catch (err: any) {
      if (signal.aborted) break;
      // v5.6: 不可重试错误（模型不存在、API Key 无效等）→ 立即终止，不等 consecutive count
      if (err instanceof NonRetryableError) {
        sendToUI(win, 'agent:log', {
          projectId, agentId: workerId,
          content: `🛑 ${feature.id} 不可重试错误 (${err.statusCode}): ${err.message}`,
        });
        addLog(projectId, workerId, 'error', `[${feature.id}] NonRetryable: ${err.message}`);
        break;
      }
      guardState.consecutiveErrorCount++;
      sendToUI(win, 'agent:log', {
        projectId, agentId: workerId,
        content: `⚠️ ${feature.id} ReAct 迭代 ${iter} 错误: ${err.message}`,
      });
      addLog(projectId, workerId, 'error', `[${feature.id}] iter ${iter}: ${err.message}`);
      await sleep(2000);
    }
  }

  // 更新 feature 的 affected_files
  if (filesWritten.size > 0) {
    const existingFiles = JSON.parse(feature.affected_files || '[]') as string[];
    const allFiles = [...new Set([...existingFiles, ...filesWritten])];
    db.prepare("UPDATE features SET affected_files = ? WHERE id = ? AND project_id = ?")
      .run(JSON.stringify(allFiles), feature.id, projectId);
  }

  // ── v8.0: 对话备份 ──
  backupConversation({
    projectId,
    agentId: workerId,
    agentRole: 'developer',
    featureId: feature.id,
    messages: messages.map(m => ({
      role: m.role as any,
      content: m.content,
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id,
    })),
    reactIterations: reactState.iterations.length,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    totalCost,
    model,
    completed,
    metadata: {
      featureTitle: feature.title,
      featureDescription: feature.description,
      filesWritten: [...filesWritten],
    },
  });

  return {
    completed,
    filesWritten: [...filesWritten],
    totalCost,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    iterations: reactState.iterations.length,
  };
}

// ═══════════════════════════════════════
// Message History Compression
// ═══════════════════════════════════════

async function compressMessageHistorySmart(
  messages: Array<{ role: string; content: any; tool_calls?: any; tool_call_id?: string }>,
  settings: AppSettings,
  signal?: AbortSignal
): Promise<void> {
  const keepRecent = 10;
  if (messages.length <= keepRecent + 2) return;

  const compressRange = messages.slice(1, messages.length - keepRecent);
  if (compressRange.length < 5) return;

  const compressText = compressRange.map(m => {
    const role = m.role;
    const content = typeof m.content === 'string' ? m.content.slice(0, 300) : JSON.stringify(m.content).slice(0, 300);
    const toolInfo = m.tool_calls ? ` [tools: ${m.tool_calls.map((t: any) => t.function.name).join(',')}]` : '';
    return `[${role}]${toolInfo} ${content}`;
  }).join('\n');

  try {
    const summaryModel = resolveModel(selectModelTier({ type: 'summarize' }).tier, settings);
    const summaryResult = await callLLM(settings, summaryModel, [
      { role: 'system', content: '你是对话摘要助手。将以下 Agent 对话历史压缩为一段简洁摘要（200-400字），保留关键决策、已创建的文件、遇到的问题和解决方案。只输出摘要，不要其他内容。' },
      { role: 'user', content: `请摘要以下 ${compressRange.length} 条对话:\n\n${compressText.slice(0, 4000)}` },
    ], signal, 1024, 0);

    if (summaryResult.content) {
      const summaryMsg = {
        role: 'user' as string,
        content: `## 之前的对话摘要 (${compressRange.length} 条消息已压缩)\n${summaryResult.content}`,
      };
      messages.splice(1, compressRange.length, summaryMsg);
      return;
    }
  } catch (err) {
    log.warn('LLM summarizer failed, falling back to simple truncation', { error: String(err) });
  }

  compressMessageHistorySimple(messages);
}

function compressMessageHistorySimple(messages: Array<{ role: string; content: any; tool_calls?: any; tool_call_id?: string }>) {
  const keepRecent = 10;
  const cutoff = messages.length - keepRecent;
  for (let i = 1; i < cutoff; i++) {
    if (messages[i].role === 'tool' && typeof messages[i].content === 'string') {
      const content = messages[i].content as string;
      if (content.length > 300) {
        messages[i].content = content.slice(0, 200) + '\n... [已压缩]';
      }
    }
  }
}

// ═══════════════════════════════════════
// Generic ReAct Agent Loop (v5.5)
// ═══════════════════════════════════════

/**
 * 通用 ReAct 循环 — 任何角色的 Agent 都可以使用。
 *
 * 与 reactDeveloperLoop 的区别:
 *   - 角色无关: 通过参数注入 role / systemPrompt / tools
 *   - 更轻量: 不含 Code Graph / Skill Context / Shared Decisions 等 developer-specific 逻辑
 *   - 支持 report_blocked: 检测到阻塞信号时可中断并返回
 *   - 输出灵活: 最终文本输出通过 finalText 返回
 *
 * 使用场景: PM 需求分析 / Architect 架构设计 / Phase 3 文档生成 / QA 审查
 */

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
    projectId, agentId, role, systemPrompt, userMessage,
    settings, workspacePath, gitConfig, win, signal,
    maxIterations = 15,
    model = settings.strongModel,
    timeoutMs = 180000,
  } = config;

  const tools = getToolsForRole(role, gitConfig.mode);
  const toolCtx: ToolContext = { workspacePath: workspacePath || '', projectId, gitConfig };

  let totalCost = 0, totalIn = 0, totalOut = 0;
  let completed = false, blocked = false;
  let blockReason = '', blockSuggestions: string[] = [];
  let finalText = '';
  const filesWritten = new Set<string>();

  const guardState: GuardReactState = {
    iteration: 0, totalTokens: 0, totalCost: 0,
    startTimeMs: Date.now(),
    consecutiveIdleCount: 0, consecutiveErrorCount: 0,
    recentCallSignatures: [], taskCompleted: false,
    filesWritten: new Set<string>(),
  };

  const messages: Array<{ role: string; content: any; tool_calls?: any; tool_call_id?: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  sendToUI(win, 'agent:log', {
    projectId, agentId,
    content: `🔄 开始 ReAct 工具循环 (最多 ${maxIterations} 轮, 角色: ${role})`,
  });

  for (let iter = 1; iter <= maxIterations && !signal.aborted; iter++) {
    guardState.iteration = iter;
    const termCheck = checkReactTermination(guardState, {
      ...DEFAULT_REACT_CONFIG,
      maxIterations,
      maxWallTimeMs: maxIterations * timeoutMs,
    }, signal.aborted);
    if (!termCheck.shouldContinue) {
      sendToUI(win, 'agent:log', { projectId, agentId, content: `🛑 终止: ${termCheck.reason}` });
      break;
    }

    try {
      const result = await callLLMWithTools(settings, model, messages, tools, signal, 16384);
      const cost = calcCost(model, result.inputTokens, result.outputTokens);
      totalCost += cost; totalIn += result.inputTokens; totalOut += result.outputTokens;
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
        break;
      }

      messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });

      for (const tc of msg.tool_calls) {
        let toolArgs: Record<string, any>;
        try {
          toolArgs = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
        } catch { toolArgs = {}; }

        const toolCall: ToolCall = { name: tc.function.name, arguments: toolArgs };
        const guard = guardToolCall(tc.function.name, toolArgs, !!workspacePath);
        if (!guard.allowed) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: `拦截: ${guard.reason}` });
          guardState.consecutiveErrorCount++;
          continue;
        }
        if (guard.repairedArgs) { toolCall.arguments = guard.repairedArgs; toolArgs = guard.repairedArgs; }

        guardState.recentCallSignatures.push(toolCallSignature(tc.function.name, toolArgs));
        if (guardState.recentCallSignatures.length > 10) guardState.recentCallSignatures = guardState.recentCallSignatures.slice(-10);

        if (tc.function.name === 'todo_write' || tc.function.name === 'todo_read') toolArgs._agentId = agentId;

        // task_complete
        if (tc.function.name === 'task_complete') {
          completed = true; guardState.taskCompleted = true;
          sendToUI(win, 'agent:log', { projectId, agentId, content: `✅ task_complete: ${toolArgs.summary || '完成'}` });
          addLog(projectId, agentId, 'output', `Completed: ${toolArgs.summary || '完成'}`);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: `任务已完成: ${toolArgs.summary}` });
          continue;
        }

        // report_blocked
        if (tc.function.name === 'report_blocked') {
          blocked = true;
          blockReason = toolArgs.reason || '未说明原因';
          blockSuggestions = toolArgs.suggestions || [];
          sendToUI(win, 'agent:log', { projectId, agentId, content: `🚫 BLOCKED: ${blockReason}\n建议: ${blockSuggestions.join(' / ')}` });
          addLog(projectId, agentId, 'warning', `BLOCKED: ${blockReason}`);
          sendToUI(win, 'agent:blocked', { projectId, agentId, reason: blockReason, suggestions: blockSuggestions });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: '已报告阻塞，等待用户回应。' });
          continue;
        }

        // 执行工具
        const isAsync = ['web_search', 'fetch_url', 'http_request', 'analyze_image', 'compare_screenshots', 'visual_assert'].includes(tc.function.name)
          || tc.function.name.startsWith('github_') || tc.function.name.startsWith('browser_')
          || tc.function.name.startsWith('mcp_') || tc.function.name.startsWith('skill_');

        const toolResult: ToolResult = isAsync
          ? await executeToolAsync(toolCall, toolCtx)
          : executeTool(toolCall, toolCtx);

        const argsSummary = tc.function.name === 'write_file'
          ? `path=${toolArgs.path}, ${Buffer.byteLength(toolArgs.content || '', 'utf-8')}B`
          : JSON.stringify(toolArgs).slice(0, 120);
        sendToUI(win, 'agent:log', {
          projectId, agentId,
          content: `🔧 ${tc.function.name}(${argsSummary}) → ${toolResult.success ? '✅' : '❌'} ${toolResult.output.slice(0, 100)}`,
        });
        emitEvent({ projectId, agentId, type: 'tool:call', data: { tool: tc.function.name, success: toolResult.success } });

        if ((tc.function.name === 'write_file' || tc.function.name === 'edit_file') && toolResult.success) {
          filesWritten.add(toolArgs.path);
          sendToUI(win, 'workspace:changed', { projectId });
        }

        messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult.output.slice(0, 4000) });
      }

      const toolCallsThisIter = (msg.tool_calls || []).map((tc: any) => tc.function.name);
      if (hasToolSideEffect(toolCallsThisIter)) guardState.consecutiveIdleCount = 0;
      else guardState.consecutiveIdleCount++;
      guardState.consecutiveErrorCount = 0;

      if (completed || blocked) {
        sendToUI(win, 'agent:log', {
          projectId, agentId,
          content: `🔚 ReAct 结束 (${iter} 轮, $${totalCost.toFixed(4)})${blocked ? ' [BLOCKED]' : ''}`,
        });
        break;
      }

      if (messages.length > 20) await compressMessageHistorySmart(messages, settings, signal);

    } catch (err: any) {
      if (signal.aborted) break;
      // v5.6: 不可重试错误立即终止
      if (err instanceof NonRetryableError) {
        sendToUI(win, 'agent:log', { projectId, agentId, content: `🛑 不可重试错误 (${err.statusCode}): ${err.message}` });
        addLog(projectId, agentId, 'error', `NonRetryable: ${err.message}`);
        break;
      }
      guardState.consecutiveErrorCount++;
      sendToUI(win, 'agent:log', { projectId, agentId, content: `⚠️ 迭代 ${iter} 错误: ${err.message}` });
      addLog(projectId, agentId, 'error', `iter ${iter}: ${err.message}`);
      await sleep(2000);
    }
  }

  // ── v8.0: 对话备份 ──
  backupConversation({
    projectId,
    agentId,
    agentRole: role,
    messages: messages.map(m => ({
      role: m.role as any,
      content: m.content,
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id,
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
    completed, blocked,
    blockReason: blocked ? blockReason : undefined,
    blockSuggestions: blocked ? blockSuggestions : undefined,
    finalText,
    filesWritten: [...filesWritten],
    totalCost, totalInputTokens: totalIn, totalOutputTokens: totalOut,
    iterations: guardState.iteration,
  };
}
