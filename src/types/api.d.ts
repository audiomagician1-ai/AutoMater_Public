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
    getLogs(projectId: string, limit?: number): Promise<any[]>;
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
}

declare global {
  interface Window {
    agentforge: AgentForgeAPI;
  }
}

export {};

