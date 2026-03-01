/**
 * 全局应用状态 (Zustand)
 * v0.7: 双层导航 — 外层 (项目列表/设置) → 内层 (项目子页)
 * v1.1: 上下文快照 + Context 页面
 */

import { create } from 'zustand';

// Types used by store
interface ContextSnapshot {
  agentId: string;
  totalTokens: number;
  tokenBudget: number;
  sections: any[];
  timestamp: number;
  filesIncluded?: number;
  featureId?: string;
}

interface AgentReactState {
  agentId: string;
  iteration: number;
  phase: string;
  toolCalls: any[];
  lastUpdated: number;
}

/** 外层页面 (无需选中项目) */
export type GlobalPageId = 'projects' | 'settings' | 'guide';
/** 项目内子页面 (需要 currentProjectId) */
export type ProjectPageId = 'overview' | 'wish' | 'board' | 'team' | 'docs' | 'workflow' | 'output' | 'logs' | 'context' | 'timeline' | 'guide';

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

  // v1.1: Agent ReAct 实时状态
  agentReactStates: Map<string, AgentReactState>;
  updateAgentReactState: (state: AgentReactState) => void;
  clearAgentReactStates: () => void;

  // v4.4: 通知 badge 计数
  pendingNotifications: number;
  incrementNotifications: () => void;
  clearNotifications: () => void;

  // v4.4: 用户验收弹窗
  showAcceptancePanel: boolean;
  setShowAcceptancePanel: (show: boolean) => void;

  // v5.3: 全局右侧元Agent面板
  metaAgentPanelOpen: boolean;
  toggleMetaAgentPanel: () => void;

  // v5.4: 元Agent对话消息持久化 (按 projectId 分组, '_global' 为跨项目)
  metaAgentMessages: Map<string, MetaAgentMessage[]>;
  addMetaAgentMessage: (projectId: string, msg: MetaAgentMessage) => void;
  clearMetaAgentMessages: (projectId: string) => void;
  /** 更新最后一条 assistant 消息（用于流式/替换 placeholder） */
  updateLastAssistantMessage: (projectId: string, content: string) => void;
}

/** 元Agent对话消息 */
export interface MetaAgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  /** 标记: 此消息是否触发了需求创建 */
  triggeredWish?: boolean;
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

  // v1.1: Agent ReAct 实时状态
  agentReactStates: new Map(),
  updateAgentReactState: (state) => set((s) => {
    const next = new Map(s.agentReactStates);
    next.set(state.agentId, state);
    return { agentReactStates: next };
  }),
  clearAgentReactStates: () => set({ agentReactStates: new Map() }),

  // v4.4: 通知 badge
  pendingNotifications: 0,
  incrementNotifications: () => set((s) => ({ pendingNotifications: s.pendingNotifications + 1 })),
  clearNotifications: () => set({ pendingNotifications: 0 }),

  // v4.4: 用户验收弹窗
  showAcceptancePanel: false,
  setShowAcceptancePanel: (show) => set({ showAcceptancePanel: show }),

  // v5.3: 全局右侧元Agent面板
  metaAgentPanelOpen: false,
  toggleMetaAgentPanel: () => set((s) => ({ metaAgentPanelOpen: !s.metaAgentPanelOpen })),

  // v5.4: 元Agent对话
  metaAgentMessages: new Map(),
  addMetaAgentMessage: (projectId, msg) => set((s) => {
    const next = new Map(s.metaAgentMessages);
    const list = [...(next.get(projectId) || []), msg];
    // 保留最近 200 条
    next.set(projectId, list.slice(-200));
    return { metaAgentMessages: next };
  }),
  clearMetaAgentMessages: (projectId) => set((s) => {
    const next = new Map(s.metaAgentMessages);
    next.delete(projectId);
    return { metaAgentMessages: next };
  }),
  updateLastAssistantMessage: (projectId, content) => set((s) => {
    const next = new Map(s.metaAgentMessages);
    const list = [...(next.get(projectId) || [])];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === 'assistant') {
        list[i] = { ...list[i], content };
        break;
      }
    }
    next.set(projectId, list);
    return { metaAgentMessages: next };
  }),
}));
