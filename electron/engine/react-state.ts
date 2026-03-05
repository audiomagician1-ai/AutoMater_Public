/**
 * ReAct State & Cache — 类型定义 + 运行状态缓存
 *
 * 从 react-loop.ts 拆出 (v30.2)
 */

import type { ContextSnapshot } from './context-collector';

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

export function cacheAgentReactState(projectId: string, state: AgentReactState) {
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
