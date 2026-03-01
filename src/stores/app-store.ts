/**
 * 全局应用状态 (Zustand)
 */

import { create } from 'zustand';

export type PageId = 'wish' | 'board' | 'team' | 'logs' | 'settings';

interface LogEntry {
  id: number;
  projectId: string;
  agentId: string;
  content: string;
  timestamp: number;
}

interface AppState {
  // 导航
  currentPage: PageId;
  setPage: (page: PageId) => void;

  // 当前项目
  currentProjectId: string | null;
  setCurrentProject: (id: string | null) => void;

  // 实时日志
  logs: LogEntry[];
  addLog: (log: Omit<LogEntry, 'id' | 'timestamp'>) => void;
  clearLogs: () => void;

  // Features 实时状态
  featureStatuses: Map<string, string>;
  updateFeatureStatus: (featureId: string, status: string) => void;

  // Agent 实时状态
  agentStatuses: Map<string, { status: string; currentTask: string | null }>;
  updateAgentStatus: (agentId: string, status: string, currentTask: string | null) => void;

  // 设置已配置
  settingsConfigured: boolean;
  setSettingsConfigured: (v: boolean) => void;
}

let logIdCounter = 0;

export const useAppStore = create<AppState>((set) => ({
  currentPage: 'wish',
  setPage: (page) => set({ currentPage: page }),

  currentProjectId: null,
  setCurrentProject: (id) => set({ currentProjectId: id }),

  logs: [],
  addLog: (log) => set((state) => ({
    logs: [...state.logs.slice(-500), { ...log, id: ++logIdCounter, timestamp: Date.now() }],
  })),
  clearLogs: () => set({ logs: [] }),

  featureStatuses: new Map(),
  updateFeatureStatus: (featureId, status) => set((state) => {
    const next = new Map(state.featureStatuses);
    next.set(featureId, status);
    return { featureStatuses: next };
  }),

  agentStatuses: new Map(),
  updateAgentStatus: (agentId, status, currentTask) => set((state) => {
    const next = new Map(state.agentStatuses);
    next.set(agentId, { status, currentTask });
    return { agentStatuses: next };
  }),

  settingsConfigured: false,
  setSettingsConfigured: (v) => set({ settingsConfigured: v }),
}));
