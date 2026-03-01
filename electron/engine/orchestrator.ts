/**
 * Orchestrator — Agent 编排引擎 (Electron 主进程版)
 *
 * v2.5: 拆分为模块化架构:
 *   - llm-client.ts: LLM 调用层 (stream/tools/retry/pricing)
 *   - ui-bridge.ts: UI 通信 + 通知 + 日志
 *   - agent-manager.ts: Agent 生命周期 / stats / budget / feature lock
 *   - react-loop.ts: ReAct 开发循环 + 消息压缩
 *   - qa-loop.ts: QA 审查 (TDD)
 *   - orchestrator.ts (本文件): 纯编排 — 4 阶段流水线组合
 */

import { BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { getDb } from '../db';

// ── 子模块 ──
import { callLLM, calcCost, getSettings, sleep } from './llm-client';
import { sendToUI, addLog, notify, createStreamCallback } from './ui-bridge';
import { stopOrchestrator as _stopOrchestrator, registerOrchestrator, unregisterOrchestrator, spawnAgent, updateAgentStats, checkBudget, lockNextFeature } from './agent-manager';
import { reactDeveloperLoop, getAgentReactStates as _getAgentReactStates, getContextSnapshots as _getContextSnapshots } from './react-loop';
import { runQAReview } from './qa-loop';

// ── 引擎依赖 ──
import type { AppSettings, ProjectRow, FeatureRow, CountResult } from './types';
import { PM_SYSTEM_PROMPT, ARCHITECT_SYSTEM_PROMPT } from './prompts';
import { parseFileBlocks, writeFileBlocks } from './file-writer';
import { parseStructuredOutput, PM_FEATURE_SCHEMA } from './output-parser';
import { gatePMToArchitect, gateArchitectToDeveloper } from './guards';
import { commitWorkspace } from './workspace-git';
import { ensureGlobalMemory, ensureProjectMemory, appendProjectMemory, buildLessonExtractionPrompt } from './memory-system';
import { selectModelTier, resolveModel } from './model-selector';
import { emitEvent } from './event-store';
import { createCheckpoint } from './mission';
import { extractFromProjectMemory } from './cross-project';
import type { GitProviderConfig } from './git-provider';

// ═══════════════════════════════════════
// Re-exports (保持向后兼容的 public API)
// ═══════════════════════════════════════

export { stopOrchestrator } from './agent-manager';
export { getAgentReactStates, getContextSnapshots } from './react-loop';
export type { AgentReactState, ReactIterationState, MessageTokenBreakdown } from './react-loop';

// ═══════════════════════════════════════

export async function runOrchestrator(projectId: string, win: BrowserWindow | null) {
  _stopOrchestrator(projectId);

  const abortCtrl = new AbortController();
  registerOrchestrator(projectId, abortCtrl);
  const signal = abortCtrl.signal;

  const db = getDb();
  const settings = getSettings();

  if (!settings || !settings.apiKey) {
    sendToUI(win, 'agent:error', { projectId, error: '请先在设置中配置 LLM API Key' });
    return;
  }

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
  if (!project) {
    sendToUI(win, 'agent:error', { projectId, error: '项目不存在' });
    return;
  }

  const workspacePath = project.workspace_path;
  if (workspacePath) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  ensureGlobalMemory();
  if (workspacePath) ensureProjectMemory(workspacePath);

  emitEvent({
    projectId, agentId: 'system', type: 'project:start',
    data: { wish: project.wish, name: project.name, workspace: workspacePath },
  });

  const existingFeatures = db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ?").get(projectId) as CountResult;
  const isResume = existingFeatures.c > 0;

  if (!isResume) {
    // ═══ Phase 1: PM — 需求分析 → Feature List ═══
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
      sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `✅ PM 分析完成 (${pmResult.inputTokens + pmResult.outputTokens} tokens, $${pmCost.toFixed(4)})` });

      // v3.0: 结构化解析替代 regex
      const parseResult = parseStructuredOutput(pmResult.content, PM_FEATURE_SCHEMA);
      if (parseResult.ok) {
        features = parseResult.data;
        if (parseResult.warnings.length > 0) {
          sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `⚠️ PM 输出修复: ${parseResult.warnings.slice(0, 3).join('; ')}` });
        }
        addLog(projectId, pmId, 'log', `Parsed via strategy: ${parseResult.strategy}`);
      } else {
        sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `❌ PM 输出解析失败: ${parseResult.error}\n原始输出: ${parseResult.rawPreview}` });
        addLog(projectId, pmId, 'error', `Parse failed: ${parseResult.error}`);
      }
      db.prepare("UPDATE agents SET status = 'idle', session_count = 1, total_input_tokens = ?, total_output_tokens = ?, total_cost_usd = ?, last_active_at = datetime('now') WHERE id = ?")
        .run(pmResult.inputTokens, pmResult.outputTokens, pmCost, pmId);
    } catch (err: any) {
      if (signal.aborted) return;
      addLog(projectId, pmId, 'error', err.message);
      sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `❌ PM 分析失败: ${err.message}` });
      db.prepare("UPDATE agents SET status = 'error' WHERE id = ?").run(pmId);
      db.prepare("UPDATE projects SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(projectId);
      sendToUI(win, 'project:status', { projectId, status: 'error' });
      unregisterOrchestrator(projectId);
      return;
    }

    if (features.length === 0) {
      sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: '⚠️ PM 未能生成有效的 Feature 清单' });
      db.prepare("UPDATE projects SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(projectId);
      unregisterOrchestrator(projectId);
      return;
    }

    // v3.0: PM→Architect 程序化门控
    const pmGate = gatePMToArchitect(features);
    if (!pmGate.passed) {
      sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `🚫 PM→Architect 门控未通过: ${pmGate.reason}` });
      addLog(projectId, pmId, 'error', `Pipeline gate blocked: ${pmGate.reason}`);
      db.prepare("UPDATE projects SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(projectId);
      unregisterOrchestrator(projectId);
      return;
    }

    const insertFeature = db.prepare(`INSERT INTO features (id, project_id, category, priority, title, description, depends_on, status, acceptance_criteria, notes) VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?)`);
    db.transaction((items: any[]) => {
      for (let i = 0; i < items.length; i++) {
        const f = items[i];
        insertFeature.run(f.id || `F${String(i + 1).padStart(3, '0')}`, projectId, f.category || 'core', f.priority ?? 1, f.title || f.description || '', f.description || '', JSON.stringify(f.dependsOn || f.depends_on || []), JSON.stringify(f.acceptanceCriteria || f.acceptance_criteria || []), f.notes || '');
      }
    })(features);

    sendToUI(win, 'project:features-ready', { projectId, count: features.length });
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `📋 生成了 ${features.length} 个 Feature` });
    emitEvent({ projectId, agentId: pmId, type: 'phase:pm:end', data: { featureCount: features.length } });
    createCheckpoint(projectId, `PM 分析完成 (${features.length} Features)`);

    // ═══ Phase 2: Architect — 技术架构设计 ═══
    if (signal.aborted) { unregisterOrchestrator(projectId); return; }
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
      const archBlocks = parseFileBlocks(archResult.content);
      if (archBlocks.length > 0 && workspacePath) {
        writeFileBlocks(workspacePath, archBlocks);
        sendToUI(win, 'agent:log', { projectId, agentId: archId, content: '📐 ARCHITECTURE.md 已写入工作区' });
      } else if (workspacePath) {
        fs.writeFileSync(path.join(workspacePath, 'ARCHITECTURE.md'), archResult.content, 'utf-8');
        sendToUI(win, 'agent:log', { projectId, agentId: archId, content: '📐 ARCHITECTURE.md 已写入工作区 (直接输出)' });
      }
      if (workspacePath) sendToUI(win, 'workspace:changed', { projectId });
      updateAgentStats(archId, projectId, archResult.inputTokens, archResult.outputTokens, archCost);
      db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(archId);
      sendToUI(win, 'agent:log', { projectId, agentId: archId, content: `✅ 架构设计完成 (${archResult.inputTokens + archResult.outputTokens} tokens, $${archCost.toFixed(4)})` });
      emitEvent({ projectId, agentId: archId, type: 'phase:architect:end', data: { tokens: archResult.inputTokens + archResult.outputTokens, cost: archCost }, inputTokens: archResult.inputTokens, outputTokens: archResult.outputTokens, costUsd: archCost });
      createCheckpoint(projectId, '架构设计完成');
    } catch (err: any) {
      if (signal.aborted) { unregisterOrchestrator(projectId); return; }
      sendToUI(win, 'agent:log', { projectId, agentId: archId, content: `⚠️ 架构设计失败 (非致命): ${err.message}` });
      db.prepare("UPDATE agents SET status = 'error' WHERE id = ?").run(archId);
    }
  } else {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '♻️ 续跑模式 — 跳过 PM/Architect，直接进入开发阶段' });
  }

  if (workspacePath) commitWorkspace(workspacePath, 'AgentForge: PM analysis + Architecture design');
  if (workspacePath) ensureAgentsMd(workspacePath, project.wish);

  // v3.0: Architect→Developer 程序化门控
  if (!isResume) {
    const archGate = gateArchitectToDeveloper(workspacePath);
    if (!archGate.passed) {
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `⚠️ Architect→Developer 门控: ${archGate.reason} (继续但可能影响质量)` });
    }
  }

  // ═══ Phase 3: Developer Agents + QA ═══
  if (signal.aborted) { unregisterOrchestrator(projectId); return; }
  db.prepare("UPDATE projects SET status = 'developing', updated_at = datetime('now') WHERE id = ?").run(projectId);
  sendToUI(win, 'project:status', { projectId, status: 'developing' });

  const featureCount = (db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ?").get(projectId) as CountResult).c;
  const workerCount = Math.min(settings.workerCount || 2, featureCount, 6);

  const qaId = `qa-${Date.now().toString(36)}`;
  spawnAgent(projectId, qaId, 'qa', win);
  sendToUI(win, 'agent:log', { projectId, agentId: qaId, content: '🧪 QA 工程师就绪' });
  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ? AND project_id = ?").run(qaId, projectId);

  const project2 = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow;
  const gitConfig: GitProviderConfig = { mode: project2.git_mode || 'local', workspacePath: workspacePath || '', githubRepo: project2.github_repo, githubToken: project2.github_token };

  const workerPromises: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    const workerId = `dev-${i + 1}`;
    spawnAgent(projectId, workerId, 'developer', win);
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = ? AND project_id = ?").run(workerId, projectId);
    workerPromises.push(workerLoop(projectId, workerId, qaId, settings, win, signal, workspacePath, gitConfig));
  }
  await Promise.all(workerPromises);

  // ═══ Phase 4: 完成 ═══
  if (signal.aborted) { unregisterOrchestrator(projectId); return; }
  const stats = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) as passed FROM features WHERE project_id = ?").get(projectId) as { total: number; passed: number };
  const finalStatus = stats.passed === stats.total ? 'delivered' : 'paused';
  db.prepare("UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?").run(finalStatus, projectId);
  sendToUI(win, 'project:status', { projectId, status: finalStatus });
  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `🏁 项目完成! ${stats.passed}/${stats.total} features 通过` });
  db.prepare("UPDATE agents SET status = 'idle' WHERE project_id = ?").run(projectId);
  notify(finalStatus === 'delivered' ? '🎉 项目已交付!' : '⏸️ 项目暂停', `${stats.passed}/${stats.total} features 已完成`);
  if (workspacePath) commitWorkspace(workspacePath, `AgentForge: Delivered ${stats.passed}/${stats.total} features`);
  emitEvent({ projectId, agentId: 'system', type: 'project:complete', data: { status: finalStatus, passed: stats.passed, total: stats.total } });
  createCheckpoint(projectId, `项目${finalStatus === 'delivered' ? '已交付' : '已暂停'} (${stats.passed}/${stats.total})`);

  if (workspacePath && stats.passed > 0) {
    try {
      const extracted = extractFromProjectMemory(workspacePath, project.name);
      if (extracted > 0) sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `🌐 已将 ${extracted} 条经验提取到全局经验池` });
    } catch { /* non-fatal */ }
  }
  unregisterOrchestrator(projectId);
}

// ═══════════════════════════════════════
// Worker 循环
// ═══════════════════════════════════════

async function workerLoop(
  projectId: string, workerId: string, qaId: string, settings: any,
  win: BrowserWindow | null, signal: AbortSignal,
  workspacePath: string | null, gitConfig: GitProviderConfig
) {
  const db = getDb();
  const maxQARetries = 3;

  while (!signal.aborted) {
    const budget = checkBudget(projectId, settings);
    if (!budget.ok) {
      sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `💰 预算已用尽! ($${budget.spent.toFixed(2)} / $${budget.budget}) — 自动暂停` });
      notify('⚠️ AgentForge 预算告警', `已花费 $${budget.spent.toFixed(2)}，超过预算 $${budget.budget}`);
      _stopOrchestrator(projectId);
      break;
    }

    const feature = lockNextFeature(projectId, workerId);
    if (!feature) {
      const inProgress = db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ? AND status IN ('in_progress', 'reviewing')").get(projectId) as CountResult;
      if (inProgress.c > 0) { await sleep(3000); continue; }
      sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: '✅ 没有更多任务，下班了' });
      db.prepare("UPDATE agents SET status = 'idle', current_task = NULL, last_active_at = datetime('now') WHERE id = ? AND project_id = ?").run(workerId, projectId);
      break;
    }

    db.prepare("UPDATE agents SET status = 'working', current_task = ?, last_active_at = datetime('now') WHERE id = ? AND project_id = ?").run(feature.id, workerId, projectId);
    sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: 'in_progress', agentId: workerId });
    sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `🔨 开始: ${feature.id} — ${feature.title || feature.description}` });

    let passed = false;
    let qaFeedback = '';

    for (let qaAttempt = 1; qaAttempt <= maxQARetries && !signal.aborted; qaAttempt++) {
      try {
        const reactResult = await reactDeveloperLoop(projectId, workerId, settings, win, signal, workspacePath, gitConfig, feature, qaFeedback);
        if (!reactResult.completed) {
          sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `⚠️ ${feature.id} ReAct 未完成 (${qaAttempt}/${maxQARetries})` });
          if (qaAttempt >= maxQARetries) break;
          continue;
        }

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
            sendToUI(win, 'agent:log', { projectId, agentId: qaId, content: `✅ ${feature.id} QA 通过! (分数: ${qaResult.score}, $${qaCost.toFixed(4)})` });
            notify('✅ Feature 完成', `${feature.id}: ${(feature.title || '').slice(0, 40)} — QA 分数 ${qaResult.score}`);

            if (qaAttempt > 1 && qaFeedback && workspacePath) {
              try {
                const lessonPrompt = buildLessonExtractionPrompt(feature.id, qaFeedback, reactResult.filesWritten, `QA pass on attempt ${qaAttempt}, score ${qaResult.score}`);
                const lessonModel = resolveModel(selectModelTier({ type: 'lesson_extract' }).tier, settings);
                const lessonResult = await callLLM(settings, lessonModel, [{ role: 'system', content: '你是经验提取助手，只输出经验条目。' }, { role: 'user', content: lessonPrompt }], signal, 1024);
                const lessonCost = calcCost(lessonModel, lessonResult.inputTokens, lessonResult.outputTokens);
                updateAgentStats(qaId, projectId, lessonResult.inputTokens, lessonResult.outputTokens, lessonCost);
                const lessons = lessonResult.content.trim();
                if (lessons) {
                  appendProjectMemory(workspacePath, `### Lessons from ${feature.id} (QA attempt ${qaAttempt})\n${lessons}`);
                  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `📝 经验已记录:\n${lessons.slice(0, 200)}` });
                  addLog(projectId, 'system', 'lesson', `[${feature.id}] ${lessons}`);
                }
              } catch (e: any) {
                sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `⚠️ 经验提取失败: ${e.message}` });
              }
            }
            break;
          } else {
            qaFeedback = qaResult.feedbackText;
            sendToUI(win, 'agent:log', { projectId, agentId: qaId, content: `❌ ${feature.id} QA 未通过 (${qaResult.score}): ${qaResult.summary}` });
            sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `🔄 ${feature.id} 重做 (${qaAttempt}/${maxQARetries})` });
            db.prepare("UPDATE features SET status = 'in_progress' WHERE id = ? AND project_id = ?").run(feature.id, projectId);
          }
        } else {
          passed = true;
          sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `✅ ${feature.id} 完成 (无文件, $${reactResult.totalCost.toFixed(4)})` });
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
    db.prepare("UPDATE features SET status = ?, locked_by = NULL, completed_at = CASE WHEN ? = 'passed' THEN datetime('now') ELSE NULL END WHERE id = ? AND project_id = ?").run(newStatus, newStatus, feature.id, projectId);
    sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: newStatus, agentId: workerId });
    db.prepare("UPDATE agents SET current_task = NULL WHERE id = ? AND project_id = ?").run(workerId, projectId);
    emitEvent({ projectId, agentId: workerId, featureId: feature.id, type: passed ? 'feature:passed' : 'feature:failed', data: { title: feature.title, status: newStatus } });
    const completedCount = (db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ? AND status IN ('passed','failed')").get(projectId) as CountResult).c;
    if (completedCount % 3 === 0) createCheckpoint(projectId, `${completedCount} Features 已处理`);
    if (passed && workspacePath) commitWorkspace(workspacePath, `feat: ${feature.id} — ${(feature.title || '').slice(0, 50)}`);
    await sleep(500);
  }
}

// ═══════════════════════════════════════
// AGENTS.md
// ═══════════════════════════════════════

function ensureAgentsMd(workspacePath: string, wish: string) {
  const agentsDir = path.join(workspacePath, '.agentforge');
  const agentsPath = path.join(agentsDir, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) return;
  fs.mkdirSync(agentsDir, { recursive: true });
  let techInfo = '';
  const archPath = path.join(workspacePath, 'ARCHITECTURE.md');
  if (fs.existsSync(archPath)) techInfo = fs.readFileSync(archPath, 'utf-8').split('\n').slice(0, 30).join('\n');
  const content = `# AGENTS.md — 项目规范\n> 此文件由 AgentForge 自动生成，Agent 和用户均可编辑。\n\n## 项目概述\n${wish.slice(0, 500)}\n\n## 技术栈概要\n${techInfo || '(待补充)'}\n\n## 编码规范\n- 使用项目已有的代码风格\n- 文件组织遵循 ARCHITECTURE.md\n- 所有新文件必须包含必要的 import/export\n- 不要忽略异常\n\n## 常用命令\n- 安装依赖: npm install / pip install -r requirements.txt\n- 编译检查: npx tsc --noEmit\n- 运行测试: npm test / pytest\n\n## 注意事项\n- 修改已有文件用 edit_file，不要 write_file 重写\n- 每个 Feature 完成后调用 task_complete\n`;
  fs.writeFileSync(agentsPath, content, 'utf-8');
}

