import { contextBridge, ipcRenderer, webFrame } from 'electron';

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
    // v5.1: 分析已有项目
    analyzeExisting: (projectId: string) =>
      ipcRenderer.invoke('project:analyze-existing', projectId),
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

  // ── MCP 服务器管理 (v5.0) ──
  mcp: {
    listServers: () => ipcRenderer.invoke('mcp:list-servers'),
    addServer: (config: any) => ipcRenderer.invoke('mcp:add-server', config),
    updateServer: (id: string, updates: any) => ipcRenderer.invoke('mcp:update-server', id, updates),
    removeServer: (id: string) => ipcRenderer.invoke('mcp:remove-server', id),
    connectServer: (id: string) => ipcRenderer.invoke('mcp:connect-server', id),
    disconnectServer: (id: string) => ipcRenderer.invoke('mcp:disconnect-server', id),
    listTools: () => ipcRenderer.invoke('mcp:list-tools'),
    testServer: (config: any) => ipcRenderer.invoke('mcp:test-server', config),
  },

  // ── Skill 目录管理 (v5.0) ──
  skill: {
    getDirectory: () => ipcRenderer.invoke('skill:get-directory'),
    setDirectory: (dirPath: string) => ipcRenderer.invoke('skill:set-directory', dirPath),
    reload: () => ipcRenderer.invoke('skill:reload'),
    list: () => ipcRenderer.invoke('skill:list'),
  },

  // ── Skill 进化系统 (v5.1) ──
  skillEvolution: {
    getIndex: () => ipcRenderer.invoke('skill-evolution:get-index'),
    getOverview: () => ipcRenderer.invoke('skill-evolution:get-overview'),
    getSkill: (id: string) => ipcRenderer.invoke('skill-evolution:get-skill', id),
    getKnowledge: (id: string) => ipcRenderer.invoke('skill-evolution:get-knowledge', id),
    deprecate: (id: string, reason: string) => ipcRenderer.invoke('skill-evolution:deprecate', id, reason),
    getRanked: () => ipcRenderer.invoke('skill-evolution:get-ranked'),
  },

  // ── 文件夹选择对话框 (v5.1) ──
  dialog: {
    openDirectory: (title?: string) => ipcRenderer.invoke('dialog:open-directory', title),
  },

  // ── 元Agent对话 (v5.4) ──
  metaAgent: {
    chat: (projectId: string | null, message: string, history?: Array<{ role: string; content: string }>) =>
      ipcRenderer.invoke('meta-agent:chat', projectId, message, history),
  },

  // ── 临时工作流 (v5.5) ──
  ephemeralMission: {
    create: (projectId: string, type: string, config?: any) =>
      ipcRenderer.invoke('mission:create', projectId, type, config),
    get: (missionId: string) => ipcRenderer.invoke('mission:get', missionId),
    list: (projectId: string) => ipcRenderer.invoke('mission:list', projectId),
    getTasks: (missionId: string) => ipcRenderer.invoke('mission:get-tasks', missionId),
    cancel: (missionId: string) => ipcRenderer.invoke('mission:cancel', missionId),
    cleanup: (missionId: string) => ipcRenderer.invoke('mission:cleanup', missionId),
    delete: (missionId: string) => ipcRenderer.invoke('mission:delete', missionId),
  },

  // ── 缩放控制 (v5.2) ──
  zoom: {
    /** 获取当前缩放倍率 (1.0 = 100%) */
    get: (): number => webFrame.getZoomFactor(),
    /** 设置缩放倍率 (0.5 ~ 3.0) */
    set: (factor: number): void => {
      const clamped = Math.min(3.0, Math.max(0.5, factor));
      webFrame.setZoomFactor(clamped);
    },
  },
});

