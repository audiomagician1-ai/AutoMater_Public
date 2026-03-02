/**
 * LLM IPC — 在主进程中直接调用 LLM API
 * 
 * 没有后端服务，没有 sidecar — 直接 fetch
 * API Key 安全地存在主进程侧，渲染进程无法直接访问
 */

import { ipcMain, BrowserWindow } from 'electron';
import { getDb } from '../db';
import type { AppSettings } from '../engine/types';
import { toErrorMessage } from '../engine/logger';
import { assertObject, assertString } from './ipc-validator';
import { safeJsonParse } from '../engine/safe-json';

interface LLMProvider {
  type: 'openai' | 'anthropic' | 'custom';
  baseUrl: string;
  apiKey: string;
}

interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
}

/**
 * 规范化 baseUrl：去掉末尾的 /v1、/v1/、尾部斜杠
 * 用户可能输入 https://api.openai.com 或 https://api.openai.com/v1
 * 内部统一存储为不带 /v1 的形式，拼接时再加
 */
function normalizeBaseUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  // 去掉末尾的 /v1
  if (u.endsWith('/v1')) u = u.slice(0, -3);
  return u;
}

function getSettings() {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app_settings') as { value: string } | undefined;
  const settings = row ? safeJsonParse<AppSettings>(row.value, {} as AppSettings) : {} as AppSettings;

  // v19.1: 解密 apiKey — 优先从 secret-manager 获取加密版本
  if (!settings.apiKey) {
    try {
      const { getSecret } = require('../engine/secret-manager'); // require-ok: 避免循环导入
      const encrypted = getSecret('__global__', 'llm_api_key');
      if (encrypted) settings.apiKey = encrypted;
    } catch { /* silent: secret-manager 不可用 */ }
  }

  return settings;
}

export function setupLLMHandlers() {

  // ── 连通性测试 ──
  ipcMain.handle('llm:test-connection', async (_event, provider: LLMProvider) => {
    assertObject('llm:test-connection', 'provider', provider);
    const base = normalizeBaseUrl(provider.baseUrl);
    try {
      if (provider.type === 'anthropic') {
        const res = await fetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': provider.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-3-5-haiku-20241022',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        return { success: res.ok, status: res.status, message: res.ok ? 'Connected!' : await res.text() };
      } else {
        // OpenAI 兼容 — 先尝试 /v1/models，失败则用轻量 chat 测试
        try {
          const res = await fetch(`${base}/v1/models`, {
            headers: { 'Authorization': `Bearer ${provider.apiKey}` },
          });
          if (res.ok) return { success: true, status: res.status, message: 'Connected!' };
        } catch { /* models endpoint not available, try chat */ }

        // Fallback: 轻量 chat 测试 — 用已保存的模型名，或通用名
        const savedSettings = getSettings();
        const testModel = savedSettings.strongModel || savedSettings.workerModel || 'gpt-4o-mini';
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${provider.apiKey}`,
          },
          body: JSON.stringify({
            model: testModel,
            max_tokens: 5,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        // 即使模型名不对，只要认证通过 (非 401/403) 就算连通
        if (res.ok) return { success: true, status: res.status, message: 'Connected!' };
        const text = await res.text();
        if (res.status === 401 || res.status === 403) {
          return { success: false, status: res.status, message: `认证失败 (${res.status}): ${text.slice(0, 200)}` };
        }
        // 其他错误 (如 404 model not found) 说明认证OK，连接没问题
        return { success: true, status: res.status, message: 'Connected! (部分端点可能不可用)' };
      }
    } catch (err: unknown) {
      return { success: false, status: 0, message: toErrorMessage(err) };
    }
  });

  // ── 列出模型 ──
  ipcMain.handle('llm:list-models', async (_event, provider: LLMProvider) => {
    assertObject('llm:list-models', 'provider', provider);
    const base = normalizeBaseUrl(provider.baseUrl);
    try {
      if (provider.type === 'anthropic') {
        return {
          success: true,
          models: [
            'claude-sonnet-4-20250514',
            'claude-opus-4-20250514',
            'claude-3-7-sonnet-20250219',
            'claude-3-5-sonnet-20241022',
            'claude-3-5-haiku-20241022',
          ],
        };
      }
      const res = await fetch(`${base}/v1/models`, {
        headers: { 'Authorization': `Bearer ${provider.apiKey}` },
      });
      if (!res.ok) return { success: false, models: [] };
      const data = await res.json() as { data?: Array<{ id: string }> };
      const models = (data.data || []).map((m) => m.id).sort();
      return { success: true, models };
    } catch { /* silent: model list fetch failed */
      return { success: false, models: [] };
    }
  });

  // ── 对话（非流式，简化版） ──
  ipcMain.handle('llm:chat', async (_event, request: ChatRequest) => {
    assertObject('llm:chat', 'request', request);
    const settings = getSettings();
    try {
      if (settings.llmProvider === 'anthropic') {
        return await chatAnthropic(settings, request);
      } else {
        return await chatOpenAI(settings, request);
      }
    } catch (err: unknown) {
      return { success: false, error: toErrorMessage(err), content: '' };
    }
  });
}

async function chatOpenAI(settings: AppSettings, request: ChatRequest) {
  const base = normalizeBaseUrl(settings.baseUrl);
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.3,
      max_tokens: request.maxTokens ?? 4096,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { success: false, error: `API error ${res.status}: ${text}`, content: '' };
  }

  const data = await res.json() as { choices: Array<{ message: { content: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string };
  const choice = data.choices[0];
  return {
    success: true,
    content: choice.message.content ?? '',
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    model: data.model,
  };
}

async function chatAnthropic(settings: AppSettings, request: ChatRequest) {
  const base = normalizeBaseUrl(settings.baseUrl);
  const systemMsg = request.messages.find(m => m.role === 'system');
  const otherMsgs = request.messages.filter(m => m.role !== 'system');

  const body: Record<string, unknown> = {
    model: request.model,
    messages: otherMsgs,
    max_tokens: request.maxTokens ?? 4096,
    temperature: request.temperature ?? 0.3,
  };
  if (systemMsg) body.system = systemMsg.content;

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    return { success: false, error: `API error ${res.status}: ${text}`, content: '' };
  }

  const data = await res.json() as { content: Array<{ type: string; text?: string }>; usage?: { input_tokens: number; output_tokens: number }; model?: string };
  const textBlocks = data.content.filter((b) => b.type === 'text');
  return {
    success: true,
    content: textBlocks.map((b) => b.text ?? '').join(''),
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    model: data.model,
  };
}
