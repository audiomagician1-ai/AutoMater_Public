/**
 * Meta-agent slice — meta agent panel, settings, and conversation messages
 */
import type { StateCreator } from 'zustand';
import type { MetaAgentMessage } from '../app-store';

export interface MetaAgentSlice {
  metaAgentPanelOpen: boolean;
  toggleMetaAgentPanel: () => void;
  metaAgentSettingsOpen: boolean;
  setMetaAgentSettingsOpen: (open: boolean) => void;
  metaAgentMessages: Map<string, MetaAgentMessage[]>;
  addMetaAgentMessage: (projectId: string, msg: MetaAgentMessage) => void;
  clearMetaAgentMessages: (projectId: string) => void;
  updateLastAssistantMessage: (projectId: string, content: string) => void;
}

export const createMetaAgentSlice: StateCreator<MetaAgentSlice, [], [], MetaAgentSlice> = (set) => ({
  metaAgentPanelOpen: false,
  toggleMetaAgentPanel: () => set((s) => ({ metaAgentPanelOpen: !s.metaAgentPanelOpen })),

  metaAgentSettingsOpen: false,
  setMetaAgentSettingsOpen: (open) => set({ metaAgentSettingsOpen: open }),

  metaAgentMessages: new Map(),
  addMetaAgentMessage: (projectId, msg) => set((s) => {
    const next = new Map(s.metaAgentMessages);
    const list = [...(next.get(projectId) || []), msg];
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
});
