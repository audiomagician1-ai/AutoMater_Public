/**
 * Anthropic Claude API 适配器
 */

import type { LLMRequest, LLMResponse } from '@agentforge/shared';
import type { LLMAdapter, StreamChunk } from './base.js';

export class AnthropicAdapter implements LLMAdapter {
  readonly providerId: string;
  readonly providerType = 'anthropic';

  private baseUrl: string;
  private apiKey: string;

  constructor(providerId: string, baseUrl: string, apiKey: string) {
    this.providerId = providerId;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const { system, messages } = this.extractSystem(request);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
    };
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools?.length) {
      body.tools = request.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }

    const data = await res.json() as any;
    const textBlocks = data.content.filter((b: any) => b.type === 'text');
    const toolBlocks = data.content.filter((b: any) => b.type === 'tool_use');

    return {
      content: textBlocks.map((b: any) => b.text).join(''),
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      costUsd: 0,
      model: data.model,
      finishReason: data.stop_reason === 'tool_use' ? 'tool_use'
        : data.stop_reason === 'max_tokens' ? 'max_tokens'
        : 'stop',
      toolCalls: toolBlocks.map((b: any) => ({
        id: b.id,
        name: b.name,
        arguments: b.input,
      })),
    };
  }

  async *chatStream(request: LLMRequest): AsyncIterable<StreamChunk> {
    const { system, messages } = this.extractSystem(request);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
    };
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'content_block_delta' && data.delta?.text) {
            yield { delta: data.delta.text, done: false };
          } else if (data.type === 'message_delta') {
            yield {
              delta: '',
              done: true,
              usage: {
                inputTokens: data.usage?.input_tokens ?? 0,
                outputTokens: data.usage?.output_tokens ?? 0,
              },
            };
          }
        } catch {
          // 忽略
        }
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Anthropic 没有 /models 端点，用一个轻量请求测试
      const res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    // Anthropic 没有 list models API，返回已知模型
    return [
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
    ];
  }

  private extractSystem(request: LLMRequest) {
    const systemMsg = request.messages.find(m => m.role === 'system');
    const otherMsgs = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));
    return {
      system: systemMsg?.content ?? null,
      messages: otherMsgs,
    };
  }
}
