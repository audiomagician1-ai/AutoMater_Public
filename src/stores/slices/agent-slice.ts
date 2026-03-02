/**
 * Agent slice — agent statuses, react states, context snapshots, work messages, notifications
 *
 * v23.0: 所有 Map 使用 `${projectId}:${agentId}` 复合键，
 *        确保切换项目时 Agent 面板隔离显示。
 */
import type { StateCreator } from 'zustand';
import type { AgentWorkMessage } from '../app-store';

/** 复合键: projectId + agentId */
function compKey(projectId: string, agentId: string): string {
  return `${projectId}:${agentId}`;
}

/** 从复合键中解出 agentId 部分 */
function agentIdFromKey(key: string): string {
  const idx = key.indexOf(':');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

/** 按 projectId 过滤 Map, 返回以 agentId 为 key 的子 Map */
export function filterByProject<V>(map: Map<string, V>, projectId: string | null): Map<string, V> {
  const result = new Map<string, V>();
  if (!projectId) return result;
  const prefix = projectId + ':';
  for (const [key, val] of map) {
    if (key.startsWith(prefix)) {
      result.set(key.slice(prefix.length), val);
    }
  }
  return result;
}

interface StoreAgentReactState {
  agentId: string;
  featureId?: string;
  iteration?: number;
  iterations?: ReactIterationState[];
  maxContextWindow?: number;
  phase?: string;
  toolCalls?: Array<{ name: string; args: string; success?: boolean }>;
  lastUpdated?: number;
}

export interface AgentSlice {
  featureStatuses: Map<string, string>;
  updateFeatureStatus: (projectId: string, featureId: string, status: string) => void;
  agentStatuses: Map<string, { status: string; currentTask: string | null; featureTitle?: string }>;
  updateAgentStatus: (
    projectId: string,
    agentId: string,
    status: string,
    currentTask: string | null,
    featureTitle?: string,
  ) => void;
  contextSnapshots: Map<string, ContextSnapshot>;
  updateContextSnapshot: (projectId: string, snapshot: ContextSnapshot) => void;
  clearContextSnapshots: () => void;
  agentReactStates: Map<string, StoreAgentReactState>;
  updateAgentReactState: (projectId: string, state: StoreAgentReactState) => void;
  clearAgentReactStates: () => void;
  pendingNotifications: number;
  incrementNotifications: () => void;
  clearNotifications: () => void;
  showAcceptancePanel: boolean;
  setShowAcceptancePanel: (show: boolean) => void;
  agentWorkMessages: Map<string, AgentWorkMessage[]>;
  addAgentWorkMessage: (projectId: string, agentId: string, msg: AgentWorkMessage) => void;
  clearAgentWorkMessages: (agentId?: string) => void;
}

export const createAgentSlice: StateCreator<AgentSlice, [], [], AgentSlice> = set => ({
  featureStatuses: new Map(),
  updateFeatureStatus: (projectId, featureId, status) =>
    set(state => {
      const next = new Map(state.featureStatuses);
      next.set(compKey(projectId, featureId), status);
      return { featureStatuses: next };
    }),

  agentStatuses: new Map(),
  updateAgentStatus: (projectId, agentId, status, currentTask, featureTitle?) =>
    set(state => {
      const next = new Map(state.agentStatuses);
      next.set(compKey(projectId, agentId), { status, currentTask, featureTitle });
      return { agentStatuses: next };
    }),

  contextSnapshots: new Map(),
  updateContextSnapshot: (projectId, snapshot) =>
    set(state => {
      const next = new Map(state.contextSnapshots);
      next.set(compKey(projectId, snapshot.agentId), snapshot);
      return { contextSnapshots: next };
    }),
  clearContextSnapshots: () => set({ contextSnapshots: new Map() }),

  agentReactStates: new Map(),
  updateAgentReactState: (projectId, state) =>
    set(s => {
      const next = new Map(s.agentReactStates);
      next.set(compKey(projectId, state.agentId), state);
      return { agentReactStates: next };
    }),
  clearAgentReactStates: () => set({ agentReactStates: new Map() }),

  pendingNotifications: 0,
  incrementNotifications: () => set(s => ({ pendingNotifications: s.pendingNotifications + 1 })),
  clearNotifications: () => set({ pendingNotifications: 0 }),

  showAcceptancePanel: false,
  setShowAcceptancePanel: show => set({ showAcceptancePanel: show }),

  agentWorkMessages: new Map(),
  addAgentWorkMessage: (projectId, agentId, msg) =>
    set(s => {
      const key = compKey(projectId, agentId);
      const next = new Map(s.agentWorkMessages);
      const list = [...(next.get(key) || []), msg];
      next.set(key, list.slice(-500));
      return { agentWorkMessages: next };
    }),
  clearAgentWorkMessages: (agentId?) =>
    set(s => {
      if (agentId) {
        const next = new Map(s.agentWorkMessages);
        for (const key of [...next.keys()]) {
          if (agentIdFromKey(key) === agentId) next.delete(key);
        }
        return { agentWorkMessages: next };
      }
      return { agentWorkMessages: new Map() };
    }),
});
