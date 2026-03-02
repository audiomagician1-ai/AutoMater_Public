/**
 * Preload API 类型声明 — 渲染进程可用的接口
 */

/** v6.0: 系统性能指标 */
interface SystemMetrics {
  timestamp: number;
  cpu: { usage: number; cores: number; perCore: number[] };
  memory: { used: number; total: number; percent: number };
  gpu: { usage: number; memoryPercent: number; name: string };
  disk: { readBytesPerSec: number; writeBytesPerSec: number };
  network: { rxBytesPerSec: number; txBytesPerSec: number };
  process: { memoryMB: number; uptimeS: number };
}

/** v6.0: 活动时序数据点 */
interface ActivityDataPoint {
  minute: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  linesWritten: number;
  llmCalls: number;
  toolCalls: number;
}

/** v6.0: 模型定价 */
interface ModelPricingEntry {
  input: number;
  output: number;
}

/** v7.0: 元Agent 管理配置 */
interface MetaAgentConfig {
  name: string;
  userNickname: string;
  personality: string;
  systemPrompt: string;
  contextHistoryLimit: number;
  contextTokenLimit: number;
  maxResponseTokens: number;
  autoMemory: boolean;
  memoryInjectLimit: number;
  greeting: string;
}

/** v7.0: 元Agent 记忆记录 */
interface MetaAgentMemoryRecord {
  id: string;
  category: 'identity' | 'user_profile' | 'lessons' | 'facts' | 'conversation_summary';
  content: string;
  source: 'auto' | 'manual' | 'system';
  importance: number;
  created_at: string;
  updated_at: string;
}

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: FileNode[];
}

/** 上下文模块 (v1.1) */
interface ContextSection {
  id: string;
  name: string;
  source: string;
  content: string;
  chars: number;
  tokens: number;
  truncated: boolean;
  files?: string[];
  budgetRatio?: number;
}

/** 上下文快照 (v1.1) */
interface ContextSnapshot {
  agentId: string;
  featureId?: string;
  timestamp: number;
  sections: ContextSection[];
  totalChars?: number;
  totalTokens: number;
  tokenBudget: number;
  contextText?: string;
  filesIncluded?: number;
}

/** 消息 token 分布 (v1.1) */
interface MessageTokenBreakdown {
  role: 'system' | 'user' | 'assistant' | 'tool';
  tokens: number;
  count: number;
}

/** 单次 ReAct 迭代状态 (v1.1) */
interface ReactIterationState {
  iteration: number;
  timestamp: number;
  messageCount: number;
  totalContextTokens: number;
  breakdown: MessageTokenBreakdown[];
  inputTokensThisCall: number;
  outputTokensThisCall: number;
  costThisCall: number;
  cumulativeCost: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  filesWritten: string[];
  toolCallsThisIteration: string[];
  completed: boolean;
}

/** Agent ReAct 完整状态 (v1.1) */
interface AgentReactState {
  agentId: string;
  featureId: string;
  iterations: ReactIterationState[];
  maxContextWindow: number;
}

interface AutoMaterAPI {
  settings: {
    get(): Promise<AppSettings>;
    save(settings: AppSettings): Promise<{ success: boolean }>;
  };
  llm: {
    testConnection(provider: { type: string; baseUrl: string; apiKey: string }): Promise<{ success: boolean; message: string }>;
    chat(request: { model: string; messages: Array<{ role: string; content: string }> }): Promise<any>;
    listModels(provider: { type: string; baseUrl: string; apiKey: string }): Promise<{ success: boolean; models: string[] }>;
  };
  project: {
    create(name: string, options?: {
      workspacePath?: string;
      gitMode?: string;
      githubRepo?: string;
      githubToken?: string;
    }): Promise<{ success: boolean; projectId: string; name: string; workspacePath: string }>;
    setWish(projectId: string, wish: string): Promise<{ success: boolean }>;
    start(projectId: string): Promise<{ success: boolean }>;
    list(): Promise<Array<ProjectRow>>;
    get(id: string): Promise<ProjectRow | null>;
    getFeatures(projectId: string): Promise<Array<FeatureRow>>;
    getAgents(projectId: string): Promise<Array<TeamMember & { status?: string; current_task?: string }>>;
    getLogs(projectId: string, options?: {
      limit?: number; offset?: number; agentId?: string; type?: string; keyword?: string;
    }): Promise<{ rows: Array<LogRow>; total: number }>;
    getStats(projectId: string): Promise<{ features: Record<string, number>; agents: Record<string, number> }>;
    stop(projectId: string): Promise<{ success: boolean }>;
    delete(projectId: string): Promise<{ success: boolean }>;
    openWorkspace(projectId: string): Promise<{ success: boolean; error?: string }>;
    export(projectId: string): Promise<{ success: boolean; path?: string; error?: string }>;
    gitCommit(projectId: string, message: string): Promise<{ success: boolean; hash?: string; pushed?: boolean }>;
    gitLog(projectId: string): Promise<string[]>;
    testGitHub(repo: string, token: string): Promise<{ success: boolean; message: string }>;
    getContextSnapshots(projectId: string): Promise<Record<string, ContextSnapshot>>;
    getReactStates(projectId: string): Promise<Record<string, AgentReactState>>;
    /** v4.2: 用户验收 */
    userAccept(projectId: string, accept: boolean, feedback?: string): Promise<{ success: boolean; status: string; feedback?: string }>;
    /** v4.2: 获取 Feature 文档 (子需求 + 测试规格) */
    getFeatureDocs(projectId: string, featureId: string): Promise<{ requirement: string | null; testSpec: string | null }>;
    /** v4.2: 获取设计文档 */
    getDesignDoc(projectId: string): Promise<string | null>;
    /** v4.2: 获取文档变更日志 */
    getDocChangelog(projectId: string): Promise<DocChangeEntry[]>;
    /** v4.4: 列出所有文档元信息 */
    listAllDocs(projectId: string): Promise<DocListResult>;
    /** v4.4: 读取单个文档内容 */
    readDoc(projectId: string, type: 'design' | 'requirement' | 'test_spec', id: string): Promise<string | null>;
    /** v4.3: 提交需求变更 */
    submitChange(projectId: string, description: string): Promise<{ success: boolean; changeRequestId: string }>;
    /** v4.3: 获取变更请求列表 */
    listChanges(projectId: string): Promise<ChangeRequestItem[]>;
    /** v4.3: 获取影响分析 */
    getImpactAnalysis(changeRequestId: string): Promise<ChangeRequestDetail | null>;
    /** v5.1: 分析已有项目（异步，进度通过 project:import-progress 事件推送） */
    analyzeExisting(projectId: string): Promise<{ success: boolean; message?: string; error?: string }>;
  };
  /** v3.1: 需求队列 */
  wish: {
    create(projectId: string, content: string): Promise<{ success: boolean; wishId: string }>;
    list(projectId: string): Promise<WishItem[]>;
    get(wishId: string): Promise<WishItem | null>;
    update(wishId: string, fields: Partial<{ status: string; pm_analysis: string; design_doc: string; content: string }>): Promise<{ success: boolean }>;
    delete(wishId: string): Promise<{ success: boolean }>;
  };
  /** v3.1: 团队管理 */
  team: {
    list(projectId: string): Promise<TeamMember[]>;
    /** v9.0: 成功后触发 team:member-added IPC 事件 (热加入) */
    add(projectId: string, member: Partial<TeamMember>): Promise<{ success: boolean; memberId: string }>;
    update(memberId: string, fields: Partial<TeamMember>): Promise<{ success: boolean }>;
    delete(memberId: string): Promise<{ success: boolean }>;
    initDefaults(projectId: string): Promise<{ success: boolean; count?: number }>;
    /** v11.0: 测试成员级 LLM 连通性 (使用成员自己的配置, fallback 到全局) */
    testMemberModel(memberId: string, config: MemberLLMConfig): Promise<{ success: boolean; message: string; model?: string }>;
  };
  workspace: {
    tree(projectId: string): Promise<{ success: boolean; tree: FileNode[] }>;
    readFile(projectId: string, relativePath: string): Promise<{ success: boolean; content: string }>;
    getPath(projectId: string): Promise<string | null>;
  };
  events: {
    query(projectId: string, options?: { featureId?: string; types?: string[]; limit?: number }): Promise<any[]>;
    getStats(projectId: string): Promise<any>;
    getTimeline(projectId: string, featureId: string): Promise<any[]>;
    exportNDJSON(projectId: string): Promise<string>;
  };
  mission: {
    getStatus(projectId: string): Promise<any>;
    getCheckpoints(projectId: string): Promise<any[]>;
    getProgressReport(projectId: string): Promise<string>;
    detectResumable(): Promise<any[]>;
  };
  knowledge: {
    getStats(): Promise<any>;
    query(tags: string[]): Promise<any[]>;
  };
  on(channel: string, callback: (...args: any[]) => void): () => void;

  /** v5.0: MCP 服务器管理 */
  mcp: {
    listServers(): Promise<McpServerStatus[]>;
    addServer(config: Omit<McpServerConfig, 'id'>): Promise<{ success: boolean; id: string }>;
    updateServer(id: string, updates: Partial<McpServerConfig>): Promise<{ success: boolean; error?: string }>;
    removeServer(id: string): Promise<{ success: boolean }>;
    connectServer(id: string): Promise<{ success: boolean; tools: McpToolSummary[]; error?: string }>;
    disconnectServer(id: string): Promise<{ success: boolean }>;
    listTools(): Promise<McpToolSummary[]>;
    testServer(config: McpServerConfig): Promise<{ success: boolean; tools: McpToolSummary[]; error?: string }>;
  };

  /** v5.0: Skill 目录管理 */
  skill: {
    getDirectory(): Promise<string>;
    setDirectory(dirPath: string): Promise<{ success: boolean; loaded: number; skills: SkillSummary[]; errors: Array<{ file: string; error: string }> }>;
    reload(): Promise<{ success: boolean; loaded: number; skills: SkillSummary[]; errors: Array<{ file: string; error: string }> }>;
    list(): Promise<SkillSummary[]>;
  };

  /** v5.1: Skill 进化系统 */
  skillEvolution: {
    getIndex(): Promise<SkillEvolutionEntry[]>;
    getOverview(): Promise<SkillEvolutionOverview>;
    getSkill(id: string): Promise<SkillEvolutionDetail | null>;
    getKnowledge(id: string): Promise<string | null>;
    deprecate(id: string, reason: string): Promise<{ success: boolean }>;
    getRanked(): Promise<Array<SkillEvolutionEntry & { score: number }>>;
  };

  /** v5.1: 文件夹选择对话框 */
  dialog: {
    openDirectory(title?: string): Promise<{ canceled: boolean; filePaths: string[] }>;
  };

  /** v5.4 → v7.0: 元Agent对话 + 管理 + 记忆 */
  metaAgent: {
    chat(projectId: string | null, message: string, history?: Array<{ role: string; content: string }>): Promise<{
      reply: string;
      intent: 'wish' | 'query' | 'workflow' | 'general';
      wishCreated?: boolean;
      tokens?: number;
      cost?: number;
    }>;
    // Config
    getConfig(): Promise<MetaAgentConfig>;
    saveConfig(config: Partial<MetaAgentConfig>): Promise<{ success: boolean; config: MetaAgentConfig }>;
    // Memory
    listMemories(category?: string, limit?: number): Promise<MetaAgentMemoryRecord[]>;
    addMemory(memory: { category: string; content: string; source?: string; importance?: number }): Promise<MetaAgentMemoryRecord>;
    updateMemory(id: string, updates: { content?: string; importance?: number; category?: string }): Promise<{ success: boolean }>;
    deleteMemory(id: string): Promise<{ success: boolean }>;
    searchMemories(query: string, limit?: number): Promise<MetaAgentMemoryRecord[]>;
    getMemoryStats(): Promise<{ total: number; byCategory: Record<string, number> }>;
    clearMemories(category?: string): Promise<{ success: boolean }>;
  };

  /** v6.0: 临时工作流 */
  ephemeralMission: {
    create(projectId: string, type: string, config?: { scope?: string; tokenBudget?: number; ttlHours?: number; maxWorkers?: number; customInstruction?: string; archivePolicy?: 'keep-all' | 'keep-conclusion' | 'delete' }): Promise<{ success: boolean; missionId?: string; error?: string }>;
    get(missionId: string): Promise<MissionRecord | null>;
    list(projectId: string): Promise<MissionRecord[]>;
    getTasks(missionId: string): Promise<MissionTaskRecord[]>;
    cancel(missionId: string): Promise<{ success: boolean }>;
    cleanup(missionId: string): Promise<{ success: boolean }>;
    delete(missionId: string): Promise<{ success: boolean }>;
    getPatches(missionId: string): Promise<Array<{ file: string; diff: string; description: string }>>;
  };

  /** v12.0: 工作流预设管理 */
  workflow: {
    list(projectId: string): Promise<WorkflowPresetInfo[]>;
    getActive(projectId: string): Promise<WorkflowPresetInfo | null>;
    get(presetId: string): Promise<WorkflowPresetInfo | null>;
    activate(projectId: string, presetId: string): Promise<{ success: boolean }>;
    create(projectId: string, data: { name: string; description?: string; icon?: string; stages: WorkflowStageInfo[] }): Promise<WorkflowPresetInfo>;
    update(presetId: string, updates: { name?: string; description?: string; icon?: string; stages?: WorkflowStageInfo[] }): Promise<WorkflowPresetInfo | null>;
    delete(presetId: string): Promise<{ success: boolean; error?: string }>;
    duplicate(presetId: string): Promise<WorkflowPresetInfo | { success: false; error: string }>;
    availableStages(): Promise<WorkflowStageInfo[]>;
  };

  /** v5.2: 缩放控制 */
  zoom: {
    /** 获取当前缩放倍率 (1.0 = 100%) */
    get(): number;
    /** 设置缩放倍率 (0.5 ~ 3.0) */
    set(factor: number): void;
  };

  /** v6.0: 系统监控 + 活动时序 */
  monitor: {
    /** 获取系统性能快照 */
    getSystemMetrics(): Promise<SystemMetrics>;
    /** 获取项目活动时序数据 */
    getActivityTimeseries(projectId: string, minutes?: number): Promise<ActivityDataPoint[]>;
    /** 获取内置模型价格表 */
    getBuiltinPricing(): Promise<Record<string, { input: number; output: number }>>;
  };

  /** v8.0: Session 管理 + v8.1: Feature-Session 关联 */
  session: {
    create(projectId: string | null, agentId: string, agentRole: string): Promise<SessionInfo>;
    switch(sessionId: string): Promise<SessionInfo | null>;
    getActive(projectId: string | null, agentId: string): Promise<SessionInfo | null>;
    list(projectId: string | null, agentId?: string): Promise<SessionInfo[]>;
    listAll(limit?: number): Promise<SessionInfo[]>;
    readBackup(sessionId: string): Promise<any>;
    backupStats(): Promise<{ totalSessions: number; totalBackupFiles: number; totalBackupSizeBytes: number; oldestBackup: string | null; newestBackup: string | null }>;
    cleanup(keepDays?: number): Promise<{ success: boolean; deletedFolders: number }>;
    /** v8.1: 获取某个 Feature 关联的所有 Sessions */
    featureSessions(projectId: string, featureId: string): Promise<Array<FeatureSessionLink & { session: SessionInfo | null }>>;
    /** v8.1: 获取某个 Session 关联的所有 Features */
    sessionFeatures(sessionId: string): Promise<FeatureSessionLink[]>;
    /** v8.1: 获取项目所有 Feature-Session 关联 */
    featureSessionLinks(projectId: string, limit?: number): Promise<FeatureSessionLink[]>;
    /** v8.1: 批量获取项目所有 Feature 的 Session 摘要 (看板用) */
    batchFeatureSummaries(projectId: string): Promise<Record<string, FeatureSessionSummary>>;
  };
}

// ═══════════════════════════════════════════════════
// IPC Event Data Types — 主进程推送到渲染进程的事件
// ═══════════════════════════════════════════════════

interface IpcAgentLogData {
  projectId: string;
  agentId: string;
  content: string;
}

interface IpcAgentSpawnedData {
  projectId: string;
  agentId: string;
  role: string;
}

interface IpcAgentStatusData {
  agentId: string;
  status: string;
  currentTask?: string | null;
  featureTitle?: string;
}

interface IpcFeatureStatusData {
  featureId: string;
  status: string;
}

interface IpcProjectStatusData {
  projectId: string;
  status: string;
}

interface IpcProjectFeaturesReadyData {
  projectId: string;
  count: number;
}

interface IpcAgentErrorData {
  projectId: string;
  error: string;
}

interface IpcAgentToolCallData {
  projectId: string;
  agentId: string;
  tool: string;
  args: string;
  success: boolean;
  outputPreview: string;
}

interface IpcContextSnapshotData {
  snapshot?: ContextSnapshot;
}

interface IpcReactStateData {
  state?: AgentReactState;
}

interface IpcStreamStartData {
  agentId: string;
  label?: string;
}

interface IpcStreamData {
  agentId: string;
  chunk: string;
}

interface IpcStreamEndData {
  agentId: string;
}

interface IpcAwaitingAcceptanceData {
  projectId: string;
}

interface IpcImportProgressData {
  projectId: string;
  phase: number;
  step: string;
  progress: number;
  done?: boolean;
  error?: string;
  message?: string;
}

interface IpcWorkspaceChangedData {
  projectId: string;
  file: string;
  changeType: string;
}

/** 需求条目 (v3.1) */
interface WishItem {
  id: string;
  project_id: string;
  content: string;
  status: 'pending' | 'analyzing' | 'analyzed' | 'developing' | 'done' | 'rejected';
  pm_analysis: string | null;
  design_doc: string | null;
  created_at: string;
  updated_at: string;
}

/** 团队成员 (v3.1 → v11.0: +llm_config/mcp_servers/skills) */
interface TeamMember {
  id: string;
  project_id: string;
  role: string;
  name: string;
  model: string | null;
  capabilities: string;  // JSON array string
  system_prompt: string | null;
  context_files: string;  // JSON array string
  max_context_tokens: number;
  created_at: string;
  /** v11.0: 成员级 LLM 配置 (JSON string or null) */
  llm_config: string | null;
  /** v11.0: 成员级 MCP 服务器 (JSON string or null) */
  mcp_servers: string | null;
  /** v11.0: 成员级 Skill 列表 (JSON string or null) */
  skills: string | null;
}

/** v11.0: 成员级 LLM 配置 — 覆盖全局设置 */
interface MemberLLMConfig {
  provider?: 'openai' | 'anthropic' | 'custom';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** v11.0: 成员级 MCP 服务器 */
interface MemberMcpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

/** v11.0: 成员级 Skill 引用 */
interface MemberSkillRef {
  name: string;
  override?: Record<string, unknown>;
}

/** 文档变更记录 (v4.2) */
interface DocChangeEntry {
  timestamp: string;
  type: 'design' | 'requirement' | 'test_spec';
  id: string;
  version: number;
  action: 'create' | 'update';
  summary: string;
  agentId: string;
}

/** 变更请求列表项 (v4.3) */
interface ChangeRequestItem {
  id: string;
  project_id: string;
  description: string;
  status: 'pending' | 'analyzing' | 'updating' | 'completed' | 'failed';
  affected_features: string;
  created_at: string;
  completed_at: string | null;
}

/** 变更请求详情 (v4.3) */
interface ChangeRequestDetail extends ChangeRequestItem {
  impactAnalysis: {
    affectedFeatures: Array<{ featureId: string; reason: string; severity: 'major' | 'minor' }>;
    docsToUpdate: Array<{ type: string; id: string; changeDescription: string }>;
    newFeaturesNeeded: Array<{ title: string; description: string; reason: string }>;
    riskLevel: 'low' | 'medium' | 'high';
    riskNotes: string;
    impactPercent: number;
  } | null;
  affectedFeatures: string[];
}

/** 文档元信息 (v4.4) */
interface DocMeta {
  type: 'design' | 'requirement' | 'test_spec';
  id: string;
  path: string;
  version: number;
  updatedAt: string;
  sizeBytes: number;
}

/** 文档列表结果 (v4.4) */
interface DocListResult {
  design: DocMeta[];
  requirements: DocMeta[];
  testSpecs: DocMeta[];
}

interface AppSettings {
  llmProvider: 'openai' | 'anthropic' | 'custom';
  apiKey: string;
  baseUrl: string;
  /** 强模型 — PM / 架构设计 / QA 审查 */
  strongModel: string;
  /** 工作模型 — Developer 编码 / Planner */
  workerModel: string;
  /** 快速模型 — 摘要 / 格式化 / 子任务 (可选，不填则用 workerModel) */
  fastModel: string;
  /** 并行 Worker 数量 (0 = 不限) */
  workerCount: number;
  /** 每日预算上限 USD (0 = 不限) */
  dailyBudgetUsd: number;
  /** UI 缩放倍率 (1.0 = 100%, 默认 1.5) */
  zoomFactor?: number;
  /** 用户自定义模型定价 ($/1K tokens)。key = 模型名 */
  modelPricing?: Record<string, ModelPricingEntry>;
}

/** MCP 服务器配置 (v5.0) */
interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  allowedRoles?: string[];
}

/** MCP 服务器状态 (含连接信息) (v5.0) */
interface McpServerStatus extends McpServerConfig {
  connected: boolean;
  toolCount: number;
}

/** MCP 工具摘要 (v5.0) */
interface McpToolSummary {
  name: string;
  description: string;
  serverId: string;
  inputSchema?: Record<string, any>;
}

/** Skill 摘要 (v5.0) */
interface SkillSummary {
  name: string;
  description: string;
  sourceFile?: string;
}

/** Skill 进化索引条目 (v5.1) */
interface SkillEvolutionEntry {
  id: string;
  name: string;
  trigger: string;
  tags: string[];
  maturity: 'draft' | 'proven' | 'stable' | 'deprecated';
  version: number;
  usedCount: number;
  successRate: number;
  lastUsed: string | null;
}

/** Skill 进化概览 (v5.1) */
interface SkillEvolutionOverview {
  total: number;
  byMaturity: Record<string, number>;
  totalUsages: number;
  avgSuccessRate: number;
}

/** Skill 进化完整详情 (v5.1) */
interface SkillEvolutionDetail {
  id: string;
  name: string;
  description: string;
  trigger: string;
  tags: string[];
  maturity: 'draft' | 'proven' | 'stable' | 'deprecated';
  version: number;
  stats: {
    usedCount: number;
    successCount: number;
    lastUsed: string | null;
    projectIds: string[];
    userRating: number;
    recentFeedback: Array<{ timestamp: string; agentId: string; feedback: string; success: boolean }>;
  };
  history: Array<{ version: number; timestamp: string; author: string; changeNote: string }>;
  source: { type: string; projectId?: string; agentId?: string; timestamp: string };
  createdAt: string;
  updatedAt: string;
}

/** Mission 记录 (v5.5) */
interface MissionRecord {
  id: string;
  project_id: string;
  type: string;
  status: 'pending' | 'planning' | 'executing' | 'judging' | 'completed' | 'failed' | 'cancelled';
  config: string;
  plan: string | null;
  conclusion: string | null;
  patches: string;
  token_usage: number;
  cost_usd: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/** Mission 任务记录 (v5.5) */
interface MissionTaskRecord {
  id: string;
  mission_id: string;
  title: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  agent_id: string | null;
  input: string | null;
  output: string | null;
  created_at: string;
  completed_at: string | null;
}

interface Window {
  automater: AutoMaterAPI;
}

/** Session 信息 (v8.0) */
interface SessionInfo {
  id: string;
  projectId: string | null;
  agentId: string;
  agentRole: string;
  agentSeq: number;
  status: 'active' | 'completed' | 'archived';
  backupPath: string | null;
  createdAt: string;
  completedAt: string | null;
  messageCount: number;
  totalTokens: number;
  totalCost: number;
}

/** Feature-Session 关联记录 (v8.1) */
interface FeatureSessionLink {
  id: string;
  featureId: string;
  sessionId: string;
  projectId: string;
  agentId: string;
  agentRole: string;
  workType: string;
  expectedOutput: string;
  actualOutput: string | null;
  status: 'pending' | 'active' | 'completed' | 'failed';
  createdAt: string;
  completedAt: string | null;
}

/** Feature 的 Session 摘要 (v8.1, 看板卡片用) */
interface FeatureSessionSummary {
  totalSessions: number;
  workTypes: string[];
  lastWorkType: string | null;
  lastAgent: string | null;
}

/** 工作流阶段定义 (v12.0) */
interface WorkflowStageInfo {
  id: string;
  label: string;
  icon: string;
  color: string;
  config?: Record<string, unknown>;
  skippable?: boolean;
}

/** 工作流预设 (v12.0) */
interface WorkflowPresetInfo {
  id: string;
  projectId: string;
  name: string;
  description: string;
  icon: string;
  stages: WorkflowStageInfo[];
  isActive: boolean;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

