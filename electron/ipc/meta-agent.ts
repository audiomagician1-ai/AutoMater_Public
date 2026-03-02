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
import type { LLMToolCall, ProjectRow, WorkflowPresetRow, WorkflowStage } from '../engine/types';
import type { DaemonConfig } from '../engine/meta-agent-daemon';

const log = createLogger('ipc:meta-agent');
import { toErrorMessage, createLogger } from '../engine/logger';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

/** 单模式参数覆盖 */
export interface ModeConfig {
  maxReactIterations?: number;   // ReAct 最大迭代轮数
  contextHistoryLimit?: number;  // 对话历史保留条数
  maxResponseTokens?: number;    // 回复最大 token
  contextTokenLimit?: number;    // 上下文 token 上限
}

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
  /** v22.0: 各模式独立参数覆盖 (未设置的字段取全局值) */
  modeConfigs: Record<string, ModeConfig>;
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
  modeConfigs: {
    work: { maxReactIterations: 50, maxResponseTokens: 128000 },
    chat: { maxReactIterations: 5, maxResponseTokens: 32000, contextHistoryLimit: 30 },
    deep: { maxReactIterations: 80, maxResponseTokens: 128000, contextHistoryLimit: 40 },
    admin: { maxReactIterations: 30, maxResponseTokens: 64000, contextHistoryLimit: 20 },
  },
};

/** 根据模式取合并后的参数 */
function getModeParam(config: MetaAgentConfig, mode: string, key: keyof ModeConfig): number {
  const modeOverride = config.modeConfigs?.[mode];
  if (modeOverride && modeOverride[key] !== undefined && modeOverride[key] !== null) {
    return modeOverride[key]!;
  }
  // 回退到全局值
  switch (key) {
    case 'maxReactIterations': return config.maxReactIterations;
    case 'contextHistoryLimit': return config.contextHistoryLimit;
    case 'maxResponseTokens': return config.maxResponseTokens;
    case 'contextTokenLimit': return config.contextTokenLimit;
    default: return config[key as keyof MetaAgentConfig] as number ?? 50;
  }
}

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

function buildSystemPrompt(config: MetaAgentConfig, memories: MetaAgentMemory[], mode: 'work' | 'chat' | 'deep' | 'admin' = 'work'): string {
  // If user has custom system prompt, use it as base
  if (config.systemPrompt.trim()) {
    const memoryBlock = formatMemoriesForContext(memories);
    return config.systemPrompt + (memoryBlock ? `\n\n${memoryBlock}` : '') + `\n\n[当前会话模式: ${mode}]`;
  }

  const userName = config.userNickname ? `称呼用户为"${config.userNickname}"` : '用正常方式称呼用户';
  const personality = config.personality || '专业、友好、高效';
  const basePreamble = `你是"${config.name}"，一个AI软件开发平台的智能管家。性格: ${personality}。${userName}。`;

  let prompt = '';

  if (mode === 'work') {
    // ── 工作模式: 管家指挥调度, 快速派发 ──
    prompt = `${basePreamble}

**当前模式: 🔧 工作模式** — 你的核心职责是**指挥和协调**，把具体工作交给团队执行。

## 职责
1. **需求派发**: 当用户表达产品需求、功能想法、审查请求、改进方案时，使用 \`create_wish\` 工具将任务派发给项目开发团队。
2. **快速查询**: 简单的项目状态、文件内容查询可以用读取工具回答。
3. **对话交流**: 其他问题友好回答。

## 工具
- \`create_wish\`: **将需求/任务派发给开发团队**（最重要）
- read_file / list_files / search_files / glob_files: 快速查看项目文件
- web_search / fetch_url: 搜索互联网
- think: 组织思路

## 规则
1. **不要自己做深度代码分析/审查** — 使用 \`create_wish\` 派发给团队。
2. **轻量查询可以自己做** — "某文件在哪"、"项目用了什么框架"等。
3. **wish 内容要精炼** — 清晰任务描述，建议500字以内。
4. **回复格式**: JSON: {"intent": "wish|query|workflow|general", "reply": "回复文本", "wishContent": "", "memoryNotes": "可选"}
5. **回复简洁友好**，中文。`;

  } else if (mode === 'chat') {
    // ── 闲聊模式: 纯对话, 极少工具 ──
    prompt = `${basePreamble}

**当前模式: 💬 闲聊模式** — 轻松、自由的对话。不涉及项目工作。

## 行为准则
1. 自由交流任何话题 — 技术讨论、头脑风暴、闲聊、问答。
2. 不主动读取项目文件或触发开发流程。
3. 如果用户提出了明确的开发/修改需求，提醒他切换到「工作模式」来派发任务。
4. 可以搜索网络获取信息。
5. 回复要自然友好，不需要 JSON 格式 — 直接回复纯文本。
6. 可以深入讨论技术方案、架构理念、最佳实践等，但仅作为讨论，不执行。`;

  } else if (mode === 'deep') {
    // ── 深度讨论模式: 管家亲自深入分析项目 + 可输出文件/派发任务 ──
    prompt = `${basePreamble}

**当前模式: 🔬 深度讨论模式** — 你将亲自深入分析项目代码和架构，与用户进行深度技术讨论。

## 行为准则
1. **亲自使用工具深入分析** — 在此模式下你应当大量使用 read_file / search_files / code_search 等工具，深入阅读代码。
2. **输出详尽的分析报告** — 你的回复应该有深度、有洞察力，包含具体的代码引用和详细建议。
3. **可以直接输出文件** — 使用 write_file / edit_file 将分析结果、方案文档、代码片段直接写入项目。
4. **可以派发任务** — 如果讨论中产生了明确的开发需求，可以使用 create_wish 将任务派发给团队执行，不需要切换模式。
5. 回复不需要 JSON 格式 — 直接输出分析内容。使用 Markdown 格式化。
6. 你拥有完整的项目读取能力（read_file, list_files, search_files, glob_files, code_search, git_log 等），请充分利用。

## 可用工具
- 读取工具: read_file, list_files, search_files, glob_files, code_search, code_search_files, read_many_files, repo_map, code_graph_query, git_log
- 写入工具: write_file, edit_file, batch_edit (输出分析文档/方案/代码)
- 任务派发: create_wish (将讨论结论转为开发任务)
- 搜索: web_search, fetch_url, web_search_boost, deep_research
- 思考: think`;

  } else if (mode === 'admin') {
    // ── 管理模式: 修改项目配置/成员/工作流 ──
    prompt = `${basePreamble}

**当前模式: 🛠️ 管理模式** — 你将帮助用户管理和调整项目的团队构成、工作流配置和项目设置。

## ⚠️ 安全准则 (最重要)
1. **先查后改** — 任何修改操作前，必须先用 admin_list_members / admin_list_workflows 查看当前配置。
2. **确认意图** — 在执行删除/大幅修改操作前，向用户确认变更内容（用 diff 格式展示"当前→修改后"）。
3. **最小变更** — 只修改用户明确要求的部分，不擅自改动其他配置。
4. **解释影响** — 每次修改后，简述此变更对项目开发流程的影响。

## 可用工具
### 团队管理
- \`admin_list_members\` — 查看所有成员（必须先调用了解当前团队）
- \`admin_add_member\` — 添加新成员
- \`admin_update_member\` — 修改成员配置（角色/名字/模型/提示词/上下文限制等）
- \`admin_remove_member\` — 删除成员（⚠️ 不可撤销）

### 工作流管理
- \`admin_list_workflows\` — 查看所有工作流预设
- \`admin_activate_workflow\` — 切换活跃工作流
- \`admin_update_workflow\` — 修改工作流阶段（增删/重排/改名）
- \`admin_get_available_stages\` — 查看所有可用阶段

### 项目配置
- \`admin_update_project\` — 修改项目名称/需求/权限

### 辅助
- read_file, list_files, search_files 等只读工具用于查看项目文件
- think — 思考和规划
- web_search — 搜索最佳实践

## 回复格式
不需要 JSON — 直接用 Markdown 输出：列出变更摘要、操作结果和影响说明。`;
  }

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
// v22.0: Admin Tool Executor
// ═══════════════════════════════════════

interface AdminToolResult { success: boolean; output: string; }

function executeAdminTool(
  toolName: string,
  args: Record<string, unknown>,
  projectId: string,
  _win: BrowserWindow | null,
): AdminToolResult {
  const db = getDb();

  try {
    switch (toolName) {

      case 'admin_list_members': {
        const rows = db.prepare('SELECT * FROM team_members WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as Array<Record<string, unknown>>;
        if (rows.length === 0) return { success: true, output: '当前项目没有团队成员。可以使用 admin_add_member 添加。' };
        const lines = rows.map((r, i) => {
          const caps = (() => { try { return JSON.parse(r.capabilities as string || '[]'); } catch { return []; } })();
          return [
            `### ${i + 1}. ${r.name} (${r.role})`,
            `- **ID**: \`${r.id}\``,
            `- **模型**: ${r.model || '(项目默认)'}`,
            `- **能力**: ${caps.length > 0 ? caps.join(', ') : '(未设置)'}`,
            `- **上下文限制**: ${r.max_context_tokens || 256000} tokens`,
            r.max_iterations ? `- **最大迭代**: ${r.max_iterations} 轮` : '',
            `- **提示词**: ${r.system_prompt ? `${(r.system_prompt as string).slice(0, 80)}...` : '(角色默认)'}`,
          ].filter(Boolean).join('\n');
        });
        return { success: true, output: `## 团队成员 (${rows.length} 人)\n\n${lines.join('\n\n')}` };
      }

      case 'admin_add_member': {
        const role = args.role as string;
        const name = args.name as string;
        if (!role || !name) return { success: false, output: '错误: role 和 name 为必填。' };
        const id = 'tm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        db.prepare(`INSERT INTO team_members (id, project_id, role, name, model, capabilities, system_prompt, context_files, max_context_tokens)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, projectId, role, name,
          (args.model as string) || null,
          JSON.stringify(args.capabilities || []),
          (args.system_prompt as string) || null,
          JSON.stringify([]),
          (args.max_context_tokens as number) || 256000,
        );
        if (args.max_iterations) {
          db.prepare('UPDATE team_members SET max_iterations = ? WHERE id = ?').run(args.max_iterations as number, id);
        }
        return { success: true, output: `✅ 已添加成员: **${name}** (${role})，ID: \`${id}\`` };
      }

      case 'admin_update_member': {
        const memberId = args.member_id as string;
        if (!memberId) return { success: false, output: '错误: member_id 为必填。' };
        // 先查当前值
        const current = db.prepare('SELECT * FROM team_members WHERE id = ?').get(memberId) as Record<string, unknown> | undefined;
        if (!current) return { success: false, output: `错误: 成员 ${memberId} 不存在。` };

        const sets: string[] = [];
        const vals: Array<string | number | null> = [];
        const changes: string[] = [];

        if (args.name !== undefined) { sets.push('name = ?'); vals.push(args.name as string); changes.push(`名字: ${current.name} → ${args.name}`); }
        if (args.role !== undefined) { sets.push('role = ?'); vals.push(args.role as string); changes.push(`角色: ${current.role} → ${args.role}`); }
        if (args.model !== undefined) { sets.push('model = ?'); vals.push(args.model as string); changes.push(`模型: ${current.model || '默认'} → ${args.model || '默认'}`); }
        if (args.system_prompt !== undefined) { sets.push('system_prompt = ?'); vals.push(args.system_prompt as string); changes.push('提示词: 已更新'); }
        if (args.capabilities !== undefined) { sets.push('capabilities = ?'); vals.push(JSON.stringify(args.capabilities)); changes.push('能力标签: 已更新'); }
        if (args.max_context_tokens !== undefined) { sets.push('max_context_tokens = ?'); vals.push(args.max_context_tokens as number); changes.push(`上下文限制: ${current.max_context_tokens} → ${args.max_context_tokens}`); }
        if (args.max_iterations !== undefined) { sets.push('max_iterations = ?'); vals.push(args.max_iterations as number); changes.push(`最大迭代: → ${args.max_iterations}`); }

        if (sets.length === 0) return { success: true, output: '未提供任何修改字段。' };
        vals.push(memberId);
        db.prepare(`UPDATE team_members SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        return { success: true, output: `✅ 已更新成员 **${current.name}** (\`${memberId}\`):\n${changes.map(c => `- ${c}`).join('\n')}` };
      }

      case 'admin_remove_member': {
        const memberId = args.member_id as string;
        if (!memberId) return { success: false, output: '错误: member_id 为必填。' };
        const target = db.prepare('SELECT name, role FROM team_members WHERE id = ?').get(memberId) as { name: string; role: string } | undefined;
        if (!target) return { success: false, output: `错误: 成员 ${memberId} 不存在。` };
        db.prepare('DELETE FROM team_members WHERE id = ?').run(memberId);
        return { success: true, output: `✅ 已移除成员: **${target.name}** (${target.role})，ID: \`${memberId}\`。⚠️ 此操作不可撤销。` };
      }

      case 'admin_list_workflows': {
        // 确保内置预设存在
        const existing = db.prepare('SELECT id FROM workflow_presets WHERE project_id = ? AND is_builtin = 1').all(projectId) as Array<{ id: string }>;
        if (existing.length === 0) {
          // 触发 ensureBuiltinPresets — 简单 INSERT
          const builtinPresets = [
            { id: 'builtin-full-dev', name: '完整开发', icon: '🚀' },
            { id: 'builtin-fast-iterate', name: '快速迭代', icon: '⚡' },
            { id: 'builtin-quality-hardening', name: '质量加固', icon: '🔬' },
          ];
          for (const bp of builtinPresets) {
            const pid = `${bp.id}-${projectId}`;
            db.prepare('INSERT OR IGNORE INTO workflow_presets (id, project_id, name, description, icon, stages, is_active, is_builtin) VALUES (?, ?, ?, ?, ?, ?, 0, 1)')
              .run(pid, projectId, bp.name, '', bp.icon, '[]');
          }
        }
        const rows = db.prepare('SELECT * FROM workflow_presets WHERE project_id = ? ORDER BY is_builtin DESC, created_at ASC')
          .all(projectId) as WorkflowPresetRow[];
        if (rows.length === 0) return { success: true, output: '当前项目没有工作流预设。' };

        const lines = rows.map(r => {
          let stages: WorkflowStage[] = [];
          try { stages = JSON.parse(r.stages); } catch { stages = []; }
          const active = r.is_active === 1 ? ' ⭐ **当前激活**' : '';
          const builtin = r.is_builtin === 1 ? ' (内置)' : ' (自定义)';
          const stageList = stages.length > 0
            ? stages.map(s => `  ${s.icon || '·'} ${s.label}${s.skippable ? ' (可跳过)' : ''}`).join('\n')
            : '  (无阶段)';
          return `### ${r.icon || '📋'} ${r.name}${builtin}${active}\n- **ID**: \`${r.id}\`\n- **描述**: ${r.description || '(无)'}\n- **阶段** (${stages.length}):\n${stageList}`;
        });
        return { success: true, output: `## 工作流预设 (${rows.length} 个)\n\n${lines.join('\n\n')}` };
      }

      case 'admin_activate_workflow': {
        const presetId = args.preset_id as string;
        if (!presetId) return { success: false, output: '错误: preset_id 为必填。' };
        const target = db.prepare('SELECT name FROM workflow_presets WHERE id = ? AND project_id = ?').get(presetId, projectId) as { name: string } | undefined;
        if (!target) return { success: false, output: `错误: 工作流 ${presetId} 不存在于当前项目。` };
        db.prepare("UPDATE workflow_presets SET is_active = 0, updated_at = datetime('now') WHERE project_id = ?").run(projectId);
        db.prepare("UPDATE workflow_presets SET is_active = 1, updated_at = datetime('now') WHERE id = ? AND project_id = ?").run(presetId, projectId);
        return { success: true, output: `✅ 已激活工作流: **${target.name}** (\`${presetId}\`)` };
      }

      case 'admin_update_workflow': {
        const presetId = args.preset_id as string;
        if (!presetId) return { success: false, output: '错误: preset_id 为必填。' };
        const current = db.prepare('SELECT * FROM workflow_presets WHERE id = ?').get(presetId) as WorkflowPresetRow | undefined;
        if (!current) return { success: false, output: `错误: 工作流 ${presetId} 不存在。` };

        const sets: string[] = [];
        const vals: Array<string | number | null> = [];
        const changes: string[] = [];

        if (args.name !== undefined) { sets.push('name = ?'); vals.push(args.name as string); changes.push(`名称: ${current.name} → ${args.name}`); }
        if (args.description !== undefined) { sets.push('description = ?'); vals.push(args.description as string); changes.push('描述: 已更新'); }
        if (args.icon !== undefined) { sets.push('icon = ?'); vals.push(args.icon as string); changes.push(`图标: ${current.icon} → ${args.icon}`); }
        if (args.stages !== undefined) {
          const newStages = args.stages as WorkflowStage[];
          sets.push('stages = ?'); vals.push(JSON.stringify(newStages));
          let oldStages: WorkflowStage[] = [];
          try { oldStages = JSON.parse(current.stages); } catch { /* empty */ }
          changes.push(`阶段: ${oldStages.length} → ${newStages.length} 个`);
        }
        sets.push("updated_at = datetime('now')");
        vals.push(presetId);

        if (changes.length === 0) return { success: true, output: '未提供任何修改字段。' };
        db.prepare(`UPDATE workflow_presets SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        return { success: true, output: `✅ 已更新工作流 **${current.name}** (\`${presetId}\`):\n${changes.map(c => `- ${c}`).join('\n')}` };
      }

      case 'admin_update_project': {
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined;
        if (!project) return { success: false, output: '错误: 项目不存在。' };

        const changes: string[] = [];
        if (args.name !== undefined) {
          db.prepare("UPDATE projects SET name = ?, updated_at = datetime('now') WHERE id = ?").run(args.name as string, projectId);
          changes.push(`名称: ${project.name} → ${args.name}`);
        }
        if (args.wish !== undefined) {
          db.prepare("UPDATE projects SET wish = ?, updated_at = datetime('now') WHERE id = ?").run(args.wish as string, projectId);
          changes.push('需求描述: 已更新');
        }
        if (args.permissions) {
          const perms = args.permissions as Record<string, boolean>;
          const sets: string[] = [];
          const vals: Array<number | string> = [];
          if (perms.externalRead !== undefined) { sets.push('allow_external_read = ?'); vals.push(perms.externalRead ? 1 : 0); changes.push(`外部读取: ${perms.externalRead ? '允许' : '禁止'}`); }
          if (perms.externalWrite !== undefined) { sets.push('allow_external_write = ?'); vals.push(perms.externalWrite ? 1 : 0); changes.push(`外部写入: ${perms.externalWrite ? '允许' : '禁止'}`); }
          if (perms.shellExec !== undefined) { sets.push('allow_shell_exec = ?'); vals.push(perms.shellExec ? 1 : 0); changes.push(`Shell 执行: ${perms.shellExec ? '允许' : '禁止'}`); }
          if (sets.length > 0) {
            vals.push(projectId);
            db.prepare(`UPDATE projects SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals);
          }
        }
        if (changes.length === 0) return { success: true, output: '未提供任何修改字段。' };
        return { success: true, output: `✅ 项目配置已更新:\n${changes.map(c => `- ${c}`).join('\n')}` };
      }

      case 'admin_get_available_stages': {
        const stages = [
          { id: 'pm_analysis', label: 'PM 需求分析', icon: '🧠' },
          { id: 'pm_triage', label: 'PM 分诊', icon: '🔀' },
          { id: 'architect', label: '架构 + 设计', icon: '🏗️' },
          { id: 'docs_gen', label: '文档生成', icon: '📋' },
          { id: 'dev_implement', label: '开发实现', icon: '💻' },
          { id: 'qa_review', label: 'QA 审查', icon: '🧪' },
          { id: 'pm_acceptance', label: 'PM 验收', icon: '📝', skippable: true },
          { id: 'devops_build', label: 'DevOps 构建', icon: '🚀', skippable: true },
          { id: 'incremental_doc_sync', label: '增量文档同步', icon: '📄', skippable: true },
          { id: 'static_analysis', label: '静态分析', icon: '🔍' },
          { id: 'security_audit', label: '安全审计', icon: '🔒' },
          { id: 'perf_benchmark', label: '性能基准', icon: '⚡' },
          { id: 'finalize', label: '交付 / 报告', icon: '🎯' },
        ];
        const lines = stages.map(s => `- \`${s.id}\` — ${s.icon} ${s.label}${s.skippable ? ' (可跳过)' : ''}`);
        return { success: true, output: `## 可用工作流阶段\n\n${lines.join('\n')}` };
      }

      default:
        return { success: false, output: `未知的管理工具: ${toolName}` };
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `管理工具执行错误: ${errMsg}` };
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
    chatMode?: string,
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

    const memories = getMemories(undefined, config.memoryInjectLimit);

    const systemPrompt = buildSystemPrompt(config, memories, mode);
    const messages: Array<{ role: string; content: string | Array<Record<string, unknown>>; tool_calls?: LLMToolCall[]; tool_call_id?: string }> = [
      { role: 'system', content: systemPrompt },
    ];

    if (projectId) {
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
          } catch {
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
    const project = projectId ? (getDb().prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined) : null;
    const workspacePath = project?.workspace_path || '';
    let tools = getToolsForRole('meta-agent', 'local');

    if (mode === 'chat') {
      // 闲聊模式: 仅 think + web_search + fetch_url (无项目工具, 无 create_wish)
      const chatAllowed = new Set(['think', 'task_complete', 'web_search', 'fetch_url', 'memory_read', 'memory_append']);
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
        'think', 'task_complete',
        'read_file', 'list_files', 'search_files', 'glob_files',
        'code_search', 'code_search_files', 'read_many_files', 'repo_map', 'code_graph_query',
        'web_search', 'fetch_url', 'memory_read', 'memory_append', 'git_log',
        'admin_list_members', 'admin_add_member', 'admin_update_member', 'admin_remove_member',
        'admin_list_workflows', 'admin_activate_workflow', 'admin_update_workflow',
        'admin_update_project', 'admin_get_available_stages',
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
          modeMaxResponseTokens,
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

          // ── v22.0: Admin tools (管理模式专用) ──
          if (tc.function.name.startsWith('admin_')) {
            if (!projectId) {
              messages.push({ role: 'tool', tool_call_id: tc.id, content: '错误: 当前没有选中项目，无法执行管理操作。' });
              continue;
            }
            const adminResult = executeAdminTool(tc.function.name, toolArgs, projectId, win);
            sendToUI(win, 'agent:log', {
              projectId, agentId,
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
      } catch {
        reply = finalReply.replace(/```json[\s\S]*?```/g, '').replace(/\{[\s\S]*\}/g, '').trim() || finalReply;
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
        chatMode: (r.chat_mode as string) || 'work',
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
