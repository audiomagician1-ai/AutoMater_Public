/**
 * Preload API 类型声明 — 渲染进程可用的接口
 */

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
    create(wish: string): Promise<{ success: boolean; projectId: string; name: string }>;
    list(): Promise<any[]>;
    get(id: string): Promise<any>;
    getFeatures(projectId: string): Promise<any[]>;
    getAgents(projectId: string): Promise<any[]>;
    start(projectId: string): Promise<{ success: boolean }>;
    stop(projectId: string): Promise<{ success: boolean }>;
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
