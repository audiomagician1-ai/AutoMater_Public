/**
 * meta-agent IPC handlers — 元Agent 对话 + 管理 + 记忆系统
 *
 * v5.4: 初始创建 — LLM 对话 + 意图检测
 * v7.0: 管理页面支持 — 可配置名字/称呼/提示词/上下文限制 + 独立记忆系统
 * v6.1: ReAct 模式升级 — callLLMWithTools, 具备只读工具集(读文件/搜索/web_search/git_log)
 * v30.2: 拆分为 types/memory/prompts/admin 子模块 (2376→~1100行)
 *
 * 子模块:
 *   - meta-agent-types.ts: 类型定义 + 默认配置 + getModeParam
 *   - meta-agent-memory.ts: 记忆 CRUD + autoExtractMemory
 *   - meta-agent-prompts.ts: PRODUCT_KNOWLEDGE + buildSystemPrompt
 *   - meta-agent-admin.ts: executeAdminTool + executeEvolutionAdminTool
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
  getDaemonConfig,
  saveDaemonConfig,
  getDaemonStatus,
  startDaemon,
  stopDaemon,
  restartDaemon,
  triggerManualHeartbeat,
  getHeartbeatLogs,
} from '../engine/meta-agent-daemon';
import { backupConversation } from '../engine/conversation-backup';
import {
  getToolsForRole,
  executeTool,
  executeToolAsync,
  isAsyncTool,
  TOOL_DEFINITIONS,
  type ToolContext,
  type ToolCall,
  type ToolResult,
} from '../engine/tool-system';
import { guardToolCall } from '../engine/guards';
import fs from 'fs';
import path from 'path';
import type { LLMToolCall, ProjectRow } from '../engine/types';
import type { DaemonConfig } from '../engine/meta-agent-daemon';

import { toErrorMessage, createLogger } from '../engine/logger';
const log = createLogger('ipc:meta-agent');

import { cacheContextSnapshot } from '../engine/react-loop';
import type { ContextSection, ContextSnapshot } from '../engine/context-collector';

// ═══════════════════════════════════════
// Sub-module imports (v30.2 拆分)
// ═══════════════════════════════════════

import {
  type ModeConfig,
  type MetaAgentConfig,
  type MetaAgentMemory,
  DEFAULT_CONFIG,
  getModeParam,
} from './meta-agent-types';

import {
  getMemories,
  addMemory,
  updateMemory,
  deleteMemory,
  searchMemories,
  getMemoryStats,
  autoExtractMemory,
} from './meta-agent-memory';

import { buildSystemPrompt } from './meta-agent-prompts';

import { executeAdminTool, executeEvolutionAdminTool } from './meta-agent-admin';

// ═══════════════════════════════════════
// Re-exports for backward compatibility
// ═══════════════════════════════════════
export type { ModeConfig, MetaAgentConfig, MetaAgentMemory };

// ═══════════════════════════════════════
// Config Management
// ═══════════════════════════════════════

function getMetaAgentConfig(): MetaAgentConfig {
  const db = getDb();
  const row = db.prepare('SELECT value FROM meta_agent_config WHERE key = ?').get('config') as
    | { value: string }
    | undefined;
  if (row) {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(row.value) };
    } catch (err) {
      /* fallback */
      log.debug('fallback', { error: String(err) });
    }
  }
  return { ...DEFAULT_CONFIG };
}

function saveMetaAgentConfig(config: Partial<MetaAgentConfig>): MetaAgentConfig {
  const db = getDb();
  const current = getMetaAgentConfig();
  const merged = { ...current, ...config };
  db.prepare('INSERT OR REPLACE INTO meta_agent_config (key, value) VALUES (?, ?)').run(
    'config',
    JSON.stringify(merged),
  );
  return merged;
}

// ═══════════════════════════════════════
// Helper: Collect project context for query
// ═══════════════════════════════════════

function collectProjectContext(projectId: string): string {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
    | { name: string; status: string; wish?: string; workspace_path?: string }
    | undefined;
  if (!project) return '(项目不存在)';

  const parts: string[] = [];
  parts.push(`项目名: ${project.name}`);
  parts.push(`状态: ${project.status}`);
  if (project.wish) parts.push(`需求: ${project.wish}`);

  // Features summary
  const features = db
    .prepare('SELECT id, title, status, category FROM features WHERE project_id = ?')
    .all(projectId) as Array<{ id: string; title: string; status: string; category: string }>;
  if (features.length > 0) {
    parts.push(`\nFeature 列表 (${features.length}个):`);
    features.forEach(f => parts.push(`  - [${f.status}] ${f.title} (${f.category || 'other'})`));
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

  ipcMain.handle('meta-agent:memory:list', (_event, category?: string, limit?: number, projectId?: string | null) => {
    return getMemories(category, limit, projectId);
  });

  ipcMain.handle(
    'meta-agent:memory:add',
    (_event, memory: Omit<MetaAgentMemory, 'id' | 'created_at' | 'updated_at'>) => {
      assertObject('meta-agent:memory:add', 'memory', memory);
      assertNonEmptyString('meta-agent:memory:add', 'content', (memory as Record<string, unknown>).content);
      return addMemory(memory);
    },
  );

  ipcMain.handle(
    'meta-agent:memory:update',
    (_event, id: string, updates: { content?: string; importance?: number; category?: string }) => {
      assertNonEmptyString('meta-agent:memory:update', 'id', id);
      assertObject('meta-agent:memory:update', 'updates', updates);
      return { success: updateMemory(id, updates) };
    },
  );

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

  ipcMain.handle(
    'meta-agent:chat',
    async (
      _event,
      projectId: string | null,
      message: string,
      history?: Array<{ role: string; content: string | Array<Record<string, unknown>> }>,
      attachments?: ChatAttachment[],
      chatMode?: string,
      sessionId?: string | null,
    ) => {
      assertNonEmptyString('meta-agent:chat', 'message', message);
      const settings = getSettings();
      if (!settings?.apiKey) {
        return { reply: '请先在设置页配置 LLM API Key。', intent: 'general' };
      }

      const config = getMetaAgentConfig();
      const win = BrowserWindow.getAllWindows()[0] ?? null;
      const agentId = 'meta-agent';
      const mode = (chatMode as 'work' | 'chat' | 'deep' | 'admin') || 'work';

      // chat 模式不加载记忆 — 保持轻松对话，不带项目记忆上下文
      // v29.0: 按 projectId 过滤记忆 — 只加载当前项目 + 全局记忆
      const memories = mode === 'chat' ? [] : getMemories(undefined, config.memoryInjectLimit, projectId);

      const systemPrompt = buildSystemPrompt(config, memories, mode);
      const messages: Array<{
        role: string;
        content: string | Array<Record<string, unknown>>;
        tool_calls?: LLMToolCall[];
        tool_call_id?: string;
      }> = [{ role: 'system', content: systemPrompt }];

      if (projectId && mode !== 'chat') {
        // chat 模式不注入项目上下文 — 保持轻松对话
        const ctx = collectProjectContext(projectId);
        messages.push({ role: 'system', content: `当前项目上下文:\n${ctx}` });
      }

      if (history?.length) {
        const modeHistoryLimit = getModeParam(config, mode, 'contextHistoryLimit');
        const recent = history.slice(-modeHistoryLimit);
        for (const h of recent) {
          // v23.0: 防御性过滤 — 前端 history 只有 {role, content} 简化形式
          // 跳过 role='tool' (无 tool_call_id 会导致 API 400)
          // 确保 content 不为 null/undefined (某些 gateway 不容忍)
          if (h.role === 'tool') continue;
          const content = h.content ?? '';
          if (h.role === 'user' || h.role === 'assistant' || h.role === 'system') {
            messages.push({ role: h.role, content });
          }
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
            } catch (err) {
              log.debug('Catch at meta-agent.ts:1631', { error: String(err) });
              contentBlocks.push({ type: 'text', text: `[附件: ${att.name} — 读取失败]` });
            }
          }
        }
        messages.push({ role: 'user', content: contentBlocks });
      } else {
        messages.push({ role: 'user', content: message });
      }

      // ── v6.1: ReAct Tool Loop (v22.0: mode-specific config) ──
      const MAX_REACT_ITERATIONS = getModeParam(config, mode, 'maxReactIterations');
      const modeMaxResponseTokens = getModeParam(config, mode, 'maxResponseTokens');
      const model = settings.strongModel || settings.workerModel || settings.fastModel || 'gpt-4o';

      // 获取 meta-agent 角色的工具集 — 按模式裁剪
      const project = projectId
        ? (getDb().prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined)
        : null;
      const workspacePath = project?.workspace_path || '';
      let tools = getToolsForRole('meta-agent', 'local');

      if (mode === 'chat') {
        // 闲聊模式: 仅 think + web_search + fetch_url (无项目工具, 无 create_wish)
        const chatAllowed = new Set([
          'think',
          'task_complete',
          'web_search',
          'fetch_url',
          'memory_read',
          'memory_append',
        ]);
        tools = tools.filter(t => chatAllowed.has((t.function as Record<string, unknown>).name as string));
      } else if (mode === 'deep') {
        // 深度讨论模式: 全部只读工具 + 写入工具 + create_wish (管家亲自深入分析 + 可输出/派发)
        //   移除 admin_* 工具
        tools = tools.filter(t => {
          const name = (t.function as Record<string, unknown>).name as string;
          return !name.startsWith('admin_');
        });
      } else if (mode === 'admin') {
        // 管理模式: admin_* 工具 + 只读工具 + think (无 create_wish, 无写入工具)
        const adminAllowed = new Set([
          'think',
          'task_complete',
          'read_file',
          'list_files',
          'search_files',
          'glob_files',
          'code_search',
          'code_search_files',
          'read_many_files',
          'repo_map',
          'code_graph_query',
          'web_search',
          'fetch_url',
          'memory_read',
          'memory_append',
          'admin_list_members',
          'admin_add_member',
          'admin_update_member',
          'admin_remove_member',
          'admin_list_workflows',
          'admin_activate_workflow',
          'admin_update_workflow',
          'admin_update_project',
          'admin_get_available_stages',
          // v29.2: Self-Evolution tools
          'admin_evolution_status',
          'admin_evolution_preflight',
          'admin_evolution_evaluate',
          'admin_evolution_run',
          'admin_evolution_verify',
          'admin_evolution_auto_run',
        ]);
        tools = tools.filter(t => adminAllowed.has((t.function as Record<string, unknown>).name as string));
      }
      // work 模式: 全部工具 (含 create_wish, 不含 admin_*, 不含 write/edit)
      if (mode === 'work') {
        tools = tools.filter(t => {
          const name = (t.function as Record<string, unknown>).name as string;
          return !name.startsWith('admin_') && name !== 'write_file' && name !== 'edit_file' && name !== 'batch_edit';
        });
      }

      // v23.0: 用户手动授权 git 访问时，动态注入 git_log 工具
      if (config.allowGitAccess) {
        const gitLogDef = TOOL_DEFINITIONS.find(t => t.name === 'git_log');
        if (gitLogDef) {
          const alreadyHas = tools.some(t => (t.function as Record<string, unknown>).name === 'git_log');
          if (!alreadyHas) {
            tools.push({
              type: 'function',
              function: { name: gitLogDef.name, description: gitLogDef.description, parameters: gitLogDef.parameters },
            } as (typeof tools)[number]);
          }
        }
      }

      const toolCtx: ToolContext = {
        workspacePath,
        projectId: projectId || '',
        gitConfig: { mode: 'local', workspacePath },
        permissions: {
          readFileLineLimit: config.readFileLineLimit || 1000,
        },
        role: 'meta-agent',
        metaAgentAllowGit: config.allowGitAccess ?? false, // v23.0: 用户手动授权
      };

      let totalIn = 0;
      let totalOut = 0;
      let totalCost = 0;
      let finalReply = '';
      let wishCreatedViaTool = false;

      sendToUI(win, 'agent:log', {
        projectId: projectId || 'system',
        agentId,
        content: `🔄 元Agent 开始 ReAct 对话循环 (最多 ${MAX_REACT_ITERATIONS} 轮)`,
      });

      // v30.0: 构建并缓存管家上下文快照，供 ContextPage 展示
      if (projectId) {
        try {
          const tokenBudget = config.contextTokenLimit || 512000;
          const sections: ContextSection[] = [];
          let totalChars = 0;
          let totalTokens = 0;
          for (const m of messages) {
            const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            const chars = text.length;
            const tokens = Math.ceil(chars / 1.5);
            const sourceMap: Record<string, ContextSection['source']> = {
              system: 'project-config',
              user: 'keyword-match',
              assistant: 'plan',
            };
            sections.push({
              id: `meta-${m.role}-${sections.length}`,
              name:
                m.role === 'system' && sections.length === 0
                  ? 'System Prompt'
                  : m.role === 'system'
                    ? '项目上下文'
                    : m.role === 'user'
                      ? '用户消息'
                      : '助手回复',
              source: sourceMap[m.role as string] ?? 'project-config',
              content: text.slice(0, 2000),
              chars,
              tokens,
              truncated: text.length > 2000,
            });
            totalChars += chars;
            totalTokens += tokens;
          }
          const snapshot: ContextSnapshot = {
            agentId: 'meta-agent',
            featureId: `mode:${mode}`,
            timestamp: Date.now(),
            sections,
            totalChars,
            totalTokens,
            tokenBudget,
            contextText: '',
            filesIncluded: 0,
          };
          cacheContextSnapshot(projectId, snapshot);
          sendToUI(win, 'agent:context-snapshot', { projectId, snapshot });
        } catch (err) {
          // 快照生成非关键路径，静默失败
          log.debug('// 快照生成非关键路径，静默失败', { error: String(err) });
        }
      }

      try {
        for (let iter = 1; iter <= MAX_REACT_ITERATIONS; iter++) {
          const result = await callLLMWithTools(settings, model, messages, tools, undefined, modeMaxResponseTokens);
          const cost = calcCost(model, result.inputTokens, result.outputTokens);
          totalIn += result.inputTokens;
          totalOut += result.outputTokens;
          totalCost += cost;

          const msg = result.message;

          // 推送思考日志
          if (msg.content) {
            const shortThought = msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content;
            sendToUI(win, 'agent:log', {
              projectId: projectId || 'system',
              agentId,
              content: `💭 [${iter}] ${shortThought}`,
            });
            finalReply = msg.content;
          }

          // 无 tool_calls → 纯文本回复，结束循环
          if (!msg.tool_calls || msg.tool_calls.length === 0) {
            sendToUI(win, 'agent:log', {
              projectId: projectId || 'system',
              agentId,
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
              toolArgs =
                typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
            } catch (err) {
              /* silent: tool args JSON parse failed */
              log.debug('tool args JSON parse failed', { error: String(err) });
              toolArgs = {};
            }

            const toolCall: ToolCall = { name: tc.function.name, arguments: toolArgs };

            // task_complete
            if (tc.function.name === 'task_complete') {
              const summary = toolArgs.summary || '完成';
              sendToUI(win, 'agent:log', {
                projectId: projectId || 'system',
                agentId,
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
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: '错误: 当前没有选中项目，无法创建需求。请让用户先选择一个项目。',
                });
                continue;
              }
              try {
                const db = getDb();
                const wishId = `wish-${Date.now().toString(36)}`;
                // 截断过长的 wish 内容 (PM 不需要管家的完整分析报告)
                const trimmedWish =
                  wishText.length > 2000
                    ? wishText.slice(0, 2000) + '\n\n[...内容已截断，团队将自行深入分析]'
                    : wishText;
                db.prepare('INSERT INTO wishes (id, project_id, content, status) VALUES (?, ?, ?, ?)').run(
                  wishId,
                  projectId,
                  trimmedWish,
                  'pending',
                );
                db.prepare("UPDATE projects SET wish = ?, updated_at = datetime('now') WHERE id = ?").run(
                  trimmedWish,
                  projectId,
                );

                addLog(projectId, agentId, 'info', `📋 ${config.name} 创建需求: ${trimmedWish.slice(0, 80)}...`);
                sendToUI(win, 'agent:log', { projectId, agentId, content: `📋 需求已创建，启动开发流水线...` });

                // 启动 orchestrator
                const proj = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId) as
                  | { status: string }
                  | undefined;
                if (proj && !['developing', 'initializing', 'reviewing'].includes(proj.status)) {
                  runOrchestrator(projectId, win).catch(err => {
                    log.error('MetaAgent create_wish→Orchestrator error', err);
                    sendToUI(win, 'agent:log', {
                      projectId,
                      agentId: 'system',
                      content: `❌ 流水线启动失败: ${err.message}`,
                    });
                  });
                }
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: `✅ 需求已创建 (ID: ${wishId})，开发流水线已启动。团队将自动进行 PM分析→架构设计→开发→QA→构建。`,
                });
                wishCreatedViaTool = true;
              } catch (err: unknown) {
                const errMsg = err instanceof Error ? err.message : String(err);
                messages.push({ role: 'tool', tool_call_id: tc.id, content: `创建需求失败: ${errMsg}` });
              }
              continue;
            }

            // ── v22.0: Admin tools (管理模式専用) ──
            if (tc.function.name.startsWith('admin_')) {
              // v29.2: 进化管理工具 (异步) — 优先处理
              if (tc.function.name.startsWith('admin_evolution_')) {
                const evoResult = await executeEvolutionAdminTool(tc.function.name, toolArgs);
                if (evoResult) {
                  sendToUI(win, 'agent:log', {
                    projectId: projectId || 'system',
                    agentId,
                    content: `🧬 ${tc.function.name} → ${evoResult.success ? '✅' : '❌'} ${evoResult.output.slice(0, 120)}`,
                  });
                  messages.push({ role: 'tool', tool_call_id: tc.id, content: evoResult.output.slice(0, 8000) });
                  continue;
                }
              }
              if (!projectId) {
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: '错误: 当前没有选中项目，无法执行管理操作。',
                });
                continue;
              }
              const adminResult = executeAdminTool(tc.function.name, toolArgs, projectId, win);
              sendToUI(win, 'agent:log', {
                projectId,
                agentId,
                content: `🛠️ ${tc.function.name} → ${adminResult.success ? '✅' : '❌'} ${adminResult.output.slice(0, 120)}`,
              });
              messages.push({ role: 'tool', tool_call_id: tc.id, content: adminResult.output.slice(0, 6000) });
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
              projectId: projectId || 'system',
              agentId,
              tool: tc.function.name,
              args: argsSummary,
              success: toolResult.success,
              outputPreview: toolResult.output.slice(0, 200),
            });
            sendToUI(win, 'agent:log', {
              projectId: projectId || 'system',
              agentId,
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
        if (projectId && totalIn + totalOut > 0) {
          try {
            const db = getDb();
            db.prepare('INSERT OR IGNORE INTO agents (id, project_id, role, status) VALUES (?, ?, ?, ?)').run(
              agentId,
              projectId,
              'meta-agent',
              'idle',
            );
            updateAgentStats(agentId, projectId, totalIn, totalOut, totalCost);
            emitEvent({
              projectId,
              agentId,
              type: 'llm:call',
              data: { model, error: true },
              inputTokens: totalIn,
              outputTokens: totalOut,
              costUsd: totalCost,
            });
          } catch (statsErr) {
            log.error('MetaAgent stats write failed (error path)', statsErr);
          }
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

      if (mode === 'work') {
        // 工作模式: 期望 JSON 格式回复
        try {
          const jsonMatch = finalReply.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            intent = parsed.intent || 'general';
            reply = parsed.reply || finalReply;
            wishContent = parsed.wishContent || '';
            memoryNotes = parsed.memoryNotes || '';
          }
        } catch (err) {
          log.debug('Catch at meta-agent.ts:2068', { error: String(err) });
          reply =
            finalReply
              .replace(/```json[\s\S]*?```/g, '')
              .replace(/\{[\s\S]*\}/g, '')
              .trim() || finalReply;
        }
      } else {
        // 闲聊/深度讨论/管理模式: 纯文本回复
        reply = finalReply;
        intent = mode === 'deep' ? 'query' : mode === 'admin' ? 'admin' : 'general';
      }

      // 如果通过 create_wish 工具已创建需求, 更新 intent
      if (wishCreatedViaTool) intent = 'wish';

      // Auto-memory: extract and store notable info from conversation
      if (config.autoMemory && memoryNotes) {
        autoExtractMemory(memoryNotes, projectId);
      }

      // ── 将 meta-agent 的 token/cost 计入当前项目统计 ──
      if (projectId && totalIn + totalOut > 0) {
        try {
          const db = getDb();
          // 确保 agents 表中有 meta-agent 记录 (首次对话时自动创建)
          db.prepare('INSERT OR IGNORE INTO agents (id, project_id, role, status) VALUES (?, ?, ?, ?)').run(
            agentId,
            projectId,
            'meta-agent',
            'idle',
          );
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
        sessionId: sessionId || undefined,
        projectId,
        agentId,
        agentRole: 'meta-agent',
        messages: messages.map(m => ({
          role: m.role as 'system' | 'user' | 'assistant' | 'tool',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
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
          db.prepare('INSERT INTO wishes (id, project_id, content, status) VALUES (?, ?, ?, ?)').run(
            wishId,
            projectId,
            wishContent.trim(),
            'pending',
          );
          db.prepare("UPDATE projects SET wish = ?, updated_at = datetime('now') WHERE id = ?").run(
            wishContent.trim(),
            projectId,
          );

          addLog(projectId, agentId, 'info', `📋 ${config.name} 已创建需求: ${wishContent.slice(0, 80)}...`);
          sendToUI(win, 'agent:log', { projectId, agentId, content: `📋 需求已创建，启动开发流水线...` });

          const proj = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId) as
            | { status: string }
            | undefined;
          if (proj && !['developing', 'initializing', 'reviewing'].includes(proj.status)) {
            runOrchestrator(projectId, win).catch(err => {
              log.error('MetaAgent→Orchestrator error', err);
              sendToUI(win, 'agent:log', {
                projectId,
                agentId: 'system',
                content: `❌ 流水线启动失败: ${err.message}`,
              });
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
    },
  );

  // ═══════════════════════════════════════
  // Chat Messages 持久化 — 应用级, 不跟随项目 (v20.0)
  // ═══════════════════════════════════════

  /** 保存一条对话消息到 DB */
  ipcMain.handle(
    'meta-agent:messages:save',
    (
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
      db.prepare(
        `
      INSERT OR REPLACE INTO meta_agent_chat_messages
        (id, session_id, project_id, role, content, triggered_wish, attachments, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `,
      ).run(
        msg.id,
        msg.sessionId,
        msg.projectId || null,
        msg.role,
        msg.content,
        msg.triggeredWish ? 1 : 0,
        msg.attachments || null,
      );
      return { success: true };
    },
  );

  /** 更新一条消息的内容 (用于 streaming 更新 assistant 回复) */
  ipcMain.handle(
    'meta-agent:messages:update',
    (_event, id: string, updates: { content?: string; triggeredWish?: boolean }) => {
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
    },
  );

  /** 加载指定 session 的所有消息 */
  ipcMain.handle('meta-agent:messages:load', (_event, sessionId: string, limit?: number) => {
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
      attachments: r.attachments
        ? (() => {
            try {
              return JSON.parse(r.attachments as string);
            } catch (err) {
              log.debug('Catch at meta-agent.ts:2272', { error: String(err) });
              return undefined;
            }
          })()
        : undefined,
      createdAt: r.created_at as string,
    }));
  });

  /** 列出管家的所有 session (含首条用户消息摘要作为标题) */
  ipcMain.handle(
    'meta-agent:messages:list-sessions',
    (_event, projectId?: string | null, limit?: number, includeHidden?: boolean) => {
      const db = getDb();
      // v27.0: 置顶优先排序, 可选过滤隐藏会话
      const hiddenFilter = includeHidden ? '' : 'AND COALESCE(s.hidden, 0) = 0';
      const sql = `
      SELECT
        s.*,
        (SELECT content FROM meta_agent_chat_messages m
         WHERE m.session_id = s.id AND m.role = 'user'
         ORDER BY m.created_at ASC LIMIT 1) as first_user_msg
      FROM sessions s
      WHERE s.agent_id = 'meta-agent'
        AND (s.project_id = ? OR (s.project_id IS NULL AND ? IS NULL) OR ? = '__all__')
        ${hiddenFilter}
      ORDER BY COALESCE(s.pinned, 0) DESC, s.created_at DESC
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
          chatMode: (r.chat_mode as string) || 'work',
          pinned: !!(r.pinned as number),
          customTitle: (r.custom_title as string) || null,
          hidden: !!(r.hidden as number),
        };
      });
    },
  );

  /** 删除指定 session 的所有消息 */
  ipcMain.handle('meta-agent:messages:delete-session', (_event, sessionId: string) => {
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
