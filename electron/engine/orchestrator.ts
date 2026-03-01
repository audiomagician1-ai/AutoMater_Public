/**
 * Orchestrator — Agent 编排引擎 (Electron 主进程版)
 * 
 * 直接在主进程跑，通过 IPC 推送状态到 UI
 * 无后端服务、无 sidecar
 * 
 * v0.2: 修复竞态 + 可停止 + 依赖检查 + 成本计算
 */

import { BrowserWindow } from 'electron';
import { getDb } from '../db';
import { PM_SYSTEM_PROMPT, DEVELOPER_SYSTEM_PROMPT } from './prompts';
import { parseFileBlocks, writeFileBlocks, type WrittenFile } from './file-writer';

// ═══════════════════════════════════════
// 运行中的编排器注册表（支持停止）
// ═══════════════════════════════════════
const runningOrchestrators = new Map<string, AbortController>();

export function stopOrchestrator(projectId: string) {
  const ctrl = runningOrchestrators.get(projectId);
  if (ctrl) {
    ctrl.abort();
    runningOrchestrators.delete(projectId);
  }
  const db = getDb();
  db.prepare("UPDATE projects SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(projectId);
  // 解锁所有 in_progress 的 feature
  db.prepare("UPDATE features SET status = 'todo', locked_by = NULL WHERE project_id = ? AND status = 'in_progress'").run(projectId);
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
  'claude-sonnet-4-20250514':    { input: 0.003,   output: 0.015 },
  'claude-opus-4-20250514':      { input: 0.015,   output: 0.075 },
  'claude-3-5-sonnet-20241022':  { input: 0.003,   output: 0.015 },
  'claude-3-5-haiku-20241022':   { input: 0.001,   output: 0.005 },
};

function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[model];
  if (!p) return 0;
  return (inputTokens / 1000) * p.input + (outputTokens / 1000) * p.output;
}

// ═══════════════════════════════════════
// LLM 调用
// ═══════════════════════════════════════
function getSettings() {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app_settings') as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}

async function callLLM(settings: any, model: string, messages: Array<{ role: string; content: string }>, signal?: AbortSignal) {
  const fetchOpts: RequestInit = { method: 'POST', signal };

  if (settings.llmProvider === 'anthropic') {
    const systemMsg = messages.find(m => m.role === 'system');
    const otherMsgs = messages.filter(m => m.role !== 'system');
    const body: any = { model, messages: otherMsgs, max_tokens: 8192, temperature: 0.3 };
    if (systemMsg) body.system = systemMsg.content;

    const res = await fetch(`${settings.baseUrl}/v1/messages`, {
      ...fetchOpts,
      headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' },
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
      ...fetchOpts,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
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

// ═══════════════════════════════════════
// UI 推送 + DB 日志
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

// ═══════════════════════════════════════
// Feature 原子锁定（解决多 Worker 竞态）
// ═══════════════════════════════════════
function lockNextFeature(projectId: string, workerId: string): any | null {
  const db = getDb();
  // 用事务实现原子 select-for-update
  const tryLock = db.transaction(() => {
    // 找到所有已通过的 feature ID 集合
    const passedRows = db.prepare("SELECT id FROM features WHERE project_id = ? AND status = 'passed'").all(projectId) as { id: string }[];
    const passedSet = new Set(passedRows.map(r => r.id));

    // 找所有 todo 的，按 priority 排序
    const todos = db.prepare("SELECT * FROM features WHERE project_id = ? AND status = 'todo' ORDER BY priority ASC, id ASC").all(projectId) as any[];

    for (const f of todos) {
      // 检查依赖是否全部完成
      let deps: string[] = [];
      try { deps = JSON.parse(f.depends_on || '[]'); } catch { /* */ }
      const depsOk = deps.every((d: string) => passedSet.has(d));
      if (!depsOk) continue;

      // 原子锁定：UPDATE ... WHERE status = 'todo' 确保只有一个 worker 能拿到
      const result = db.prepare(
        "UPDATE features SET status = 'in_progress', locked_by = ? WHERE id = ? AND project_id = ? AND status = 'todo'"
      ).run(workerId, f.id, projectId);

      if (result.changes > 0) {
        return { ...f, status: 'in_progress', locked_by: workerId };
      }
      // 如果 changes === 0，说明被其他 worker 抢了，继续找下一个
    }
    return null;
  });

  return tryLock();
}

// ═══════════════════════════════════════
// 主编排流程
// ═══════════════════════════════════════
export async function runOrchestrator(projectId: string, win: BrowserWindow | null) {
  // 如果已有编排在运行，先停掉
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

  // 确保工作区目录存在
  const workspacePath = project.workspace_path;
  if (workspacePath) {
    const fs = require('fs');
    fs.mkdirSync(workspacePath, { recursive: true });
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
    if (signal.aborted) return;

    const pmResult = await callLLM(settings, settings.strongModel, [
      { role: 'system', content: PM_SYSTEM_PROMPT },
      { role: 'user', content: `用户需求:\n${project.wish}\n\n请分析此需求，拆解为 Feature 清单。直接输出 JSON 数组，不要用 markdown 代码块包裹。` },
    ], signal);

    const pmCost = calcCost(settings.strongModel, pmResult.inputTokens, pmResult.outputTokens);
    addLog(projectId, pmId, 'output', pmResult.content);
    sendToUI(win, 'agent:log', {
      projectId, agentId: pmId,
      content: `✅ PM 分析完成 (${pmResult.inputTokens + pmResult.outputTokens} tokens, $${pmCost.toFixed(4)})`,
    });

    // 解析 JSON
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

  // ═══════════════════════════════════════
  // Phase 2: Developer Agents — 迭代开发
  // ═══════════════════════════════════════
  if (signal.aborted) { runningOrchestrators.delete(projectId); return; }

  db.prepare("UPDATE projects SET status = 'developing', updated_at = datetime('now') WHERE id = ?").run(projectId);
  sendToUI(win, 'project:status', { projectId, status: 'developing' });

  const workerCount = Math.min(settings.workerCount || 2, features.length, 6);
  const workerPromises: Promise<void>[] = [];

  for (let i = 0; i < workerCount; i++) {
    const workerId = `dev-${i + 1}`;
    db.prepare('INSERT OR REPLACE INTO agents (id, project_id, role, status) VALUES (?, ?, ?, ?)').run(workerId, projectId, 'developer', 'idle');
    sendToUI(win, 'agent:spawned', { projectId, agentId: workerId, role: 'developer' });
    workerPromises.push(workerLoop(projectId, workerId, settings, win, signal, workspacePath));
  }

  await Promise.all(workerPromises);

  // ═══════════════════════════════════════
  // Phase 3: 完成
  // ═══════════════════════════════════════
  if (signal.aborted) { runningOrchestrators.delete(projectId); return; }

  const stats = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) as passed FROM features WHERE project_id = ?").get(projectId) as any;
  const finalStatus = stats.passed === stats.total ? 'delivered' : 'paused';
  db.prepare("UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?").run(finalStatus, projectId);
  sendToUI(win, 'project:status', { projectId, status: finalStatus });
  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `🏁 项目完成! ${stats.passed}/${stats.total} features 通过` });

  runningOrchestrators.delete(projectId);
}

// ═══════════════════════════════════════
// Worker 循环
// ═══════════════════════════════════════
async function workerLoop(
  projectId: string, workerId: string, settings: any,
  win: BrowserWindow | null, signal: AbortSignal, workspacePath: string | null
) {
  const db = getDb();
  const maxRetries = 2;

  while (!signal.aborted) {
    // 原子锁定下一个可做的 feature（解决竞态）
    const feature = lockNextFeature(projectId, workerId);

    if (!feature) {
      // 检查是否还有 in_progress 的（其他 worker 在做）
      const inProgress = db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ? AND status = 'in_progress'").get(projectId) as any;
      if (inProgress.c > 0) {
        // 等一会儿再看
        await sleep(3000);
        continue;
      }
      // 真的没任务了
      sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: '✅ 没有更多任务，下班了' });
      db.prepare("UPDATE agents SET status = 'idle', current_task = NULL, last_active_at = datetime('now') WHERE id = ? AND project_id = ?").run(workerId, projectId);
      break;
    }

    db.prepare("UPDATE agents SET status = 'working', current_task = ?, last_active_at = datetime('now') WHERE id = ? AND project_id = ?").run(feature.id, workerId, projectId);
    sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: 'in_progress', agentId: workerId });
    sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `🔨 开始: ${feature.id} — ${feature.title || feature.description}` });

    let passed = false;

    for (let attempt = 1; attempt <= maxRetries && !signal.aborted; attempt++) {
      try {
        const result = await callLLM(settings, settings.workerModel, [
          { role: 'system', content: DEVELOPER_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `请实现以下 Feature:\n\nID: ${feature.id}\n标题: ${feature.title}\n描述: ${feature.description}\n验收标准: ${feature.acceptance_criteria}\n\n请输出所有需要创建/修改的文件。使用如下格式：\n<<<FILE:relative/path/to/file>>>\n文件内容\n<<<END>>>\n\n完成所有文件后明确写出 "${feature.id} COMPLETED"。`,
          },
        ], signal);

        const cost = calcCost(settings.workerModel, result.inputTokens, result.outputTokens);
        addLog(projectId, workerId, 'output', `[${feature.id}] Attempt ${attempt}:\n${result.content.slice(0, 2000)}`);

        // 解析并写入文件
        const fileBlocks = parseFileBlocks(result.content);
        let writtenFiles: WrittenFile[] = [];
        if (fileBlocks.length > 0 && workspacePath) {
          writtenFiles = writeFileBlocks(workspacePath, fileBlocks);
          const fileList = writtenFiles.map(f => f.relativePath).join(', ');
          sendToUI(win, 'agent:log', {
            projectId, agentId: workerId,
            content: `📁 ${feature.id} 写入 ${writtenFiles.length} 个文件: ${fileList}`,
          });
          addLog(projectId, workerId, 'files', JSON.stringify(writtenFiles.map(f => f.relativePath)));
          // 更新 feature 的 affected_files
          const existingFiles = JSON.parse(feature.affected_files || '[]') as string[];
          const allFiles = [...new Set([...existingFiles, ...writtenFiles.map(f => f.relativePath)])];
          db.prepare("UPDATE features SET affected_files = ? WHERE id = ? AND project_id = ?").run(JSON.stringify(allFiles), feature.id, projectId);
          // 通知前端文件变化
          sendToUI(win, 'workspace:changed', { projectId });
        } else if (fileBlocks.length === 0) {
          sendToUI(win, 'agent:log', {
            projectId, agentId: workerId,
            content: `⚠️ ${feature.id} LLM 未输出文件块`,
          });
        }

        db.prepare(`
          UPDATE agents SET
            session_count = session_count + 1,
            total_input_tokens = total_input_tokens + ?,
            total_output_tokens = total_output_tokens + ?,
            total_cost_usd = total_cost_usd + ?,
            last_active_at = datetime('now')
          WHERE id = ? AND project_id = ?
        `).run(result.inputTokens, result.outputTokens, cost, workerId, projectId);

        if (result.content.toUpperCase().includes('COMPLETED')) {
          passed = true;
          sendToUI(win, 'agent:log', {
            projectId, agentId: workerId,
            content: `✅ ${feature.id} 完成! (attempt ${attempt}, ${result.inputTokens + result.outputTokens} tokens, $${cost.toFixed(4)})`,
          });
          break;
        } else {
          sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `⚠️ ${feature.id} 未明确完成标记, 重试 ${attempt}/${maxRetries}` });
        }
      } catch (err: any) {
        if (signal.aborted) break;
        sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `❌ ${feature.id} 错误: ${err.message}` });
        addLog(projectId, workerId, 'error', `[${feature.id}] ${err.message}`);
        if (attempt >= maxRetries) break;
        await sleep(2000);
      }
    }

    if (signal.aborted) break;

    const newStatus = passed ? 'passed' : 'failed';
    db.prepare("UPDATE features SET status = ?, locked_by = NULL, completed_at = CASE WHEN ? = 'passed' THEN datetime('now') ELSE NULL END WHERE id = ? AND project_id = ?")
      .run(newStatus, newStatus, feature.id, projectId);
    sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: newStatus, agentId: workerId });
    db.prepare("UPDATE agents SET current_task = NULL WHERE id = ? AND project_id = ?").run(workerId, projectId);

    await sleep(800);
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

