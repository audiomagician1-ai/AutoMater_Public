/**
 * Meta-agent slice — meta agent panel, settings, session management, and conversation messages
 *
 * v20.0: session 列表管理 — 支持多会话切换, 新建对话, 历史消息加载
 *
 * 消息存储键规则:
 *   - 活跃会话: chatKey = currentMetaSessionId (session-xxx)
 *   - 无会话时: chatKey = projectId || '_global' (向后兼容)
 */
import type { StateCreator } from 'zustand';
import type { MetaAgentMessage } from '../app-store';

/** Session 列表项 (与 conversation-backup.ts SessionInfo 对齐) */
export interface MetaSessionItem {
  id: string;
  projectId: string | null;
  agentId: string;
  agentRole: string;
  agentSeq: number;
  status: 'active' | 'completed' | 'archived';
  createdAt: string;
  completedAt: string | null;
  messageCount: number;
  totalTokens: number;
  totalCost: number;
  /** 第一条用户消息摘要 — 用作会话标题 */
  title?: string;
}

export interface MetaAgentSlice {
  metaAgentPanelOpen: boolean;
  toggleMetaAgentPanel: () => void;
  metaAgentSettingsOpen: boolean;
  setMetaAgentSettingsOpen: (open: boolean) => void;

  // ── Session 管理 ──
  /** 当前选中的 session ID (null = 新对话/无会话) */
  currentMetaSessionId: string | null;
  /** 当前项目的 meta-agent session 列表 */
  metaSessionList: MetaSessionItem[];
  /** 是否正在加载 session 列表 */
  metaSessionsLoading: boolean;
  setCurrentMetaSessionId: (id: string | null) => void;
  setMetaSessionList: (list: MetaSessionItem[]) => void;
  setMetaSessionsLoading: (loading: boolean) => void;

  // ── 消息管理 ──
  metaAgentMessages: Map<string, MetaAgentMessage[]>;
  addMetaAgentMessage: (chatKey: string, msg: MetaAgentMessage) => void;
  clearMetaAgentMessages: (chatKey: string) => void;
  setMetaAgentMessages: (chatKey: string, messages: MetaAgentMessage[]) => void;
  updateLastAssistantMessage: (chatKey: string, content: string) => void;
}

export const createMetaAgentSlice: StateCreator<MetaAgentSlice, [], [], MetaAgentSlice> = (set) => ({
  metaAgentPanelOpen: false,
  toggleMetaAgentPanel: () => set((s) => ({ metaAgentPanelOpen: !s.metaAgentPanelOpen })),

  metaAgentSettingsOpen: false,
  setMetaAgentSettingsOpen: (open) => set({ metaAgentSettingsOpen: open }),

  // ── Session 状态 ──
  currentMetaSessionId: null,
  metaSessionList: [],
  metaSessionsLoading: false,
  setCurrentMetaSessionId: (id) => set({ currentMetaSessionId: id }),
  setMetaSessionList: (list) => set({ metaSessionList: list }),
  setMetaSessionsLoading: (loading) => set({ metaSessionsLoading: loading }),

  // ── 消息管理 ──
  metaAgentMessages: new Map(),
  addMetaAgentMessage: (chatKey, msg) => set((s) => {
    const next = new Map(s.metaAgentMessages);
    const list = [...(next.get(chatKey) || []), msg];
    next.set(chatKey, list.slice(-200));
    return { metaAgentMessages: next };
  }),
  clearMetaAgentMessages: (chatKey) => set((s) => {
    const next = new Map(s.metaAgentMessages);
    next.delete(chatKey);
    return { metaAgentMessages: next };
  }),
  setMetaAgentMessages: (chatKey, messages) => set((s) => {
    const next = new Map(s.metaAgentMessages);
    next.set(chatKey, messages);
    return { metaAgentMessages: next };
  }),
  updateLastAssistantMessage: (chatKey, content) => set((s) => {
    const next = new Map(s.metaAgentMessages);
    const list = [...(next.get(chatKey) || [])];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === 'assistant') {
        list[i] = { ...list[i], content };
        break;
      }
    }
    next.set(chatKey, list);
    return { metaAgentMessages: next };
  }),
});
