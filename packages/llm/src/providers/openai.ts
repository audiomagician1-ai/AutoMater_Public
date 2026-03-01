/**
 * OpenAI 兼容 API 适配器
 * 
 * 支持所有兼容 OpenAI API 格式的服务:
 * - OpenAI 官方
 * - Azure OpenAI
 * - 本地 LLM (vLLM, Ollama, LM Studio, etc.)
 * - 第三方中转 (OpenRouter, etc.)
 */

import type { LLMRequest, LLMResponse } from '@agentforge/shared';
import type { LLMAdapter, StreamChunk } from './base.js';

export class OpenAIAdapter implements LLMAdapter {
  readonly providerId: string;
  readonly providerType = 'openai';

  private baseUrl: string;
  private apiKey: string;

  constructor(providerId: string, baseUrl: string, apiKey: string) {
    this.providerId = providerId;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const body = this.buildRequestBody(request, false);

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${text}`);
    }

    const data = await res.json() as any;
    const choice = data.choices[0];
    const usage = data.usage;

    return {
      content: choice.message.content ?? '',
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      costUsd: 0, // 由 CostTracker 计算
      model: data.model,
      finishReason: this.mapFinishReason(choice.finish_reason),
      toolCalls: choice.message.tool_calls?.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      })),
    };
  }

  async *chatStream(request: LLMRequest): AsyncIterable<StreamChunk> {
    const body = this.buildRequestBody(request, true);

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${text}`);
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
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') {
          yield { delta: '', done: true };
          return;
        }

        try {
          const data = JSON.parse(payload);
          const delta = data.choices?.[0]?.delta?.content ?? '';
          const usage = data.usage;
          yield {
            delta,
            done: false,
            usage: usage ? {
              inputTokens: usage.prompt_tokens ?? 0,
              outputTokens: usage.completion_tokens ?? 0,
            } : undefined,
          };
        } catch {
          // 忽略解析错误
        }
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return data.data?.map((m: any) => m.id) ?? [];
  }

  private buildRequestBody(request: LLMRequest, stream: boolean) {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.name && { name: m.name }),
        ...(m.toolCallId && { tool_call_id: m.toolCallId }),
      })),
      stream,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.tools?.length) {
      body.tools = request.tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (stream) {
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  private mapFinishReason(reason: string): 'stop' | 'max_tokens' | 'tool_use' {
    switch (reason) {
      case 'stop': return 'stop';
      case 'length': return 'max_tokens';
      case 'tool_calls': return 'tool_use';
      default: return 'stop';
    }
  }
}
