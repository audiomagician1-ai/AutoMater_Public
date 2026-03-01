/**
 * 全局应用状态 (Zustand)
 * v0.7: 双层导航 — 外层 (项目列表/设置) → 内层 (项目子页)
 * v1.1: 上下文快照 + Context 页面
 */

import { create } from 'zustand';

/** 外层页面 (无需选中项目) */
export type GlobalPageId = 'projects' | 'settings';
/** 项目内子页面 (需要 currentProjectId) */
export type ProjectPageId = 'overview' | 'wish' | 'board' | 'team' | 'output' | 'logs' | 'context';

interface LogEntry {
  id: number;
  projectId: string;
  agentId: string;
  content: string;
  timestamp: number;
  streaming?: boolean;
}

interface StreamSession {
  agentId: string;
  label: string;
  content: string;
  startedAt: number;
}

interface AppState {
  // ── 双层导航 ──
  /** 是否处于项目内部视图 */
  insideProject: boolean;
  /** 外层当前页 */
  globalPage: GlobalPageId;
  /** 项目内当前子页 */
  projectPage: ProjectPageId;
  /** 进入项目 */
  enterProject: (projectId: string, page?: ProjectPageId) => void;
  /** 返回项目列表 */
  exitProject: () => void;
  /** 外层切页 */
  setGlobalPage: (page: GlobalPageId) => void;
  /** 项目内切页 */
  setProjectPage: (page: ProjectPageId) => void;

  // 当前项目
  currentProjectId: string | null;
  setCurrentProject: (id: string | null) => void;

  // 实时日志
  logs: LogEntry[];
  addLog: (log: Omit<LogEntry, 'id' | 'timestamp'>) => void;
  clearLogs: () => void;

  // 流式日志
  activeStreams: Map<string, StreamSession>;
  startStream: (agentId: string, label: string) => void;
  appendStream: (agentId: string, chunk: string) => void;
  endStream: (agentId: string) => void;

  // Features 实时状态
  featureStatuses: Map<string, string>;
  updateFeatureStatus: (featureId: string, status: string) => void;

  // Agent 实时状态
  agentStatuses: Map<string, { status: string; currentTask: string | null }>;
  updateAgentStatus: (agentId: string, status: string, currentTask: string | null) => void;

  // 设置已配置
  settingsConfigured: boolean;
  setSettingsConfigured: (v: boolean) => void;

  // v1.1: 上下文快照
  contextSnapshots: Map<string, ContextSnapshot>;
  updateContextSnapshot: (snapshot: ContextSnapshot) => void;
  clearContextSnapshots: () => void;
}

let logIdCounter = 0;

export const useAppStore = create<AppState>((set) => ({
  // ── 双层导航 ──
  insideProject: false,
  globalPage: 'projects',
  projectPage: 'overview',

  enterProject: (projectId, page = 'overview') => set({
    insideProject: true,
    currentProjectId: projectId,
    projectPage: page,
  }),
  exitProject: () => set({
    insideProject: false,
    globalPage: 'projects',
  }),
  setGlobalPage: (page) => set({ globalPage: page, insideProject: false }),
  setProjectPage: (page) => set({ projectPage: page }),

  currentProjectId: null,
  setCurrentProject: (id) => set({ currentProjectId: id }),

  logs: [],
  addLog: (log) => set((state) => ({
    logs: [...state.logs.slice(-500), { ...log, id: ++logIdCounter, timestamp: Date.now() }],
  })),
  clearLogs: () => set({ logs: [] }),

  // ── 流式日志 ──
  activeStreams: new Map(),
  startStream: (agentId, label) => set((state) => {
    const next = new Map(state.activeStreams);
    next.set(agentId, { agentId, label, content: '', startedAt: Date.now() });
    return { activeStreams: next };
  }),
  appendStream: (agentId, chunk) => set((state) => {
    const session = state.activeStreams.get(agentId);
    if (!session) return {};
    const next = new Map(state.activeStreams);
    next.set(agentId, { ...session, content: session.content + chunk });
    return { activeStreams: next };
  }),
  endStream: (agentId) => set((state) => {
    const next = new Map(state.activeStreams);
    next.delete(agentId);
    return { activeStreams: next };
  }),

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

  // v1.1: 上下文快照
  contextSnapshots: new Map(),
  updateContextSnapshot: (snapshot) => set((state) => {
    const next = new Map(state.contextSnapshots);
    next.set(snapshot.agentId, snapshot);
    return { contextSnapshots: next };
  }),
  clearContextSnapshots: () => set({ contextSnapshots: new Map() }),
}));
