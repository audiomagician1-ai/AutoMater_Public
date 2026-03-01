/**
 * Orchestrator — Agent 编排引擎 (Electron 主进程版)
 * 
 * 直接在主进程跑，通过 IPC 推送状态到 UI
 * 无后端服务、无 sidecar
 * 
 * v0.4: 4 阶段流水线 PM → Architect → Developer (上下文感知) → QA 审查
 * v0.6: LLM 流式输出 + Electron 原生通知
 * v0.9: ReAct 多轮工具调用循环 (Developer Agent)
 */

import { BrowserWindow, Notification } from 'electron';
import { getDb } from '../db';
import { PM_SYSTEM_PROMPT, ARCHITECT_SYSTEM_PROMPT, DEVELOPER_REACT_PROMPT, DEVELOPER_SYSTEM_PROMPT, QA_SYSTEM_PROMPT, QA_REACT_PROMPT, PLANNER_FEATURE_PROMPT } from './prompts';
import { parseFileBlocks, writeFileBlocks, readWorkspaceFile, type WrittenFile } from './file-writer';
import { collectDeveloperContext, collectLightContext, type ContextSnapshot } from './context-collector';
import { initGitRepo, commitWorkspace } from './workspace-git';
import { getToolsForLLM, getToolsForRole, executeTool, executeToolAsync, type ToolContext, type ToolCall, type ToolResult } from './tool-system';
import { parsePlanFromLLM, advancePlan, failCurrentStep, getPlanSummary, type FeaturePlan } from './planner';
import { ensureGlobalMemory, ensureProjectMemory, readMemoryForRole, appendProjectMemory, appendRoleMemory, recordLessonLearned, buildLessonExtractionPrompt, appendSharedDecision, readRecentDecisions, formatDecisionsForContext } from './memory-system';
import { selectModelTier, resolveModel, estimateFeatureComplexity, type TaskComplexity } from './model-selector';
import { runResearcher } from './sub-agent';
import { buildCodeGraph, graphSummary } from './code-graph';
import { emitEvent, type EventType } from './event-store';
import { createCheckpoint } from './mission';
import { extractFromProjectMemory, buildCrossProjectContext } from './cross-project';
import type { GitProviderConfig } from './git-provider';

// ═══════════════════════════════════════
// 运行中的编排器注册表（支持停止）
// ═══════════════════════════════════════
const runningOrchestrators = new Map<string, AbortController>();

// v1.1: 上下文快照缓存 (projectId → agentId → snapshot)
const contextSnapshotCache = new Map<string, Map<string, ContextSnapshot>>();

// v1.1: Agent ReAct 状态缓存 (projectId → agentId → ReactStateHistory)
export interface MessageTokenBreakdown {
  role: 'system' | 'user' | 'assistant' | 'tool';
  tokens: number;
  count: number;
}

export interface ReactIterationState {
  iteration: number;
  timestamp: number;
  messageCount: number;
  totalContextTokens: number;
  breakdown: MessageTokenBreakdown[];
  inputTokensThisCall: number;
  outputTokensThisCall: number;
  costThisCall: number;
  cumulativeCost: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  filesWritten: string[];
  toolCallsThisIteration: string[];
  completed: boolean;
}

export interface AgentReactState {
  agentId: string;
  featureId: string;
  iterations: ReactIterationState[];
  maxContextWindow: number; // model's max tokens (estimated)
}

const agentReactStateCache = new Map<string, Map<string, AgentReactState>>();

export function getAgentReactStates(projectId: string): Map<string, AgentReactState> {
  return agentReactStateCache.get(projectId) ?? new Map();
}

function cacheAgentReactState(projectId: string, state: AgentReactState) {
  if (!agentReactStateCache.has(projectId)) {
    agentReactStateCache.set(projectId, new Map());
  }
  agentReactStateCache.get(projectId)!.set(state.agentId, state);
}

/** 粗估消息 token (和 context-collector 保持一致) */
function estimateMsgTokens(content: any): number {
  if (!content) return 0;
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return Math.ceil(text.length / 1.5);
}

/** 计算消息链条 token 分布 */
function computeMessageBreakdown(messages: Array<{ role: string; content: any }>): { breakdown: MessageTokenBreakdown[]; total: number } {
  const map: Record<string, { tokens: number; count: number }> = {};
  let total = 0;
  for (const m of messages) {
    const role = m.role as string;
    const t = estimateMsgTokens(m.content);
    if (!map[role]) map[role] = { tokens: 0, count: 0 };
    map[role].tokens += t;
    map[role].count += 1;
    total += t;
  }
  const breakdown: MessageTokenBreakdown[] = Object.entries(map).map(([role, v]) => ({
    role: role as any,
    tokens: v.tokens,
    count: v.count,
  }));
  return { breakdown, total };
}

export function getContextSnapshots(projectId: string): Map<string, ContextSnapshot> {
  return contextSnapshotCache.get(projectId) ?? new Map();
}

function cacheContextSnapshot(projectId: string, snapshot: ContextSnapshot) {
  if (!contextSnapshotCache.has(projectId)) {
    contextSnapshotCache.set(projectId, new Map());
  }
  contextSnapshotCache.get(projectId)!.set(snapshot.agentId, snapshot);
}

export function stopOrchestrator(projectId: string) {
  const ctrl = runningOrchestrators.get(projectId);
  if (ctrl) {
    ctrl.abort();
    runningOrchestrators.delete(projectId);
  }
  const db = getDb();
  db.prepare("UPDATE projects SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(projectId);
  db.prepare("UPDATE features SET status = 'todo', locked_by = NULL WHERE project_id = ? AND status IN ('in_progress', 'reviewing')").run(projectId);
  db.prepare("UPDATE agents SET status = 'idle', current_task = NULL WHERE project_id = ? AND status = 'working'").run(projectId);
}

// ═══════════════════════════════════════
// 模型定价表（USD per 1K tokens）
// ═══════════════════════════════════════
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
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

/** 未知模型的兜底定价 */
const FALLBACK_PRICING = { input: 0.002, output: 0.008 };

function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[model] ?? FALLBACK_PRICING;
  return (inputTokens / 1000) * p.input + (outputTokens / 1000) * p.output;
}

// ═══════════════════════════════════════
// LLM 调用 (支持流式 + 非流式)
// ═══════════════════════════════════════
interface LLMResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

type StreamCallback = (chunk: string) => void;

function getSettings() {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app_settings') as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}

async function callLLM(
  settings: any, model: string,
  messages: Array<{ role: string; content: string }>,
  signal?: AbortSignal,
  maxTokens: number = 16384,
  retries: number = 2,
  onChunk?: StreamCallback
): Promise<LLMResult> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new Error('Aborted');
    try {
      return await _callLLMOnce(settings, model, messages, signal, maxTokens, onChunk);
    } catch (err: any) {
      lastError = err;
      if (signal?.aborted) throw err;
      // 不重试 4xx 错误（除了 429 rate limit）
      if (err.message?.includes('API 4') && !err.message?.includes('429')) throw err;
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
  onChunk?: StreamCallback
): Promise<LLMResult> {
  // 超时保护: 180秒 (流式需要更长时间)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
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

  const res = await fetch(`${settings.baseUrl}/v1/chat/completions`, {
    ...fetchOpts,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);

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
    buffer = lines.pop() ?? ''; // 保留不完整的最后一行

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
        // 部分 provider 在最后一个 chunk 带 usage
        if (json.usage) {
          inputTokens = json.usage.prompt_tokens ?? inputTokens;
          outputTokens = json.usage.completion_tokens ?? outputTokens;
        }
      } catch { /* skip malformed JSON */ }
    }
  }

  // 如果 provider 没有在流式中返回 usage，粗估
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

  const res = await fetch(`${settings.baseUrl}/v1/messages`, {
    ...fetchOpts,
    headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);

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
        // Anthropic events: message_start, content_block_delta, message_delta, message_stop
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
      } catch { /* skip */ }
    }
  }

  if (outputTokens === 0) {
    outputTokens = Math.ceil(content.length / 3.5);
  }

  return { content, inputTokens, outputTokens };
}

// ═══════════════════════════════════════
// LLM with Tools (Function-Calling) — 非流式
// ═══════════════════════════════════════

interface ToolCallMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

interface LLMWithToolsResult {
  message: ToolCallMessage;
  inputTokens: number;
  outputTokens: number;
}

/**
 * 调用 LLM，带 function-calling tools。
 * 非流式（tool-use 多轮时流式意义不大）。
 * 支持 OpenAI 和 Anthropic 两种协议。
 */
async function callLLMWithTools(
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

  const res = await fetch(`${settings.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);

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
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: (m as any).tool_call_id,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
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

  const res = await fetch(`${settings.baseUrl}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);

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

/** Combine multiple AbortSignals */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(s.reason); return ctrl.signal; }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

// ═══════════════════════════════════════
// UI 推送 + DB 日志 + 系统通知
// ═══════════════════════════════════════
function sendToUI(win: BrowserWindow | null, channel: string, data: any) {
  try { win?.webContents.send(channel, data); } catch { /* closed */ }
}

function addLog(projectId: string, agentId: string, type: string, content: string) {
  try {
    const db = getDb();
    db.prepare('INSERT INTO agent_logs (project_id, agent_id, type, content) VALUES (?, ?, ?, ?)').run(projectId, agentId, type, content);
  } catch { /* ignore during shutdown */ }
}

/** 发送 Electron 系统原生通知 */
function notify(title: string, body: string) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, silent: false }).show();
    }
  } catch { /* non-fatal */ }
}

/**
 * 创建流式回调: 每攒 N 个字符向 UI 推送一次 agent:stream 事件
 * 返回 [onChunk callback, getAccumulated]
 */
function createStreamCallback(
  win: BrowserWindow | null,
  projectId: string,
  agentId: string,
  flushInterval: number = 80
): [StreamCallback, () => string] {
  let accumulated = '';
  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (buffer.length > 0) {
      sendToUI(win, 'agent:stream', { projectId, agentId, chunk: buffer });
      buffer = '';
    }
    timer = null;
  };

  const onChunk = (chunk: string) => {
    accumulated += chunk;
    buffer += chunk;
    // 立即刷新换行符，否则定时刷新
    if (chunk.includes('\n') || buffer.length > 200) {
      if (timer) { clearTimeout(timer); timer = null; }
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, flushInterval);
    }
  };

  return [onChunk, () => { flush(); return accumulated; }];
}

function spawnAgent(projectId: string, id: string, role: string, win: BrowserWindow | null) {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO agents (id, project_id, role, status) VALUES (?, ?, ?, ?)').run(id, projectId, role, 'working');
  sendToUI(win, 'agent:spawned', { projectId, agentId: id, role });
}

function updateAgentStats(agentId: string, projectId: string, inputTokens: number, outputTokens: number, cost: number) {
  const db = getDb();
  db.prepare(`
    UPDATE agents SET
      session_count = session_count + 1,
      total_input_tokens = total_input_tokens + ?,
      total_output_tokens = total_output_tokens + ?,
      total_cost_usd = total_cost_usd + ?,
      last_active_at = datetime('now')
    WHERE id = ? AND project_id = ?
  `).run(inputTokens, outputTokens, cost, agentId, projectId);
}

/**
 * 预算防护 — 检查项目总成本是否超过日预算
 */
function checkBudget(projectId: string, settings: any): { ok: boolean; spent: number; budget: number } {
  const db = getDb();
  const row = db.prepare('SELECT SUM(total_cost_usd) as total FROM agents WHERE project_id = ?').get(projectId) as any;
  const spent = row?.total ?? 0;
  const budget = settings.dailyBudgetUsd ?? 50;
  return { ok: spent < budget, spent, budget };
}

// ═══════════════════════════════════════
// Feature 原子锁定（解决多 Worker 竞态）
// ═══════════════════════════════════════
function lockNextFeature(projectId: string, workerId: string): any | null {
  const db = getDb();
  const tryLock = db.transaction(() => {
    const passedRows = db.prepare("SELECT id FROM features WHERE project_id = ? AND status = 'passed'").all(projectId) as { id: string }[];
    const passedSet = new Set(passedRows.map(r => r.id));

    const todos = db.prepare("SELECT * FROM features WHERE project_id = ? AND status = 'todo' ORDER BY priority ASC, id ASC").all(projectId) as any[];

    for (const f of todos) {
      let deps: string[] = [];
      try { deps = JSON.parse(f.depends_on || '[]'); } catch { /* */ }
      const depsOk = deps.every((d: string) => passedSet.has(d));
      if (!depsOk) continue;

      const result = db.prepare(
        "UPDATE features SET status = 'in_progress', locked_by = ? WHERE id = ? AND project_id = ? AND status = 'todo'"
      ).run(workerId, f.id, projectId);

      if (result.changes > 0) {
        return { ...f, status: 'in_progress', locked_by: workerId };
      }
    }
    return null;
  });

  return tryLock();
}

// ═══════════════════════════════════════
// 主编排流程 (4 阶段)
// ═══════════════════════════════════════
export async function runOrchestrator(projectId: string, win: BrowserWindow | null) {
  stopOrchestrator(projectId);

  const abortCtrl = new AbortController();
  runningOrchestrators.set(projectId, abortCtrl);
  const signal = abortCtrl.signal;

  const db = getDb();
  const settings = getSettings();

  if (!settings || !settings.apiKey) {
    sendToUI(win, 'agent:error', { projectId, error: '请先在设置中配置 LLM API Key' });
    return;
  }

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
  if (!project) {
    sendToUI(win, 'agent:error', { projectId, error: '项目不存在' });
    return;
  }

  const workspacePath = project.workspace_path;
  if (workspacePath) {
    const fs = require('fs');
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  // v1.2: 确保记忆系统文件存在
  ensureGlobalMemory();
  if (workspacePath) {
    ensureProjectMemory(workspacePath);
  }

  // v2.0: 发射项目启动事件
  emitEvent({
    projectId, agentId: 'system', type: 'project:start',
    data: { wish: project.wish, name: project.name, workspace: workspacePath },
  });

  // 检查是否已有 features（续跑场景）
  const existingFeatures = db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ?").get(projectId) as any;
  const isResume = existingFeatures.c > 0;

  if (!isResume) {
    // ═══════════════════════════════════════
    // Phase 1: PM Agent — 需求分析 → Feature List
    // ═══════════════════════════════════════
    const pmId = `pm-${Date.now().toString(36)}`;
    spawnAgent(projectId, pmId, 'pm', win);
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: '🧠 产品经理开始分析需求...' });
    addLog(projectId, pmId, 'log', '开始分析需求: ' + project.wish);

    db.prepare("UPDATE projects SET status = 'initializing', updated_at = datetime('now') WHERE id = ?").run(projectId);
    sendToUI(win, 'project:status', { projectId, status: 'initializing' });

    let features: any[] = [];
    try {
      if (signal.aborted) return;

      const [onChunk] = createStreamCallback(win, projectId, pmId);
      sendToUI(win, 'agent:stream-start', { projectId, agentId: pmId, label: 'PM 需求分析' });

      const pmResult = await callLLM(settings, settings.strongModel, [
        { role: 'system', content: PM_SYSTEM_PROMPT },
        { role: 'user', content: `用户需求:\n${project.wish}\n\n请分析此需求，拆解为 Feature 清单。直接输出 JSON 数组，不要用 markdown 代码块包裹。` },
      ], signal, 16384, 2, onChunk);

      sendToUI(win, 'agent:stream-end', { projectId, agentId: pmId });

      const pmCost = calcCost(settings.strongModel, pmResult.inputTokens, pmResult.outputTokens);
      addLog(projectId, pmId, 'output', pmResult.content);
      sendToUI(win, 'agent:log', {
        projectId, agentId: pmId,
        content: `✅ PM 分析完成 (${pmResult.inputTokens + pmResult.outputTokens} tokens, $${pmCost.toFixed(4)})`,
      });

      const jsonMatch = pmResult.content.trim().match(/\[[\s\S]*\]/);
      if (jsonMatch) features = JSON.parse(jsonMatch[0]);

      db.prepare("UPDATE agents SET status = 'idle', session_count = 1, total_input_tokens = ?, total_output_tokens = ?, total_cost_usd = ?, last_active_at = datetime('now') WHERE id = ?")
        .run(pmResult.inputTokens, pmResult.outputTokens, pmCost, pmId);
    } catch (err: any) {
      if (signal.aborted) return;
      addLog(projectId, pmId, 'error', err.message);
      sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `❌ PM 分析失败: ${err.message}` });
      db.prepare("UPDATE agents SET status = 'error' WHERE id = ?").run(pmId);
      db.prepare("UPDATE projects SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(projectId);
      sendToUI(win, 'project:status', { projectId, status: 'error' });
      runningOrchestrators.delete(projectId);
      return;
    }

    if (features.length === 0) {
      sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: '⚠️ PM 未能生成有效的 Feature 清单' });
      db.prepare("UPDATE projects SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(projectId);
      runningOrchestrators.delete(projectId);
      return;
    }

    // 写入 features
    const insertFeature = db.prepare(`
      INSERT INTO features (id, project_id, category, priority, title, description, depends_on, status, acceptance_criteria, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?)
    `);

    db.transaction((items: any[]) => {
      for (let i = 0; i < items.length; i++) {
        const f = items[i];
        insertFeature.run(
          f.id || `F${String(i + 1).padStart(3, '0')}`,
          projectId,
          f.category || 'core',
          f.priority ?? 1,
          f.title || f.description || '',
          f.description || '',
          JSON.stringify(f.dependsOn || f.depends_on || []),
          JSON.stringify(f.acceptanceCriteria || f.acceptance_criteria || []),
          f.notes || ''
        );
      }
    })(features);

    sendToUI(win, 'project:features-ready', { projectId, count: features.length });
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `📋 生成了 ${features.length} 个 Feature` });

    // v2.0: PM 完成事件
    emitEvent({
      projectId, agentId: pmId, type: 'phase:pm:end',
      data: { featureCount: features.length },
    });
    createCheckpoint(projectId, `PM 分析完成 (${features.length} Features)`);

    // ═══════════════════════════════════════
    // Phase 2: Architect Agent — 技术架构设计
    // ═══════════════════════════════════════
    if (signal.aborted) { runningOrchestrators.delete(projectId); return; }

    const archId = `arch-${Date.now().toString(36)}`;
    spawnAgent(projectId, archId, 'architect', win);
    sendToUI(win, 'agent:log', { projectId, agentId: archId, content: '🏗️ 架构师开始设计技术方案...' });
    addLog(projectId, archId, 'log', '开始架构设计');

    try {
      const featureSummary = features.map(f => `- ${f.id}: ${f.title || f.description}`).join('\n');
      const [onChunk] = createStreamCallback(win, projectId, archId);
      sendToUI(win, 'agent:stream-start', { projectId, agentId: archId, label: '架构设计' });

      const archResult = await callLLM(settings, settings.strongModel, [
        { role: 'system', content: ARCHITECT_SYSTEM_PROMPT },
        { role: 'user', content: `用户需求:\n${project.wish}\n\nFeature 清单:\n${featureSummary}\n\n请设计项目技术架构，输出 ARCHITECTURE.md 文件。` },
      ], signal, 16384, 2, onChunk);

      sendToUI(win, 'agent:stream-end', { projectId, agentId: archId });

      const archCost = calcCost(settings.strongModel, archResult.inputTokens, archResult.outputTokens);
      addLog(projectId, archId, 'output', archResult.content.slice(0, 3000));

      // 解析并写入 ARCHITECTURE.md
      const archBlocks = parseFileBlocks(archResult.content);
      if (archBlocks.length > 0 && workspacePath) {
        writeFileBlocks(workspacePath, archBlocks);
        sendToUI(win, 'agent:log', { projectId, agentId: archId, content: '📐 ARCHITECTURE.md 已写入工作区' });
        sendToUI(win, 'workspace:changed', { projectId });
      } else {
        // 如果 LLM 没用格式输出，把内容直接写成 ARCHITECTURE.md
        if (workspacePath) {
          const fs = require('fs');
          const path = require('path');
          fs.writeFileSync(path.join(workspacePath, 'ARCHITECTURE.md'), archResult.content, 'utf-8');
          sendToUI(win, 'agent:log', { projectId, agentId: archId, content: '📐 ARCHITECTURE.md 已写入工作区 (直接输出)' });
          sendToUI(win, 'workspace:changed', { projectId });
        }
      }

      updateAgentStats(archId, projectId, archResult.inputTokens, archResult.outputTokens, archCost);
      db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(archId);
      sendToUI(win, 'agent:log', {
        projectId, agentId: archId,
        content: `✅ 架构设计完成 (${archResult.inputTokens + archResult.outputTokens} tokens, $${archCost.toFixed(4)})`,
      });

      // v2.0: Architect 完成事件 + 检查点
      emitEvent({
        projectId, agentId: archId, type: 'phase:architect:end',
        data: { tokens: archResult.inputTokens + archResult.outputTokens, cost: archCost },
        inputTokens: archResult.inputTokens, outputTokens: archResult.outputTokens, costUsd: archCost,
      });
      createCheckpoint(projectId, '架构设计完成');
    } catch (err: any) {
      if (signal.aborted) { runningOrchestrators.delete(projectId); return; }
      // 架构设计失败不致命，继续开发
      sendToUI(win, 'agent:log', { projectId, agentId: archId, content: `⚠️ 架构设计失败 (非致命): ${err.message}` });
      db.prepare("UPDATE agents SET status = 'error' WHERE id = ?").run(archId);
    }
  } else {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '♻️ 续跑模式 — 跳过 PM/Architect，直接进入开发阶段' });
  }

  // Git commit: PM + Architect 阶段产出
  if (workspacePath) {
    commitWorkspace(workspacePath, 'AgentForge: PM analysis + Architecture design');
  }

  // ═══════════════════════════════════════
  // Phase 2.5: 自动生成 .agentforge/AGENTS.md (v1.0)
  // ═══════════════════════════════════════
  if (workspacePath) {
    ensureAgentsMd(workspacePath, project.wish);
  }

  // ═══════════════════════════════════════
  // Phase 3: Developer Agents — 上下文感知迭代开发 + QA 审查
  // ═══════════════════════════════════════
  if (signal.aborted) { runningOrchestrators.delete(projectId); return; }

  db.prepare("UPDATE projects SET status = 'developing', updated_at = datetime('now') WHERE id = ?").run(projectId);
  sendToUI(win, 'project:status', { projectId, status: 'developing' });

  const featureCount = (db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ?").get(projectId) as any).c;
  const workerCount = Math.min(settings.workerCount || 2, featureCount, 6);
  const workerPromises: Promise<void>[] = [];

  // 同时 spawn 一个 QA agent
  const qaId = `qa-${Date.now().toString(36)}`;
  spawnAgent(projectId, qaId, 'qa', win);
  sendToUI(win, 'agent:log', { projectId, agentId: qaId, content: '🧪 QA 工程师就绪，等待审查...' });
  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ? AND project_id = ?").run(qaId, projectId);

  // 构建 git 配置 + 工具上下文
  const project2 = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
  const gitConfig: GitProviderConfig = {
    mode: project2.git_mode || 'local',
    workspacePath: workspacePath || '',
    githubRepo: project2.github_repo,
    githubToken: project2.github_token,
  };

  for (let i = 0; i < workerCount; i++) {
    const workerId = `dev-${i + 1}`;
    spawnAgent(projectId, workerId, 'developer', win);
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = ? AND project_id = ?").run(workerId, projectId);
    workerPromises.push(workerLoop(projectId, workerId, qaId, settings, win, signal, workspacePath, gitConfig));
  }

  await Promise.all(workerPromises);

  // ═══════════════════════════════════════
  // Phase 4: 完成
  // ═══════════════════════════════════════
  if (signal.aborted) { runningOrchestrators.delete(projectId); return; }

  const stats = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) as passed FROM features WHERE project_id = ?").get(projectId) as any;
  const finalStatus = stats.passed === stats.total ? 'delivered' : 'paused';
  db.prepare("UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?").run(finalStatus, projectId);
  sendToUI(win, 'project:status', { projectId, status: finalStatus });
  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `🏁 项目完成! ${stats.passed}/${stats.total} features 通过` });
  db.prepare("UPDATE agents SET status = 'idle' WHERE project_id = ?").run(projectId);

  notify(
    finalStatus === 'delivered' ? '🎉 项目已交付!' : '⏸️ 项目暂停',
    `${stats.passed}/${stats.total} features 已完成`
  );

  // Git commit: 最终产出
  if (workspacePath) {
    commitWorkspace(workspacePath, `AgentForge: Delivered ${stats.passed}/${stats.total} features`);
  }

  // v2.0: 项目完成事件 + 检查点 + 跨项目经验提取
  emitEvent({
    projectId, agentId: 'system', type: 'project:complete',
    data: { status: finalStatus, passed: stats.passed, total: stats.total },
  });
  createCheckpoint(projectId, `项目${finalStatus === 'delivered' ? '已交付' : '已暂停'} (${stats.passed}/${stats.total})`);

  // 跨项目经验提取
  if (workspacePath && stats.passed > 0) {
    try {
      const extracted = extractFromProjectMemory(workspacePath, project.name);
      if (extracted > 0) {
        sendToUI(win, 'agent:log', {
          projectId, agentId: 'system',
          content: `🌐 已将 ${extracted} 条经验提取到全局经验池 (跨项目学习)`,
        });
      }
    } catch { /* non-fatal */ }
  }

  runningOrchestrators.delete(projectId);
}

// ═══════════════════════════════════════
// Worker 循环 (v0.9: ReAct 多轮工具调用 + Planner + QA 审查)
// ═══════════════════════════════════════
async function workerLoop(
  projectId: string, workerId: string, qaId: string, settings: any,
  win: BrowserWindow | null, signal: AbortSignal,
  workspacePath: string | null, gitConfig: GitProviderConfig
) {
  const db = getDb();
  const maxQARetries = 3;

  while (!signal.aborted) {
    // ── 预算检查 ──
    const budget = checkBudget(projectId, settings);
    if (!budget.ok) {
      sendToUI(win, 'agent:log', {
        projectId, agentId: workerId,
        content: `💰 预算已用尽! ($${budget.spent.toFixed(2)} / $${budget.budget}) — 自动暂停`,
      });
      notify('⚠️ AgentForge 预算告警', `项目已花费 $${budget.spent.toFixed(2)}，超过预算 $${budget.budget}，已自动暂停`);
      const ctrl = runningOrchestrators.get(projectId);
      if (ctrl) ctrl.abort();
      break;
    }

    const feature = lockNextFeature(projectId, workerId);

    if (!feature) {
      const inProgress = db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ? AND status IN ('in_progress', 'reviewing')").get(projectId) as any;
      if (inProgress.c > 0) {
        await sleep(3000);
        continue;
      }
      sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: '✅ 没有更多任务，下班了' });
      db.prepare("UPDATE agents SET status = 'idle', current_task = NULL, last_active_at = datetime('now') WHERE id = ? AND project_id = ?").run(workerId, projectId);
      break;
    }

    db.prepare("UPDATE agents SET status = 'working', current_task = ?, last_active_at = datetime('now') WHERE id = ? AND project_id = ?").run(feature.id, workerId, projectId);
    sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: 'in_progress', agentId: workerId });
    sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `🔨 开始: ${feature.id} — ${feature.title || feature.description}` });

    let passed = false;
    let qaFeedback: string = '';

    for (let qaAttempt = 1; qaAttempt <= maxQARetries && !signal.aborted; qaAttempt++) {
      try {
        // ═══ ReAct 开发循环 ═══
        const reactResult = await reactDeveloperLoop(
          projectId, workerId, settings, win, signal,
          workspacePath, gitConfig, feature, qaFeedback
        );

        if (!reactResult.completed) {
          sendToUI(win, 'agent:log', {
            projectId, agentId: workerId,
            content: `⚠️ ${feature.id} ReAct 循环未完成 (attempt ${qaAttempt}/${maxQARetries})`,
          });
          if (qaAttempt >= maxQARetries) break;
          continue;
        }

        // ═══ QA 审查 ═══
        if (reactResult.filesWritten.length > 0 && workspacePath) {
          sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: 'reviewing', agentId: qaId });
          db.prepare("UPDATE features SET status = 'reviewing' WHERE id = ? AND project_id = ?").run(feature.id, projectId);
          db.prepare("UPDATE agents SET status = 'working', current_task = ? WHERE id = ? AND project_id = ?").run(feature.id, qaId, projectId);
          sendToUI(win, 'agent:log', { projectId, agentId: qaId, content: `🔍 审查 ${feature.id}...` });

          const qaResult = await runQAReview(settings, signal, feature, reactResult.filesWritten, workspacePath);
          const qaCost = calcCost(settings.strongModel, qaResult.inputTokens, qaResult.outputTokens);
          updateAgentStats(qaId, projectId, qaResult.inputTokens, qaResult.outputTokens, qaCost);
          db.prepare("UPDATE agents SET current_task = NULL WHERE id = ? AND project_id = ?").run(qaId, projectId);

          if (qaResult.verdict === 'pass') {
            passed = true;
            sendToUI(win, 'agent:log', {
              projectId, agentId: qaId,
              content: `✅ ${feature.id} QA 通过! (分数: ${qaResult.score}, $${qaCost.toFixed(4)})`,
            });
            sendToUI(win, 'agent:log', {
              projectId, agentId: workerId,
              content: `✅ ${feature.id} 完成! (QA attempt ${qaAttempt}, $${(reactResult.totalCost + qaCost).toFixed(4)})`,
            });
            notify('✅ Feature 完成', `${feature.id}: ${(feature.title || '').slice(0, 40)} — QA 分数 ${qaResult.score}`);

            // ═══ v1.2: Auto Lessons Learned — QA fail→fix 经验提取 ═══
            if (qaAttempt > 1 && qaFeedback && workspacePath) {
              try {
                const lessonPrompt = buildLessonExtractionPrompt(
                  feature.id, qaFeedback, reactResult.filesWritten,
                  `QA pass on attempt ${qaAttempt}, score ${qaResult.score}`
                );
                const lessonModel = resolveModel(selectModelTier({ type: 'lesson_extract' }).tier, settings);
                const lessonResult = await callLLM(settings, lessonModel, [
                  { role: 'system', content: '你是经验提取助手，只输出经验条目。' },
                  { role: 'user', content: lessonPrompt },
                ], signal, 1024);
                const lessonCost = calcCost(lessonModel, lessonResult.inputTokens, lessonResult.outputTokens);
                updateAgentStats(qaId, projectId, lessonResult.inputTokens, lessonResult.outputTokens, lessonCost);

                // 写入 project memory
                const lessons = lessonResult.content.trim();
                if (lessons) {
                  appendProjectMemory(workspacePath, `### Lessons from ${feature.id} (QA attempt ${qaAttempt})\n${lessons}`);
                  sendToUI(win, 'agent:log', {
                    projectId, agentId: 'system',
                    content: `📝 经验已自动记录到 project-memory:\n${lessons.slice(0, 200)}`,
                  });
                  addLog(projectId, 'system', 'lesson', `[${feature.id}] ${lessons}`);
                }
              } catch (lessonErr: any) {
                // 经验提取失败不影响主流程
                sendToUI(win, 'agent:log', {
                  projectId, agentId: 'system',
                  content: `⚠️ 经验提取失败 (非致命): ${lessonErr.message}`,
                });
              }
            }

            break;
          } else {
            qaFeedback = qaResult.feedbackText;
            sendToUI(win, 'agent:log', {
              projectId, agentId: qaId,
              content: `❌ ${feature.id} QA 未通过 (分数: ${qaResult.score}): ${qaResult.summary}`,
            });
            sendToUI(win, 'agent:log', {
              projectId, agentId: workerId,
              content: `🔄 ${feature.id} 根据 QA 反馈重做 (${qaAttempt}/${maxQARetries})`,
            });
            db.prepare("UPDATE features SET status = 'in_progress' WHERE id = ? AND project_id = ?").run(feature.id, projectId);
          }
        } else {
          // task_complete 但没有文件 → 勉强通过
          passed = true;
          sendToUI(win, 'agent:log', {
            projectId, agentId: workerId,
            content: `✅ ${feature.id} 完成 (无文件输出, $${reactResult.totalCost.toFixed(4)})`,
          });
          break;
        }
      } catch (err: any) {
        if (signal.aborted) break;
        sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `❌ ${feature.id} 错误: ${err.message}` });
        addLog(projectId, workerId, 'error', `[${feature.id}] ${err.message}`);
        if (qaAttempt >= maxQARetries) break;
        await sleep(2000);
      }
    }

    if (signal.aborted) break;

    const newStatus = passed ? 'passed' : 'failed';
    db.prepare("UPDATE features SET status = ?, locked_by = NULL, completed_at = CASE WHEN ? = 'passed' THEN datetime('now') ELSE NULL END WHERE id = ? AND project_id = ?")
      .run(newStatus, newStatus, feature.id, projectId);
    sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: newStatus, agentId: workerId });
    db.prepare("UPDATE agents SET current_task = NULL WHERE id = ? AND project_id = ?").run(workerId, projectId);

    // v2.0: Feature 完成事件 + 每 3 个 feature 创建检查点
    emitEvent({
      projectId, agentId: workerId, featureId: feature.id,
      type: passed ? 'feature:passed' : 'feature:failed',
      data: { title: feature.title, status: newStatus },
    });
    // 定期检查点
    const completedCount = (db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ? AND status IN ('passed','failed')").get(projectId) as any).c;
    if (completedCount % 3 === 0) {
      createCheckpoint(projectId, `${completedCount} Features 已处理`);
    }

    // Git commit after each passed feature
    if (passed && workspacePath) {
      commitWorkspace(workspacePath, `feat: ${feature.id} — ${(feature.title || '').slice(0, 50)}`);
    }

    await sleep(500);
  }
}

// ═══════════════════════════════════════
// ReAct Developer Loop — 多轮工具调用核心
// ═══════════════════════════════════════
interface ReactResult {
  completed: boolean;
  filesWritten: string[];    // 相对路径列表
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  iterations: number;
}

async function reactDeveloperLoop(
  projectId: string, workerId: string, settings: any,
  win: BrowserWindow | null, signal: AbortSignal,
  workspacePath: string | null, gitConfig: GitProviderConfig,
  feature: any, qaFeedback: string
): Promise<ReactResult> {
  const db = getDb();
  const MAX_ITERATIONS = 25;

  // ── v1.3: Dynamic Model Selection ──
  const featureComplexity = estimateFeatureComplexity(feature);
  let depCount = 0;
  try { depCount = JSON.parse(feature.depends_on || '[]').length; } catch {}
  const taskComplexity: TaskComplexity = {
    type: 'development',
    featureComplexity,
    dependencyCount: depCount,
    hasQAFeedback: !!qaFeedback,
    qaAttempt: qaFeedback ? 2 : 1, // 如有 QA 反馈则至少第 2 次
  };
  const modelSelection = selectModelTier(taskComplexity);
  const model = resolveModel(modelSelection.tier, settings);
  sendToUI(win, 'agent:log', {
    projectId, agentId: workerId,
    content: `🤖 ${feature.id} 模型选择: ${model} (${modelSelection.tier}) — ${modelSelection.reason}`,
  });

  const tools = getToolsForRole('developer', gitConfig.mode);

  const toolCtx: ToolContext = {
    workspacePath: workspacePath || '',
    projectId,
    gitConfig,
  };

  let totalCost = 0;
  let totalIn = 0;
  let totalOut = 0;
  let completed = false;
  const filesWritten = new Set<string>();

  // ── Step 1: 规划 ──
  sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `📋 ${feature.id} 制定开发计划...` });

  let plan: FeaturePlan | null = null;
  try {
    const planCtx = workspacePath
      ? collectLightContext(workspacePath, projectId, feature, undefined, 2000, workerId)
      : { contextText: '', estimatedTokens: 0, filesIncluded: 0 };

    const planModel = resolveModel(selectModelTier({ type: 'planning' }).tier, settings);
    const planResult = await callLLM(settings, planModel, [
      { role: 'system', content: PLANNER_FEATURE_PROMPT },
      {
        role: 'user',
        content: `Feature: ${feature.id}\n标题: ${feature.title}\n描述: ${feature.description}\n验收标准: ${feature.acceptance_criteria}\n${qaFeedback ? `\nQA 反馈（需修复）:\n${qaFeedback}` : ''}\n\n${planCtx.contextText}`,
      },
    ], signal, 4096);

    const planCost = calcCost(planModel, planResult.inputTokens, planResult.outputTokens);
    totalCost += planCost;
    totalIn += planResult.inputTokens;
    totalOut += planResult.outputTokens;
    updateAgentStats(workerId, projectId, planResult.inputTokens, planResult.outputTokens, planCost);

    plan = parsePlanFromLLM(planResult.content, feature.id, feature.title || feature.description);
    const planSummary = plan.steps.map((s, i) => `  ${i + 1}. ${s.description}`).join('\n');
    sendToUI(win, 'agent:log', {
      projectId, agentId: workerId,
      content: `📋 ${feature.id} 计划 (${plan.steps.length} 步):\n${planSummary}`,
    });
    addLog(projectId, workerId, 'plan', `[${feature.id}] Plan:\n${planSummary}`);
  } catch (err: any) {
    sendToUI(win, 'agent:log', {
      projectId, agentId: workerId,
      content: `⚠️ ${feature.id} 规划失败，使用默认计划: ${err.message}`,
    });
    plan = parsePlanFromLLM('', feature.id, feature.title || feature.description);
  }

  // ── Step 2: ReAct 循环 ──
  // v1.3: Code Graph 日志
  if (workspacePath) {
    try {
      const graph = buildCodeGraph(workspacePath, 300);
      const summary = graphSummary(graph);
      sendToUI(win, 'agent:log', {
        projectId, agentId: workerId,
        content: `📊 ${feature.id} ${summary}`,
      });
    } catch { /* non-fatal */ }
  }

  // 构建初始消息列表
  const initialContext = workspacePath
    ? collectDeveloperContext(workspacePath, projectId, feature, 5000, workerId)
    : { contextText: '', estimatedTokens: 0, filesIncluded: 0 };

  // v1.1: 推送上下文快照到 UI
  if (initialContext.snapshot) {
    cacheContextSnapshot(projectId, initialContext.snapshot);
    sendToUI(win, 'agent:context-snapshot', {
      projectId,
      snapshot: initialContext.snapshot,
    });
  }

  const planText = plan ? getPlanSummary(plan) : '';

  // v1.2: 共享决策日志注入
  let sharedDecisionsText = '';
  if (workspacePath) {
    const decisions = readRecentDecisions(workspacePath, 20);
    sharedDecisionsText = formatDecisionsForContext(decisions, workerId);
  }

  const messages: Array<{ role: string; content: any; tool_calls?: any; tool_call_id?: string }> = [
    { role: 'system', content: DEVELOPER_REACT_PROMPT },
    {
      role: 'user',
      content: `## 任务\nFeature: ${feature.id}\n标题: ${feature.title}\n描述: ${feature.description}\n验收标准: ${feature.acceptance_criteria}\n${qaFeedback ? `\n## QA 审查反馈（必须修复）\n${qaFeedback}` : ''}\n\n${planText}\n\n${sharedDecisionsText ? sharedDecisionsText + '\n\n' : ''}## 项目上下文\n${initialContext.contextText}`,
    },
  ];

  sendToUI(win, 'agent:log', {
    projectId, agentId: workerId,
    content: `🔄 ${feature.id} 开始 ReAct 工具循环 (最多 ${MAX_ITERATIONS} 轮)`,
  });

  // v1.1: 初始化 Agent ReAct 状态跟踪
  const reactState: AgentReactState = {
    agentId: workerId,
    featureId: feature.id,
    iterations: [],
    maxContextWindow: 128000, // 默认估值，大多数现代模型
  };

  for (let iter = 1; iter <= MAX_ITERATIONS && !signal.aborted; iter++) {
    // 预算检查
    const budget = checkBudget(projectId, settings);
    if (!budget.ok) break;

    try {
      const result = await callLLMWithTools(settings, model, messages, tools, signal, 16384);
      const cost = calcCost(model, result.inputTokens, result.outputTokens);
      totalCost += cost;
      totalIn += result.inputTokens;
      totalOut += result.outputTokens;
      updateAgentStats(workerId, projectId, result.inputTokens, result.outputTokens, cost);

      const msg = result.message;

      // ── 有思考内容，推送到 UI ──
      if (msg.content) {
        const shortThought = msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content;
        sendToUI(win, 'agent:log', {
          projectId, agentId: workerId,
          content: `💭 ${feature.id} [${iter}] ${shortThought}`,
        });
      }

      // ── 无 tool_calls → 纯文本回复，结束循环 ──
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // 尝试从文本中解析旧格式的 <<<FILE>>> 块（兼容模式）
        if (msg.content && workspacePath) {
          const fileBlocks = parseFileBlocks(msg.content);
          if (fileBlocks.length > 0) {
            const written = writeFileBlocks(workspacePath, fileBlocks);
            for (const w of written) filesWritten.add(w.relativePath);
            sendToUI(win, 'agent:log', {
              projectId, agentId: workerId,
              content: `📁 ${feature.id} [兼容模式] 写入 ${written.length} 文件`,
            });
            sendToUI(win, 'workspace:changed', { projectId });
          }
          if (msg.content.toUpperCase().includes('COMPLETED')) {
            completed = true;
          }
        }
        sendToUI(win, 'agent:log', {
          projectId, agentId: workerId,
          content: `🔚 ${feature.id} ReAct 循环结束 (${iter} 轮, ${totalIn + totalOut} tokens, $${totalCost.toFixed(4)})`,
        });
        break;
      }

      // ── 执行 tool calls ──
      // 将 assistant 消息加入历史
      messages.push({
        role: 'assistant',
        content: msg.content,
        tool_calls: msg.tool_calls,
      });

      for (const tc of msg.tool_calls) {
        let toolArgs: Record<string, any>;
        try {
          toolArgs = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
        } catch {
          toolArgs = {};
        }

        const toolCall: ToolCall = { name: tc.function.name, arguments: toolArgs };

        // v2.1: 注入 agentId 到 todo 工具
        if (tc.function.name === 'todo_write' || tc.function.name === 'todo_read') {
          toolArgs._agentId = workerId;
        }

        // ── task_complete → 完成 ──
        if (tc.function.name === 'task_complete') {
          completed = true;
          const summary = toolArgs.summary || '完成';
          const changedFiles = toolArgs.files_changed || [...filesWritten];

          sendToUI(win, 'agent:log', {
            projectId, agentId: workerId,
            content: `✅ ${feature.id} task_complete: ${summary}`,
          });
          addLog(projectId, workerId, 'output', `[${feature.id}] Completed: ${summary}\nFiles: ${changedFiles.join(', ')}`);

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `任务已标记完成: ${summary}`,
          });
          continue;
        }

        // 执行工具
        let toolResult: ToolResult;
        const isAsync = tc.function.name.startsWith('github_');

        // ── v1.3: spawn_researcher 子 Agent ──
        if (tc.function.name === 'spawn_researcher') {
          sendToUI(win, 'agent:log', {
            projectId, agentId: workerId,
            content: `🔬 ${feature.id} 启动研究子 Agent: ${(toolArgs.question || '').slice(0, 80)}...`,
          });

          try {
            const researchModel = resolveModel('worker', settings);
            const researchResult = await runResearcher(
              toolArgs.question || '',
              toolCtx,
              async (msgs, tools) => {
                return await callLLMWithTools(settings, researchModel, msgs, tools, signal, 8192);
              },
              signal,
            );

            const resCost = calcCost(researchModel, researchResult.inputTokens, researchResult.outputTokens);
            totalCost += resCost;
            totalIn += researchResult.inputTokens;
            totalOut += researchResult.outputTokens;
            updateAgentStats(workerId, projectId, researchResult.inputTokens, researchResult.outputTokens, resCost);

            sendToUI(win, 'agent:log', {
              projectId, agentId: workerId,
              content: `🔬 ${feature.id} 研究子 Agent 完成 (读取 ${researchResult.filesRead.length} 文件, $${resCost.toFixed(4)})`,
            });

            toolResult = {
              success: researchResult.success,
              output: `研究结论:
${researchResult.conclusion}\n\n参考文件: ${researchResult.filesRead.join(', ') || '无'}`,
              action: 'read',
            };
          } catch (resErr: any) {
            toolResult = { success: false, output: `研究子 Agent 失败: ${resErr.message}`, action: 'read' };
          }
        } else if (isAsync) {
          toolResult = await executeToolAsync(toolCall, toolCtx);
        } else {
          toolResult = executeTool(toolCall, toolCtx);
        }

        // 推送工具调用日志
        const argsSummary = tc.function.name === 'write_file'
          ? `path=${toolArgs.path}, ${Buffer.byteLength(toolArgs.content || '', 'utf-8')} bytes`
          : tc.function.name === 'edit_file'
          ? `path=${toolArgs.path}, replace ${(toolArgs.old_string || '').length}→${(toolArgs.new_string || '').length} chars`
          : JSON.stringify(toolArgs).slice(0, 150);
        sendToUI(win, 'agent:tool-call', {
          projectId, agentId: workerId,
          tool: tc.function.name,
          args: argsSummary,
          success: toolResult.success,
          outputPreview: toolResult.output.slice(0, 200),
        });
        // v2.0: 工具调用事件
        emitEvent({
          projectId, agentId: workerId, featureId: feature.id,
          type: 'tool:call',
          data: { tool: tc.function.name, args: argsSummary, success: toolResult.success },
        });
        sendToUI(win, 'agent:log', {
          projectId, agentId: workerId,
          content: `🔧 ${tc.function.name}(${argsSummary}) → ${toolResult.success ? '✅' : '❌'} ${toolResult.output.slice(0, 100)}`,
        });

        // 记录写入/编辑的文件
        if ((tc.function.name === 'write_file' || tc.function.name === 'edit_file') && toolResult.success) {
          filesWritten.add(toolArgs.path);
          sendToUI(win, 'workspace:changed', { projectId });
          // v1.2: 共享决策日志
          if (workspacePath) {
            appendSharedDecision(workspacePath, {
              agentId: workerId,
              featureId: feature.id,
              type: tc.function.name === 'write_file' ? 'file_created' : 'other',
              description: `${tc.function.name} ${toolArgs.path}`,
            });
          }
        }

        // 将工具结果加入消息历史
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolResult.output.slice(0, 4000), // 限制输出长度
        });
      }

      // ═══ v1.1: 推送 Agent ReAct 迭代状态 ═══
      const toolCallsThisIter = (msg.tool_calls || []).map((tc: any) => tc.function.name);
      const { breakdown, total: contextTokens } = computeMessageBreakdown(messages);
      const iterState: ReactIterationState = {
        iteration: iter,
        timestamp: Date.now(),
        messageCount: messages.length,
        totalContextTokens: contextTokens,
        breakdown,
        inputTokensThisCall: result.inputTokens,
        outputTokensThisCall: result.outputTokens,
        costThisCall: cost,
        cumulativeCost: totalCost,
        cumulativeInputTokens: totalIn,
        cumulativeOutputTokens: totalOut,
        filesWritten: [...filesWritten],
        toolCallsThisIteration: toolCallsThisIter,
        completed,
      };
      reactState.iterations.push(iterState);
      cacheAgentReactState(projectId, reactState);
      sendToUI(win, 'agent:react-state', {
        projectId,
        agentId: workerId,
        state: reactState,
        latestIteration: iterState,
      });

      // 如果 task_complete 已触发，结束循环
      if (completed) {
        sendToUI(win, 'agent:log', {
          projectId, agentId: workerId,
          content: `🔚 ${feature.id} ReAct 完成 (${iter} 轮, ${totalIn + totalOut} tokens, $${totalCost.toFixed(4)})`,
        });
        break;
      }

      // ── 消息窗口压缩: 超过 30 条消息时使用 LLM 摘要 (v1.2) ──
      if (messages.length > 30) {
        await compressMessageHistorySmart(messages, settings, signal);
      }

    } catch (err: any) {
      if (signal.aborted) break;
      sendToUI(win, 'agent:log', {
        projectId, agentId: workerId,
        content: `⚠️ ${feature.id} ReAct 迭代 ${iter} 错误: ${err.message}`,
      });
      addLog(projectId, workerId, 'error', `[${feature.id}] iter ${iter}: ${err.message}`);
      // 短暂等待后继续
      await sleep(2000);
    }
  }

  // 更新 feature 的 affected_files
  if (filesWritten.size > 0) {
    const existingFiles = JSON.parse(feature.affected_files || '[]') as string[];
    const allFiles = [...new Set([...existingFiles, ...filesWritten])];
    db.prepare("UPDATE features SET affected_files = ? WHERE id = ? AND project_id = ?")
      .run(JSON.stringify(allFiles), feature.id, projectId);
  }

  return {
    completed,
    filesWritten: [...filesWritten],
    totalCost,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    iterations: 0, // not tracked precisely, but available in logs
  };
}

/**
 * 压缩消息历史 — v1.2 智能摘要版
 * 使用 LLM 将旧消息摘要为一条紧凑的 user 消息，替代暴力截断。
 * 失败时 fallback 到简单截断。
 */
async function compressMessageHistorySmart(
  messages: Array<{ role: string; content: any; tool_calls?: any; tool_call_id?: string }>,
  settings: any,
  signal?: AbortSignal
): Promise<void> {
  const keepRecent = 10;
  if (messages.length <= keepRecent + 2) return; // 没啥好压缩的

  // 提取需要压缩的消息 (跳过 system[0] 和最近 keepRecent 条)
  const compressRange = messages.slice(1, messages.length - keepRecent);
  if (compressRange.length < 5) return;

  // 构建摘要 prompt
  const compressText = compressRange.map(m => {
    const role = m.role;
    const content = typeof m.content === 'string' ? m.content.slice(0, 300) : JSON.stringify(m.content).slice(0, 300);
    const toolInfo = m.tool_calls ? ` [tools: ${m.tool_calls.map((t: any) => t.function.name).join(',')}]` : '';
    return `[${role}]${toolInfo} ${content}`;
  }).join('\n');

  try {
    const summaryModel = resolveModel(selectModelTier({ type: 'summarize' }).tier, settings);
    const summaryResult = await callLLM(settings, summaryModel, [
      { role: 'system', content: '你是对话摘要助手。将以下 Agent 对话历史压缩为一段简洁摘要（200-400字），保留关键决策、已创建的文件、遇到的问题和解决方案。只输出摘要，不要其他内容。' },
      { role: 'user', content: `请摘要以下 ${compressRange.length} 条对话:\n\n${compressText.slice(0, 4000)}` },
    ], signal, 1024, 0); // 不重试

    if (summaryResult.content) {
      // 替换: 删掉旧消息，插入一条摘要
      const summaryMsg = {
        role: 'user' as string,
        content: `## 之前的对话摘要 (${compressRange.length} 条消息已压缩)\n${summaryResult.content}`,
      };
      messages.splice(1, compressRange.length, summaryMsg);
      return;
    }
  } catch {
    // LLM 摘要失败，fallback 到简单截断
  }

  // Fallback: 简单截断
  compressMessageHistorySimple(messages);
}

/** 简单截断 (原 v0.9 逻辑, 作为 fallback) */
function compressMessageHistorySimple(messages: Array<{ role: string; content: any; tool_calls?: any; tool_call_id?: string }>) {
  const keepRecent = 10;
  const cutoff = messages.length - keepRecent;
  for (let i = 1; i < cutoff; i++) {
    if (messages[i].role === 'tool' && typeof messages[i].content === 'string') {
      const content = messages[i].content as string;
      if (content.length > 300) {
        messages[i].content = content.slice(0, 200) + '\n... [已压缩]';
      }
    }
  }
}

// ═══════════════════════════════════════
// ═══════════════════════════════════════
// QA 审查 (v1.2: TDD 模式 — 先跑测试, 再 LLM 审查)
// ═══════════════════════════════════════
interface QAResult {
  verdict: 'pass' | 'fail';
  score: number;
  summary: string;
  feedbackText: string;
  inputTokens: number;
  outputTokens: number;
}

async function runQAReview(
  settings: any, signal: AbortSignal,
  feature: any, filesWritten: string[], workspacePath: string
): Promise<QAResult> {
  const filesContent: string[] = [];
  for (const filePath of filesWritten.slice(0, 10)) {
    const content = readWorkspaceFile(workspacePath, filePath);
    if (content) {
      filesContent.push(`### ${filePath}\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  // ═══ v1.2: TDD — 先跑测试和 lint ═══
  let testResults = '';
  const hasTestFiles = filesWritten.some(f =>
    f.includes('test') || f.includes('spec') || f.includes('__tests__')
  );
  const fs = require('fs');
  const hasPackageJson = fs.existsSync(require('path').join(workspacePath, 'package.json'));
  const hasRequirements = fs.existsSync(require('path').join(workspacePath, 'requirements.txt'));
  const hasCargoToml = fs.existsSync(require('path').join(workspacePath, 'Cargo.toml'));

  if (hasTestFiles || hasPackageJson || hasRequirements || hasCargoToml) {
    const { runTest: sbRunTest, runLint: sbRunLint } = require('./sandbox-executor');
    const sandboxCfg = { workspacePath, timeoutMs: 120_000 };

    // 运行测试
    try {
      const testResult = sbRunTest(sandboxCfg);
      testResults += `## 测试执行结果\n`;
      testResults += `状态: ${testResult.success ? '✅ PASS' : '❌ FAIL'} (exit ${testResult.exitCode}, ${testResult.duration}ms)\n`;
      testResults += `\`\`\`\n${(testResult.stdout + testResult.stderr).slice(0, 3000)}\n\`\`\`\n\n`;
    } catch (e: any) {
      testResults += `## 测试执行\n⚠️ 无法运行: ${e.message}\n\n`;
    }

    // 运行 lint
    try {
      const lintResult = sbRunLint(sandboxCfg);
      if (lintResult.stdout && lintResult.stdout !== '未检测到 lint/type-check 配置') {
        testResults += `## Lint/类型检查结果\n`;
        testResults += `状态: ${lintResult.success ? '✅ PASS' : '❌ FAIL'}\n`;
        testResults += `\`\`\`\n${lintResult.stdout.slice(0, 2000)}\n\`\`\`\n\n`;
      }
    } catch { /* non-fatal */ }
  }

  const result = await callLLM(settings, settings.strongModel, [
    { role: 'system', content: QA_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `请审查以下 Feature 的实现代码:\n\nFeature ID: ${feature.id}\n标题: ${feature.title}\n描述: ${feature.description}\n验收标准: ${feature.acceptance_criteria}\n\n${testResults}## 实现的文件\n${filesContent.join('\n\n')}\n\n请给出审查结果（JSON 格式，不要用 markdown 代码块包裹）。${testResults ? '\n注意: 如果测试失败，verdict 应为 fail。' : ''}`,
    },
  ], signal, 4096);

  let verdict: 'pass' | 'fail' = 'pass';
  let score = 80;
  let summary = '';
  let issues: any[] = [];

  try {
    const jsonMatch = result.content.trim().match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      verdict = parsed.verdict === 'fail' ? 'fail' : 'pass';
      score = parsed.score ?? 80;
      summary = parsed.summary ?? '';
      issues = parsed.issues ?? [];
    }
  } catch {
    summary = 'QA 输出格式异常，默认通过';
  }

  let feedbackText = `QA 分数: ${score}/100\n${summary}`;
  if (issues.length > 0) {
    feedbackText += '\n\n问题列表:\n' + issues.map((iss: any, i: number) =>
      `${i + 1}. [${iss.severity}] ${iss.file || ''}: ${iss.description}\n   建议: ${iss.suggestion || 'N/A'}`
    ).join('\n');
  }

  return {
    verdict, score, summary, feedbackText,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

// ═══════════════════════════════════════
// AGENTS.md — 项目级 Agent 指令文件 (v1.0)
// ═══════════════════════════════════════

/**
 * 确保 .agentforge/AGENTS.md 存在。
 * 如果不存在，从 ARCHITECTURE.md 和 wish 自动生成初始版本。
 * Agent 可以通过 edit_file 自行更新此文件。
 */
function ensureAgentsMd(workspacePath: string, wish: string) {
  const fs = require('fs');
  const p = require('path');
  const agentsDir = p.join(workspacePath, '.agentforge');
  const agentsPath = p.join(agentsDir, 'AGENTS.md');

  if (fs.existsSync(agentsPath)) return; // 已存在，不覆盖

  fs.mkdirSync(agentsDir, { recursive: true });

  // 从 ARCHITECTURE.md 提取技术栈信息
  let techInfo = '';
  const archPath = p.join(workspacePath, 'ARCHITECTURE.md');
  if (fs.existsSync(archPath)) {
    const archContent = fs.readFileSync(archPath, 'utf-8');
    // 提取前 30 行作为概要
    techInfo = archContent.split('\n').slice(0, 30).join('\n');
  }

  const content = `# AGENTS.md — 项目规范
> 此文件由 AgentForge 自动生成，Agent 和用户均可编辑。
> 所有 Agent 在每次操作前会自动读取此文件。

## 项目概述
${wish.slice(0, 500)}

## 技术栈概要
${techInfo || '(待 Architect 生成 ARCHITECTURE.md 后自动补充)'}

## 编码规范
- 使用项目已有的代码风格和命名规范
- 文件组织遵循 ARCHITECTURE.md 中的目录结构
- 所有新文件必须包含必要的 import 和 export
- 错误处理: 不要忽略异常，必须有适当的 catch/error handling

## 常用命令
- 安装依赖: (根据项目类型，如 npm install / pip install -r requirements.txt)
- 编译检查: (如 npx tsc --noEmit / python -m py_compile)
- 运行测试: (如 npm test / pytest)

## 注意事项
- 修改已有文件时使用 edit_file (str_replace)，不要 write_file 重写整个文件
- 创建新文件前先 list_files 确认不会覆盖已有文件
- 每个 Feature 完成后务必调用 task_complete

## 项目经验记录
> Agent 在开发过程中发现的重要经验会自动追加到这里
`;

  fs.writeFileSync(agentsPath, content, 'utf-8');
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

