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
    create: (wish: string) => ipcRenderer.invoke('project:create', wish),
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
  },

  // ── 工作区文件系统 ──
  workspace: {
    tree: (projectId: string) => ipcRenderer.invoke('workspace:tree', projectId),
    readFile: (projectId: string, relativePath: string) => ipcRenderer.invoke('workspace:read-file', projectId, relativePath),
    getPath: (projectId: string) => ipcRenderer.invoke('workspace:get-path', projectId),
  },

  // ── 事件订阅 (主进程 → 渲染进程) ──
  on: (channel: string, callback: (...args: any[]) => void) => {
    const subscription = (_event: any, ...args: any[]) => callback(...args);
    ipcRenderer.on(channel, subscription);
    return () => ipcRenderer.removeListener(channel, subscription);
  },
});

