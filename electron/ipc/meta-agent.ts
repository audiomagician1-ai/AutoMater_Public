/**
 * meta-agent IPC handlers — 元Agent 对话 + 管理 + 记忆系统
 *
 * v5.4: 初始创建 — LLM 对话 + 意图检测
 * v7.0: 管理页面支持 — 可配置名字/称呼/提示词/上下文限制 + 独立记忆系统
 *
 * 记忆系统参考 EchoAgent agent-memory 架构:
 *   - identity: 管家自我认知 (名字/角色/性格)
 *   - user_profile: 对用户的了解 (偏好/称呼/习惯)
 *   - lessons: 经验教训 (自动积累, 大容量, 支持100+条)
 *   - facts: 长期事实记忆 (重要事件/决策/约定)
 *   - conversation_summary: 历史对话压缩摘要
 */

import { ipcMain, BrowserWindow } from 'electron';
import { callLLM, getSettings } from '../engine/llm-client';
import { sendToUI, addLog } from '../engine/ui-bridge';
import { getDb } from '../db';
import { runOrchestrator } from '../engine/orchestrator';
import { backupConversation } from '../engine/conversation-backup';
import fs from 'fs';
import path from 'path';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface MetaAgentConfig {
  name: string;               // 管家名字 (默认 "元Agent管家")
  userNickname: string;       // 对用户的称呼 (默认 "你")
  personality: string;        // 性格描述 (简短)
  systemPrompt: string;       // 完整系统提示词 (可覆盖默认)
  contextHistoryLimit: number; // 对话历史保留条数 (默认 20)
  contextTokenLimit: number;  // 上下文 token 上限 (默认 4096)
  maxResponseTokens: number;  // 回复最大 token (默认 2048)
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
  contextTokenLimit: 8192,
  maxResponseTokens: 2048,
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
  const params: any[] = [];

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
  const params: any[] = [];

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
  const total = (db.prepare('SELECT COUNT(*) as count FROM meta_agent_memories').get() as any).count;
  const rows = db.prepare('SELECT category, COUNT(*) as count FROM meta_agent_memories GROUP BY category').all() as any[];
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

  let prompt = `你是"${config.name}"，一个AI软件开发平台的智能助手。性格: ${personality}。${userName}。

你的职责：

1. **需求接收**: 当用户表达产品需求/功能想法时，提取核心需求，回复确认并告知已转交团队处理。
2. **项目查询**: 当用户询问项目状态、设计文档、技术架构时，基于提供的项目上下文回答。
3. **工作流管理**: 当用户想调整团队配置、暂停/恢复项目时，给出操作建议。
4. **通用对话**: 其他问题友好回答。

**重要规则**:
- 你的回复必须是 JSON 格式: {"intent": "wish|query|workflow|general", "reply": "你的回复文本", "wishContent": "仅当intent=wish时，提取的需求文本", "memoryNotes": "可选,值得记住的新信息(用户偏好/重要决策/经验教训),不超过50字,没有则省略此字段"}
- intent=wish: 用户在表达新功能需求、产品想法、要做什么系统/功能
- intent=query: 用户在问项目状态、进度、文档内容、技术细节
- intent=workflow: 用户想暂停/启动/调整工作流、团队配置
- intent=general: 闲聊或其他
- wishContent: 精炼后的需求描述（保留用户原意，去除口语化表达），仅 wish 意图时填写
- memoryNotes: 从对话中提取值得长期记住的信息(用户偏好变化/重要决策/新的约定等)，可选字段
- 回复要简洁友好，中文。确认需求时要复述核心要点让用户确认。`;

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
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
  if (!project) return '(项目不存在)';

  const parts: string[] = [];
  parts.push(`项目名: ${project.name}`);
  parts.push(`状态: ${project.status}`);
  if (project.wish) parts.push(`需求: ${project.wish}`);

  // Features summary
  const features = db.prepare('SELECT id, title, status, category FROM features WHERE project_id = ?').all(projectId) as any[];
  if (features.length > 0) {
    parts.push(`\nFeature 列表 (${features.length}个):`);
    features.forEach((f: any) => parts.push(`  - [${f.status}] ${f.title} (${f.category || 'other'})`));
  }

  // Design doc (truncated)
  if (project.workspace_path) {
    const archPath = path.join(project.workspace_path, '.agentforge', 'docs', 'ARCHITECTURE.md');
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

    console.log(`[MetaAgent] Auto-memory stored: [${category}] ${memoryNotes.slice(0, 50)}`);
  } catch (err) {
    console.error('[MetaAgent] Auto-memory failed:', err);
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
    const saved = saveMetaAgentConfig(config);
    return { success: true, config: saved };
  });

  // ── Memory CRUD ──

  ipcMain.handle('meta-agent:memory:list', (_event, category?: string, limit?: number) => {
    return getMemories(category, limit);
  });

  ipcMain.handle('meta-agent:memory:add', (_event, memory: Omit<MetaAgentMemory, 'id' | 'created_at' | 'updated_at'>) => {
    return addMemory(memory);
  });

  ipcMain.handle('meta-agent:memory:update', (_event, id: string, updates: { content?: string; importance?: number; category?: string }) => {
    return { success: updateMemory(id, updates) };
  });

  ipcMain.handle('meta-agent:memory:delete', (_event, id: string) => {
    return { success: deleteMemory(id) };
  });

  ipcMain.handle('meta-agent:memory:search', (_event, query: string, limit?: number) => {
    return searchMemories(query, limit);
  });

  ipcMain.handle('meta-agent:memory:stats', () => {
    return getMemoryStats();
  });

  ipcMain.handle('meta-agent:memory:clear', (_event, category?: string) => {
    const db = getDb();
    if (category) {
      db.prepare('DELETE FROM meta_agent_memories WHERE category = ?').run(category);
    } else {
      db.prepare('DELETE FROM meta_agent_memories').run();
    }
    return { success: true };
  });

  // ── Chat (enhanced with config + memory) ──

  ipcMain.handle('meta-agent:chat', async (_event, projectId: string | null, message: string, history?: Array<{ role: string; content: string }>) => {
    const settings = getSettings();
    if (!settings?.apiKey) {
      return { reply: '请先在设置页配置 LLM API Key。', intent: 'general' };
    }

    const config = getMetaAgentConfig();
    const win = BrowserWindow.getAllWindows()[0] ?? null;

    // Load relevant memories (capped by config limit)
    const memories = getMemories(undefined, config.memoryInjectLimit);

    // Build messages for LLM
    const systemPrompt = buildSystemPrompt(config, memories);
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];

    // Add project context if available
    if (projectId) {
      const ctx = collectProjectContext(projectId);
      messages.push({ role: 'system', content: `当前项目上下文:\n${ctx}` });
    }

    // Add conversation history (capped by config)
    if (history?.length) {
      const recent = history.slice(-(config.contextHistoryLimit || 20));
      for (const h of recent) {
        messages.push({ role: h.role, content: h.content });
      }
    }

    // Add current user message
    messages.push({ role: 'user', content: message });

    try {
      const model = settings.fastModel || settings.workerModel || settings.strongModel;
      const result = await callLLM(settings, model, messages, undefined, config.maxResponseTokens || 2048, 1);

      // Parse structured response
      let intent = 'general';
      const text = result.content ?? '';
      let reply = text;
      let wishContent = '';
      let memoryNotes = '';

      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          intent = parsed.intent || 'general';
          reply = parsed.reply || text;
          wishContent = parsed.wishContent || '';
          memoryNotes = parsed.memoryNotes || '';
        }
      } catch {
        reply = text.replace(/```json[\s\S]*?```/g, '').replace(/\{[\s\S]*\}/g, '').trim() || text;
      }

      // Auto-memory: extract and store notable info from conversation
      if (config.autoMemory && memoryNotes) {
        autoExtractMemory(memoryNotes);
      }

      // v8.0: 备份元 Agent 对话
      backupConversation({
        projectId,
        agentId: 'meta-agent',
        agentRole: 'meta-agent',
        messages: messages.map(m => ({ role: m.role as any, content: m.content })),
        totalInputTokens: result.inputTokens,
        totalOutputTokens: result.outputTokens,
        totalCost: result.inputTokens * 0.000001 + result.outputTokens * 0.000003,
        model,
        completed: true,
        metadata: { intent, wishCreated: false },
      });

      // ── Intent: wish → Create wish + start pipeline ──
      let wishCreated = false;
      if (intent === 'wish' && projectId && wishContent.trim()) {
        const db = getDb();
        try {
          const wishId = `wish-${Date.now().toString(36)}`;
          db.prepare('INSERT INTO wishes (id, project_id, content, status) VALUES (?, ?, ?, ?)')
            .run(wishId, projectId, wishContent.trim(), 'pending');
          db.prepare("UPDATE projects SET wish = ?, updated_at = datetime('now') WHERE id = ?")
            .run(wishContent.trim(), projectId);

          addLog(projectId, 'meta-agent', 'info', `📋 ${config.name} 已创建需求: ${wishContent.slice(0, 80)}...`);
          sendToUI(win, 'agent:log', { projectId, agentId: 'meta-agent', content: `📋 需求已创建，启动开发流水线...` });

          const proj = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId) as { status: string } | undefined;
          if (proj && !['developing', 'initializing', 'reviewing'].includes(proj.status)) {
            runOrchestrator(projectId, win).catch(err => {
              console.error('[MetaAgent→Orchestrator] Error:', err);
              sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `❌ 流水线启动失败: ${err.message}` });
            });
            wishCreated = true;
            reply += '\n\n✅ 已创建需求并启动开发流水线。你可以在「总览」页查看进度。';
          } else {
            wishCreated = true;
            reply += '\n\n✅ 已记录需求。当前项目正在运行中，新需求将在本轮结束后自动处理。';
          }
        } catch (err: any) {
          console.error('[MetaAgent] Wish creation error:', err);
          reply += '\n\n⚠️ 需求记录失败，请手动在需求页提交。';
        }
      }

      return {
        reply,
        intent,
        wishCreated,
        tokens: result.inputTokens + result.outputTokens,
        cost: result.inputTokens * 0.000001 + result.outputTokens * 0.000003,
      };
    } catch (err: any) {
      console.error('[meta-agent:chat] LLM error:', err);
      return {
        reply: `抱歉，我暂时无法处理你的消息。错误: ${err.message?.slice(0, 100)}`,
        intent: 'general',
      };
    }
  });
}
