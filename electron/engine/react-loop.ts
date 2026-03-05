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
import { callLLM, callLLMWithTools, calcCost, sleep, NonRetryableError, type ContentChunkCallback } from './llm-client';
import { sendToUI, addLog, createStreamCallback } from './ui-bridge';
import {
  updateAgentStats,
  checkBudget,
  getTeamPrompt,
  getTeamMemberLLMConfig,
  getTeamMemberMaxIterations,
} from './agent-manager';
import type { AppSettings, EnrichedFeature, LLMMessage, LLMToolCall } from './types';
import { collectDeveloperContext, loadKnownIssues, type ContextSnapshot } from './context-collector';
import {
  getToolsForRole,
  executeTool,
  executeToolAsync,
  isAsyncTool,
  type ToolContext,
  type ToolCall,
  type ToolResult,
} from './tool-system';
import { safeJsonParse } from './safe-json';
import { parsePlanFromLLM, getPlanSummary, type FeaturePlan } from './planner';
import { DEVELOPER_REACT_PROMPT, getCategoryGuidance, withContextDiscipline } from './prompts';
import { parseFileBlocks, writeFileBlocks } from './file-writer';
import {
  guardToolCall,
  checkReactTermination,
  toolCallSignature,
  hasToolSideEffect,
  checkVerificationGate,
  checkSemanticLoop,
  DEFAULT_REACT_CONFIG,
  type ReactState as GuardReactState,
  // v10.1: Budget Tracker + Stuck Detector
  computeBudgetNudge,
  type BudgetTrackerState,
  createStuckDetectorState,
  recordToolCalls as recordStuckToolCalls,
  detectStuckPattern,
} from './guards';
import { selectModelTier, resolveModel, estimateFeatureComplexity, type TaskComplexity } from './model-selector';
import { selectTools, detectProjectProfile, type TaskContext as ToolTaskContext } from './adaptive-tool-selector';
import { runResearcher } from './sub-agent';
import { buildCodeGraph, graphSummary } from './code-graph';
import { readRecentDecisions, formatDecisionsForContext, appendSharedDecision } from './memory-system';
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
  recordErrorResolved,
  buildScratchpadAnchor,
  maskOldToolOutputs,
  recordProgress,
  extractExperience,
  getOtherWorkersChanges,
} from './scratchpad';
import { getProjectExperienceContext, retrieveErrorExperience } from './experience-library';
import { compressSubAgentResult } from './sub-agent-compressor';
import { harvestPostSession } from './experience-harvester';
import { summarizeToolResult } from './tool-result-summarizer';
import { buildExecutionPlan, type ToolCallInfo } from './parallel-tools';
import { createLearningState, recordFailure, injectLessons, type LearningState } from './iteration-learning';
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
  /** v18.0: 终止原因 (null = task_complete 正常完成) */
  terminationReason?: string;
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
  agentReactStateCache.get(projectId)?.set(state.agentId, state);
}

// ═══════════════════════════════════════
// Context Snapshot Cache
// ═══════════════════════════════════════

const contextSnapshotCache = new Map<string, Map<string, ContextSnapshot>>();

export function getContextSnapshots(projectId: string): Map<string, ContextSnapshot> {
  return contextSnapshotCache.get(projectId) ?? new Map();
}

export function cacheContextSnapshot(projectId: string, snapshot: ContextSnapshot) {
  if (!contextSnapshotCache.has(projectId)) {
    contextSnapshotCache.set(projectId, new Map());
  }
  contextSnapshotCache.get(projectId)?.set(snapshot.agentId, snapshot);
}

// ═══════════════════════════════════════
// Token Estimation Utilities
// ═══════════════════════════════════════

function estimateMsgTokens(content: string | null | unknown): number {
  if (!content) return 0;
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return Math.ceil(text.length / 1.5);
}

function computeMessageBreakdown(messages: LLMMessage[]): { breakdown: MessageTokenBreakdown[]; total: number } {
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
    role: role as MessageTokenBreakdown['role'],
    tokens: v.tokens,
    count: v.count,
  }));
  return { breakdown, total };
}

// ═══════════════════════════════════════
// Termination Summary — 达到上限时生成最终总结
// ═══════════════════════════════════════

const TERMINATION_SUMMARY_PROMPT = `你是一个项目管理助手。当前 Agent 的工作因为达到资源上限而被终止。
请根据对话历史，生成一份精炼的终止总结报告，包含以下 4 个部分：

## 已完成的工作
列出已经完成的具体任务和修改过的文件。

## 当前进度
当前正在进行的工作处于什么状态，做到了哪一步。

## 未完成事项
列出尚未完成的任务，以及每个任务的阻塞原因或剩余工作量。

## 继续建议
如果要继续完成这些工作，建议从哪里开始，需要注意什么。

请保持简洁（不超过 800 字），使用中文，重点是帮助下一次执行能快速接续。`;

interface TerminationSummaryConfig {
  projectId: string;
  agentId: string;
  role: string;
  terminationReason: string;
  iterations: number;
  totalCost: number;
  totalIn: number;
  totalOut: number;
  filesWritten: Set<string> | string[];
  messages: LLMMessage[];
  settings: AppSettings;
  model: string;
  signal: AbortSignal;
  win: BrowserWindow | null;
  workspacePath: string | null;
  featureId?: string;
}

/**
 * v24.0: 生成终止总结 — 当 Agent 因达到迭代上限/Token 上限/成本上限等原因
 * 非正常终止时，额外调用一次 LLM 生成结构化的工作总结，写入 scratchpad
 * 供下次继续使用，并通过 UI 事件通知用户。
 */
async function generateTerminationSummary(config: TerminationSummaryConfig): Promise<string> {
  const {
    projectId,
    agentId,
    role,
    terminationReason,
    iterations,
    totalCost,
    totalIn,
    totalOut,
    filesWritten,
    messages,
    settings,
    model,
    signal,
    win,
    workspacePath,
    featureId,
  } = config;

  // 已中断 / 正常完成 → 不需要总结
  if (signal.aborted) return '';

  const filesList = Array.isArray(filesWritten) ? filesWritten : [...filesWritten];

  // 构造精简的历史上下文 — 只取 system prompt + 最近 20 条消息，控制 token 消耗
  const recentMessages = messages.length > 21 ? [messages[0], ...messages.slice(-20)] : [...messages];

  // 在末尾注入总结请求
  const summaryMessages: LLMMessage[] = [
    ...recentMessages,
    {
      role: 'user',
      content: [
        `⚠️ **Agent 已被终止** — 原因: ${terminationReason}`,
        `- 已执行 ${iterations} 轮迭代`,
        `- 消耗 ${totalIn + totalOut} tokens, 成本 $${totalCost.toFixed(4)}`,
        `- 已修改文件: ${filesList.length > 0 ? filesList.join(', ') : '无'}`,
        '',
        TERMINATION_SUMMARY_PROMPT,
      ].join('\n'),
    },
  ];

  try {
    sendToUI(win, 'agent:log', {
      projectId,
      agentId,
      content: `📝 正在生成终止总结 (${terminationReason})...`,
    });

    // 使用 mini 模型生成总结，限制 maxTokens 控制成本
    const summaryModel = resolveModel('mini', settings);
    const result = await callLLM(
      settings,
      summaryModel,
      summaryMessages as Array<{ role: string; content: string | Array<Record<string, unknown>> }>,
      signal,
      2048, // maxTokens — 总结不需要太长
      1, // retries — 只重试 1 次
      undefined,
      30000, // timeoutMs — 30 秒超时
    );

    const summaryText = result.content || '';
    if (!summaryText.trim()) return '';

    const summaryCost = calcCost(summaryModel, result.inputTokens, result.outputTokens);
    updateAgentStats(agentId, projectId, result.inputTokens, result.outputTokens, summaryCost);

    // 构造完整的总结文本
    const fullSummary = [
      `## 🛑 终止总结 (${terminationReason})`,
      `> Agent: ${agentId} | 角色: ${role}${featureId ? ` | Feature: ${featureId}` : ''}`,
      `> 迭代: ${iterations} | 成本: $${(totalCost + summaryCost).toFixed(4)} | 文件: ${filesList.length}`,
      '',
      summaryText,
    ].join('\n');

    // 写入 scratchpad — 供下次 agent 恢复使用
    if (workspacePath) {
      recordProgress(workspacePath, agentId, `[终止总结] ${terminationReason}: ${summaryText.slice(0, 300)}`);
    }

    // 通过 UI 事件通知用户
    sendToUI(win, 'agent:log', {
      projectId,
      agentId,
      content: `📋 终止总结:\n${summaryText.slice(0, 500)}${summaryText.length > 500 ? '...' : ''}`,
    });

    // 写入持久化日志
    addLog(projectId, agentId, 'output', `[终止总结] ${terminationReason}\n${summaryText}`);

    // 推送 work message 到 UI
    sendToUI(win, 'agent:work-message', {
      projectId,
      agentId,
      message: {
        id: `summary-${Date.now()}`,
        type: 'output',
        content: fullSummary,
        timestamp: Date.now(),
      },
    });

    return fullSummary;
  } catch (err: unknown) {
    // 总结生成失败不应影响主流程
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to generate termination summary: ${errMsg}`);
    sendToUI(win, 'agent:log', {
      projectId,
      agentId,
      content: `⚠️ 终止总结生成失败: ${errMsg}`,
    });
    return '';
  }
}

// ═══════════════════════════════════════
// ReAct Developer Loop
// ═══════════════════════════════════════

export async function reactDeveloperLoop(
  projectId: string,
  workerId: string,
  settings: AppSettings,
  win: BrowserWindow | null,
  signal: AbortSignal,
  workspacePath: string | null,
  gitConfig: GitProviderConfig,
  feature: EnrichedFeature,
  qaFeedback: string,
  permissions?: import('./tool-registry').AgentPermissions,
): Promise<ReactResult> {
  const db = getDb();
  // v18.0: 成员级 maxIterations 优先 → 系统默认 25
  const memberMaxIter = getTeamMemberMaxIterations(
    projectId,
    'developer',
    parseInt(workerId.replace('dev-', ''), 10) - 1 || 0,
  );
  const MAX_ITERATIONS = memberMaxIter ?? 50;

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
    // v20.0: 新增验证追踪
    hasRunVerification: false,
    hasWrittenFiles: false,
    consecutivePlainTextCount: 0,
    semanticFailures: new Map(),
  };

  // v18.0: 迭代间学习
  const learningState: LearningState = createLearningState();

  // v10.1: Budget Tracker + Stuck Detector (developer loop)
  const devStuckState = createStuckDetectorState();
  const devBudgetTracker: BudgetTrackerState = {
    iteration: 0,
    maxIterations: MAX_ITERATIONS,
    totalTokens: 0,
    maxTokens: DEFAULT_REACT_CONFIG.maxTotalTokens,
    totalCost: 0,
    maxCost: DEFAULT_REACT_CONFIG.maxCostUsd,
    hasWrittenFiles: false,
    hasRunVerification: false,
    role: 'developer',
  };

  // v11.0: 从 workerId 提取 worker 索引 (用于成员级配置)
  const workerIndex = parseInt(workerId.replace('dev-', ''), 10) - 1 || 0;

  // ── v1.3: Dynamic Model Selection ──
  const featureComplexity = estimateFeatureComplexity(feature);
  let depCount = 0;
  try {
    depCount = JSON.parse(feature.depends_on || '[]').length;
  } catch (err) {
    log.debug('depends_on parse failed', { featureId: feature.id, error: String(err) });
  }
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
    projectId,
    agentId: workerId,
    content: memberHasModel
      ? `🤖 ${feature.id} 成员模型: ${model} (独立配置)`
      : `🤖 ${feature.id} 模型选择: ${model} (${modelSelection.tier}) — ${modelSelection.reason}`,
  });

  const allTools = getToolsForRole('developer', gitConfig.mode);

  // v20.0: 自适应工具选择 — 根据项目 profile 和任务类型动态裁剪工具列表
  let tools = allTools;
  const toolTaskContext: ToolTaskContext = {
    phase: 'coding',
    description: `${feature.title} ${feature.description}`,
    iteration: 0,
    recentTools: [],
    failedTools: [],
  };
  try {
    if (workspacePath) {
      const fs = await import('fs');
      const fileList = fs.readdirSync(workspacePath, { recursive: true }) as string[];
      const projectProfile = detectProjectProfile(fileList.map(String).slice(0, 500));
      projectProfile.needsWebSearch = /api|http|外部|third.?party|接口|调研/.test(
        `${feature.title} ${feature.description}`.toLowerCase(),
      );
      const selection = selectTools(allTools, projectProfile, toolTaskContext);
      tools = selection.tools;
      if (selection.removed.length > 0) {
        sendToUI(win, 'agent:log', {
          projectId,
          agentId: workerId,
          content: `🔧 ${feature.id} 自适应工具选择: ${selection.tools.length}/${allTools.length} 工具 (移除: ${selection.removed.slice(0, 5).join(', ')}${selection.removed.length > 5 ? '...' : ''})`,
        });
      }
    }
  } catch (err) {
    log.debug('Adaptive tool selection failed, using full toolset', { error: String(err) });
    tools = allTools;
  }

  const toolCtx: ToolContext = {
    workspacePath: workspacePath || '',
    projectId,
    gitConfig,
    workerId,
    featureId: feature.id,
    permissions,
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
      const result = await callLLM(settings, visionModel, messages, signal, 4096);
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
    projectId,
    agentId: workerId,
    content: `📋 ${feature.id} 使用内嵌规划 (ReAct think 步骤自行细化)`,
  });

  // ── Code Graph ──
  if (workspacePath) {
    try {
      const graph = await buildCodeGraph(workspacePath, 300);
      const summary = graphSummary(graph);
      sendToUI(win, 'agent:log', {
        projectId,
        agentId: workerId,
        content: `📊 ${feature.id} ${summary}`,
      });
    } catch (_err) {
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
  } catch (err) {
    log.debug('Skill context load failed', { error: String(err) });
  }

  // v7.0: Known Issues — inject tech-debt warnings from import probes
  let knownIssuesText = '';
  if (workspacePath) {
    const issues = loadKnownIssues(workspacePath);
    if (issues) {
      // Truncate to max ~2000 chars to not overwhelm context
      const maxLen = 2000;
      const trimmed =
        issues.length > maxLen
          ? issues.slice(0, maxLen) + '\n... [更多问题见 .automater/docs/KNOWN-ISSUES.md]'
          : issues;
      knownIssuesText = `## ⚠️ 已知技术问题 (导入分析发现)\n${trimmed}`;
    }
  }

  // v22.0: 分层经验库注入 — principles 全量 + patterns 按 domain 过滤
  let experienceText = '';
  if (workspacePath) {
    try {
      const domains = inferDomainsFromFeature(feature);
      experienceText = getProjectExperienceContext(workspacePath, domains, 2000);
    } catch (err) {
      log.debug('Experience library load failed', { error: String(err) });
    }
  }

  // v25.0 D5: QA 驳回时主动检索相关错误经验
  let errorExperienceText = '';
  if (qaFeedback && workspacePath) {
    try {
      const domains = inferDomainsFromFeature(feature);
      errorExperienceText = retrieveErrorExperience(workspacePath, qaFeedback, domains, 1500);
    } catch (err) {
      log.debug('Error experience retrieval failed', { error: String(err) });
    }
  }

  // v4.0: 从 team_members 读取自定义 prompt, fallback 到内置 prompt
  const baseDevPrompt = getTeamPrompt(projectId, 'developer', workerIndex) ?? DEVELOPER_REACT_PROMPT;
  // v20.0: 按 feature category 注入特定指导
  const categoryGuidance = getCategoryGuidance(feature.category || '');
  // v10.2: 全局上下文管理纪律
  const devSystemPrompt = withContextDiscipline(categoryGuidance ? baseDevPrompt + categoryGuidance : baseDevPrompt);

  const messages: LLMMessage[] = [
    { role: 'system', content: devSystemPrompt },
    {
      role: 'user',
      content: `## 任务\nFeature: ${feature.id}\n标题: ${feature.title}\n描述: ${feature.description}\n验收标准: ${feature.acceptance_criteria}\n${qaFeedback ? `\n## QA 审查反馈（必须修复）\n${qaFeedback}` : ''}${errorExperienceText ? `\n\n${errorExperienceText}` : ''}${feature._docContext ? `\n\n## 需求与测试文档\n${feature._docContext}` : ''}${feature._tddContext ? `\n\n${feature._tddContext}` : ''}${feature._conflictWarning ? `\n\n## ⚠️ 文件冲突警告\n${feature._conflictWarning}` : ''}${feature._teamContext ? `\n\n${feature._teamContext}` : ''}\n\n${planText}\n\n${sharedDecisionsText ? sharedDecisionsText + '\n\n' : ''}${skillContextText ? skillContextText + '\n\n' : ''}${experienceText ? experienceText + '\n\n' : ''}${knownIssuesText ? knownIssuesText + '\n\n' : ''}## 项目上下文\n${initialContext.contextText}`,
    },
  ];

  sendToUI(win, 'agent:log', {
    projectId,
    agentId: workerId,
    content: `🔄 ${feature.id} 开始 ReAct 工具循环 (最多 ${MAX_ITERATIONS} 轮)`,
  });

  let terminationReason: string | undefined;

  const reactState: AgentReactState = {
    agentId: workerId,
    featureId: feature.id,
    iterations: [],
    maxContextWindow: 256000,
  };

  for (let iter = 1; iter <= MAX_ITERATIONS && !signal.aborted; iter++) {
    // v3.0: 程序化终止检查 (每轮迭代前)
    guardState.iteration = iter;

    // v20.0: 阶段感知工具过滤 — 根据当前迭代动态调整工具列表
    if (iter <= 3) {
      toolTaskContext.phase = 'planning'; // 前3轮: 理解+规划
    } else if (iter >= MAX_ITERATIONS - 3) {
      toolTaskContext.phase = 'testing'; // 最后3轮: 验证
    } else {
      toolTaskContext.phase = 'coding'; // 中间: 编码
    }
    toolTaskContext.iteration = iter;
    toolTaskContext.recentTools = guardState.recentCallSignatures.slice(-5).map(s => s.split(':')[0]);
    toolTaskContext.failedTools = learningState.failures.slice(-5).map(f => f.toolName);

    const termCheck = checkReactTermination(guardState, DEFAULT_REACT_CONFIG, signal.aborted);
    if (!termCheck.shouldContinue) {
      terminationReason = termCheck.reason;
      sendToUI(win, 'agent:log', {
        projectId,
        agentId: workerId,
        content: `🛑 ${feature.id} 程序化终止: ${termCheck.reason} — ${termCheck.message}`,
      });
      if (termCheck.reason !== 'task_complete') {
        addLog(
          projectId,
          workerId,
          'warning',
          `[${feature.id}] Terminated: ${termCheck.reason} — ${termCheck.message}`,
        );
      }
      break;
    }

    const budget = checkBudget(projectId, settings);
    if (!budget.ok) {
      terminationReason = 'budget_exceeded';
      break;
    }

    try {
      // v18.0: 注入从失败中学到的教训
      injectLessons(messages, learningState);

      // v10.1: Budget Tracker — developer 进度感知
      devBudgetTracker.iteration = iter;
      devBudgetTracker.totalTokens = totalIn + totalOut;
      devBudgetTracker.totalCost = totalCost;
      devBudgetTracker.hasWrittenFiles = guardState.hasWrittenFiles;
      devBudgetTracker.hasRunVerification = guardState.hasRunVerification;

      const devNudge = computeBudgetNudge(devBudgetTracker);
      if (devNudge.shouldInject) {
        messages.push({ role: 'user', content: devNudge.message });
        if (devNudge.phase === 'urgent' || devNudge.phase === 'final') {
          sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: devNudge.message });
        }
      }

      // v10.1: Stuck Detector — developer 行为模式检测
      devStuckState.plainTextStreak = guardState.consecutivePlainTextCount;
      const devStuck = detectStuckPattern(devStuckState, devBudgetTracker);
      if (devStuck.isStuck) {
        messages.push({ role: 'user', content: devStuck.correctionMessage });
        sendToUI(win, 'agent:log', {
          projectId,
          agentId: workerId,
          content: `🔍 Stuck [${devStuck.pattern}]: ${devStuck.correctionMessage.slice(0, 120)}`,
        });
      }

      // v26.0: 流式推送思维链 — 创建 stream callback 将 content/reasoning 实时推送到前端
      sendToUI(win, 'agent:stream-start', { agentId: workerId, label: `${feature.id} [${iter}] 思考中` });
      let streamedReasoning = '';
      const onContentChunk: ContentChunkCallback = (chunk, type) => {
        if (type === 'reasoning') {
          streamedReasoning += chunk;
          sendToUI(win, 'agent:stream', { agentId: workerId, chunk });
        } else {
          sendToUI(win, 'agent:stream', { agentId: workerId, chunk });
        }
      };

      const result = await callLLMWithTools(settings, model, messages, tools, signal, 16384, onContentChunk);
      sendToUI(win, 'agent:stream-end', { agentId: workerId });

      const cost = calcCost(model, result.inputTokens, result.outputTokens);
      totalCost += cost;
      totalIn += result.inputTokens;
      totalOut += result.outputTokens;
      updateAgentStats(workerId, projectId, result.inputTokens, result.outputTokens, cost);

      // v3.0: 更新 guard 状态
      guardState.totalTokens = totalIn + totalOut;
      guardState.totalCost = totalCost;

      const msg = result.message;

      // v26.0: 推送完整思维链 + reasoning 到工作消息
      const fullThinking = result.reasoning || msg.content || '';
      if (fullThinking) {
        sendToUI(win, 'agent:log', {
          projectId,
          agentId: workerId,
          content: `💭 ${feature.id} [${iter}] ${fullThinking.length > 200 ? fullThinking.slice(0, 200) + '...' : fullThinking}`,
        });
        // 推送完整思维链作为工作消息
        sendToUI(win, 'agent:work-message', {
          projectId,
          agentId: workerId,
          message: {
            id: `think-${iter}-${Date.now()}`,
            type: 'think',
            content: msg.content || '',
            reasoning: result.reasoning || undefined,
            timestamp: Date.now(),
            iteration: iter,
            featureId: feature.id,
          },
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
              projectId,
              agentId: workerId,
              content: `📁 ${feature.id} [兼容模式] 写入 ${written.length} 文件`,
            });
            sendToUI(win, 'workspace:changed', { projectId });
          }
          if (msg.content.toUpperCase().includes('COMPLETED')) {
            completed = true;
          }
        }

        // v20.0: 纯文本回复容忍 — 不立即 break，注入修复消息后继续循环
        guardState.consecutivePlainTextCount++;
        if (!completed && guardState.consecutivePlainTextCount < 3) {
          sendToUI(win, 'agent:log', {
            projectId,
            agentId: workerId,
            content: `⚠️ ${feature.id} 纯文本回复 (${guardState.consecutivePlainTextCount}/3)，注入工具使用提示`,
          });
          messages.push({
            role: 'assistant',
            content: msg.content,
          });
          messages.push({
            role: 'user',
            content:
              '你需要使用工具来完成任务。请调用合适的工具（如 search_files 定位代码、read_file(offset,limit) 精读、edit_file 精确修改、run_command 验证等）。如果任务已全部完成，请调用 task_complete 工具。不要只输出文本，必须使用工具。',
          });
          continue;
        }

        sendToUI(win, 'agent:log', {
          projectId,
          agentId: workerId,
          content: `🔚 ${feature.id} ReAct 循环结束 (${iter} 轮, ${totalIn + totalOut} tokens, $${totalCost.toFixed(4)})`,
        });
        terminationReason = 'consecutive_plain_text';
        break;
      }

      // v20.0: 有 tool_calls 时重置纯文本计数
      guardState.consecutivePlainTextCount = 0;

      // ── 执行 tool calls ──
      messages.push({
        role: 'assistant',
        content: msg.content,
        tool_calls: msg.tool_calls,
      });

      for (const tc of msg.tool_calls) {
        let toolArgs: Record<string, any>; // accepted: JSON.parse result fed to tool executor
        try {
          toolArgs =
            typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
        } catch (_err) {
          log.warn('Failed to parse tool arguments as JSON, using empty object', { tool: tc.function.name });
          toolArgs = {};
        }

        const toolCall: ToolCall = { name: tc.function.name, arguments: toolArgs };

        // v3.0: 程序化参数校验 + 速率限制
        const guard = guardToolCall(tc.function.name, toolArgs, !!workspacePath);
        if (!guard.allowed) {
          sendToUI(win, 'agent:log', {
            projectId,
            agentId: workerId,
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

        if (
          tc.function.name === 'todo_write' ||
          tc.function.name === 'todo_read' ||
          tc.function.name === 'scratchpad_write' ||
          tc.function.name === 'scratchpad_read'
        ) {
          toolArgs._agentId = workerId;
        }

        // ── task_complete ──
        if (tc.function.name === 'task_complete') {
          // v20.0: 验证门控 — 写过文件但没验证过 → 拦截并提示
          const vGate = checkVerificationGate(guardState);
          if (!vGate.allowed) {
            sendToUI(win, 'agent:log', {
              projectId,
              agentId: workerId,
              content: `🚧 ${feature.id} task_complete 被验证门控拦截: 尚未执行验证命令`,
            });
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: vGate.message || '请先验证代码再完成任务。',
            });
            continue;
          }

          completed = true;
          guardState.taskCompleted = true;
          const summary = toolArgs.summary || '完成';
          const changedFiles = toolArgs.files_changed || [...filesWritten];

          sendToUI(win, 'agent:log', {
            projectId,
            agentId: workerId,
            content: `✅ ${feature.id} task_complete: ${summary}`,
          });
          addLog(
            projectId,
            workerId,
            'output',
            `[${feature.id}] Completed: ${summary}\nFiles: ${changedFiles.join(', ')}`,
          );

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `任务已标记完成: ${summary}`,
          });
          continue;
        }

        // 执行工具
        let toolResult: ToolResult;
        const isAsync = isAsyncTool(tc.function.name);

        // ── spawn_researcher 子 Agent ──
        if (tc.function.name === 'spawn_researcher') {
          sendToUI(win, 'agent:log', {
            projectId,
            agentId: workerId,
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
              projectId,
              agentId: workerId,
              content: `🔬 ${feature.id} 研究子 Agent 完成 (读取 ${researchResult.filesRead.length} 文件, $${resCost.toFixed(4)})`,
            });

            // v19.0: 压缩研究子 Agent 结果 — 只返回精华给父 Agent
            toolResult = {
              success: researchResult.success,
              output: compressSubAgentResult(
                {
                  success: researchResult.success,
                  conclusion: researchResult.conclusion,
                  filesRead: researchResult.filesRead,
                },
                {
                  maxChars: 2500,
                  role: '研究员',
                  originalTask: toolArgs.question,
                },
              ),
              action: 'read',
            };
          } catch (resErr: unknown) {
            const resErrMsg = resErr instanceof Error ? resErr.message : String(resErr);
            toolResult = { success: false, output: `研究子 Agent 失败: ${resErrMsg}`, action: 'read' };
          }
        } else if (isAsync) {
          toolResult = await executeToolAsync(toolCall, toolCtx);
        } else {
          toolResult = executeTool(toolCall, toolCtx);
        }

        // v8.0: 工具调用智能重试 — 对可重试工具的网络/超时错误自动重试一次
        if (!toolResult.success && isRetryableTool(tc.function.name) && isRetryableError(toolResult.output || '')) {
          log.info(`[${workerId}] Auto-retrying ${tc.function.name} after transient error`);
          await sleep(1500);
          if (isAsync) {
            toolResult = await executeToolAsync(toolCall, toolCtx);
          } else {
            toolResult = executeTool(toolCall, toolCtx);
          }
          if (toolResult.success) {
            sendToUI(win, 'agent:log', {
              projectId,
              agentId: workerId,
              content: `🔄 ${tc.function.name} 自动重试成功`,
            });
          }
        }

        // v18.0: 迭代间学习 — 记录失败并提取教训
        if (!toolResult.success) {
          const lesson = recordFailure(learningState, {
            toolName: tc.function.name,
            errorOutput: toolResult.output.slice(0, 500),
            arguments: toolArgs,
            timestamp: Date.now(),
          });
          if (lesson) {
            sendToUI(win, 'agent:log', {
              projectId,
              agentId: workerId,
              content: `📚 学到教训: ${lesson.description}`,
            });
          }
        }

        // 推送工具调用日志
        const argsSummary =
          tc.function.name === 'write_file'
            ? `path=${toolArgs.path}, ${Buffer.byteLength(toolArgs.content || '', 'utf-8')} bytes`
            : tc.function.name === 'edit_file'
              ? `path=${toolArgs.path}, replace ${(toolArgs.old_string || '').length}→${(toolArgs.new_string || '').length} chars`
              : JSON.stringify(toolArgs).slice(0, 150);

        // v26.0: 构建增强的工具调用数据 (含 diff / fullArgs / output)
        const enhancedToolData: Record<string, unknown> = {
          projectId,
          agentId: workerId,
          tool: tc.function.name,
          args: argsSummary,
          success: toolResult.success,
          outputPreview: toolResult.output.slice(0, 500), // 增大 preview 上限
          fullOutput: toolResult.output.slice(0, 5000),
          iteration: iter,
          featureId: feature.id,
        };

        // edit_file: 携带 diff 数据用于前端展示
        if (tc.function.name === 'edit_file') {
          enhancedToolData.diff = {
            path: toolArgs.path,
            oldString: (toolArgs.old_string || '').slice(0, 3000),
            newString: (toolArgs.new_string || '').slice(0, 3000),
            added: (toolArgs.new_string || '').split('\n').length,
            removed: (toolArgs.old_string || '').split('\n').length,
          };
        }
        // write_file: 携带文件内容摘要
        if (tc.function.name === 'write_file') {
          enhancedToolData.diff = {
            path: toolArgs.path,
            newString: (toolArgs.content || '').slice(0, 3000),
            added: (toolArgs.content || '').split('\n').length,
            removed: 0,
          };
        }
        // run_command / run_test / run_lint: 携带完整命令和输出
        if (['run_command', 'run_test', 'run_lint'].includes(tc.function.name)) {
          enhancedToolData.command = toolArgs.command || toolArgs.cmd || '';
          enhancedToolData.cwd = toolArgs.cwd || '';
        }
        // 完整参数 (search_files, read_file 等)
        enhancedToolData.fullArgs = JSON.stringify(toolArgs).slice(0, 2000);

        sendToUI(win, 'agent:tool-call', enhancedToolData);
        emitEvent({
          projectId,
          agentId: workerId,
          featureId: feature.id,
          type: 'tool:call',
          data: { tool: tc.function.name, args: argsSummary, success: toolResult.success },
        });
        // v20.0: 决策审计追踪 (P3-2) — 副作用工具调用自动记录 why/what/result
        if (hasToolSideEffect([tc.function.name]) && workspacePath) {
          const lastThought = msg.content ? msg.content.slice(0, 200) : '';
          emitEvent({
            projectId,
            agentId: workerId,
            featureId: feature.id,
            type: 'decision:point',
            data: {
              why: lastThought,
              what: `${tc.function.name}(${argsSummary})`,
              result: toolResult.success ? 'success' : `failed: ${toolResult.output.slice(0, 100)}`,
              iteration: iter,
            },
          });
        }
        sendToUI(win, 'agent:log', {
          projectId,
          agentId: workerId,
          content: `🔧 ${tc.function.name}(${argsSummary}) → ${toolResult.success ? '✅' : '❌'} ${toolResult.output.slice(0, 100)}`,
        });

        // 记录写入/编辑的文件
        if ((tc.function.name === 'write_file' || tc.function.name === 'edit_file') && toolResult.success) {
          filesWritten.add(toolArgs.path);
          guardState.hasWrittenFiles = true;
          sendToUI(win, 'workspace:changed', { projectId });
          if (workspacePath) {
            appendSharedDecision(workspacePath, {
              agentId: workerId,
              featureId: feature.id,
              type: tc.function.name === 'write_file' ? 'file_created' : 'other',
              description: `${tc.function.name} ${toolArgs.path}`,
            });
            // v19.0: Harness 自动收集文件变更到 scratchpad
            recordFileChange(
              workspacePath,
              workerId,
              toolArgs.path,
              tc.function.name === 'write_file' ? 'created' : 'modified',
            );
            // v20.0: 自动更新进度 (P2-3)
            recordProgress(
              workspacePath,
              workerId,
              `[迭代 ${iter}] ${tc.function.name === 'write_file' ? '创建' : '修改'} ${toolArgs.path}`,
            );
          }
        }

        // v19.0: Harness 自动收集工具错误/恢复到 scratchpad
        if (!toolResult.success && workspacePath) {
          recordToolError(workspacePath, workerId, tc.function.name, toolResult.output.slice(0, 300));
        }
        if (toolResult.success && workspacePath && learningState.failures.length > 0) {
          const lastFail = learningState.failures[learningState.failures.length - 1];
          if (lastFail && lastFail.toolName === tc.function.name) {
            recordErrorResolved(workspacePath, workerId, tc.function.name, `重试后成功`);
            // v20.0: 自动经验提取 (P2-1) — 错误修复时记录修复模式
            extractExperience(
              workspacePath,
              workerId,
              'error_fixed',
              `${tc.function.name} 错误 "${lastFail.errorOutput.slice(0, 100)}" 已通过重试修复`,
            );
          }
        }

        // v20.0: 追踪验证命令执行
        if (['run_command', 'run_test', 'run_lint'].includes(tc.function.name)) {
          guardState.hasRunVerification = true;
        }

        // v20.0: 语义死循环检测 — 同一工具+同一文件连续失败
        const targetFile = toolArgs.path || toolArgs.command || '';
        if (typeof targetFile === 'string' && targetFile) {
          const semLoop = checkSemanticLoop(guardState, tc.function.name, targetFile, toolResult.success);
          if (semLoop.detected && semLoop.escalation) {
            sendToUI(win, 'agent:log', {
              projectId,
              agentId: workerId,
              content: `🔴 ${feature.id} 语义死循环检测: ${tc.function.name} → ${targetFile}`,
            });
            // 注入强制策略升级指令到消息历史
            messages.push({
              role: 'user',
              content: semLoop.escalation,
            });
          }
        }

        // 将工具结果加入消息历史
        const toolResultAny = toolResult as ToolResult & { _imageBase64?: string };
        if (
          (tc.function.name === 'screenshot' || tc.function.name === 'browser_screenshot') &&
          toolResultAny._imageBase64
        ) {
          const base64 = toolResultAny._imageBase64;
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: [
              { type: 'text', text: toolResult.output },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
            ],
          });
        } else {
          // v18.0: 智能摘要 — 根据工具类型和 context 预算进行结构化摘要
          const summary = summarizeToolResult(tc.function.name, toolResult.output, {
            success: toolResult.success,
            budgetStatus: 'normal', // 下方压缩逻辑会二次处理
          });
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: summary.text,
          });
        }
      }

      // ═══ 推送 Agent ReAct 迭代状态 ═══
      const toolCallsThisIter = (msg.tool_calls || []).map((tc: LLMToolCall) => tc.function.name);

      // v10.1: Record tool calls for stuck detection (developer loop)
      recordStuckToolCalls(
        devStuckState,
        (msg.tool_calls || []).map((tc: LLMToolCall) => ({
          name: tc.function.name,
          argsSignature: toolCallSignature(
            tc.function.name,
            (() => {
              try {
                return JSON.parse(tc.function.arguments as string);
              } catch (err) {
                log.debug('Catch at react-loop.ts:1199', { error: String(err) });
                return {};
              }
            })(),
          ),
        })),
      );

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
          projectId,
          agentId: workerId,
          content: `🔚 ${feature.id} ReAct 完成 (${iter} 轮, ${totalIn + totalOut} tokens, $${totalCost.toFixed(4)})`,
        });
        break;
      }

      // ── v10.2 渐进式上下文压缩 (Proactive Compaction) ──
      // 不再等到 overflow 才压缩，而是基于 token 预算主动分级处理：
      //   ok (< 50%)      → 无操作
      //   warning (50-75%) → 仅 Observation Masking (轻量，不丢信息)
      //   critical (75-90%) → Masking + Tool 输出截断 + LLM 摘要压缩
      //   overflow (> 90%)  → 全面压缩 + 激进截断
      const budget = checkContextBudget(contextTokens, model);

      if (budget.status !== 'ok') {
        // Step 1: Observation Masking — 所有非 ok 状态都执行 (成本: 0, 纯字符串替换)
        const keepRecentCount = budget.status === 'overflow' ? 6 : budget.status === 'critical' ? 8 : 10;
        const maskResult = maskOldToolOutputs(messages, keepRecentCount);
        if (maskResult.maskedCount > 0) {
          log.info(
            `[${budget.status}] Observation masking: ${maskResult.maskedCount} outputs masked, ~${maskResult.estimatedTokensSaved} tokens saved`,
          );
        }

        // Step 2: 深度压缩 — 仅 critical/overflow 或消息数过多时执行
        if (budget.status === 'overflow' || budget.status === 'critical') {
          compressToolOutputs(messages, budget.status);
          await compressMessageHistorySmart(messages, settings, signal);
        } else if (messages.length > 25) {
          // warning + 消息数较多 → 轻度截断
          compressToolOutputs(messages, 'warning');
        }

        // Step 3: 注入 Scratchpad 锚点 — 确保关键信息存活于压缩
        if (workspacePath) {
          const anchor = buildScratchpadAnchor(workspacePath, workerId);
          if (anchor) {
            // 插在 system prompt 之后, 压缩摘要之后
            const insertIdx = Math.min(2, messages.length);
            messages.splice(insertIdx, 0, anchor);
          }
        }
      }

      // v20.0: 并行 Worker 信息共享 (P2-4) — 每 5 轮注入其他 Worker 的最新变更
      if (workspacePath && iter % 5 === 0 && iter > 1) {
        const otherChanges = getOtherWorkersChanges(workspacePath, workerId);
        if (otherChanges) {
          messages.push({
            role: 'user',
            content:
              otherChanges +
              '\n\n> 以上是其他并行 Worker 的最新变更，请注意避免冲突。如果你正在修改的文件被其他 Worker 修改过，请先用 search_files 定位变更区域，再用 read_file(offset, limit) 精读最新内容后再修改。',
          });
        }
      }
    } catch (err: unknown) {
      if (signal.aborted) break;
      // v5.6: 不可重试错误（模型不存在、API Key 无效等）→ 立即终止，不等 consecutive count
      if (err instanceof NonRetryableError) {
        sendToUI(win, 'agent:log', {
          projectId,
          agentId: workerId,
          content: `🛑 ${feature.id} 不可重试错误 (${err.statusCode}): ${err.message}`,
        });
        addLog(projectId, workerId, 'error', `[${feature.id}] NonRetryable: ${err.message}`);
        terminationReason = `non_retryable_error: ${err.message}`;
        break;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      guardState.consecutiveErrorCount++;
      // v8.0: 指数退避 (替代固定 sleep(2000))
      const backoffMs = getBackoffDelayMs(guardState.consecutiveErrorCount);
      sendToUI(win, 'agent:log', {
        projectId,
        agentId: workerId,
        content: `⚠️ ${feature.id} ReAct 迭代 ${iter} 错误 (第${guardState.consecutiveErrorCount}次): ${errMsg} — 等待 ${Math.round(backoffMs / 1000)}s`,
      });
      addLog(projectId, workerId, 'error', `[${feature.id}] iter ${iter}: ${errMsg}`);
      await sleep(backoffMs);
    }
  }

  // v24.0: 终止总结 — 非正常结束时生成最终总结
  // 补充: 如果 for 循环自然退出 (iter > MAX_ITERATIONS) 但 terminationReason 未设置
  if (!completed && !signal.aborted && !terminationReason) {
    terminationReason = 'max_iterations';
  }
  if (!completed && !signal.aborted && terminationReason) {
    await generateTerminationSummary({
      projectId,
      agentId: workerId,
      role: 'developer',
      terminationReason,
      iterations: reactState.iterations.length,
      totalCost,
      totalIn,
      totalOut,
      filesWritten,
      messages,
      settings,
      model,
      signal,
      win,
      workspacePath,
      featureId: feature.id,
    });
  }

  // 更新 feature 的 affected_files
  if (filesWritten.size > 0) {
    const existingFiles = safeJsonParse<string[]>(feature.affected_files || '[]', []) as string[];
    const allFiles = [...new Set([...existingFiles, ...filesWritten])];
    db.prepare('UPDATE features SET affected_files = ? WHERE id = ? AND project_id = ?').run(
      JSON.stringify(allFiles),
      feature.id,
      projectId,
    );

    // v20.0: 自动经验提取 (P2-1) — Feature 完成时记录使用的方案
    if (completed && workspacePath) {
      extractExperience(
        workspacePath,
        workerId,
        'feature_done',
        `${feature.id} "${feature.title}" 完成, 影响文件: ${[...filesWritten].join(', ')}`,
      );
    }
  }

  // ── v8.0: 对话备份 ──
  backupConversation({
    projectId,
    agentId: workerId,
    agentRole: 'developer',
    featureId: feature.id,
    messages: messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content ? JSON.stringify(m.content) : null,
      tool_calls: m.tool_calls,
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

  // ── D4: Post-session 反思 (fire-and-forget, 不阻塞返回) ──
  if (workspacePath) {
    harvestPostSession({
      projectId,
      agentId: workerId,
      role: 'developer',
      featureId: feature.id,
      featureTitle: feature.title || '',
      completed,
      iterations: reactState.iterations.length,
      filesWritten: [...filesWritten],
      workspacePath,
      settings,
      signal,
    }).catch(() => {}); // non-blocking
  }

  return {
    completed,
    filesWritten: [...filesWritten],
    totalCost,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    iterations: reactState.iterations.length,
    terminationReason,
  };
}

// ═══════════════════════════════════════
// Feature Domain Inference (for Experience Library)
// ═══════════════════════════════════════

/** 从 feature 的标题/描述/分类推断相关领域 */
function inferDomainsFromFeature(feature: EnrichedFeature): string[] {
  const text =
    `${feature.title || ''} ${feature.description || ''} ${feature.category || ''} ${feature.acceptance_criteria || ''}`.toLowerCase();
  const domains: string[] = [];
  if (/typescript|tsx?|type|interface/.test(text)) domains.push('typescript');
  if (/react|component|hook|state|jsx|页面|组件/.test(text)) domains.push('react');
  if (/css|style|tailwind|布局|样式/.test(text)) domains.push('css');
  if (/api|endpoint|fetch|request|接口/.test(text)) domains.push('api');
  if (/test|spec|assert|mock|测试/.test(text)) domains.push('testing');
  if (/git|commit|branch/.test(text)) domains.push('git');
  if (/security|auth|token|权限|认证/.test(text)) domains.push('security');
  if (/sql|database|migration|表|数据库/.test(text)) domains.push('database');
  if (/electron|ipc|preload/.test(text)) domains.push('electron');
  if (/deploy|build|ci|cd|部署/.test(text)) domains.push('deploy');
  if (domains.length === 0) domains.push('general');
  return domains;
}

// ═══════════════════════════════════════
// Message History Compression
// ═══════════════════════════════════════

/**
 * 找到安全的压缩分界点 — 确保不会把 assistant(tool_calls) 和对应的 tool(tool_result) 拆散。
 * 返回可以安全压缩的消息数量（从 messages[1] 开始计数）。
 */
function findSafeCompressBoundary(messages: LLMMessage[], keepRecent: number): number {
  let boundary = messages.length - keepRecent;
  // 向前扫描: 如果 boundary 切到了 assistant(tool_calls) 与 tool 之间，往前收缩
  // 确保 boundary 处不是 tool 消息（否则它的 assistant 在被压缩区域内但 tool 在保留区域）
  while (boundary > 1 && messages[boundary]?.role === 'tool') {
    boundary--;
  }
  // 同时确保 boundary 处不是带 tool_calls 的 assistant（否则 tool 结果在保留区但 assistant 被压缩）
  if (boundary > 1 && messages[boundary]?.role === 'assistant' && messages[boundary]?.tool_calls?.length) {
    // 这条 assistant 带 tool_calls，它后面的 tool 消息也应该一起保留
    boundary--;
  }
  return Math.max(1, boundary);
}

/**
 * 消息完整性修复 — 清理压缩后可能残留的孤儿 tool/tool_result 消息。
 * 确保每条 role=tool 的消息前面都有一条 assistant(tool_calls) 包含其 tool_call_id。
 */
function sanitizeToolPairs(messages: LLMMessage[]): void {
  // 收集所有 assistant 消息中声明的 tool_call ids
  const declaredIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls as Array<{ id: string }>) {
        declaredIds.add(tc.id);
      }
    }
  }
  // 移除孤立的 tool 消息（其 tool_call_id 没有对应的 assistant tool_use）
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool' && messages[i].tool_call_id) {
      if (!declaredIds.has(messages[i].tool_call_id as string)) {
        messages.splice(i, 1);
      }
    }
  }
  // 移除孤立的 assistant(tool_calls)：如果其 tool_call_id 没有对应的 tool 结果
  const existingToolIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id) existingToolIds.add(m.tool_call_id as string);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].tool_calls?.length) {
      const tcIds = (messages[i].tool_calls as Array<{ id: string }>).map(tc => tc.id);
      const hasAnyResult = tcIds.some(id => existingToolIds.has(id));
      if (!hasAnyResult) {
        // 这条 assistant 的所有 tool 结果都没了 → 退化为纯文本
        delete messages[i].tool_calls;
        if (!messages[i].content) messages[i].content = '[工具调用结果已压缩]';
      }
    }
  }
}

async function compressMessageHistorySmart(
  messages: LLMMessage[],
  settings: AppSettings,
  signal?: AbortSignal,
): Promise<void> {
  const keepRecent = 10;
  if (messages.length <= keepRecent + 2) return;

  const safeCount = findSafeCompressBoundary(messages, keepRecent);
  const compressRange = messages.slice(1, safeCount);
  if (compressRange.length < 5) return;

  const compressText = compressRange
    .map(m => {
      const role = m.role;
      const content = typeof m.content === 'string' ? m.content.slice(0, 300) : JSON.stringify(m.content).slice(0, 300);
      const toolInfo = m.tool_calls
        ? ` [tools: ${m.tool_calls.map((t: LLMToolCall) => t.function.name).join(',')}]`
        : '';
      return `[${role}]${toolInfo} ${content}`;
    })
    .join('\n');

  try {
    const summaryModel = resolveModel(selectModelTier({ type: 'summarize' }).tier, settings);
    const summaryResult = await callLLM(
      settings,
      summaryModel,
      [
        {
          role: 'system',
          content:
            '你是对话摘要助手。将以下 Agent 对话历史压缩为一段简洁摘要（200-400字），保留关键决策、已创建的文件、遇到的问题和解决方案。只输出摘要，不要其他内容。',
        },
        { role: 'user', content: `请摘要以下 ${compressRange.length} 条对话:\n\n${compressText.slice(0, 4000)}` },
      ],
      signal,
      1024,
      0,
    );

    if (summaryResult.content) {
      const summaryMsg: LLMMessage = {
        role: 'user',
        content: `## 之前的对话摘要 (${compressRange.length} 条消息已压缩)\n${summaryResult.content}`,
      };
      messages.splice(1, compressRange.length, summaryMsg);
      sanitizeToolPairs(messages);
      return;
    }
  } catch (err) {
    log.warn('LLM summarizer failed, falling back to simple truncation', { error: String(err) });
  }

  compressMessageHistorySimple(messages);
  sanitizeToolPairs(messages);
}

function compressMessageHistorySimple(messages: LLMMessage[]) {
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
