import { contextBridge, ipcRenderer, webFrame } from 'electron';

/**
 * Preload — 暴露安全的 API 给渲染进程
 */
contextBridge.exposeInMainWorld('automater', {
  // ── 设置 ──
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (settings: Record<string, unknown>) => ipcRenderer.invoke('settings:save', settings),
  },

  // ── LLM ──
  llm: {
    testConnection: (provider: { type: string; baseUrl: string; apiKey: string }) => ipcRenderer.invoke('llm:test-connection', provider),
    chat: (request: { model: string; messages: Array<{ role: string; content: string }> }) => ipcRenderer.invoke('llm:chat', request),
    listModels: (provider: { type: string; baseUrl: string; apiKey: string }) => ipcRenderer.invoke('llm:list-models', provider),
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
    resumeFeature: (projectId: string, featureId: string) => ipcRenderer.invoke('feature:resume', projectId, featureId),
    getAgents: (projectId: string) => ipcRenderer.invoke('project:get-agents', projectId),
    getLogs: (projectId: string, options?: {
      limit?: number; offset?: number; agentId?: string; type?: string; keyword?: string;
    }) => ipcRenderer.invoke('project:get-logs', projectId, options),
    getStats: (projectId: string) => ipcRenderer.invoke('project:get-stats', projectId),
    getLogAgentIds: (projectId: string) => ipcRenderer.invoke('project:get-log-agent-ids', projectId),
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
    // v7.0: Module Graph + Probe Analysis API
    getModuleGraph: (projectId: string) =>
      ipcRenderer.invoke('project:get-module-graph', projectId),
    getKnownIssues: (projectId: string) =>
      ipcRenderer.invoke('project:get-known-issues', projectId),
    getArchitectureDoc: (projectId: string) =>
      ipcRenderer.invoke('project:get-architecture-doc', projectId),
    getProbeReports: (projectId: string) =>
      ipcRenderer.invoke('project:get-probe-reports', projectId),
    detectIncrementalChanges: (projectId: string) =>
      ipcRenderer.invoke('project:detect-incremental-changes', projectId),
    applyModuleCorrection: (projectId: string, correction: Record<string, unknown>) =>
      ipcRenderer.invoke('project:apply-module-correction', projectId, correction),
    getUserCorrections: (projectId: string) =>
      ipcRenderer.invoke('project:get-user-corrections', projectId),
    // v16.0: 项目权限开关
    getPermissions: (projectId: string) =>
      ipcRenderer.invoke('project:get-permissions', projectId),
    updatePermissions: (projectId: string, permissions: { externalRead?: boolean; externalWrite?: boolean; shellExec?: boolean }) =>
      ipcRenderer.invoke('project:update-permissions', projectId, permissions),
  },

  // ── 需求队列 (v3.1) ──
  wish: {
    create: (projectId: string, content: string) => ipcRenderer.invoke('wish:create', projectId, content),
    list: (projectId: string) => ipcRenderer.invoke('wish:list', projectId),
    get: (wishId: string) => ipcRenderer.invoke('wish:get', wishId),
    update: (wishId: string, fields: Record<string, unknown>) => ipcRenderer.invoke('wish:update', wishId, fields),
    delete: (wishId: string) => ipcRenderer.invoke('wish:delete', wishId),
  },

  // ── 团队管理 (v3.1 → v11.0) ──
  team: {
    list: (projectId: string) => ipcRenderer.invoke('team:list', projectId),
    add: (projectId: string, member: Record<string, unknown>) => ipcRenderer.invoke('team:add', projectId, member),
    update: (memberId: string, fields: Record<string, unknown>) => ipcRenderer.invoke('team:update', memberId, fields),
    delete: (memberId: string) => ipcRenderer.invoke('team:delete', memberId),
    initDefaults: (projectId: string) => ipcRenderer.invoke('team:init-defaults', projectId),
    /** v11.0: 测试成员级 LLM 连通性 */
    testMemberModel: (memberId: string, config: Record<string, unknown>) => ipcRenderer.invoke('team:test-member-model', memberId, config),
  },

  // ── 工作区文件系统 + 搜索 (v21.0) ──
  workspace: {
    tree: (projectId: string) => ipcRenderer.invoke('workspace:tree', projectId),
    readFile: (projectId: string, relativePath: string) => ipcRenderer.invoke('workspace:read-file', projectId, relativePath),
    getPath: (projectId: string) => ipcRenderer.invoke('workspace:get-path', projectId),
    /** v21.0: 项目内搜索 — 文件名 / 内容 (复用 Agent 的 ripgrep 引擎) */
    search: (projectId: string, query: string, options?: {
      mode?: 'filename' | 'content';
      include?: string[];
      caseSensitive?: boolean;
      wholeWord?: boolean;
      maxResults?: number;
      context?: number;
    }) => ipcRenderer.invoke('workspace:search', projectId, query, options),
    /** v21.0: 全局搜索 — 跨所有项目 */
    searchGlobal: (query: string, options?: {
      mode?: 'filename' | 'content';
      caseSensitive?: boolean;
      wholeWord?: boolean;
      maxResultsPerProject?: number;
    }) => ipcRenderer.invoke('workspace:search-global', query, options),
  },

  // ── v2.0: 事件流 + Mission ──
  events: {
    query: (projectId: string, options?: Record<string, unknown>) => ipcRenderer.invoke('events:query', projectId, options),
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
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const subscription = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, subscription);
    return () => ipcRenderer.removeListener(channel, subscription);
  },

  // ── MCP 服务器管理 (v5.0) ──
  mcp: {
    listServers: () => ipcRenderer.invoke('mcp:list-servers'),
    addServer: (config: Record<string, unknown>) => ipcRenderer.invoke('mcp:add-server', config),
    updateServer: (id: string, updates: Record<string, unknown>) => ipcRenderer.invoke('mcp:update-server', id, updates),
    removeServer: (id: string) => ipcRenderer.invoke('mcp:remove-server', id),
    connectServer: (id: string) => ipcRenderer.invoke('mcp:connect-server', id),
    disconnectServer: (id: string) => ipcRenderer.invoke('mcp:disconnect-server', id),
    listTools: () => ipcRenderer.invoke('mcp:list-tools'),
    testServer: (config: Record<string, unknown>) => ipcRenderer.invoke('mcp:test-server', config),
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

  // ── 密钥管理 (v13.0) ──
  secrets: {
    set: (projectId: string, key: string, value: string, provider: string) =>
      ipcRenderer.invoke('secrets:set', projectId, key, value, provider),
    get: (projectId: string, key: string) =>
      ipcRenderer.invoke('secrets:get', projectId, key),
    list: (projectId: string, provider?: string) =>
      ipcRenderer.invoke('secrets:list', projectId, provider),
    delete: (projectId: string, key: string) =>
      ipcRenderer.invoke('secrets:delete', projectId, key),
  },

  // ── v14.0: Issue Watcher (GitHub → Feature) ──
  issues: {
    sync: (projectId: string) =>
      ipcRenderer.invoke('issues:sync', projectId),
    listFeatures: (projectId: string) =>
      ipcRenderer.invoke('issues:list-features', projectId),
    startPolling: (projectId: string, intervalMinutes?: number) =>
      ipcRenderer.invoke('issues:start-polling', projectId, intervalMinutes || 10),
    stopPolling: (projectId: string) =>
      ipcRenderer.invoke('issues:stop-polling', projectId),
  },

  // ── 元Agent对话 + 管理 (v5.4 → v7.0) ──
  metaAgent: {
    chat: (
      projectId: string | null,
      message: string,
      history?: Array<{ role: string; content: string | Array<Record<string, unknown>> }>,
      attachments?: Array<{ type: string; name: string; data: string; mimeType: string }>,
      chatMode?: string,
    ) =>
      ipcRenderer.invoke('meta-agent:chat', projectId, message, history, attachments, chatMode),
    // Config
    getConfig: () => ipcRenderer.invoke('meta-agent:config:get'),
    saveConfig: (config: Record<string, unknown>) => ipcRenderer.invoke('meta-agent:config:save', config),
    // Memory
    listMemories: (category?: string, limit?: number) =>
      ipcRenderer.invoke('meta-agent:memory:list', category, limit),
    addMemory: (memory: { category: string; content: string; source?: string; importance?: number }) => ipcRenderer.invoke('meta-agent:memory:add', memory),
    updateMemory: (id: string, updates: { content?: string; importance?: number; category?: string }) => ipcRenderer.invoke('meta-agent:memory:update', id, updates),
    deleteMemory: (id: string) => ipcRenderer.invoke('meta-agent:memory:delete', id),
    searchMemories: (query: string, limit?: number) => ipcRenderer.invoke('meta-agent:memory:search', query, limit),
    getMemoryStats: () => ipcRenderer.invoke('meta-agent:memory:stats'),
    clearMemories: (category?: string) => ipcRenderer.invoke('meta-agent:memory:clear', category),
    // Daemon (heartbeat/hooks/cron)
    getDaemonStatus: () => ipcRenderer.invoke('meta-agent:daemon:status'),
    getDaemonConfig: () => ipcRenderer.invoke('meta-agent:daemon:config:get'),
    saveDaemonConfig: (config: Record<string, unknown>) => ipcRenderer.invoke('meta-agent:daemon:config:save', config),
    startDaemon: () => ipcRenderer.invoke('meta-agent:daemon:start'),
    stopDaemon: () => ipcRenderer.invoke('meta-agent:daemon:stop'),
    triggerHeartbeat: () => ipcRenderer.invoke('meta-agent:daemon:trigger'),
    getDaemonLogs: (limit?: number) => ipcRenderer.invoke('meta-agent:daemon:logs', limit),
    // v20.0: Chat Messages 持久化
    saveMessage: (msg: {
      id: string; sessionId: string; projectId: string | null;
      role: 'user' | 'assistant' | 'system'; content: string;
      triggeredWish?: boolean; attachments?: string;
    }) => ipcRenderer.invoke('meta-agent:messages:save', msg),
    updateMessage: (id: string, updates: { content?: string; triggeredWish?: boolean }) =>
      ipcRenderer.invoke('meta-agent:messages:update', id, updates),
    loadMessages: (sessionId: string, limit?: number) =>
      ipcRenderer.invoke('meta-agent:messages:load', sessionId, limit),
    listChatSessions: (projectId?: string | null, limit?: number) =>
      ipcRenderer.invoke('meta-agent:messages:list-sessions', projectId, limit),
    deleteSessionMessages: (sessionId: string) =>
      ipcRenderer.invoke('meta-agent:messages:delete-session', sessionId),
  },

  // ── 临时工作流 (v5.5) ──
  ephemeralMission: {
    create: (projectId: string, type: string, config?: Record<string, unknown>) =>
      ipcRenderer.invoke('mission:create', projectId, type, config),
    get: (missionId: string) => ipcRenderer.invoke('mission:get', missionId),
    list: (projectId: string) => ipcRenderer.invoke('mission:list', projectId),
    getTasks: (missionId: string) => ipcRenderer.invoke('mission:get-tasks', missionId),
    cancel: (missionId: string) => ipcRenderer.invoke('mission:cancel', missionId),
    cleanup: (missionId: string) => ipcRenderer.invoke('mission:cleanup', missionId),
    delete: (missionId: string) => ipcRenderer.invoke('mission:delete', missionId),
    getPatches: (missionId: string) => ipcRenderer.invoke('mission:get-patches', missionId),
  },

  // ── 上下文管理 (v5.6) ──
  context: {
    previewBaseline: (projectId: string, role: string, tokenBudget?: number) =>
      ipcRenderer.invoke('context:preview-baseline', projectId, role, tokenBudget),
  },

  // ── Session / Backup 管理 (v8.0) + Feature-Session 关联 (v8.1) ──
  session: {
    create: (projectId: string | null, agentId: string, agentRole: string, chatMode?: string) =>
      ipcRenderer.invoke('session:create', projectId, agentId, agentRole, chatMode),
    switch: (sessionId: string) =>
      ipcRenderer.invoke('session:switch', sessionId),
    getActive: (projectId: string | null, agentId: string) =>
      ipcRenderer.invoke('session:get-active', projectId, agentId),
    list: (projectId: string | null, agentId?: string) =>
      ipcRenderer.invoke('session:list', projectId, agentId),
    listAll: (limit?: number) =>
      ipcRenderer.invoke('session:list-all', limit),
    readBackup: (sessionId: string) =>
      ipcRenderer.invoke('session:read-backup', sessionId),
    openBackupFolder: (sessionId: string) =>
      ipcRenderer.invoke('session:open-backup-folder', sessionId),
    backupStats: () =>
      ipcRenderer.invoke('session:backup-stats'),
    cleanup: (keepDays?: number) =>
      ipcRenderer.invoke('session:cleanup', keepDays),
    // v8.1: Feature-Session 关联查询
    /** 获取某个 Feature 关联的所有 Sessions */
    featureSessions: (projectId: string, featureId: string) =>
      ipcRenderer.invoke('session:feature-sessions', projectId, featureId),
    /** 获取某个 Session 关联的所有 Features */
    sessionFeatures: (sessionId: string) =>
      ipcRenderer.invoke('session:session-features', sessionId),
    /** 获取项目所有 Feature-Session 关联 */
    featureSessionLinks: (projectId: string, limit?: number) =>
      ipcRenderer.invoke('session:feature-session-links', projectId, limit),
    /** 批量获取项目所有 Feature 的 Session 摘要 (看板用) */
    batchFeatureSummaries: (projectId: string) =>
      ipcRenderer.invoke('session:batch-feature-summaries', projectId),
  },

  // ── 工作流预设管理 (v12.0) ──
  workflow: {
    list: (projectId: string) => ipcRenderer.invoke('workflow:list', projectId),
    getActive: (projectId: string) => ipcRenderer.invoke('workflow:get-active', projectId),
    get: (presetId: string) => ipcRenderer.invoke('workflow:get', presetId),
    activate: (projectId: string, presetId: string) => ipcRenderer.invoke('workflow:activate', projectId, presetId),
    create: (projectId: string, data: Record<string, unknown>) => ipcRenderer.invoke('workflow:create', projectId, data),
    update: (presetId: string, updates: Record<string, unknown>) => ipcRenderer.invoke('workflow:update', presetId, updates),
    delete: (presetId: string) => ipcRenderer.invoke('workflow:delete', presetId),
    duplicate: (presetId: string) => ipcRenderer.invoke('workflow:duplicate', presetId),
    availableStages: () => ipcRenderer.invoke('workflow:available-stages'),
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

  // ── 系统监控 + 活动时序 (v6.0) ──
  monitor: {
    /** 获取系统性能快照 (CPU/GPU/内存/硬盘/网络) */
    getSystemMetrics: () => ipcRenderer.invoke('monitor:system-metrics'),
    /** 获取项目活动时序数据 (每分钟 token/cost/代码行) */
    getActivityTimeseries: (projectId: string, minutes?: number) =>
      ipcRenderer.invoke('monitor:activity-timeseries', projectId, minutes),
    /** 获取内置模型价格表 */
    getBuiltinPricing: () => ipcRenderer.invoke('monitor:builtin-pricing'),
  },
});

