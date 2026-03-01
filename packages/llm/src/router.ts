/**
 * LLM Router — 统一模型路由
 * 
 * 根据配置自动选择合适的 Provider 和 Model
 */

import type { LLMRequest, LLMResponse, LLMProvider } from '@agentforge/shared';
import type { LLMAdapter, StreamChunk } from './providers/base.js';
import { OpenAIAdapter } from './providers/openai.js';
import { AnthropicAdapter } from './providers/anthropic.js';

export class LLMRouter {
  private adapters = new Map<string, LLMAdapter>();

  /** 注册一个 Provider */
  registerProvider(provider: LLMProvider): void {
    let adapter: LLMAdapter;

    switch (provider.type) {
      case 'openai':
      case 'local':
      case 'custom':
        adapter = new OpenAIAdapter(provider.id, provider.baseUrl, provider.apiKey);
        break;
      case 'anthropic':
        adapter = new AnthropicAdapter(provider.id, provider.baseUrl, provider.apiKey);
        break;
      default:
        throw new Error(`Unknown provider type: ${provider.type}`);
    }

    this.adapters.set(provider.id, adapter);
  }

  /** 注销 Provider */
  unregisterProvider(providerId: string): void {
    this.adapters.delete(providerId);
  }

  /** 发送请求 */
  async chat(request: LLMRequest): Promise<LLMResponse> {
    const adapter = this.getAdapter(request.providerId);
    return adapter.chat(request);
  }

  /** 流式请求 */
  chatStream(request: LLMRequest): AsyncIterable<StreamChunk> {
    const adapter = this.getAdapter(request.providerId);
    return adapter.chatStream(request);
  }

  /** 健康检查 */
  async healthCheck(providerId: string): Promise<boolean> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) return false;
    return adapter.healthCheck();
  }

  /** 列出可用模型 */
  async listModels(providerId: string): Promise<string[]> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) return [];
    return adapter.listModels();
  }

  /** 获取所有已注册 Provider ID */
  getProviderIds(): string[] {
    return Array.from(this.adapters.keys());
  }

  private getAdapter(providerId: string): LLMAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw new Error(`LLM Provider not found: ${providerId}. Register it first.`);
    }
    return adapter;
  }
}
