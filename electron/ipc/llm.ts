/**
 * LLM IPC — 在主进程中直接调用 LLM API
 * 
 * 没有后端服务，没有 sidecar — 直接 fetch
 * API Key 安全地存在主进程侧，渲染进程无法直接访问
 */

import { ipcMain, BrowserWindow } from 'electron';
import { getDb } from '../db';

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

function getSettings() {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app_settings') as { value: string } | undefined;
  return row ? JSON.parse(row.value) : {};
}

export function setupLLMHandlers() {

  // ── 连通性测试 ──
  ipcMain.handle('llm:test-connection', async (_event, provider: LLMProvider) => {
    try {
      if (provider.type === 'anthropic') {
        const res = await fetch(`${provider.baseUrl}/v1/messages`, {
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
        // OpenAI 兼容
        const res = await fetch(`${provider.baseUrl}/v1/models`, {
          headers: { 'Authorization': `Bearer ${provider.apiKey}` },
        });
        return { success: res.ok, status: res.status, message: res.ok ? 'Connected!' : await res.text() };
      }
    } catch (err: any) {
      return { success: false, status: 0, message: err.message };
    }
  });

  // ── 列出模型 ──
  ipcMain.handle('llm:list-models', async (_event, provider: LLMProvider) => {
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
      const res = await fetch(`${provider.baseUrl}/v1/models`, {
        headers: { 'Authorization': `Bearer ${provider.apiKey}` },
      });
      if (!res.ok) return { success: false, models: [] };
      const data = await res.json() as any;
      const models = (data.data || []).map((m: any) => m.id).sort();
      return { success: true, models };
    } catch {
      return { success: false, models: [] };
    }
  });

  // ── 对话（非流式，简化版） ──
  ipcMain.handle('llm:chat', async (_event, request: ChatRequest) => {
    const settings = getSettings();
    try {
      if (settings.llmProvider === 'anthropic') {
        return await chatAnthropic(settings, request);
      } else {
        return await chatOpenAI(settings, request);
      }
    } catch (err: any) {
      return { success: false, error: err.message, content: '' };
    }
  });
}

async function chatOpenAI(settings: any, request: ChatRequest) {
  const res = await fetch(`${settings.baseUrl}/v1/chat/completions`, {
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

  const data = await res.json() as any;
  const choice = data.choices[0];
  return {
    success: true,
    content: choice.message.content ?? '',
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    model: data.model,
  };
}

async function chatAnthropic(settings: any, request: ChatRequest) {
  const systemMsg = request.messages.find(m => m.role === 'system');
  const otherMsgs = request.messages.filter(m => m.role !== 'system');

  const body: any = {
    model: request.model,
    messages: otherMsgs,
    max_tokens: request.maxTokens ?? 4096,
    temperature: request.temperature ?? 0.3,
  };
  if (systemMsg) body.system = systemMsg.content;

  const res = await fetch(`${settings.baseUrl}/v1/messages`, {
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

  const data = await res.json() as any;
  const textBlocks = data.content.filter((b: any) => b.type === 'text');
  return {
    success: true,
    content: textBlocks.map((b: any) => b.text).join(''),
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    model: data.model,
  };
}
