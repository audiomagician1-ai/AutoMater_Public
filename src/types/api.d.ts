/**
 * Preload API 类型声明 — 渲染进程可用的接口
 */

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
  source: 'project-config' | 'architecture' | 'file-tree' | 'repo-map' | 'dependency' | 'keyword-match' | 'code-graph' | 'plan' | 'qa-feedback';
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
  featureId: string;
  timestamp: number;
  sections: ContextSection[];
  totalChars: number;
  totalTokens: number;
  tokenBudget: number;
  contextText: string;
  filesIncluded: number;
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

interface AgentForgeAPI {
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
    list(): Promise<any[]>;
    get(id: string): Promise<any>;
    getFeatures(projectId: string): Promise<any[]>;
    getAgents(projectId: string): Promise<any[]>;
    getLogs(projectId: string, options?: {
      limit?: number; offset?: number; agentId?: string; type?: string; keyword?: string;
    }): Promise<{ rows: any[]; total: number }>;
    getStats(projectId: string): Promise<{ features: any; agents: any }>;
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
    add(projectId: string, member: Partial<TeamMember>): Promise<{ success: boolean; memberId: string }>;
    update(memberId: string, fields: Partial<TeamMember>): Promise<{ success: boolean }>;
    delete(memberId: string): Promise<{ success: boolean }>;
    initDefaults(projectId: string): Promise<{ success: boolean; count?: number }>;
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

  /** v5.2: 缩放控制 */
  zoom: {
    /** 获取当前缩放倍率 (1.0 = 100%) */
    get(): number;
    /** 设置缩放倍率 (0.5 ~ 3.0) */
    set(factor: number): void;
  };
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

/** 团队成员 (v3.1) */
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

declare global {
  interface Window {
    agentforge: AgentForgeAPI;
  }
}

export {};

