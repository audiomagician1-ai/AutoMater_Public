/**
 * meta-agent IPC handlers — 元Agent 对话接口
 *
 * 用户通过管家面板发消息 → LLM 意图识别 + 回复
 *   - 需求类 → 自动 wish:create + project:start
 *   - 查询类 → 读取设计文档/技术架构回答
 *   - 通用类 → 直接对话回复
 *
 * v5.4: 初始创建
 */

import { ipcMain, BrowserWindow } from 'electron';
import { callLLM, getSettings } from '../engine/llm-client';
import { sendToUI, addLog } from '../engine/ui-bridge';
import { getDb } from '../db';
import { runOrchestrator, stopOrchestrator } from '../engine/orchestrator';
import fs from 'fs';
import path from 'path';

// ═══════════════════════════════════════
// System Prompt for Meta Agent
// ═══════════════════════════════════════

const META_AGENT_SYSTEM_PROMPT = `你是"元Agent管家"，一个AI软件开发平台的智能助手。你的职责：

1. **需求接收**: 当用户表达产品需求/功能想法时，提取核心需求，回复确认并告知已转交团队处理。
2. **项目查询**: 当用户询问项目状态、设计文档、技术架构时，基于提供的项目上下文回答。
3. **工作流管理**: 当用户想调整团队配置、暂停/恢复项目时，给出操作建议。
4. **通用对话**: 其他问题友好回答。

**重要规则**:
- 你的回复必须是 JSON 格式: {"intent": "wish|query|workflow|general", "reply": "你的回复文本", "wishContent": "仅当intent=wish时，提取的需求文本"}
- intent=wish: 用户在表达新功能需求、产品想法、要做什么系统/功能
- intent=query: 用户在问项目状态、进度、文档内容、技术细节
- intent=workflow: 用户想暂停/启动/调整工作流、团队配置
- intent=general: 闲聊或其他
- wishContent: 精炼后的需求描述（保留用户原意，去除口语化表达），仅 wish 意图时填写
- 回复要简洁友好，中文。确认需求时要复述核心要点让用户确认。`;

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
// IPC Handler Registration
// ═══════════════════════════════════════

export function setupMetaAgentHandlers() {
  /**
   * meta-agent:chat — 处理用户消息
   *
   * @param projectId - 当前项目 ID (null = 全局对话)
   * @param message - 用户消息文本
   * @param history - 最近对话历史 [{role, content}]
   * @returns { reply, intent, wishCreated? }
   */
  ipcMain.handle('meta-agent:chat', async (_event, projectId: string | null, message: string, history?: Array<{ role: string; content: string }>) => {
    const settings = getSettings();
    if (!settings?.apiKey) {
      return { reply: '请先在设置页配置 LLM API Key。', intent: 'general' };
    }

    const win = BrowserWindow.getAllWindows()[0] ?? null;

    // Build messages for LLM
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: META_AGENT_SYSTEM_PROMPT },
    ];

    // Add project context if available
    if (projectId) {
      const ctx = collectProjectContext(projectId);
      messages.push({ role: 'system', content: `当前项目上下文:\n${ctx}` });
    }

    // Add conversation history (last 10 exchanges)
    if (history?.length) {
      const recent = history.slice(-20);
      for (const h of recent) {
        messages.push({ role: h.role, content: h.content });
      }
    }

    // Add current user message
    messages.push({ role: 'user', content: message });

    try {
      // Use fast model if available, otherwise worker model
      const model = settings.fastModel || settings.workerModel || settings.strongModel;
      const result = await callLLM(settings, model, messages, undefined, 2048, 1);

      // Parse structured response
      let intent = 'general';
      const text = result.content ?? '';
      let reply = text;
      let wishContent = '';

      try {
        // Try to extract JSON from response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          intent = parsed.intent || 'general';
          reply = parsed.reply || text;
          wishContent = parsed.wishContent || '';
        }
      } catch {
        // If JSON parse fails, use raw text as reply
        reply = text.replace(/```json[\s\S]*?```/g, '').replace(/\{[\s\S]*\}/g, '').trim() || text;
      }

      // ── Intent: wish → Create wish + start pipeline ──
      let wishCreated = false;
      if (intent === 'wish' && projectId && wishContent.trim()) {
        const db = getDb();
        try {
          // Create wish record
          const wishId = `wish-${Date.now().toString(36)}`;
          db.prepare('INSERT INTO wishes (id, project_id, content, status) VALUES (?, ?, ?, ?)')
            .run(wishId, projectId, wishContent.trim(), 'pending');

          // Update project wish field
          db.prepare("UPDATE projects SET wish = ?, updated_at = datetime('now') WHERE id = ?")
            .run(wishContent.trim(), projectId);

          // Start orchestrator
          addLog(projectId, 'meta-agent', 'info', `📋 元Agent 已创建需求: ${wishContent.slice(0, 80)}...`);
          sendToUI(win, 'agent:log', { projectId, agentId: 'meta-agent', content: `📋 需求已创建，启动开发流水线...` });

          // Check project status — only start if not already running
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
