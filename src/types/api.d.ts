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
  source: 'project-config' | 'architecture' | 'file-tree' | 'repo-map' | 'dependency' | 'keyword-match' | 'plan' | 'qa-feedback';
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
    create(wish: string, options?: { gitMode?: string; githubRepo?: string; githubToken?: string }): Promise<{ success: boolean; projectId: string; name: string; workspacePath: string }>;
    list(): Promise<any[]>;
    get(id: string): Promise<any>;
    getFeatures(projectId: string): Promise<any[]>;
    getAgents(projectId: string): Promise<any[]>;
    getLogs(projectId: string, limit?: number): Promise<any[]>;
    getStats(projectId: string): Promise<{ features: any; agents: any }>;
    start(projectId: string): Promise<{ success: boolean }>;
    stop(projectId: string): Promise<{ success: boolean }>;
    delete(projectId: string): Promise<{ success: boolean }>;
    openWorkspace(projectId: string): Promise<{ success: boolean; error?: string }>;
    export(projectId: string): Promise<{ success: boolean; path?: string; error?: string }>;
    gitCommit(projectId: string, message: string): Promise<{ success: boolean; hash?: string; pushed?: boolean }>;
    gitLog(projectId: string): Promise<string[]>;
    testGitHub(repo: string, token: string): Promise<{ success: boolean; message: string }>;
    getContextSnapshots(projectId: string): Promise<Record<string, ContextSnapshot>>;
  };
  workspace: {
    tree(projectId: string): Promise<{ success: boolean; tree: FileNode[] }>;
    readFile(projectId: string, relativePath: string): Promise<{ success: boolean; content: string }>;
    getPath(projectId: string): Promise<string | null>;
  };
  on(channel: string, callback: (...args: any[]) => void): () => void;
}

interface AppSettings {
  llmProvider: 'openai' | 'anthropic' | 'custom';
  apiKey: string;
  baseUrl: string;
  strongModel: string;
  workerModel: string;
  workerCount: number;
  dailyBudgetUsd: number;
}

declare global {
  interface Window {
    agentforge: AgentForgeAPI;
  }
}

export {};

