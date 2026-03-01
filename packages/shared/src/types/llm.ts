/**
 * LLM 接入层类型定义
 * 
 * 模型中立，支持 OpenAI / Anthropic / 本地 / 自定义 API
 */

export type LLMProviderType = 'openai' | 'anthropic' | 'local' | 'custom';

export interface ModelConfig {
  id: string;
  name: string;
  contextWindow: number;
  inputPricePer1k: number;   // USD per 1k input tokens
  outputPricePer1k: number;  // USD per 1k output tokens
}

export interface LLMProvider {
  id: string;
  name: string;
  type: LLMProviderType;
  baseUrl: string;
  apiKey: string;
  models: ModelConfig[];
  enabled: boolean;
}

/** LLM 对话消息 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: MessageRole;
  content: string;
  name?: string;           // tool name
  toolCallId?: string;
}

/** LLM 调用请求 */
export interface LLMRequest {
  providerId: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
}

/** LLM 调用响应 */
export interface LLMResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  finishReason: 'stop' | 'max_tokens' | 'tool_use';
  toolCalls?: ToolCall[];
}

/** 工具定义 (function calling) */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 工具调用 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Token & 成本追踪记录 */
export interface CostRecord {
  timestamp: string;
  agentId: string;
  featureIds: string[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
