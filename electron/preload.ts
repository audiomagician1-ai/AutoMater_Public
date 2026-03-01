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
    getLogs: (projectId: string, options?: {
      limit?: number; offset?: number; agentId?: string; type?: string; keyword?: string;
    }) => ipcRenderer.invoke('project:get-logs', projectId, options),
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
    // v4.2: 用户验收 + 文档查询
    userAccept: (projectId: string, accept: boolean, feedback?: string) =>
      ipcRenderer.invoke('project:user-accept', projectId, accept, feedback),
    getFeatureDocs: (projectId: string, featureId: string) =>
      ipcRenderer.invoke('project:get-feature-docs', projectId, featureId),
    getDesignDoc: (projectId: string) =>
      ipcRenderer.invoke('project:get-design-doc', projectId),
    getDocChangelog: (projectId: string) =>
      ipcRenderer.invoke('project:get-doc-changelog', projectId),
    // v4.4: 文档浏览器
    listAllDocs: (projectId: string) =>
      ipcRenderer.invoke('project:list-all-docs', projectId),
    readDoc: (projectId: string, type: string, id: string) =>
      ipcRenderer.invoke('project:read-doc', projectId, type, id),
    // v4.3: 需求变更
    submitChange: (projectId: string, description: string) =>
      ipcRenderer.invoke('project:submit-change', projectId, description),
    listChanges: (projectId: string) =>
      ipcRenderer.invoke('project:list-changes', projectId),
    getImpactAnalysis: (changeRequestId: string) =>
      ipcRenderer.invoke('project:get-impact-analysis', changeRequestId),
  },

  // ── 需求队列 (v3.1) ──
  wish: {
    create: (projectId: string, content: string) => ipcRenderer.invoke('wish:create', projectId, content),
    list: (projectId: string) => ipcRenderer.invoke('wish:list', projectId),
    get: (wishId: string) => ipcRenderer.invoke('wish:get', wishId),
    update: (wishId: string, fields: any) => ipcRenderer.invoke('wish:update', wishId, fields),
    delete: (wishId: string) => ipcRenderer.invoke('wish:delete', wishId),
  },

  // ── 团队管理 (v3.1) ──
  team: {
    list: (projectId: string) => ipcRenderer.invoke('team:list', projectId),
    add: (projectId: string, member: any) => ipcRenderer.invoke('team:add', projectId, member),
    update: (memberId: string, fields: any) => ipcRenderer.invoke('team:update', memberId, fields),
    delete: (memberId: string) => ipcRenderer.invoke('team:delete', memberId),
    initDefaults: (projectId: string) => ipcRenderer.invoke('team:init-defaults', projectId),
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

