/**
 * meta-agent IPC handlers — 元Agent 对话 + 管理 + 记忆系统
 *
 * v5.4: 初始创建 — LLM 对话 + 意图检测
 * v7.0: 管理页面支持 — 可配置名字/称呼/提示词/上下文限制 + 独立记忆系统
 * v6.1: ReAct 模式升级 — callLLMWithTools, 具备只读工具集(读文件/搜索/web_search/git_log)
 *
 * 记忆系统参考 EchoAgent agent-memory 架构:
 *   - identity: 管家自我认知 (名字/角色/性格)
 *   - user_profile: 对用户的了解 (偏好/称呼/习惯)
 *   - lessons: 经验教训 (自动积累, 大容量, 支持100+条)
 *   - facts: 长期事实记忆 (重要事件/决策/约定)
 *   - conversation_summary: 历史对话压缩摘要
 */

import { ipcMain, BrowserWindow } from 'electron';
import { callLLMWithTools, calcCost, getSettings } from '../engine/llm-client';
import { sendToUI, addLog } from '../engine/ui-bridge';
import { getDb } from '../db';
import { runOrchestrator } from '../engine/orchestrator';
import { updateAgentStats } from '../engine/agent-manager';
import { emitEvent } from '../engine/event-store';
import { assertNonEmptyString, assertObject, assertOptionalString, assertOptionalNumber } from './ipc-validator';
import {
  getDaemonConfig, saveDaemonConfig, getDaemonStatus,
  startDaemon, stopDaemon, restartDaemon,
  triggerManualHeartbeat, getHeartbeatLogs,
} from '../engine/meta-agent-daemon';
import { backupConversation } from '../engine/conversation-backup';
import { getToolsForRole, executeTool, executeToolAsync, isAsyncTool, type ToolContext, type ToolCall, type ToolResult } from '../engine/tool-system';
import { guardToolCall } from '../engine/guards';
import fs from 'fs';
import path from 'path';
import type { LLMToolCall, ProjectRow } from '../engine/types';
import type { DaemonConfig } from '../engine/meta-agent-daemon';

const log = createLogger('ipc:meta-agent');
import { toErrorMessage, createLogger } from '../engine/logger';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface MetaAgentConfig {
  name: string;               // 管家名字 (默认 "元Agent管家")
  userNickname: string;       // 对用户的称呼 (默认 "你")
  personality: string;        // 性格描述 (简短)
  systemPrompt: string;       // 完整系统提示词 (可覆盖默认)
  contextHistoryLimit: number; // 对话历史保留条数 (默认 20)
  contextTokenLimit: number;  // 上下文 token 上限 (默认 512000)
  maxResponseTokens: number;  // 回复最大 token (默认 128000)
  maxReactIterations: number; // ReAct 工具循环最大迭代轮数 (默认 50)
  readFileLineLimit: number;  // read_file 工具默认行数上限 (默认 1000, 最大2000)
  autoMemory: boolean;        // 是否自动积累记忆 (默认 true)
  memoryInjectLimit: number;  // 每次对话注入记忆条数上限 (默认 30)
  greeting: string;           // 自定义开场白
}

export interface MetaAgentMemory {
  id: string;
  category: 'identity' | 'user_profile' | 'lessons' | 'facts' | 'conversation_summary';
  content: string;
  source: 'auto' | 'manual' | 'system';
  importance: number;         // 1-10, 越高越重要
  created_at: string;
  updated_at: string;
}

// ═══════════════════════════════════════
// Default Config
// ═══════════════════════════════════════

const DEFAULT_CONFIG: MetaAgentConfig = {
  name: '元Agent管家',
  userNickname: '',
  personality: '专业、友好、高效',
  systemPrompt: '',  // 空 = 使用内置默认
  contextHistoryLimit: 20,
  contextTokenLimit: 512000,
  maxResponseTokens: 128000,
  maxReactIterations: 50,
  readFileLineLimit: 1000,
  autoMemory: true,
  memoryInjectLimit: 30,
  greeting: '',  // 空 = 使用内置默认
};

// ═══════════════════════════════════════
// Config Management
// ═══════════════════════════════════════

function getMetaAgentConfig(): MetaAgentConfig {
  const db = getDb();
  const row = db.prepare('SELECT value FROM meta_agent_config WHERE key = ?').get('config') as { value: string } | undefined;
  if (row) {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(row.value) };
    } catch { /* fallback */ }
  }
  return { ...DEFAULT_CONFIG };
}

function saveMetaAgentConfig(config: Partial<MetaAgentConfig>): MetaAgentConfig {
  const db = getDb();
  const current = getMetaAgentConfig();
  const merged = { ...current, ...config };
  db.prepare('INSERT OR REPLACE INTO meta_agent_config (key, value) VALUES (?, ?)').run('config', JSON.stringify(merged));
  return merged;
}

// ═══════════════════════════════════════
// Memory Management
// ═══════════════════════════════════════

function getMemories(category?: string, limit?: number): MetaAgentMemory[] {
  const db = getDb();
  let sql = 'SELECT * FROM meta_agent_memories';
  const params: Array<string | number> = [];

  if (category) {
    sql += ' WHERE category = ?';
    params.push(category);
  }

  sql += ' ORDER BY importance DESC, updated_at DESC';

  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  return db.prepare(sql).all(...params) as MetaAgentMemory[];
}

function addMemory(memory: Omit<MetaAgentMemory, 'id' | 'created_at' | 'updated_at'>): MetaAgentMemory {
  const db = getDb();
  const id = `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO meta_agent_memories (id, category, content, source, importance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, memory.category, memory.content, memory.source, memory.importance, now, now);

  return { id, ...memory, created_at: now, updated_at: now };
}

function updateMemory(id: string, updates: { content?: string; importance?: number; category?: string }): boolean {
  const db = getDb();
  const parts: string[] = [];
  const params: Array<string | number> = [];

  if (updates.content !== undefined) { parts.push('content = ?'); params.push(updates.content); }
  if (updates.importance !== undefined) { parts.push('importance = ?'); params.push(updates.importance); }
  if (updates.category !== undefined) { parts.push('category = ?'); params.push(updates.category); }

  if (parts.length === 0) return false;

  parts.push("updated_at = datetime('now')");
  params.push(id);

  const result = db.prepare(`UPDATE meta_agent_memories SET ${parts.join(', ')} WHERE id = ?`).run(...params);
  return result.changes > 0;
}

function deleteMemory(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM meta_agent_memories WHERE id = ?').run(id);
  return result.changes > 0;
}

function searchMemories(query: string, limit: number = 20): MetaAgentMemory[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM meta_agent_memories WHERE content LIKE ? ORDER BY importance DESC, updated_at DESC LIMIT ?`
  ).all(`%${query}%`, limit) as MetaAgentMemory[];
}

function getMemoryStats(): { total: number; byCategory: Record<string, number> } {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as count FROM meta_agent_memories').get() as { count: number }).count;
  const rows = db.prepare('SELECT category, COUNT(*) as count FROM meta_agent_memories GROUP BY category').all() as Array<{ category: string; count: number }>;
  const byCategory: Record<string, number> = {};
  for (const r of rows) byCategory[r.category] = r.count;
  return { total, byCategory };
}

// ═══════════════════════════════════════
// Build System Prompt (dynamic, config-aware)
// ═══════════════════════════════════════

function buildSystemPrompt(config: MetaAgentConfig, memories: MetaAgentMemory[]): string {
  // If user has custom system prompt, use it as base
  if (config.systemPrompt.trim()) {
    // Still inject memory context even with custom prompt
    const memoryBlock = formatMemoriesForContext(memories);
    return config.systemPrompt + (memoryBlock ? `\n\n${memoryBlock}` : '');
  }

  // Build default system prompt with config values
  const userName = config.userNickname ? `称呼用户为"${config.userNickname}"` : '用正常方式称呼用户';
  const personality = config.personality || '专业、友好、高效';

  let prompt = `你是"${config.name}"，一个AI软件开发平台的智能管家。性格: ${personality}。${userName}。

你的核心职责是**指挥和协调**，而不是亲自执行开发/分析任务。

## 职责

1. **需求派发**: 当用户表达产品需求、功能想法、审查请求、改进方案时，使用 \`create_wish\` 工具将任务派发给项目开发团队。团队有 PM、架构师、开发、QA 等角色，会自动执行完整流水线。
2. **快速查询**: 当用户只是简单询问项目状态、某个文件内容、架构概况时，可以使用读取/搜索工具快速回答。
3. **对话交流**: 其他问题友好回答。

## 工具能力

### 任务派发 (最重要)
- \`create_wish\`: **将需求/任务派发给开发团队**。任何涉及代码编写、深度审查、架构重构、功能开发的请求都应通过此工具派发。

### 信息查询 (辅助)
- read_file / list_files / search_files / glob_files: 快速查看项目文件
- web_search / fetch_url: 搜索互联网信息
- git_log: 查看 Git 提交历史
- think: 组织思路

## 重要规则

1. **不要自己做深度代码分析/审查**: 当用户要求"分析项目"、"审查代码质量"、"提出改进方案"等任务时，你应该用 \`create_wish\` 把任务描述清楚后派发给团队，而不是自己花几十轮去读文件分析。
2. **可以做轻量查询**: 如果用户只是问"某个文件在哪"、"项目用了什么框架"这类简单问题，你可以用工具快速查看后回答。
3. **wish 内容要精炼**: create_wish 的内容应该是清晰的任务描述（建议500字以内），不要把你的全部分析过程塞进去。团队成员会自行深入分析。
4. **回复格式**: 最终回复使用 JSON: {"intent": "wish|query|workflow|general", "reply": "回复文本", "wishContent": "", "memoryNotes": "可选"}
   - intent=wish: 已通过 create_wish 工具派发了任务
   - intent=query: 信息查询
   - intent=workflow: 工作流调整
   - intent=general: 闲聊
5. **回复要简洁友好**，中文。`;

  // Inject memory context
  const memoryBlock = formatMemoriesForContext(memories);
  if (memoryBlock) {
    prompt += `\n\n${memoryBlock}`;
  }

  return prompt;
}

function formatMemoriesForContext(memories: MetaAgentMemory[]): string {
  if (memories.length === 0) return '';

  const sections: string[] = [];
  const grouped: Record<string, MetaAgentMemory[]> = {};

  for (const m of memories) {
    if (!grouped[m.category]) grouped[m.category] = [];
    grouped[m.category].push(m);
  }

  const categoryLabels: Record<string, string> = {
    identity: '🤖 自我认知',
    user_profile: '👤 对用户的了解',
    lessons: '📝 经验教训',
    facts: '📌 重要事实',
    conversation_summary: '💬 历史对话摘要',
  };

  for (const [cat, items] of Object.entries(grouped)) {
    const label = categoryLabels[cat] || cat;
    const lines = items.map(m => `- ${m.content}`).join('\n');
    sections.push(`### ${label}\n${lines}`);
  }

  return `## 你的记忆 (长期知识)\n以下是你积累的记忆，请在回复时参考：\n\n${sections.join('\n\n')}`;
}

// ═══════════════════════════════════════
// Helper: Collect project context for query
// ═══════════════════════════════════════

function collectProjectContext(projectId: string): string {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as { name: string; status: string; wish?: string; workspace_path?: string } | undefined;
  if (!project) return '(项目不存在)';

  const parts: string[] = [];
  parts.push(`项目名: ${project.name}`);
  parts.push(`状态: ${project.status}`);
  if (project.wish) parts.push(`需求: ${project.wish}`);

  // Features summary
  const features = db.prepare('SELECT id, title, status, category FROM features WHERE project_id = ?').all(projectId) as Array<{ id: string; title: string; status: string; category: string }>;
  if (features.length > 0) {
    parts.push(`\nFeature 列表 (${features.length}个):`);
    features.forEach((f) => parts.push(`  - [${f.status}] ${f.title} (${f.category || 'other'})`));
  }

  // Design doc (truncated)
  if (project.workspace_path) {
    const archPath = path.join(project.workspace_path, '.automater', 'docs', 'ARCHITECTURE.md');
    if (fs.existsSync(archPath)) {
      const content = fs.readFileSync(archPath, 'utf-8');
      parts.push(`\n设计文档(前2000字):\n${content.slice(0, 2000)}`);
    }
  }

  return parts.join('\n');
}

// ═══════════════════════════════════════
// Auto Memory: Extract and store from conversations
// ═══════════════════════════════════════

function autoExtractMemory(memoryNotes: string): void {
  if (!memoryNotes || !memoryNotes.trim()) return;

  try {
    // Determine category heuristically
    const lower = memoryNotes.toLowerCase();
    let category: MetaAgentMemory['category'] = 'facts';
    if (lower.includes('偏好') || lower.includes('喜欢') || lower.includes('不喜欢') || lower.includes('习惯') || lower.includes('称呼')) {
      category = 'user_profile';
    } else if (lower.includes('教训') || lower.includes('经验') || lower.includes('避免') || lower.includes('注意') || lower.includes('bug') || lower.includes('坑')) {
      category = 'lessons';
    }

    addMemory({
      category,
      content: memoryNotes.trim(),
      source: 'auto',
      importance: 5,
    });

    log.info('Auto-memory stored', { category, preview: memoryNotes.slice(0, 50) });
  } catch (err) {
    log.error('Auto-memory failed', err);
  }
}

// ═══════════════════════════════════════
// IPC Handler Registration
// ═══════════════════════════════════════

export function setupMetaAgentHandlers() {

  // ── Config CRUD ──

  ipcMain.handle('meta-agent:config:get', () => {
    return getMetaAgentConfig();
  });

  ipcMain.handle('meta-agent:config:save', (_event, config: Partial<MetaAgentConfig>) => {
    assertObject('meta-agent:config:save', 'config', config);
    const saved = saveMetaAgentConfig(config);
    return { success: true, config: saved };
  });

  // ── Memory CRUD ──

  ipcMain.handle('meta-agent:memory:list', (_event, category?: string, limit?: number) => {
    return getMemories(category, limit);
  });

  ipcMain.handle('meta-agent:memory:add', (_event, memory: Omit<MetaAgentMemory, 'id' | 'created_at' | 'updated_at'>) => {
    assertObject('meta-agent:memory:add', 'memory', memory);
    assertNonEmptyString('meta-agent:memory:add', 'content', (memory as Record<string, unknown>).content);
    return addMemory(memory);
  });

  ipcMain.handle('meta-agent:memory:update', (_event, id: string, updates: { content?: string; importance?: number; category?: string }) => {
    assertNonEmptyString('meta-agent:memory:update', 'id', id);
    assertObject('meta-agent:memory:update', 'updates', updates);
    return { success: updateMemory(id, updates) };
  });

  ipcMain.handle('meta-agent:memory:delete', (_event, id: string) => {
    assertNonEmptyString('meta-agent:memory:delete', 'id', id);
    return { success: deleteMemory(id) };
  });

  ipcMain.handle('meta-agent:memory:search', (_event, query: string, limit?: number) => {
    assertNonEmptyString('meta-agent:memory:search', 'query', query);
    assertOptionalNumber('meta-agent:memory:search', 'limit', limit);
    return searchMemories(query, limit);
  });

  ipcMain.handle('meta-agent:memory:stats', () => {
    return getMemoryStats();
  });

  ipcMain.handle('meta-agent:memory:clear', (_event, category?: string) => {
    assertOptionalString('meta-agent:memory:clear', 'category', category);
    const db = getDb();
    if (category) {
      db.prepare('DELETE FROM meta_agent_memories WHERE category = ?').run(category);
    } else {
      db.prepare('DELETE FROM meta_agent_memories').run();
    }
    return { success: true };
  });

  // ── Chat (v6.1: ReAct 模式 — callLLMWithTools + 只读工具集) ──
  // v19.0: 支持多模态消息 — 用户可发送图片/文件附件

  interface ChatAttachment {
    type: string;
    name: string;
    data: string;
    mimeType: string;
  }

  ipcMain.handle('meta-agent:chat', async (
    _event,
    projectId: string | null,
    message: string,
    history?: Array<{ role: string; content: string | Array<Record<string, unknown>> }>,
    attachments?: ChatAttachment[],
  ) => {
    assertNonEmptyString('meta-agent:chat', 'message', message);
    const settings = getSettings();
    if (!settings?.apiKey) {
      return { reply: '请先在设置页配置 LLM API Key。', intent: 'general' };
    }

    const config = getMetaAgentConfig();
    const win = BrowserWindow.getAllWindows()[0] ?? null;
    const agentId = 'meta-agent';

    const memories = getMemories(undefined, config.memoryInjectLimit);

    const systemPrompt = buildSystemPrompt(config, memories);
    const messages: Array<{ role: string; content: string | Array<Record<string, unknown>>; tool_calls?: LLMToolCall[]; tool_call_id?: string }> = [
      { role: 'system', content: systemPrompt },
    ];

    if (projectId) {
      const ctx = collectProjectContext(projectId);
      messages.push({ role: 'system', content: `当前项目上下文:\n${ctx}` });
    }

    if (history?.length) {
      const recent = history.slice(-(config.contextHistoryLimit || 20));
      for (const h of recent) {
        messages.push({ role: h.role, content: h.content });
      }
    }

    // v19.0: Build multimodal user message if attachments exist
    if (attachments?.length) {
      const contentBlocks: Array<Record<string, unknown>> = [];
      if (message) contentBlocks.push({ type: 'text', text: message });
      for (const att of attachments) {
        if (att.type === 'image' && att.data) {
          contentBlocks.push({
            type: 'image_url',
            image_url: {
              url: att.data.startsWith('data:') ? att.data : `data:${att.mimeType};base64,${att.data}`,
              detail: 'high',
            },
          });
        } else if (att.type === 'file') {
          try {
            const fs = require('fs');
            if (fs.existsSync(att.data)) {
              const fileContent = fs.readFileSync(att.data, 'utf-8').slice(0, 10000);
              contentBlocks.push({ type: 'text', text: `[附件: ${att.name}]\n\`\`\`\n${fileContent}\n\`\`\`` });
            }
          } catch {
            contentBlocks.push({ type: 'text', text: `[附件: ${att.name} — 读取失败]` });
          }
        }
      }
      messages.push({ role: 'user', content: contentBlocks });
    } else {
      messages.push({ role: 'user', content: message });
    }

    // ── v6.1: ReAct Tool Loop ──
    const MAX_REACT_ITERATIONS = config.maxReactIterations || 50;
    const model = settings.strongModel || settings.workerModel || settings.fastModel || 'gpt-4o';

    // 获取 meta-agent 角色的工具集
    const project = projectId ? (getDb().prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined) : null;
    const workspacePath = project?.workspace_path || '';
    const tools = getToolsForRole('meta-agent', 'local');
    const toolCtx: ToolContext = {
      workspacePath,
      projectId: projectId || '',
      gitConfig: { mode: 'local', workspacePath },
      permissions: {
        readFileLineLimit: config.readFileLineLimit || 1000,
      },
    };

    let totalIn = 0;
    let totalOut = 0;
    let totalCost = 0;
    let finalReply = '';
    let wishCreatedViaTool = false;

    sendToUI(win, 'agent:log', {
      projectId: projectId || 'system', agentId,
      content: `🔄 元Agent 开始 ReAct 对话循环 (最多 ${MAX_REACT_ITERATIONS} 轮)`,
    });

    try {
      for (let iter = 1; iter <= MAX_REACT_ITERATIONS; iter++) {
const result = await callLLMWithTools(
            settings, model, messages, tools, undefined,
          config.maxResponseTokens || 128000,
        );
        const cost = calcCost(model, result.inputTokens, result.outputTokens);
        totalIn += result.inputTokens;
        totalOut += result.outputTokens;
        totalCost += cost;

        const msg = result.message;

        // 推送思考日志
        if (msg.content) {
          const shortThought = msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content;
          sendToUI(win, 'agent:log', {
            projectId: projectId || 'system', agentId,
            content: `💭 [${iter}] ${shortThought}`,
          });
          finalReply = msg.content;
        }

        // 无 tool_calls → 纯文本回复，结束循环
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          sendToUI(win, 'agent:log', {
            projectId: projectId || 'system', agentId,
            content: `🔚 元Agent ReAct 结束 (${iter} 轮, ${totalIn + totalOut} tokens, $${totalCost.toFixed(4)})`,
          });
          break;
        }

        // 有 tool_calls → 执行工具
        messages.push({
          role: 'assistant',
          content: msg.content || '',
          tool_calls: msg.tool_calls,
        });

        for (const tc of msg.tool_calls) {
          let toolArgs: Record<string, any>; // accepted: JSON.parse result fed to tool executor
          try {
            toolArgs = typeof tc.function.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function.arguments;
          } catch { /* silent: tool args JSON parse failed */
            toolArgs = {};
          }

          const toolCall: ToolCall = { name: tc.function.name, arguments: toolArgs };

          // task_complete
          if (tc.function.name === 'task_complete') {
            const summary = toolArgs.summary || '完成';
            sendToUI(win, 'agent:log', {
              projectId: projectId || 'system', agentId,
              content: `✅ task_complete: ${summary}`,
            });
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `任务已完成: ${summary}`,
            });
            continue;
          }

          // create_wish — 派发任务给团队
          if (tc.function.name === 'create_wish') {
            const wishText = (toolArgs.wish_content || '').trim();
            if (!wishText) {
              messages.push({ role: 'tool', tool_call_id: tc.id, content: '错误: wish_content 不能为空' });
              continue;
            }
            if (!projectId) {
              messages.push({ role: 'tool', tool_call_id: tc.id, content: '错误: 当前没有选中项目，无法创建需求。请让用户先选择一个项目。' });
              continue;
            }
            try {
              const db = getDb();
              const wishId = `wish-${Date.now().toString(36)}`;
              // 截断过长的 wish 内容 (PM 不需要管家的完整分析报告)
              const trimmedWish = wishText.length > 2000 ? wishText.slice(0, 2000) + '\n\n[...内容已截断，团队将自行深入分析]' : wishText;
              db.prepare('INSERT INTO wishes (id, project_id, content, status) VALUES (?, ?, ?, ?)')
                .run(wishId, projectId, trimmedWish, 'pending');
              db.prepare("UPDATE projects SET wish = ?, updated_at = datetime('now') WHERE id = ?")
                .run(trimmedWish, projectId);

              addLog(projectId, agentId, 'info', `📋 ${config.name} 创建需求: ${trimmedWish.slice(0, 80)}...`);
              sendToUI(win, 'agent:log', { projectId, agentId, content: `📋 需求已创建，启动开发流水线...` });

              // 启动 orchestrator
              const proj = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId) as { status: string } | undefined;
              if (proj && !['developing', 'initializing', 'reviewing'].includes(proj.status)) {
                runOrchestrator(projectId, win).catch(err => {
                  log.error('MetaAgent create_wish→Orchestrator error', err);
                  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `❌ 流水线启动失败: ${err.message}` });
                });
              }
              messages.push({ role: 'tool', tool_call_id: tc.id, content: `✅ 需求已创建 (ID: ${wishId})，开发流水线已启动。团队将自动进行 PM分析→架构设计→开发→QA→构建。` });
              wishCreatedViaTool = true;
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);
              messages.push({ role: 'tool', tool_call_id: tc.id, content: `创建需求失败: ${errMsg}` });
            }
            continue;
          }

          // Guard check
          const guard = guardToolCall(tc.function.name, toolArgs, !!workspacePath);
          if (!guard.allowed) {
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `工具调用被拦截: ${guard.reason}`,
            });
            continue;
          }
          if (guard.repairedArgs) {
            toolCall.arguments = guard.repairedArgs;
            toolArgs = guard.repairedArgs;
          }

          // 执行工具
          const isAsync = isAsyncTool(tc.function.name);
          const toolResult: ToolResult = isAsync
            ? await executeToolAsync(toolCall, toolCtx)
            : executeTool(toolCall, toolCtx);

          // 推送工具调用日志
          const argsSummary = JSON.stringify(toolArgs).slice(0, 150);
          sendToUI(win, 'agent:tool-call', {
            projectId: projectId || 'system', agentId,
            tool: tc.function.name,
            args: argsSummary,
            success: toolResult.success,
            outputPreview: toolResult.output.slice(0, 200),
          });
          sendToUI(win, 'agent:log', {
            projectId: projectId || 'system', agentId,
            content: `🔧 ${tc.function.name}(${argsSummary}) → ${toolResult.success ? '✅' : '❌'} ${toolResult.output.slice(0, 100)}`,
          });

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: toolResult.output.slice(0, 4000),
          });
        }
      }
    } catch (err: unknown) {
      log.error('MetaAgent ReAct error', err);
      finalReply = `抱歉，我在处理你的消息时遇到了错误。错误: ${toErrorMessage(err).slice(0, 100)}`;
      // 即使出错也要记录已消耗的 token/cost 到项目统计
      if (projectId && (totalIn + totalOut) > 0) {
        try {
          const db = getDb();
          db.prepare('INSERT OR IGNORE INTO agents (id, project_id, role, status) VALUES (?, ?, ?, ?)').run(agentId, projectId, 'meta-agent', 'idle');
          updateAgentStats(agentId, projectId, totalIn, totalOut, totalCost);
          emitEvent({ projectId, agentId, type: 'llm:call', data: { model, error: true }, inputTokens: totalIn, outputTokens: totalOut, costUsd: totalCost });
        } catch (statsErr) { log.error('MetaAgent stats write failed (error path)', statsErr); }
      }
      return {
        reply: finalReply,
        intent: 'general',
        tokens: totalIn + totalOut,
        cost: totalCost,
      };
    }

    // ── 解析结构化响应 (兼容 JSON 和纯文本) ──
    let intent = 'general';
    let reply = finalReply;
    let wishContent = '';
    let memoryNotes = '';

    try {
      const jsonMatch = finalReply.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        intent = parsed.intent || 'general';
        reply = parsed.reply || finalReply;
        wishContent = parsed.wishContent || '';
        memoryNotes = parsed.memoryNotes || '';
      }
    } catch { /* silent: 意图/记忆解析失败,使用原始回复 */
      // 非JSON输出 → 当作纯文本回复
      reply = finalReply.replace(/```json[\s\S]*?```/g, '').replace(/\{[\s\S]*\}/g, '').trim() || finalReply;
    }

    // Auto-memory: extract and store notable info from conversation
    if (config.autoMemory && memoryNotes) {
      autoExtractMemory(memoryNotes);
    }

    // ── 将 meta-agent 的 token/cost 计入当前项目统计 ──
    if (projectId && (totalIn + totalOut) > 0) {
      try {
        const db = getDb();
        // 确保 agents 表中有 meta-agent 记录 (首次对话时自动创建)
        db.prepare('INSERT OR IGNORE INTO agents (id, project_id, role, status) VALUES (?, ?, ?, ?)').run(agentId, projectId, 'meta-agent', 'idle');
        updateAgentStats(agentId, projectId, totalIn, totalOut, totalCost);
        emitEvent({
          projectId,
          agentId,
          type: 'llm:call',
          data: { model, iterations: messages.length, intent: 'meta-agent-chat' },
          inputTokens: totalIn,
          outputTokens: totalOut,
          costUsd: totalCost,
        });
      } catch (statsErr) {
        log.error('MetaAgent stats write failed', statsErr);
      }
    }

    // v8.0: 备份元 Agent 对话
    backupConversation({
      projectId,
      agentId,
      agentRole: 'meta-agent',
      messages: messages.map(m => ({ role: m.role as 'system' | 'user' | 'assistant' | 'tool', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
      totalInputTokens: totalIn,
      totalOutputTokens: totalOut,
      totalCost,
      model,
      completed: true,
      metadata: { intent, wishCreated: false },
    });

    // ── Intent: wish → Create wish + start pipeline (仅当未通过 create_wish 工具创建时) ──
    let wishCreated = wishCreatedViaTool;
    if (!wishCreatedViaTool && intent === 'wish' && projectId && wishContent.trim()) {
      const db = getDb();
      try {
        const wishId = `wish-${Date.now().toString(36)}`;
        db.prepare('INSERT INTO wishes (id, project_id, content, status) VALUES (?, ?, ?, ?)')
          .run(wishId, projectId, wishContent.trim(), 'pending');
        db.prepare("UPDATE projects SET wish = ?, updated_at = datetime('now') WHERE id = ?")
          .run(wishContent.trim(), projectId);

        addLog(projectId, agentId, 'info', `📋 ${config.name} 已创建需求: ${wishContent.slice(0, 80)}...`);
        sendToUI(win, 'agent:log', { projectId, agentId, content: `📋 需求已创建，启动开发流水线...` });

        const proj = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId) as { status: string } | undefined;
        if (proj && !['developing', 'initializing', 'reviewing'].includes(proj.status)) {
          runOrchestrator(projectId, win).catch(err => {
            log.error('MetaAgent→Orchestrator error', err);
            sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `❌ 流水线启动失败: ${err.message}` });
          });
          wishCreated = true;
          reply += '\n\n✅ 已创建需求并启动开发流水线。你可以在「总览」页查看进度。';
        } else {
          wishCreated = true;
          reply += '\n\n✅ 已记录需求。当前项目正在运行中，新需求将在本轮结束后自动处理。';
        }
      } catch (err: unknown) {
        log.error('Wish creation error', err);
        reply += '\n\n⚠️ 需求记录失败，请手动在需求页提交。';
      }
    }

    return {
      reply,
      intent,
      wishCreated,
      tokens: totalIn + totalOut,
      cost: totalCost,
    };
  });

  // ═══════════════════════════════════════
  // Chat Messages 持久化 — 应用级, 不跟随项目 (v20.0)
  // ═══════════════════════════════════════

  /** 保存一条对话消息到 DB */
  ipcMain.handle('meta-agent:messages:save', (
    _event,
    msg: {
      id: string;
      sessionId: string;
      projectId: string | null;
      role: 'user' | 'assistant' | 'system';
      content: string;
      triggeredWish?: boolean;
      attachments?: string; // JSON string
    },
  ) => {
    assertNonEmptyString('meta-agent:messages:save', 'id', msg.id);
    assertNonEmptyString('meta-agent:messages:save', 'sessionId', msg.sessionId);
    assertNonEmptyString('meta-agent:messages:save', 'role', msg.role);
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO meta_agent_chat_messages
        (id, session_id, project_id, role, content, triggered_wish, attachments, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      msg.id,
      msg.sessionId,
      msg.projectId || null,
      msg.role,
      msg.content,
      msg.triggeredWish ? 1 : 0,
      msg.attachments || null,
    );
    return { success: true };
  });

  /** 更新一条消息的内容 (用于 streaming 更新 assistant 回复) */
  ipcMain.handle('meta-agent:messages:update', (
    _event,
    id: string,
    updates: { content?: string; triggeredWish?: boolean },
  ) => {
    assertNonEmptyString('meta-agent:messages:update', 'id', id);
    const db = getDb();
    const sets: string[] = [];
    const params: Array<string | number> = [];
    if (updates.content !== undefined) {
      sets.push('content = ?');
      params.push(updates.content);
    }
    if (updates.triggeredWish !== undefined) {
      sets.push('triggered_wish = ?');
      params.push(updates.triggeredWish ? 1 : 0);
    }
    if (sets.length === 0) return { success: true };
    params.push(id);
    db.prepare(`UPDATE meta_agent_chat_messages SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return { success: true };
  });

  /** 加载指定 session 的所有消息 */
  ipcMain.handle('meta-agent:messages:load', (
    _event,
    sessionId: string,
    limit?: number,
  ) => {
    assertNonEmptyString('meta-agent:messages:load', 'sessionId', sessionId);
    const db = getDb();
    const sql = limit
      ? 'SELECT * FROM meta_agent_chat_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
      : 'SELECT * FROM meta_agent_chat_messages WHERE session_id = ? ORDER BY created_at ASC';
    const rows = limit ? db.prepare(sql).all(sessionId, limit) : db.prepare(sql).all(sessionId);
    return (rows as Array<Record<string, unknown>>).map(r => ({
      id: r.id as string,
      sessionId: r.session_id as string,
      projectId: r.project_id as string | null,
      role: r.role as string,
      content: r.content as string,
      triggeredWish: !!(r.triggered_wish as number),
      attachments: r.attachments ? JSON.parse(r.attachments as string) : undefined,
      createdAt: r.created_at as string,
    }));
  });

  /** 列出管家的所有 session (含首条用户消息摘要作为标题) */
  ipcMain.handle('meta-agent:messages:list-sessions', (
    _event,
    projectId?: string | null,
    limit?: number,
  ) => {
    const db = getDb();
    // 从 sessions 表中获取 meta-agent 的 session, LEFT JOIN 首条用户消息获取标题
    const sql = `
      SELECT
        s.*,
        (SELECT content FROM meta_agent_chat_messages m
         WHERE m.session_id = s.id AND m.role = 'user'
         ORDER BY m.created_at ASC LIMIT 1) as first_user_msg
      FROM sessions s
      WHERE s.agent_id = 'meta-agent'
        AND (s.project_id = ? OR (s.project_id IS NULL AND ? IS NULL) OR ? = '__all__')
      ORDER BY s.created_at DESC
      LIMIT ?
    `;
    const pId = projectId === undefined || projectId === null ? null : projectId;
    const rows = db.prepare(sql).all(pId, pId, pId ?? '__none__', limit || 100);
    return (rows as Array<Record<string, unknown>>).map(r => {
      const firstMsg = r.first_user_msg as string | null;
      return {
        id: r.id as string,
        projectId: r.project_id as string | null,
        agentId: r.agent_id as string,
        agentRole: r.agent_role as string,
        agentSeq: r.agent_seq as number,
        status: r.status as string,
        createdAt: r.created_at as string,
        completedAt: r.completed_at as string | null,
        messageCount: r.message_count as number,
        totalTokens: r.total_tokens as number,
        totalCost: r.total_cost as number,
        title: firstMsg ? (firstMsg.length > 40 ? firstMsg.slice(0, 40) + '…' : firstMsg) : null,
      };
    });
  });

  /** 删除指定 session 的所有消息 */
  ipcMain.handle('meta-agent:messages:delete-session', (
    _event,
    sessionId: string,
  ) => {
    assertNonEmptyString('meta-agent:messages:delete-session', 'sessionId', sessionId);
    const db = getDb();
    const result = db.prepare('DELETE FROM meta_agent_chat_messages WHERE session_id = ?').run(sessionId);
    return { success: true, deletedCount: result.changes };
  });

  // ═══════════════════════════════════════
  // Daemon — 心跳/事件钩子/定时任务 管理
  // ═══════════════════════════════════════

  ipcMain.handle('meta-agent:daemon:status', () => {
    return getDaemonStatus();
  });

  ipcMain.handle('meta-agent:daemon:config:get', () => {
    return getDaemonConfig();
  });

  ipcMain.handle('meta-agent:daemon:config:save', (_event, config: Partial<DaemonConfig>) => {
    assertObject('meta-agent:daemon:config:save', 'config', config);
    const saved = saveDaemonConfig(config);
    // Restart daemon with new config
    restartDaemon();
    return { success: true, config: saved };
  });

  ipcMain.handle('meta-agent:daemon:start', () => {
    startDaemon();
    return { success: true };
  });

  ipcMain.handle('meta-agent:daemon:stop', () => {
    stopDaemon();
    return { success: true };
  });

  ipcMain.handle('meta-agent:daemon:trigger', async () => {
    await triggerManualHeartbeat();
    return { success: true };
  });

  ipcMain.handle('meta-agent:daemon:logs', (_event, limit?: number) => {
    assertOptionalNumber('meta-agent:daemon:logs', 'limit', limit);
    return getHeartbeatLogs(limit);
  });
}
