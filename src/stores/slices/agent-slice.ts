/**
 * Agent slice — agent statuses, react states, context snapshots, work messages, notifications
 */
import type { StateCreator } from 'zustand';
import type { AgentWorkMessage } from '../app-store';

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
  updateFeatureStatus: (featureId: string, status: string) => void;
  agentStatuses: Map<string, { status: string; currentTask: string | null; featureTitle?: string }>;
  updateAgentStatus: (agentId: string, status: string, currentTask: string | null, featureTitle?: string) => void;
  contextSnapshots: Map<string, ContextSnapshot>;
  updateContextSnapshot: (snapshot: ContextSnapshot) => void;
  clearContextSnapshots: () => void;
  agentReactStates: Map<string, StoreAgentReactState>;
  updateAgentReactState: (state: StoreAgentReactState) => void;
  clearAgentReactStates: () => void;
  pendingNotifications: number;
  incrementNotifications: () => void;
  clearNotifications: () => void;
  showAcceptancePanel: boolean;
  setShowAcceptancePanel: (show: boolean) => void;
  agentWorkMessages: Map<string, AgentWorkMessage[]>;
  addAgentWorkMessage: (agentId: string, msg: AgentWorkMessage) => void;
  clearAgentWorkMessages: (agentId?: string) => void;
}

export const createAgentSlice: StateCreator<AgentSlice, [], [], AgentSlice> = (set) => ({
  featureStatuses: new Map(),
  updateFeatureStatus: (featureId, status) => set((state) => {
    const next = new Map(state.featureStatuses);
    next.set(featureId, status);
    return { featureStatuses: next };
  }),

  agentStatuses: new Map(),
  updateAgentStatus: (agentId, status, currentTask, featureTitle?) => set((state) => {
    const next = new Map(state.agentStatuses);
    next.set(agentId, { status, currentTask, featureTitle });
    return { agentStatuses: next };
  }),

  contextSnapshots: new Map(),
  updateContextSnapshot: (snapshot) => set((state) => {
    const next = new Map(state.contextSnapshots);
    next.set(snapshot.agentId, snapshot);
    return { contextSnapshots: next };
  }),
  clearContextSnapshots: () => set({ contextSnapshots: new Map() }),

  agentReactStates: new Map(),
  updateAgentReactState: (state) => set((s) => {
    const next = new Map(s.agentReactStates);
    next.set(state.agentId, state);
    return { agentReactStates: next };
  }),
  clearAgentReactStates: () => set({ agentReactStates: new Map() }),

  pendingNotifications: 0,
  incrementNotifications: () => set((s) => ({ pendingNotifications: s.pendingNotifications + 1 })),
  clearNotifications: () => set({ pendingNotifications: 0 }),

  showAcceptancePanel: false,
  setShowAcceptancePanel: (show) => set({ showAcceptancePanel: show }),

  agentWorkMessages: new Map(),
  addAgentWorkMessage: (agentId, msg) => set((s) => {
    const next = new Map(s.agentWorkMessages);
    const list = [...(next.get(agentId) || []), msg];
    next.set(agentId, list.slice(-500));
    return { agentWorkMessages: next };
  }),
  clearAgentWorkMessages: (agentId?) => set((s) => {
    if (agentId) {
      const next = new Map(s.agentWorkMessages);
      next.delete(agentId);
      return { agentWorkMessages: next };
    }
    return { agentWorkMessages: new Map() };
  }),
});
