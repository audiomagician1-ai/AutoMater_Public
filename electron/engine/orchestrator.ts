/**
 * Orchestrator — Agent 编排引擎 (Electron 主进程版)
 * 
 * 直接在主进程跑，通过 IPC 推送状态到 UI
 * 无后端服务、无 sidecar
 */

import { BrowserWindow } from 'electron';
import { getDb } from '../db';
import { PM_SYSTEM_PROMPT, DEVELOPER_SYSTEM_PROMPT } from './prompts';

interface Feature {
  id: string;
  project_id: string;
  category: string;
  priority: number;
  title: string;
  description: string;
  depends_on: string;
  status: string;
  locked_by: string | null;
  acceptance_criteria: string;
  notes: string;
}

function getSettings() {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app_settings') as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}

async function callLLM(settings: any, model: string, messages: Array<{ role: string; content: string }>) {
  if (settings.llmProvider === 'anthropic') {
    const systemMsg = messages.find(m => m.role === 'system');
    const otherMsgs = messages.filter(m => m.role !== 'system');
    const body: any = { model, messages: otherMsgs, max_tokens: 8192, temperature: 0.3 };
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
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    const data = await res.json() as any;
    return {
      content: data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''),
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    };
  } else {
    const res = await fetch(`${settings.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 8192 }),
    });
    if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
    const data = await res.json() as any;
    return {
      content: data.choices[0].message.content ?? '',
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  }
}

function sendToUI(win: BrowserWindow | null, channel: string, data: any) {
  try {
    win?.webContents.send(channel, data);
  } catch { /* window might be closed */ }
}

function addLog(projectId: string, agentId: string, type: string, content: string) {
  const db = getDb();
  db.prepare('INSERT INTO agent_logs (project_id, agent_id, type, content) VALUES (?, ?, ?, ?)').run(
    projectId, agentId, type, content
  );
}

/**
 * 主编排流程 — 在 Electron 主进程异步执行
 */
export async function runOrchestrator(projectId: string, win: BrowserWindow | null) {
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

  // ═══════════════════════════════════════
  // Phase 1: PM Agent — 需求分析 → Feature List
  // ═══════════════════════════════════════
  const pmId = `pm-${Date.now().toString(36)}`;
  db.prepare('INSERT INTO agents (id, project_id, role, status) VALUES (?, ?, ?, ?)').run(pmId, projectId, 'pm', 'working');
  sendToUI(win, 'agent:spawned', { projectId, agentId: pmId, role: 'pm' });
  sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: '🧠 产品经理开始分析需求...' });
  addLog(projectId, pmId, 'log', '开始分析需求: ' + project.wish);

  db.prepare("UPDATE projects SET status = 'initializing', updated_at = datetime('now') WHERE id = ?").run(projectId);
  sendToUI(win, 'project:status', { projectId, status: 'initializing' });

  let features: any[] = [];
  try {
    const pmResult = await callLLM(settings, settings.strongModel, [
      { role: 'system', content: PM_SYSTEM_PROMPT },
      { role: 'user', content: `用户需求:\n${project.wish}\n\n请分析此需求，拆解为 Feature 清单。直接输出 JSON 数组，不要用 markdown 代码块包裹。` },
    ]);

    addLog(projectId, pmId, 'output', pmResult.content);
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `✅ PM 分析完成 (${pmResult.inputTokens + pmResult.outputTokens} tokens)` });

    // 解析 JSON
    let jsonStr = pmResult.content.trim();
    // 尝试提取 JSON 数组
    const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      features = JSON.parse(jsonMatch[0]);
    }

    // 更新 PM agent 状态
    db.prepare("UPDATE agents SET status = 'idle', session_count = 1, total_input_tokens = ?, total_output_tokens = ?, last_active_at = datetime('now') WHERE id = ?")
      .run(pmResult.inputTokens, pmResult.outputTokens, pmId);
  } catch (err: any) {
    addLog(projectId, pmId, 'error', err.message);
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `❌ PM 分析失败: ${err.message}` });
    db.prepare("UPDATE agents SET status = 'error' WHERE id = ?").run(pmId);
    db.prepare("UPDATE projects SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(projectId);
    sendToUI(win, 'project:status', { projectId, status: 'error' });
    return;
  }

  if (features.length === 0) {
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: '⚠️ PM 未能生成有效的 Feature 清单' });
    db.prepare("UPDATE projects SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(projectId);
    return;
  }

  // 写入 features 到数据库
  const insertFeature = db.prepare(`
    INSERT INTO features (id, project_id, category, priority, title, description, depends_on, status, acceptance_criteria, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?)
  `);

  const insertMany = db.transaction((items: any[]) => {
    for (const f of items) {
      insertFeature.run(
        f.id || `F${String(items.indexOf(f) + 1).padStart(3, '0')}`,
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
  });
  insertMany(features);

  sendToUI(win, 'project:features-ready', { projectId, count: features.length });
  sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `📋 生成了 ${features.length} 个 Feature` });

  // ═══════════════════════════════════════
  // Phase 2: Developer Agents — 迭代开发
  // ═══════════════════════════════════════
  db.prepare("UPDATE projects SET status = 'developing', updated_at = datetime('now') WHERE id = ?").run(projectId);
  sendToUI(win, 'project:status', { projectId, status: 'developing' });

  const workerCount = Math.min(settings.workerCount || 2, features.length);

  // 启动 N 个 Worker 并行
  const workerPromises: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    const workerId = `dev-${i + 1}`;
    db.prepare('INSERT INTO agents (id, project_id, role, status) VALUES (?, ?, ?, ?)').run(workerId, projectId, 'developer', 'idle');
    sendToUI(win, 'agent:spawned', { projectId, agentId: workerId, role: 'developer' });
    workerPromises.push(workerLoop(projectId, workerId, settings, win));
  }

  await Promise.all(workerPromises);

  // ═══════════════════════════════════════
  // Phase 3: 完成
  // ═══════════════════════════════════════
  const stats = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) as passed FROM features WHERE project_id = ?").get(projectId) as any;
  const finalStatus = stats.passed === stats.total ? 'delivered' : 'paused';
  db.prepare(`UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(finalStatus, projectId);
  sendToUI(win, 'project:status', { projectId, status: finalStatus });
  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `🏁 项目完成! ${stats.passed}/${stats.total} features 通过` });
}

/**
 * 单个 Worker 循环
 */
async function workerLoop(projectId: string, workerId: string, settings: any, win: BrowserWindow | null) {
  const db = getDb();
  const maxRetries = 2;
  let sessionCount = 0;

  while (true) {
    // 选择下一个可做的 feature
    const feature = db.prepare(`
      SELECT * FROM features
      WHERE project_id = ? AND status = 'todo'
      ORDER BY priority ASC, id ASC
      LIMIT 1
    `).get(projectId) as Feature | undefined;

    if (!feature) {
      // 没有更多任务了
      sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: '✅ 没有更多任务，下班了' });
      db.prepare("UPDATE agents SET status = 'idle', last_active_at = datetime('now') WHERE id = ? AND project_id = ?").run(workerId, projectId);
      break;
    }

    // 锁定
    db.prepare("UPDATE features SET status = 'in_progress', locked_by = ? WHERE id = ? AND project_id = ?").run(workerId, feature.id, projectId);
    db.prepare("UPDATE agents SET status = 'working', current_task = ?, last_active_at = datetime('now') WHERE id = ? AND project_id = ?").run(feature.id, workerId, projectId);
    sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: 'in_progress', agentId: workerId });
    sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `🔨 开始: ${feature.id} — ${feature.title || feature.description}` });

    sessionCount++;
    let passed = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await callLLM(settings, settings.workerModel, [
          { role: 'system', content: DEVELOPER_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `请实现以下 Feature:\n\nID: ${feature.id}\n标题: ${feature.title}\n描述: ${feature.description}\n验收标准: ${feature.acceptance_criteria}\n\n完成后请明确写出 "${feature.id} COMPLETED"。`,
          },
        ]);

        addLog(projectId, workerId, 'output', `[${feature.id}] Attempt ${attempt}:\n${result.content}`);

        // 更新 token 计数
        db.prepare(`
          UPDATE agents SET
            session_count = session_count + 1,
            total_input_tokens = total_input_tokens + ?,
            total_output_tokens = total_output_tokens + ?,
            last_active_at = datetime('now')
          WHERE id = ? AND project_id = ?
        `).run(result.inputTokens, result.outputTokens, workerId, projectId);

        // 简单验证: 输出中是否包含 COMPLETED
        if (result.content.includes('COMPLETED') || result.content.includes('completed')) {
          passed = true;
          sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `✅ ${feature.id} 完成! (attempt ${attempt}, ${result.inputTokens + result.outputTokens} tokens)` });
          break;
        } else {
          sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `⚠️ ${feature.id} 未明确完成标记, 重试 ${attempt}/${maxRetries}` });
        }
      } catch (err: any) {
        sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `❌ ${feature.id} 错误: ${err.message}` });
        addLog(projectId, workerId, 'error', `[${feature.id}] ${err.message}`);
        if (attempt >= maxRetries) break;
        await sleep(2000);
      }
    }

    // 更新状态
    const newStatus = passed ? 'passed' : 'failed';
    db.prepare(`UPDATE features SET status = ?, locked_by = NULL, completed_at = CASE WHEN ? = 'passed' THEN datetime('now') ELSE NULL END WHERE id = ? AND project_id = ?`)
      .run(newStatus, newStatus, feature.id, projectId);
    sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: newStatus, agentId: workerId });

    db.prepare("UPDATE agents SET current_task = NULL WHERE id = ? AND project_id = ?").run(workerId, projectId);

    await sleep(1000); // cooldown
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
