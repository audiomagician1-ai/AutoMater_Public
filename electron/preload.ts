import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload — 暴露安全的 API 给渲染进程
 */
contextBridge.exposeInMainWorld('agentforge', {
  // ── 设置 ──
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (settings: any) => ipcRenderer.invoke('settings:save', settings),
  },

  // ── LLM ──
  llm: {
    testConnection: (provider: any) => ipcRenderer.invoke('llm:test-connection', provider),
    chat: (request: any) => ipcRenderer.invoke('llm:chat', request),
    listModels: (provider: any) => ipcRenderer.invoke('llm:list-models', provider),
  },

  // ── 项目 ──
  project: {
    create: (name: string, options?: {
      workspacePath?: string;
      gitMode?: string;
      githubRepo?: string;
      githubToken?: string;
    }) => ipcRenderer.invoke('project:create', name, options),
    setWish: (projectId: string, wish: string) => ipcRenderer.invoke('project:set-wish', projectId, wish),
    list: () => ipcRenderer.invoke('project:list'),
    get: (id: string) => ipcRenderer.invoke('project:get', id),
    getFeatures: (projectId: string) => ipcRenderer.invoke('project:get-features', projectId),
    getAgents: (projectId: string) => ipcRenderer.invoke('project:get-agents', projectId),
    getLogs: (projectId: string, limit?: number) => ipcRenderer.invoke('project:get-logs', projectId, limit),
    getStats: (projectId: string) => ipcRenderer.invoke('project:get-stats', projectId),
    start: (projectId: string) => ipcRenderer.invoke('project:start', projectId),
    stop: (projectId: string) => ipcRenderer.invoke('project:stop', projectId),
    delete: (projectId: string) => ipcRenderer.invoke('project:delete', projectId),
    openWorkspace: (projectId: string) => ipcRenderer.invoke('project:open-workspace', projectId),
    export: (projectId: string) => ipcRenderer.invoke('project:export', projectId),
    gitCommit: (projectId: string, message: string) => ipcRenderer.invoke('project:git-commit', projectId, message),
    gitLog: (projectId: string) => ipcRenderer.invoke('project:git-log', projectId),
    testGitHub: (repo: string, token: string) => ipcRenderer.invoke('project:test-github', repo, token),
    getContextSnapshots: (projectId: string) => ipcRenderer.invoke('project:get-context-snapshots', projectId),
    getReactStates: (projectId: string) => ipcRenderer.invoke('project:get-react-states', projectId),
  },

  // ── 工作区文件系统 ──
  workspace: {
    tree: (projectId: string) => ipcRenderer.invoke('workspace:tree', projectId),
    readFile: (projectId: string, relativePath: string) => ipcRenderer.invoke('workspace:read-file', projectId, relativePath),
    getPath: (projectId: string) => ipcRenderer.invoke('workspace:get-path', projectId),
  },

  // ── v2.0: 事件流 + Mission ──
  events: {
    query: (projectId: string, options?: any) => ipcRenderer.invoke('events:query', projectId, options),
    getStats: (projectId: string) => ipcRenderer.invoke('events:get-stats', projectId),
    getTimeline: (projectId: string, featureId: string) => ipcRenderer.invoke('events:get-timeline', projectId, featureId),
    exportNDJSON: (projectId: string) => ipcRenderer.invoke('events:export-ndjson', projectId),
  },
  mission: {
    getStatus: (projectId: string) => ipcRenderer.invoke('mission:get-status', projectId),
    getCheckpoints: (projectId: string) => ipcRenderer.invoke('mission:get-checkpoints', projectId),
    getProgressReport: (projectId: string) => ipcRenderer.invoke('mission:get-progress-report', projectId),
    detectResumable: () => ipcRenderer.invoke('mission:detect-resumable'),
  },
  knowledge: {
    getStats: () => ipcRenderer.invoke('knowledge:get-stats'),
    query: (tags: string[]) => ipcRenderer.invoke('knowledge:query', tags),
  },

  // ── 事件订阅 (主进程 → 渲染进程) ──
  on: (channel: string, callback: (...args: any[]) => void) => {
    const subscription = (_event: any, ...args: any[]) => callback(...args);
    ipcRenderer.on(channel, subscription);
    return () => ipcRenderer.removeListener(channel, subscription);
  },
});

