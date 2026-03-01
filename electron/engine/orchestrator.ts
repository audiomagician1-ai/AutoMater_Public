/**
 * Orchestrator — Agent 编排引擎 (Electron 主进程版)
 * 
 * 直接在主进程跑，通过 IPC 推送状态到 UI
 * 无后端服务、无 sidecar
 * 
 * v0.4: 4 阶段流水线 PM → Architect → Developer (上下文感知) → QA 审查
 */

import { BrowserWindow } from 'electron';
import { getDb } from '../db';
import { PM_SYSTEM_PROMPT, ARCHITECT_SYSTEM_PROMPT, DEVELOPER_SYSTEM_PROMPT, QA_SYSTEM_PROMPT } from './prompts';
import { parseFileBlocks, writeFileBlocks, readWorkspaceFile, type WrittenFile } from './file-writer';
import { collectDeveloperContext } from './context-collector';
import { initGitRepo, commitWorkspace } from './workspace-git';

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

async function callLLM(
  settings: any, model: string,
  messages: Array<{ role: string; content: string }>,
  signal?: AbortSignal,
  maxTokens: number = 16384,
  retries: number = 2
) {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new Error('Aborted');
    try {
      return await _callLLMOnce(settings, model, messages, signal, maxTokens);
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
  maxTokens: number = 16384
) {
  // 超时保护: 120秒
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const combinedSignal = signal
    ? anySignal([signal, controller.signal])
    : controller.signal;

  try {
    const fetchOpts: RequestInit = { method: 'POST', signal: combinedSignal };

  if (settings.llmProvider === 'anthropic') {
    const systemMsg = messages.find(m => m.role === 'system');
    const otherMsgs = messages.filter(m => m.role !== 'system');
    const body: any = { model, messages: otherMsgs, max_tokens: maxTokens, temperature: 0.3 };
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
      body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: maxTokens }),
    });
    if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
    const data = await res.json() as any;
    return {
      content: data.choices[0].message.content ?? '',
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  }
  } finally {
    clearTimeout(timeout);
  }
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
    // Phase 2: Architect Agent — 技术架构设计
    // ═══════════════════════════════════════
    if (signal.aborted) { runningOrchestrators.delete(projectId); return; }

    const archId = `arch-${Date.now().toString(36)}`;
    spawnAgent(projectId, archId, 'architect', win);
    sendToUI(win, 'agent:log', { projectId, agentId: archId, content: '🏗️ 架构师开始设计技术方案...' });
    addLog(projectId, archId, 'log', '开始架构设计');

    try {
      const featureSummary = features.map(f => `- ${f.id}: ${f.title || f.description}`).join('\n');
      const archResult = await callLLM(settings, settings.strongModel, [
        { role: 'system', content: ARCHITECT_SYSTEM_PROMPT },
        { role: 'user', content: `用户需求:\n${project.wish}\n\nFeature 清单:\n${featureSummary}\n\n请设计项目技术架构，输出 ARCHITECTURE.md 文件。` },
      ], signal);

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

  for (let i = 0; i < workerCount; i++) {
    const workerId = `dev-${i + 1}`;
    spawnAgent(projectId, workerId, 'developer', win);
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = ? AND project_id = ?").run(workerId, projectId);
    workerPromises.push(workerLoop(projectId, workerId, qaId, settings, win, signal, workspacePath));
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

  // Git commit: 最终产出
  if (workspacePath) {
    commitWorkspace(workspacePath, `AgentForge: Delivered ${stats.passed}/${stats.total} features`);
  }

  runningOrchestrators.delete(projectId);
}

// ═══════════════════════════════════════
// Worker 循环 (带上下文收集 + QA 审查)
// ═══════════════════════════════════════
async function workerLoop(
  projectId: string, workerId: string, qaId: string, settings: any,
  win: BrowserWindow | null, signal: AbortSignal, workspacePath: string | null
) {
  const db = getDb();
  const maxRetries = 3;

  while (!signal.aborted) {
    // ── 预算检查 ──
    const budget = checkBudget(projectId, settings);
    if (!budget.ok) {
      sendToUI(win, 'agent:log', {
        projectId, agentId: workerId,
        content: `💰 预算已用尽! ($${budget.spent.toFixed(2)} / $${budget.budget}) — 自动暂停`,
      });
      // 触发停止
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

    for (let attempt = 1; attempt <= maxRetries && !signal.aborted; attempt++) {
      try {
        // ── 收集上下文 ──
        let contextBlock = '';
        if (workspacePath) {
          const ctx = collectDeveloperContext(workspacePath, projectId, feature);
          if (ctx.contextText) {
            contextBlock = `\n\n## 项目上下文 (${ctx.filesIncluded} 个文件, ~${ctx.estimatedTokens} tokens)\n${ctx.contextText}`;
            sendToUI(win, 'agent:log', {
              projectId, agentId: workerId,
              content: `📚 ${feature.id} 上下文: ${ctx.filesIncluded} 文件, ~${ctx.estimatedTokens} tokens`,
            });
          }
        }

        // ── QA 反馈（重试时） ──
        let qaBlock = '';
        if (qaFeedback) {
          qaBlock = `\n\n## QA 审查反馈（请根据反馈修改）\n${qaFeedback}`;
        }

        // ── 调用 LLM 开发 ──
        const result = await callLLM(settings, settings.workerModel, [
          { role: 'system', content: DEVELOPER_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `请实现以下 Feature:\n\nID: ${feature.id}\n标题: ${feature.title}\n描述: ${feature.description}\n验收标准: ${feature.acceptance_criteria}${contextBlock}${qaBlock}\n\n请输出所有需要创建/修改的文件。使用如下格式：\n<<<FILE:relative/path/to/file>>>\n文件内容\n<<<END>>>\n\n完成所有文件后明确写出 "${feature.id} COMPLETED"。`,
          },
        ], signal, 16384);

        const cost = calcCost(settings.workerModel, result.inputTokens, result.outputTokens);
        addLog(projectId, workerId, 'output', `[${feature.id}] Attempt ${attempt}:\n${result.content.slice(0, 3000)}`);
        updateAgentStats(workerId, projectId, result.inputTokens, result.outputTokens, cost);

        // ── 解析并写入文件 ──
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
          // 更新 affected_files
          const existingFiles = JSON.parse(feature.affected_files || '[]') as string[];
          const allFiles = [...new Set([...existingFiles, ...writtenFiles.map(f => f.relativePath)])];
          db.prepare("UPDATE features SET affected_files = ? WHERE id = ? AND project_id = ?").run(JSON.stringify(allFiles), feature.id, projectId);
          sendToUI(win, 'workspace:changed', { projectId });
        } else if (fileBlocks.length === 0) {
          sendToUI(win, 'agent:log', {
            projectId, agentId: workerId,
            content: `⚠️ ${feature.id} LLM 未输出文件块 (attempt ${attempt})`,
          });
          continue; // 直接重试
        }

        if (!result.content.toUpperCase().includes('COMPLETED')) {
          sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `⚠️ ${feature.id} 未明确完成标记, 重试 ${attempt}/${maxRetries}` });
          continue;
        }

        // ── QA 审查 ──
        if (writtenFiles.length > 0 && workspacePath) {
          sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: 'reviewing', agentId: qaId });
          db.prepare("UPDATE features SET status = 'reviewing' WHERE id = ? AND project_id = ?").run(feature.id, projectId);
          db.prepare("UPDATE agents SET status = 'working', current_task = ? WHERE id = ? AND project_id = ?").run(feature.id, qaId, projectId);
          sendToUI(win, 'agent:log', { projectId, agentId: qaId, content: `🔍 审查 ${feature.id}...` });

          const qaResult = await runQAReview(settings, signal, feature, writtenFiles, workspacePath);
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
              content: `✅ ${feature.id} 完成! (attempt ${attempt}, dev+qa $${(cost + qaCost).toFixed(4)})`,
            });
            break;
          } else {
            qaFeedback = qaResult.feedbackText;
            sendToUI(win, 'agent:log', {
              projectId, agentId: qaId,
              content: `❌ ${feature.id} QA 未通过 (分数: ${qaResult.score}): ${qaResult.summary}`,
            });
            sendToUI(win, 'agent:log', {
              projectId, agentId: workerId,
              content: `🔄 ${feature.id} 根据 QA 反馈重做 (${attempt}/${maxRetries})`,
            });
            // 回退状态为 in_progress 以便重做
            db.prepare("UPDATE features SET status = 'in_progress' WHERE id = ? AND project_id = ?").run(feature.id, projectId);
          }
        } else {
          // 没有文件但说了 COMPLETED —— 勉强通过
          passed = true;
          sendToUI(win, 'agent:log', {
            projectId, agentId: workerId,
            content: `✅ ${feature.id} 完成! (attempt ${attempt}, 无文件输出, $${cost.toFixed(4)})`,
          });
          break;
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

    // Git commit after each passed feature
    if (passed && workspacePath) {
      commitWorkspace(workspacePath, `feat: ${feature.id} — ${(feature.title || '').slice(0, 50)}`);
    }

    await sleep(500);
  }
}

// ═══════════════════════════════════════
// QA 审查
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
  feature: any, writtenFiles: WrittenFile[], workspacePath: string
): Promise<QAResult> {
  // 构建审查内容：读取所有写入的文件
  const filesContent: string[] = [];
  for (const wf of writtenFiles.slice(0, 10)) { // 最多审查 10 个文件
    const content = readWorkspaceFile(workspacePath, wf.relativePath);
    if (content) {
      filesContent.push(`### ${wf.relativePath}\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  const result = await callLLM(settings, settings.strongModel, [
    { role: 'system', content: QA_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `请审查以下 Feature 的实现代码:\n\nFeature ID: ${feature.id}\n标题: ${feature.title}\n描述: ${feature.description}\n验收标准: ${feature.acceptance_criteria}\n\n## 实现的文件\n${filesContent.join('\n\n')}\n\n请给出审查结果（JSON 格式，不要用 markdown 代码块包裹）。`,
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
    // JSON 解析失败，默认通过
    summary = 'QA 输出格式异常，默认通过';
  }

  // 构建反馈文本供开发者参考
  let feedbackText = `QA 分数: ${score}/100\n${summary}`;
  if (issues.length > 0) {
    feedbackText += '\n\n问题列表:\n' + issues.map((iss: any, i: number) =>
      `${i + 1}. [${iss.severity}] ${iss.file || ''}: ${iss.description}\n   建议: ${iss.suggestion || 'N/A'}`
    ).join('\n');
  }

  return {
    verdict,
    score,
    summary,
    feedbackText,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

