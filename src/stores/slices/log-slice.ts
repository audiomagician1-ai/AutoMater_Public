/**
 * Log slice — real-time logs and streaming sessions
 */
import type { StateCreator } from 'zustand';

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

export interface LogSlice {
  logs: LogEntry[];
  addLog: (log: Omit<LogEntry, 'id' | 'timestamp'>) => void;
  clearLogs: () => void;
  activeStreams: Map<string, StreamSession>;
  startStream: (agentId: string, label: string) => void;
  appendStream: (agentId: string, chunk: string) => void;
  endStream: (agentId: string) => void;
}

let logIdCounter = 0;

export const createLogSlice: StateCreator<LogSlice, [], [], LogSlice> = (set) => ({
  logs: [],
  addLog: (log) => set((state) => ({
    logs: [...state.logs.slice(-500), { ...log, id: ++logIdCounter, timestamp: Date.now() }],
  })),
  clearLogs: () => set({ logs: [] }),

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
});
