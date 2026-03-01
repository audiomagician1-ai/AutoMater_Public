/**
 * LLM Adapter 基础接口
 * 
 * 所有 Provider 必须实现此接口，确保模型中立
 */

import type { LLMRequest, LLMResponse, ChatMessage } from '@agentforge/shared';

export interface LLMAdapter {
  readonly providerId: string;
  readonly providerType: string;

  /** 发送请求，返回完整响应 */
  chat(request: LLMRequest): Promise<LLMResponse>;

  /** 流式请求，返回 AsyncIterator */
  chatStream(request: LLMRequest): AsyncIterable<StreamChunk>;

  /** 测试连接是否正常 */
  healthCheck(): Promise<boolean>;

  /** 获取可用模型列表 */
  listModels(): Promise<string[]>;
}

export interface StreamChunk {
  /** 增量文本 */
  delta: string;
  /** 是否结束 */
  done: boolean;
  /** 仅最后一个 chunk 有值 */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}
