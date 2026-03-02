/**
 * 全局应用状态 (Zustand) — Composed from slices
 *
 * Slices:
 *   NavigationSlice — dual-layer nav (global + project pages)
 *   LogSlice        — real-time logs and streaming
 *   AgentSlice      — agent statuses, react states, context, work messages
 *   MetaAgentSlice  — meta agent panel and conversations
 */

import { create } from 'zustand';
import { createNavigationSlice, type NavigationSlice, type GlobalPageId, type ProjectPageId } from './slices/navigation-slice';
import { createLogSlice, type LogSlice } from './slices/log-slice';
import { createAgentSlice, type AgentSlice } from './slices/agent-slice';
import { createMetaAgentSlice, type MetaAgentSlice } from './slices/meta-agent-slice';

// Re-export page ID types for consumers
export type { GlobalPageId, ProjectPageId };

/** Agent 工作消息 — 对话式展示思维链、工具调用、输出等 */
export interface AgentWorkMessage {
  id: string;
  type: 'think' | 'tool-call' | 'tool-result' | 'output' | 'status' | 'sub-agent' | 'error' | 'plan';
  timestamp: number;
  content: string;
  /** 工具调用详情 */
  tool?: {
    name: string;
    args: string;
    success?: boolean;
    outputPreview?: string;
  };
  /** 迭代编号 */
  iteration?: number;
  /** 关联 feature */
  featureId?: string;
}

/** 元Agent对话消息 */
export interface MetaAgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  triggeredWish?: boolean;
  /** v19.0: 附件 (图片/文件) */
  attachments?: Array<{
    type: 'image' | 'file';
    name: string;
    data: string;
    mimeType: string;
  }>;
}

type AppState = NavigationSlice & LogSlice & AgentSlice & MetaAgentSlice;

export const useAppStore = create<AppState>()((...a) => ({
  ...createNavigationSlice(...a),
  ...createLogSlice(...a),
  ...createAgentSlice(...a),
  ...createMetaAgentSlice(...a),
}));

