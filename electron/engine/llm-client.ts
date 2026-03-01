/**
 * LLM Client — 统一的 LLM 调用层
 *
 * 支持 OpenAI / Anthropic 两种协议
 * 支持流式 (SSE) / 非流式 / function-calling (tool-use)
 * 自带重试 + 超时保护 + 模型定价
 *
 * 从 orchestrator.ts 拆出 (v2.5)
 */

import { getDb } from '../db';
import type { AppSettings } from './types';
import { createLogger } from './logger';

const log = createLogger('llm-client');

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

/**
 * 规范化 baseUrl：去掉末尾的 /v1、尾部斜杠
 * 用户可能输入 https://api.openai.com 或 https://xxx/v1
 */
function normalizeBaseUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (u.endsWith('/v1')) u = u.slice(0, -3);
  return u;
}

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface LLMResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export type StreamCallback = (chunk: string) => void;

/**
 * 不可重试的 LLM 错误 — 模型不存在、API Key 无效、权限不足等。
 * react-loop / workerLoop 见到此错误应立即终止，不再重试。
 */
export class NonRetryableError extends Error {
  public readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'NonRetryableError';
    this.statusCode = statusCode;
  }
}

export interface ToolCallMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface LLMWithToolsResult {
  message: ToolCallMessage;
  inputTokens: number;
  outputTokens: number;
}

// ═══════════════════════════════════════
// 模型定价表（USD per 1K tokens）
// ═══════════════════════════════════════

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o':                      { input: 0.0025,  output: 0.01 },
  'gpt-4o-mini':                 { input: 0.00015, output: 0.0006 },
  'gpt-4-turbo':                 { input: 0.01,    output: 0.03 },
  'gpt-3.5-turbo':               { input: 0.0005,  output: 0.0015 },
  'o1':                          { input: 0.015,   output: 0.06 },
  'o1-mini':                     { input: 0.003,   output: 0.012 },
  'o3-mini':                     { input: 0.0011,  output: 0.0044 },
  'claude-sonnet-4-20250514':    { input: 0.003,   output: 0.015 },
  'claude-opus-4-20250514':      { input: 0.015,   output: 0.075 },
  'claude-3-5-sonnet-20241022':  { input: 0.003,   output: 0.015 },
  'claude-3-5-haiku-20241022':   { input: 0.001,   output: 0.005 },
  'claude-3-7-sonnet-20250219':  { input: 0.003,   output: 0.015 },
  'deepseek-chat':               { input: 0.00014, output: 0.00028 },
  'deepseek-reasoner':           { input: 0.00055, output: 0.0022 },
};

const FALLBACK_PRICING = { input: 0.002, output: 0.008 };

/**
 * 计算 LLM 调用成本。
 * 优先级：用户自定义定价(settings.modelPricing) > 内置定价表 > 兜底定价
 * customPricing 参数可选，不传时自动从 DB settings 读取。
 */
export function calcCost(model: string, inputTokens: number, outputTokens: number, customPricing?: Record<string, { input: number; output: number }>): number {
  // 如果没有显式传入自定义价格，尝试从用户设置中读取
  let userPricing = customPricing;
  if (!userPricing) {
    try {
      const settings = getSettings();
      if (settings?.modelPricing) userPricing = settings.modelPricing;
    } catch { /* settings 不可用时降级 */ }
  }
  const p = userPricing?.[model] ?? MODEL_PRICING[model] ?? FALLBACK_PRICING;
  return (inputTokens / 1000) * p.input + (outputTokens / 1000) * p.output;
}

// ═══════════════════════════════════════
// Settings
// ═══════════════════════════════════════

export function getSettings(): AppSettings | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app_settings') as { value: string } | undefined;
  return row ? JSON.parse(row.value) as AppSettings : null;
}

// ═══════════════════════════════════════
// Utilities
// ═══════════════════════════════════════

/**
 * 预检模型可用性 — 发送一条极简请求，验证模型名称有效 + API 连通
 * 返回 null 表示通过，否则返回错误描述
 */
export async function validateModel(settings: AppSettings, model: string): Promise<string | null> {
  if (!model?.trim()) return `模型名称为空`;
  try {
    await callLLM(settings, model, [
      { role: 'user', content: 'hi' },
    ], undefined, 1, 0); // maxTokens=1, retries=0 — 极低开销
    return null; // 通过
  } catch (err: any) {
    if (err instanceof NonRetryableError) {
      return `模型 ${model} 不可用: ${err.message}`;
    }
    // 网络错误等也报出来
    return `模型 ${model} 连接失败: ${err.message}`;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 统一处理 LLM API 的 HTTP 错误响应。
 * 4xx（除 429）→ NonRetryableError，其余 → 普通 Error。
 */
async function throwOnHttpError(res: Response, provider: string): Promise<void> {
  if (res.ok) return;
  const errText = await res.text().catch(() => '(failed to read body)');
  const errMsg = `${provider} API ${res.status}: ${errText}`;
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    throw new NonRetryableError(errMsg, res.status);
  }
  throw new Error(errMsg);
}

/** Combine multiple AbortSignals — any one aborts → combined aborts */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(s.reason); return ctrl.signal; }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

// ═══════════════════════════════════════
// callLLM — 流式 / 非流式文本生成
// ═══════════════════════════════════════

export async function callLLM(
  settings: any, model: string,
  messages: Array<{ role: string; content: string }>,
  signal?: AbortSignal,
  maxTokens: number = 16384,
  retries: number = 2,
  onChunk?: StreamCallback,
  timeoutMs: number = 180000,
): Promise<LLMResult> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new Error('Aborted');
    try {
      return await _callLLMOnce(settings, model, messages, signal, maxTokens, onChunk, timeoutMs);
    } catch (err: any) {
      lastError = err;
      if (signal?.aborted) throw err;
      // v5.6: NonRetryableError 直接冒泡，不重试
      if (err instanceof NonRetryableError) throw err;
      if (attempt < retries) {
        const delay = Math.min(2000 * Math.pow(2, attempt), 15000);
        await sleep(delay);
      }
    }
  }
  throw lastError || new Error('LLM call failed');
}

async function _callLLMOnce(
  settings: any, model: string,
  messages: Array<{ role: string; content: string }>,
  signal?: AbortSignal,
  maxTokens: number = 16384,
  onChunk?: StreamCallback,
  timeoutMs: number = 180000,
): Promise<LLMResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const combinedSignal = signal
    ? anySignal([signal, controller.signal])
    : controller.signal;

  const useStream = !!onChunk;

  try {
    const fetchOpts: RequestInit = { method: 'POST', signal: combinedSignal };

    if (settings.llmProvider === 'anthropic') {
      return await _callAnthropic(settings, model, messages, maxTokens, fetchOpts, useStream, onChunk);
    } else {
      return await _callOpenAI(settings, model, messages, maxTokens, fetchOpts, useStream, onChunk);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function _callOpenAI(
  settings: any, model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number, fetchOpts: RequestInit,
  stream: boolean, onChunk?: StreamCallback
): Promise<LLMResult> {
  const body: any = { model, messages, temperature: 0.3, max_tokens: maxTokens };
  if (stream) body.stream = true;

  const res = await fetch(`${normalizeBaseUrl(settings.baseUrl)}/v1/chat/completions`, {
    ...fetchOpts,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwOnHttpError(res, 'OpenAI');

  if (!stream) {
    const data = await res.json() as any;
    return {
      content: data.choices[0].message.content ?? '',
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  }

  // ── 流式解析 (SSE) ──
  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;

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
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;

      try {
        const json = JSON.parse(trimmed.slice(6));
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
          onChunk?.(delta);
        }
        if (json.usage) {
          inputTokens = json.usage.prompt_tokens ?? inputTokens;
          outputTokens = json.usage.completion_tokens ?? outputTokens;
        }
      } catch { /* skip malformed SSE JSON chunk (common during streaming) */ }
    }
  }

  if (outputTokens === 0) {
    outputTokens = Math.ceil(content.length / 3.5);
  }

  return { content, inputTokens, outputTokens };
}

async function _callAnthropic(
  settings: any, model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number, fetchOpts: RequestInit,
  stream: boolean, onChunk?: StreamCallback
): Promise<LLMResult> {
  const systemMsg = messages.find(m => m.role === 'system');
  const otherMsgs = messages.filter(m => m.role !== 'system');
  const body: any = { model, messages: otherMsgs, max_tokens: maxTokens, temperature: 0.3 };
  if (systemMsg) body.system = systemMsg.content;
  if (stream) body.stream = true;

  const res = await fetch(`${normalizeBaseUrl(settings.baseUrl)}/v1/messages`, {
    ...fetchOpts,
    headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwOnHttpError(res, 'Anthropic');

  if (!stream) {
    const data = await res.json() as any;
    return {
      content: data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''),
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    };
  }

  // ── 流式解析 (Anthropic SSE) ──
  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;

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
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      try {
        const json = JSON.parse(trimmed.slice(6));
        if (json.type === 'content_block_delta') {
          const delta = json.delta?.text;
          if (delta) {
            content += delta;
            onChunk?.(delta);
          }
        } else if (json.type === 'message_start' && json.message?.usage) {
          inputTokens = json.message.usage.input_tokens ?? 0;
        } else if (json.type === 'message_delta' && json.usage) {
          outputTokens = json.usage.output_tokens ?? 0;
        }
      } catch { /* skip malformed Anthropic SSE chunk */ }
    }
  }

  if (outputTokens === 0) {
    outputTokens = Math.ceil(content.length / 3.5);
  }

  return { content, inputTokens, outputTokens };
}

// ═══════════════════════════════════════
// callLLMWithTools — Function-Calling (非流式)
// ═══════════════════════════════════════

export async function callLLMWithTools(
  settings: any,
  model: string,
  messages: Array<{ role: string; content: any }>,
  tools: any[],
  signal?: AbortSignal,
  maxTokens: number = 16384,
): Promise<LLMWithToolsResult> {
  if (signal?.aborted) throw new Error('Aborted');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  const combinedSignal = signal
    ? anySignal([signal, controller.signal])
    : controller.signal;

  try {
    if (settings.llmProvider === 'anthropic') {
      return await _callAnthropicWithTools(settings, model, messages, tools, maxTokens, combinedSignal);
    } else {
      return await _callOpenAIWithTools(settings, model, messages, tools, maxTokens, combinedSignal);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function _callOpenAIWithTools(
  settings: any, model: string,
  messages: Array<{ role: string; content: any }>,
  tools: any[], maxTokens: number, signal: AbortSignal,
): Promise<LLMWithToolsResult> {
  const body: any = {
    model,
    messages,
    tools,
    temperature: 0.2,
    max_tokens: maxTokens,
  };

  const res = await fetch(`${normalizeBaseUrl(settings.baseUrl)}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwOnHttpError(res, 'OpenAI');

  const data = await res.json() as any;
  const choice = data.choices[0];
  return {
    message: choice.message,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

async function _callAnthropicWithTools(
  settings: any, model: string,
  messages: Array<{ role: string; content: any }>,
  tools: any[], maxTokens: number, signal: AbortSignal,
): Promise<LLMWithToolsResult> {
  // Convert OpenAI tools format to Anthropic format
  const anthropicTools = tools.map((t: any) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  const systemMsg = messages.find(m => m.role === 'system');
  const otherMsgs = messages.filter(m => m.role !== 'system');

  // Anthropic 需要将 tool_result 消息转换格式
  const anthropicMessages = otherMsgs.map(m => {
    if (m.role === 'tool') {
      // OpenAI tool result → Anthropic tool_result
      // v2.2: 支持 multimodal content (图像)
      const toolContent = m.content;
      let anthropicToolContent: any;
      if (Array.isArray(toolContent)) {
        // Multimodal content (text + image)
        anthropicToolContent = toolContent.map((block: any) => {
          if (block.type === 'image_url' && block.image_url?.url) {
            const dataMatch = block.image_url.url.match(/^data:([^;]+);base64,(.+)/);
            if (dataMatch) {
              return {
                type: 'image',
                source: { type: 'base64', media_type: dataMatch[1], data: dataMatch[2] },
              };
            }
          }
          if (block.type === 'text') return { type: 'text', text: block.text };
          return { type: 'text', text: JSON.stringify(block) };
        });
      } else {
        anthropicToolContent = typeof toolContent === 'string' ? toolContent : JSON.stringify(toolContent);
      }
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: (m as any).tool_call_id,
          content: anthropicToolContent,
        }],
      };
    }
    if (m.role === 'assistant' && (m as any).tool_calls) {
      // OpenAI assistant with tool_calls → Anthropic with tool_use blocks
      const content: any[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of (m as any).tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments,
        });
      }
      return { role: 'assistant', content };
    }
    return m;
  });

  const body: any = {
    model,
    messages: anthropicMessages,
    tools: anthropicTools,
    max_tokens: maxTokens,
    temperature: 0.2,
  };
  if (systemMsg) body.system = typeof systemMsg.content === 'string' ? systemMsg.content : JSON.stringify(systemMsg.content);

  const res = await fetch(`${normalizeBaseUrl(settings.baseUrl)}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwOnHttpError(res, 'Anthropic');

  const data = await res.json() as any;

  // Convert Anthropic response back to OpenAI format
  let textContent = '';
  const toolCalls: ToolCallMessage['tool_calls'] = [];

  for (const block of data.content || []) {
    if (block.type === 'text') {
      textContent += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  return {
    message: {
      role: 'assistant',
      content: textContent || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    },
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
}
