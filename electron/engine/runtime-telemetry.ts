/**
 * Runtime Telemetry — Agent 运行时遥测与可观测性 (v1.0)
 *
 * 提供 Agent 运行期间的细粒度观测数据:
 *   1. 工具调用链 — 每次工具调用的耗时、成功率、输入输出大小
 *   2. Agent 会话概览 — 每个 Agent 的聚合统计
 *   3. 成本追踪 — 按模型、按角色的 token 消耗 + 美元成本
 *   4. 瓶颈分析 — 自动识别最慢工具、最贵操作、失败率最高的工具
 *
 * 数据来源: 内存环形缓冲 (最近 2000 条) + event-store DB 查询
 * 设计: 零运行时开销，仅在查询时聚合
 */

import { createLogger } from './logger';

const log = createLogger('telemetry');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface ToolCallRecord {
  /** 唯一 ID */
  id: string;
  /** 所属项目 */
  projectId: string;
  /** 调用者 Agent */
  agentId: string;
  agentRole: string;
  /** 工具名 */
  toolName: string;
  /** 工具参数 (截断) */
  argsPreview: string;
  /** 开始时间 */
  startedAt: number;
  /** 耗时 ms */
  durationMs: number;
  /** 是否成功 */
  success: boolean;
  /** 输出预览 (截断) */
  outputPreview: string;
  /** 输出大小 (字符) */
  outputSize: number;
  /** 分类标签 */
  action: string;
}

export interface AgentSessionStats {
  agentId: string;
  agentRole: string;
  /** 总工具调用次数 */
  totalToolCalls: number;
  /** 成功率 */
  successRate: number;
  /** 总耗时 ms */
  totalDurationMs: number;
  /** 平均工具调用耗时 ms */
  avgToolDurationMs: number;
  /** 最慢工具调用 */
  slowestCall: { toolName: string; durationMs: number } | null;
  /** 调用最多的工具 */
  mostUsedTool: { toolName: string; count: number } | null;
  /** Token 使用 */
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  /** 当前迭代轮次 */
  currentIteration: number;
}

export interface CostBreakdown {
  /** 按模型统计 */
  byModel: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    callCount: number;
  }>;
  /** 按角色统计 */
  byRole: Array<{
    role: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
  /** 总计 */
  total: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
}

export interface BottleneckReport {
  /** 最慢工具 TOP 5 */
  slowestTools: Array<{
    toolName: string;
    avgDurationMs: number;
    maxDurationMs: number;
    callCount: number;
  }>;
  /** 失败率最高工具 TOP 5 */
  failingTools: Array<{
    toolName: string;
    failureRate: number;
    failCount: number;
    totalCount: number;
  }>;
  /** 最贵工具调用 TOP 5 (按输出大小 = token 消耗代理指标) */
  largestOutputTools: Array<{
    toolName: string;
    avgOutputSize: number;
    totalOutputSize: number;
    callCount: number;
  }>;
}

// ═══════════════════════════════════════
// Ring Buffer — 内存中的工具调用记录
// ═══════════════════════════════════════

const MAX_RECORDS = 2000;
const _records: ToolCallRecord[] = [];
let _idCounter = 0;

/**
 * 记录一次工具调用。由 tool-executor 在每次执行完成后调用。
 */
export function recordToolCall(record: Omit<ToolCallRecord, 'id'>): string {
  const id = `tc_${++_idCounter}_${Date.now()}`;
  const full: ToolCallRecord = { id, ...record };

  _records.push(full);
  if (_records.length > MAX_RECORDS) {
    _records.splice(0, _records.length - MAX_RECORDS);
  }

  return id;
}

/**
 * 获取最近 N 条工具调用记录
 */
export function getRecentToolCalls(
  projectId?: string,
  limit: number = 50,
): ToolCallRecord[] {
  let filtered = projectId
    ? _records.filter(r => r.projectId === projectId)
    : _records;
  return filtered.slice(-limit).reverse(); // 最新在前
}

/**
 * 获取特定 Agent 的工具调用记录
 */
export function getToolCallsByAgent(
  agentId: string,
  limit: number = 100,
): ToolCallRecord[] {
  return _records
    .filter(r => r.agentId === agentId)
    .slice(-limit)
    .reverse();
}

// ═══════════════════════════════════════
// Agent Session 统计
// ═══════════════════════════════════════

// LLM 调用记录 (轻量)
interface LLMCallRecord {
  agentId: string;
  agentRole: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: number;
}

const _llmRecords: LLMCallRecord[] = [];

/**
 * 记录一次 LLM 调用。由 react-loop 在每次 LLM 返回后调用。
 */
export function recordLLMCall(record: LLMCallRecord): void {
  _llmRecords.push(record);
  if (_llmRecords.length > MAX_RECORDS) {
    _llmRecords.splice(0, _llmRecords.length - MAX_RECORDS);
  }
}

// Agent 迭代计数
const _agentIterations = new Map<string, number>();

/**
 * 记录 Agent 迭代轮次
 */
export function recordIteration(agentId: string, iteration: number): void {
  _agentIterations.set(agentId, iteration);
}

/**
 * 获取 Agent 会话统计
 */
export function getAgentSessionStats(agentId: string): AgentSessionStats | null {
  const toolCalls = _records.filter(r => r.agentId === agentId);
  const llmCalls = _llmRecords.filter(r => r.agentId === agentId);

  if (toolCalls.length === 0 && llmCalls.length === 0) return null;

  const role = toolCalls[0]?.agentRole || llmCalls[0]?.agentRole || 'unknown';
  const successCount = toolCalls.filter(r => r.success).length;
  const totalDuration = toolCalls.reduce((s, r) => s + r.durationMs, 0);

  // 最慢调用
  let slowest: ToolCallRecord | null = null;
  for (const r of toolCalls) {
    if (!slowest || r.durationMs > slowest.durationMs) slowest = r;
  }

  // 调用最多的工具
  const toolCounts = new Map<string, number>();
  for (const r of toolCalls) {
    toolCounts.set(r.toolName, (toolCounts.get(r.toolName) || 0) + 1);
  }
  let mostUsed: { toolName: string; count: number } | null = null;
  for (const [name, count] of toolCounts) {
    if (!mostUsed || count > mostUsed.count) mostUsed = { toolName: name, count };
  }

  // Token 使用
  const tokenUsage = {
    inputTokens: llmCalls.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: llmCalls.reduce((s, r) => s + r.outputTokens, 0),
    costUsd: llmCalls.reduce((s, r) => s + r.costUsd, 0),
  };

  return {
    agentId,
    agentRole: role,
    totalToolCalls: toolCalls.length,
    successRate: toolCalls.length > 0 ? successCount / toolCalls.length : 1,
    totalDurationMs: totalDuration,
    avgToolDurationMs: toolCalls.length > 0 ? Math.round(totalDuration / toolCalls.length) : 0,
    slowestCall: slowest ? { toolName: slowest.toolName, durationMs: slowest.durationMs } : null,
    mostUsedTool: mostUsed,
    tokenUsage,
    currentIteration: _agentIterations.get(agentId) || 0,
  };
}

// ═══════════════════════════════════════
// 成本分解
// ═══════════════════════════════════════

/**
 * 获取成本分解 (按模型 + 按角色)
 */
export function getCostBreakdown(projectId?: string): CostBreakdown {
  const relevant = projectId
    ? _llmRecords.filter(r => {
        // 需要关联 tool records 找 projectId — 简化: 使用全部记录
        return true; // TODO: 如果需要 projectId 过滤，需要在 LLMCallRecord 中加 projectId
      })
    : _llmRecords;

  // 按模型
  const modelMap = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number; callCount: number }>();
  for (const r of relevant) {
    const existing = modelMap.get(r.model) || { inputTokens: 0, outputTokens: 0, costUsd: 0, callCount: 0 };
    existing.inputTokens += r.inputTokens;
    existing.outputTokens += r.outputTokens;
    existing.costUsd += r.costUsd;
    existing.callCount += 1;
    modelMap.set(r.model, existing);
  }

  // 按角色
  const roleMap = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number }>();
  for (const r of relevant) {
    const existing = roleMap.get(r.agentRole) || { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    existing.inputTokens += r.inputTokens;
    existing.outputTokens += r.outputTokens;
    existing.costUsd += r.costUsd;
    roleMap.set(r.agentRole, existing);
  }

  // 总计
  const total = {
    inputTokens: relevant.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: relevant.reduce((s, r) => s + r.outputTokens, 0),
    costUsd: relevant.reduce((s, r) => s + r.costUsd, 0),
  };

  return {
    byModel: Array.from(modelMap.entries()).map(([model, stats]) => ({ model, ...stats })),
    byRole: Array.from(roleMap.entries()).map(([role, stats]) => ({ role, ...stats })),
    total,
  };
}

// ═══════════════════════════════════════
// 瓶颈分析
// ═══════════════════════════════════════

/**
 * 分析工具调用瓶颈
 */
export function getBottleneckReport(projectId?: string): BottleneckReport {
  const relevant = projectId
    ? _records.filter(r => r.projectId === projectId)
    : _records;

  if (relevant.length === 0) {
    return { slowestTools: [], failingTools: [], largestOutputTools: [] };
  }

  // 按工具聚合
  const toolStats = new Map<string, {
    durations: number[];
    failCount: number;
    totalCount: number;
    outputSizes: number[];
  }>();

  for (const r of relevant) {
    const existing = toolStats.get(r.toolName) || {
      durations: [], failCount: 0, totalCount: 0, outputSizes: [],
    };
    existing.durations.push(r.durationMs);
    existing.totalCount += 1;
    if (!r.success) existing.failCount += 1;
    existing.outputSizes.push(r.outputSize);
    toolStats.set(r.toolName, existing);
  }

  // 最慢工具 TOP 5
  const slowestTools = Array.from(toolStats.entries())
    .map(([toolName, stats]) => ({
      toolName,
      avgDurationMs: Math.round(stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length),
      maxDurationMs: Math.max(...stats.durations),
      callCount: stats.totalCount,
    }))
    .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
    .slice(0, 5);

  // 失败率最高 TOP 5 (至少 2 次调用)
  const failingTools = Array.from(toolStats.entries())
    .filter(([, stats]) => stats.totalCount >= 2 && stats.failCount > 0)
    .map(([toolName, stats]) => ({
      toolName,
      failureRate: stats.failCount / stats.totalCount,
      failCount: stats.failCount,
      totalCount: stats.totalCount,
    }))
    .sort((a, b) => b.failureRate - a.failureRate)
    .slice(0, 5);

  // 最大输出 TOP 5
  const largestOutputTools = Array.from(toolStats.entries())
    .map(([toolName, stats]) => ({
      toolName,
      avgOutputSize: Math.round(stats.outputSizes.reduce((a, b) => a + b, 0) / stats.outputSizes.length),
      totalOutputSize: stats.outputSizes.reduce((a, b) => a + b, 0),
      callCount: stats.totalCount,
    }))
    .sort((a, b) => b.avgOutputSize - a.avgOutputSize)
    .slice(0, 5);

  return { slowestTools, failingTools, largestOutputTools };
}

// ═══════════════════════════════════════
// Dashboard 综合数据
// ═══════════════════════════════════════

export interface DashboardData {
  /** 最近工具调用 */
  recentCalls: ToolCallRecord[];
  /** 活跃 Agent 列表 + 统计 */
  agents: AgentSessionStats[];
  /** 成本分解 */
  costs: CostBreakdown;
  /** 瓶颈报告 */
  bottlenecks: BottleneckReport;
  /** 摘要数字 */
  summary: {
    totalToolCalls: number;
    successRate: number;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    activeAgents: number;
    avgToolDurationMs: number;
  };
}

/**
 * 获取完整 Dashboard 数据 (一次调用返回所有面板所需数据)
 */
export function getDashboardData(projectId?: string): DashboardData {
  const recentCalls = getRecentToolCalls(projectId, 30);
  const costs = getCostBreakdown(projectId);
  const bottlenecks = getBottleneckReport(projectId);

  // 收集活跃 Agent IDs
  const agentIds = new Set<string>();
  for (const r of _records) {
    if (!projectId || r.projectId === projectId) agentIds.add(r.agentId);
  }

  const agents: AgentSessionStats[] = [];
  for (const id of agentIds) {
    const stats = getAgentSessionStats(id);
    if (stats) agents.push(stats);
  }

  // 摘要
  const relevant = projectId ? _records.filter(r => r.projectId === projectId) : _records;
  const totalToolCalls = relevant.length;
  const successCount = relevant.filter(r => r.success).length;
  const totalDuration = relevant.reduce((s, r) => s + r.durationMs, 0);

  return {
    recentCalls,
    agents,
    costs,
    bottlenecks,
    summary: {
      totalToolCalls,
      successRate: totalToolCalls > 0 ? successCount / totalToolCalls : 1,
      totalCostUsd: costs.total.costUsd,
      totalInputTokens: costs.total.inputTokens,
      totalOutputTokens: costs.total.outputTokens,
      activeAgents: agents.length,
      avgToolDurationMs: totalToolCalls > 0 ? Math.round(totalDuration / totalToolCalls) : 0,
    },
  };
}

/**
 * 清空遥测数据（测试用）
 */
export function clearTelemetry(): void {
  _records.length = 0;
  _llmRecords.length = 0;
  _agentIterations.clear();
  _idCounter = 0;
}
