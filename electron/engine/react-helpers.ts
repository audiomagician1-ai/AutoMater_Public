/**
 * ReAct Helpers — Token 估算 + 终止总结生成
 *
 * 从 react-loop.ts 拆出 (v30.2)
 */

import { BrowserWindow } from 'electron';
import { callLLM, calcCost } from './llm-client';
import { sendToUI, addLog } from './ui-bridge';
import { updateAgentStats } from './agent-manager';
import { resolveModel, selectModelTier } from './model-selector';
import { recordProgress } from './scratchpad';
import { createLogger } from './logger';
import type { AppSettings, LLMMessage } from './types';
import type { MessageTokenBreakdown } from './react-state';

const log = createLogger('react-helpers');

// ═══════════════════════════════════════
// Token Estimation Utilities
// ═══════════════════════════════════════

export function estimateMsgTokens(content: string | null | unknown): number {
  if (!content) return 0;
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return Math.ceil(text.length / 1.5);
}

export function computeMessageBreakdown(messages: LLMMessage[]): { breakdown: MessageTokenBreakdown[]; total: number } {
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

export interface TerminationSummaryConfig {
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
export async function generateTerminationSummary(config: TerminationSummaryConfig): Promise<string> {
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
