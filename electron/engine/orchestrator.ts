/**
 * Orchestrator — Agent 编排引擎 (7 阶段流水线)
 *
 * v4.2 流水线:
 *   Phase 1: PM 需求分析 → Feature 清单
 *   Phase 2: PM 设计文档 → .agentforge/docs/design.md
 *   Phase 3: Architect 技术架构 → ARCHITECTURE.md
 *   Phase 4: PM 子需求拆分 + QA 测试规格 → per-feature docs
 *   Phase 5: Developer 实现 (ReAct parallel) + QA 代码审查
 *   Phase 6: PM 验收审查 (per-feature)
 *   Phase 7: 汇总 + 用户验收等待
 *
 * 演进历程:
 *   v0.3: 4 阶段 (PM → Architect → Dev → QA)
 *   v2.5: 拆分为模块化架构
 *   v4.2: 7 阶段, 文档驱动, PM 验收闭环
 */

import { BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { getDb } from '../db';

// ── 子模块 ──
import { callLLM, calcCost, getSettings, sleep } from './llm-client';
import { sendToUI, addLog, notify, createStreamCallback } from './ui-bridge';
import {
  stopOrchestrator as _stopOrchestrator, registerOrchestrator, unregisterOrchestrator,
  spawnAgent, updateAgentStats, checkBudget, lockNextFeature, getTeamPrompt,
} from './agent-manager';
import { reactDeveloperLoop, getAgentReactStates as _getAgentReactStates, getContextSnapshots as _getContextSnapshots } from './react-loop';
import { runQAReview } from './qa-loop';

// ── 引擎依赖 ──
import type { AppSettings, ProjectRow, FeatureRow, CountResult } from './types';
import {
  PM_SYSTEM_PROMPT, ARCHITECT_SYSTEM_PROMPT,
  PM_DESIGN_DOC_PROMPT, PM_SPLIT_REQS_PROMPT, QA_TEST_SPEC_PROMPT, PM_ACCEPTANCE_PROMPT,
} from './prompts';
import { parseFileBlocks, writeFileBlocks } from './file-writer';
import { parseStructuredOutput, PM_FEATURE_SCHEMA, PM_ACCEPTANCE_SCHEMA } from './output-parser';
import { gatePMToArchitect, gateArchitectToDeveloper } from './guards';
import { commitWorkspace } from './workspace-git';
import { ensureGlobalMemory, ensureProjectMemory, appendProjectMemory, buildLessonExtractionPrompt } from './memory-system';
import { selectModelTier, resolveModel } from './model-selector';
import { emitEvent } from './event-store';
import { createCheckpoint } from './mission';
import { extractFromProjectMemory } from './cross-project';
import { writeDoc, readDoc, buildDesignContext, buildFeatureDocContext, checkConsistency } from './doc-manager';
import type { GitProviderConfig } from './git-provider';

// ═══════════════════════════════════════
// Re-exports (保持向后兼容的 public API)
// ═══════════════════════════════════════

export { stopOrchestrator } from './agent-manager';
export { getAgentReactStates, getContextSnapshots } from './react-loop';
export type { AgentReactState, ReactIterationState, MessageTokenBreakdown } from './react-loop';

// ═══════════════════════════════════════
// Main Orchestrator Entry Point
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
    // ═══════════════════════════════════════
    // Phase 1: PM 需求分析 → Feature 清单
    // ═══════════════════════════════════════
    const features = await phasePMAnalysis(projectId, project, settings, win, signal);
    if (!features || signal.aborted) { unregisterOrchestrator(projectId); return; }

    // ═══════════════════════════════════════
    // Phase 2: PM 设计文档
    // ═══════════════════════════════════════
    if (workspacePath) {
      await phasePMDesignDoc(projectId, project, features, settings, win, signal, workspacePath);
      if (signal.aborted) { unregisterOrchestrator(projectId); return; }
    }

    // ═══════════════════════════════════════
    // Phase 3: Architect 技术架构
    // ═══════════════════════════════════════
    await phaseArchitect(projectId, project, features, settings, win, signal, workspacePath);
    if (signal.aborted) { unregisterOrchestrator(projectId); return; }

    // ═══════════════════════════════════════
    // Phase 4: PM 子需求拆分 + QA 测试规格
    // ═══════════════════════════════════════
    if (workspacePath) {
      await phaseReqsAndTestSpecs(projectId, features, settings, win, signal, workspacePath);
      if (signal.aborted) { unregisterOrchestrator(projectId); return; }
    }
  } else {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '♻️ 续跑模式 — 跳过 PM/Architect, 直接进入开发阶段' });
  }

  if (workspacePath) commitWorkspace(workspacePath, 'AgentForge: PM analysis + Architecture + Docs');
  if (workspacePath) ensureAgentsMd(workspacePath, project.wish);

  // v3.0: Architect→Developer 程序化门控
  if (!isResume) {
    const archGate = gateArchitectToDeveloper(workspacePath);
    if (!archGate.passed) {
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `⚠️ Architect→Developer 门控: ${archGate.reason} (继续但可能影响质量)` });
    }
  }

  // ═══════════════════════════════════════
  // Phase 5: Developer 实现 + QA 代码审查
  // ═══════════════════════════════════════
  if (signal.aborted) { unregisterOrchestrator(projectId); return; }
  db.prepare("UPDATE projects SET status = 'developing', updated_at = datetime('now') WHERE id = ?").run(projectId);
  sendToUI(win, 'project:status', { projectId, status: 'developing' });

  const featureCount = (db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ?").get(projectId) as CountResult).c;
  const maxWorkers = settings.workerCount > 0 ? settings.workerCount : featureCount;
  const workerCount = Math.min(maxWorkers, featureCount);

  const qaId = `qa-${Date.now().toString(36)}`;
  spawnAgent(projectId, qaId, 'qa', win);
  sendToUI(win, 'agent:log', { projectId, agentId: qaId, content: '🧪 QA 工程师就绪' });
  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ? AND project_id = ?").run(qaId, projectId);

  const project2 = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow;
  const gitConfig: GitProviderConfig = {
    mode: project2.git_mode || 'local',
    workspacePath: workspacePath || '',
    githubRepo: project2.github_repo,
    githubToken: project2.github_token,
  };

  const workerPromises: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    const workerId = `dev-${i + 1}`;
    spawnAgent(projectId, workerId, 'developer', win);
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = ? AND project_id = ?").run(workerId, projectId);
    workerPromises.push(workerLoop(projectId, workerId, qaId, settings, win, signal, workspacePath, gitConfig));
  }
  await Promise.all(workerPromises);

  if (signal.aborted) { unregisterOrchestrator(projectId); return; }

  // ═══════════════════════════════════════
  // Phase 6: PM 验收审查 (per-feature)
  // ═══════════════════════════════════════
  if (workspacePath) {
    await phasePMAcceptance(projectId, settings, win, signal, workspacePath);
    if (signal.aborted) { unregisterOrchestrator(projectId); return; }
  }

  // ═══════════════════════════════════════
  // Phase 7: 汇总 + 用户验收等待
  // ═══════════════════════════════════════
  await phaseFinalize(projectId, settings, win, signal, workspacePath, project.name);

  unregisterOrchestrator(projectId);
}

// ═══════════════════════════════════════
// Phase 1: PM 需求分析
// ═══════════════════════════════════════

async function phasePMAnalysis(
  projectId: string, project: ProjectRow, settings: AppSettings,
  win: BrowserWindow | null, signal: AbortSignal,
): Promise<any[] | null> {
  const db = getDb();
  const pmId = `pm-${Date.now().toString(36)}`;
  spawnAgent(projectId, pmId, 'pm', win);
  sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: '🧠 Phase 1: 产品经理开始分析需求...' });
  addLog(projectId, pmId, 'log', '开始分析需求: ' + project.wish);
  db.prepare("UPDATE projects SET status = 'initializing', updated_at = datetime('now') WHERE id = ?").run(projectId);
  sendToUI(win, 'project:status', { projectId, status: 'initializing' });

  let features: any[] = [];
  try {
    if (signal.aborted) return null;
    const [onChunk] = createStreamCallback(win, projectId, pmId);
    sendToUI(win, 'agent:stream-start', { projectId, agentId: pmId, label: 'PM 需求分析' });
    const pmPrompt = getTeamPrompt(projectId, 'pm') ?? PM_SYSTEM_PROMPT;
    const pmResult = await callLLM(settings, settings.strongModel, [
      { role: 'system', content: pmPrompt },
      { role: 'user', content: `用户需求:\n${project.wish}\n\n请分析此需求，拆解为 Feature 清单。直接输出 JSON 数组，不要用 markdown 代码块包裹。` },
    ], signal, 16384, 2, onChunk);
    sendToUI(win, 'agent:stream-end', { projectId, agentId: pmId });

    const pmCost = calcCost(settings.strongModel, pmResult.inputTokens, pmResult.outputTokens);
    addLog(projectId, pmId, 'output', pmResult.content);
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `✅ PM 分析完成 (${pmResult.inputTokens + pmResult.outputTokens} tokens, $${pmCost.toFixed(4)})` });

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
    if (signal.aborted) return null;
    addLog(projectId, pmId, 'error', err.message);
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `❌ PM 分析失败: ${err.message}` });
    db.prepare("UPDATE agents SET status = 'error' WHERE id = ?").run(pmId);
    db.prepare("UPDATE projects SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(projectId);
    sendToUI(win, 'project:status', { projectId, status: 'error' });
    return null;
  }

  if (features.length === 0) {
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: '⚠️ PM 未能生成有效的 Feature 清单' });
    db.prepare("UPDATE projects SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(projectId);
    return null;
  }

  // v3.0: PM→Architect 程序化门控
  const pmGate = gatePMToArchitect(features);
  if (!pmGate.passed) {
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `🚫 PM→Architect 门控未通过: ${pmGate.reason}` });
    addLog(projectId, pmId, 'error', `Pipeline gate blocked: ${pmGate.reason}`);
    db.prepare("UPDATE projects SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(projectId);
    return null;
  }

  // 写入 DB
  const insertFeature = db.prepare(`INSERT INTO features (id, project_id, category, priority, group_name, sub_group, title, description, depends_on, status, acceptance_criteria, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?)`);
  db.transaction((items: any[]) => {
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      insertFeature.run(
        f.id || `F${String(i + 1).padStart(3, '0')}`, projectId,
        f.category || 'core', f.priority ?? 1,
        f.group_name || f.category || '', f.sub_group || '',
        f.title || f.description || '', f.description || '',
        JSON.stringify(f.dependsOn || f.depends_on || []),
        JSON.stringify(f.acceptanceCriteria || f.acceptance_criteria || []),
        f.notes || '',
      );
    }
  })(features);

  sendToUI(win, 'project:features-ready', { projectId, count: features.length });
  sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `📋 生成了 ${features.length} 个 Feature` });
  emitEvent({ projectId, agentId: pmId, type: 'phase:pm:end', data: { featureCount: features.length } });
  createCheckpoint(projectId, `PM 分析完成 (${features.length} Features)`);

  return features;
}

// ═══════════════════════════════════════
// Phase 2: PM 设计文档
// ═══════════════════════════════════════

async function phasePMDesignDoc(
  projectId: string, project: ProjectRow, features: any[], settings: AppSettings,
  win: BrowserWindow | null, signal: AbortSignal, workspacePath: string,
): Promise<void> {
  const pmId = `pm-design-${Date.now().toString(36)}`;
  spawnAgent(projectId, pmId, 'pm', win);
  sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: '📐 Phase 2: 编写产品设计文档...' });

  try {
    const featureSummary = features.map(f =>
      `- ${f.id}: [${f.category}] ${f.title || f.description} (priority: ${f.priority})\n  验收: ${JSON.stringify(f.acceptance_criteria || f.acceptanceCriteria || [])}`
    ).join('\n');

    const [onChunk] = createStreamCallback(win, projectId, pmId);
    sendToUI(win, 'agent:stream-start', { projectId, agentId: pmId, label: 'PM 设计文档' });

    const designPrompt = getTeamPrompt(projectId, 'pm') ? null : PM_DESIGN_DOC_PROMPT;
    const result = await callLLM(settings, settings.strongModel, [
      { role: 'system', content: designPrompt ?? PM_DESIGN_DOC_PROMPT },
      { role: 'user', content: `用户需求:\n${project.wish}\n\nFeature 清单 (${features.length} 个):\n${featureSummary}\n\n请编写产品设计文档。` },
    ], signal, 16384, 2, onChunk);
    sendToUI(win, 'agent:stream-end', { projectId, agentId: pmId });

    const cost = calcCost(settings.strongModel, result.inputTokens, result.outputTokens);
    updateAgentStats(pmId, projectId, result.inputTokens, result.outputTokens, cost);

    // 写入 .agentforge/docs/design.md
    const version = writeDoc(workspacePath, 'design', result.content, pmId, '初始版本: PM 生成设计文档');
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `✅ 设计文档已写入 (v${version}, ${result.content.length} chars, $${cost.toFixed(4)})` });
    addLog(projectId, pmId, 'output', `设计文档 v${version}: ${result.content.slice(0, 2000)}`);

    emitEvent({ projectId, agentId: pmId, type: 'phase:design-doc:end', data: { version, chars: result.content.length } });
    createCheckpoint(projectId, '设计文档完成');
  } catch (err: any) {
    if (signal.aborted) return;
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `⚠️ 设计文档生成失败 (非致命): ${err.message}` });
    addLog(projectId, pmId, 'error', err.message);
  }

  const db = getDb();
  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(pmId);
}

// ═══════════════════════════════════════
// Phase 3: Architect 技术架构
// ═══════════════════════════════════════

async function phaseArchitect(
  projectId: string, project: ProjectRow, features: any[], settings: AppSettings,
  win: BrowserWindow | null, signal: AbortSignal, workspacePath: string | null,
): Promise<void> {
  if (signal.aborted) return;

  const db = getDb();
  const archId = `arch-${Date.now().toString(36)}`;
  spawnAgent(projectId, archId, 'architect', win);
  sendToUI(win, 'agent:log', { projectId, agentId: archId, content: '🏗️ Phase 3: 架构师开始设计技术方案...' });
  addLog(projectId, archId, 'log', '开始架构设计');

  try {
    const featureSummary = features.map(f => `- ${f.id}: ${f.title || f.description}`).join('\n');

    // 如果有设计文档, 注入为上下文
    const designContext = workspacePath ? buildDesignContext(workspacePath, 4000) : '';

    const [onChunk] = createStreamCallback(win, projectId, archId);
    sendToUI(win, 'agent:stream-start', { projectId, agentId: archId, label: '架构设计' });
    const archPrompt = getTeamPrompt(projectId, 'architect') ?? ARCHITECT_SYSTEM_PROMPT;
    const archResult = await callLLM(settings, settings.strongModel, [
      { role: 'system', content: archPrompt },
      { role: 'user', content: `用户需求:\n${project.wish}\n\nFeature 清单:\n${featureSummary}\n\n${designContext ? `## 产品设计文档摘要\n${designContext}\n\n` : ''}请设计项目技术架构，输出 ARCHITECTURE.md 文件。` },
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
    if (signal.aborted) return;
    sendToUI(win, 'agent:log', { projectId, agentId: archId, content: `⚠️ 架构设计失败 (非致命): ${err.message}` });
    db.prepare("UPDATE agents SET status = 'error' WHERE id = ?").run(archId);
  }
}

// ═══════════════════════════════════════
// Phase 4: PM 子需求拆分 + QA 测试规格
// ═══════════════════════════════════════

async function phaseReqsAndTestSpecs(
  projectId: string, features: any[], settings: AppSettings,
  win: BrowserWindow | null, signal: AbortSignal, workspacePath: string,
): Promise<void> {
  const db = getDb();
  const designContext = buildDesignContext(workspacePath, 4000);

  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `📋 Phase 4: 为 ${features.length} 个 Feature 生成子需求和测试规格...` });

  for (const feature of features) {
    if (signal.aborted) return;

    const featureId = feature.id || `F${features.indexOf(feature) + 1}`;

    // ── 4a: PM 子需求文档 ──
    try {
      const pmReqId = `pm-req-${Date.now().toString(36)}`;
      const reqResult = await callLLM(settings, settings.strongModel, [
        { role: 'system', content: PM_SPLIT_REQS_PROMPT },
        {
          role: 'user',
          content: `## 设计文档上下文\n${designContext}\n\n## Feature 信息\nID: ${featureId}\n标题: ${feature.title || feature.description}\n描述: ${feature.description}\n验收标准: ${JSON.stringify(feature.acceptance_criteria || feature.acceptanceCriteria || [])}\n依赖: ${JSON.stringify(feature.dependsOn || feature.depends_on || [])}\n备注: ${feature.notes || '无'}\n\n请编写此 Feature 的详细子需求文档。`,
        },
      ], signal, 8192);

      const reqCost = calcCost(settings.strongModel, reqResult.inputTokens, reqResult.outputTokens);
      const reqVer = writeDoc(workspacePath, 'requirement', reqResult.content, pmReqId, `${featureId} 初始子需求`, featureId);

      db.prepare("UPDATE features SET requirement_doc_ver = ? WHERE id = ? AND project_id = ?")
        .run(reqVer, featureId, projectId);

      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  📄 ${featureId} 子需求文档 v${reqVer} ($${reqCost.toFixed(4)})` });
    } catch (err: any) {
      if (signal.aborted) return;
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ⚠️ ${featureId} 子需求生成失败: ${err.message}` });
    }

    // ── 4b: QA 测试规格 ──
    try {
      const reqContent = readDoc(workspacePath, 'requirement', featureId);
      if (!reqContent) {
        sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ⚠️ ${featureId} 跳过测试规格 (无子需求文档)` });
        continue;
      }

      const qaSpecId = `qa-spec-${Date.now().toString(36)}`;
      const specResult = await callLLM(settings, settings.strongModel, [
        { role: 'system', content: QA_TEST_SPEC_PROMPT },
        {
          role: 'user',
          content: `## 子需求文档\n${reqContent}\n\n请为此 Feature 编写功能测试规格文档。`,
        },
      ], signal, 8192);

      const specCost = calcCost(settings.strongModel, specResult.inputTokens, specResult.outputTokens);
      const specVer = writeDoc(workspacePath, 'test_spec', specResult.content, qaSpecId, `${featureId} 初始测试规格`, featureId);

      db.prepare("UPDATE features SET test_spec_doc_ver = ? WHERE id = ? AND project_id = ?")
        .run(specVer, featureId, projectId);

      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  🧪 ${featureId} 测试规格 v${specVer} ($${specCost.toFixed(4)})` });
    } catch (err: any) {
      if (signal.aborted) return;
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ⚠️ ${featureId} 测试规格生成失败: ${err.message}` });
    }

    // 每 5 个 Feature 做一个 checkpoint
    const idx = features.indexOf(feature);
    if ((idx + 1) % 5 === 0) {
      createCheckpoint(projectId, `Phase 4: ${idx + 1}/${features.length} Feature 文档已生成`);
    }
  }

  // 一致性检查
  const featureIds = features.map((f: any, i: number) => f.id || `F${String(i + 1).padStart(3, '0')}`);
  const consistency = checkConsistency(workspacePath, featureIds);
  if (!consistency.ok) {
    const issueList = consistency.issues.map(i => `  - [${i.severity}] ${i.description}`).join('\n');
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `⚠️ 文档一致性检查:\n${issueList}` });
  } else {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `✅ 文档一致性检查通过 (${featureIds.length} features)` });
  }

  emitEvent({ projectId, agentId: 'system', type: 'phase:docs:end', data: { featureCount: features.length } });
  createCheckpoint(projectId, `Phase 4 完成: ${features.length} Feature 文档已生成`);
}

// ═══════════════════════════════════════
// Phase 5: Worker Loop (Dev + QA per feature)
// ═══════════════════════════════════════

async function workerLoop(
  projectId: string, workerId: string, qaId: string, settings: AppSettings,
  win: BrowserWindow | null, signal: AbortSignal,
  workspacePath: string | null, gitConfig: GitProviderConfig,
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

    db.prepare("UPDATE agents SET status = 'working', current_task = ?, last_active_at = datetime('now') WHERE id = ? AND project_id = ?")
      .run(feature.id, workerId, projectId);
    sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: 'in_progress', agentId: workerId });
    sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `🔨 开始: ${feature.id} — ${feature.title || feature.description}` });

    // v4.2: 如果有子需求和测试规格, 注入到 feature 对象供 react-loop 使用
    if (workspacePath) {
      const docContext = buildFeatureDocContext(workspacePath, feature.id);
      if (docContext) {
        feature._docContext = docContext;
      }
    }

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

          const qaResult = await runQAReview(settings, signal, feature, reactResult.filesWritten, workspacePath, projectId);
          const qaCost = calcCost(settings.strongModel, qaResult.inputTokens, qaResult.outputTokens);
          updateAgentStats(qaId, projectId, qaResult.inputTokens, qaResult.outputTokens, qaCost);
          db.prepare("UPDATE agents SET current_task = NULL WHERE id = ? AND project_id = ?").run(qaId, projectId);

          if (qaResult.verdict === 'pass') {
            passed = true;
            sendToUI(win, 'agent:log', { projectId, agentId: qaId, content: `✅ ${feature.id} QA 通过! (分数: ${qaResult.score}, $${qaCost.toFixed(4)})` });
            notify('✅ Feature 完成', `${feature.id}: ${(feature.title || '').slice(0, 40)} — QA 分数 ${qaResult.score}`);

            if (qaAttempt > 1 && qaFeedback && workspacePath) {
              await extractLessons(projectId, qaId, feature, qaFeedback, reactResult.filesWritten, qaResult.score, qaAttempt, settings, signal, workspacePath);
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

    // QA pass → 进入 pm_pending 状态 (等 Phase 6 PM 验收); QA fail → 直接 failed
    const newStatus = passed ? 'qa_passed' : 'failed';
    db.prepare("UPDATE features SET status = ?, locked_by = NULL WHERE id = ? AND project_id = ?")
      .run(newStatus, feature.id, projectId);
    sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: newStatus, agentId: workerId });
    db.prepare("UPDATE agents SET current_task = NULL WHERE id = ? AND project_id = ?").run(workerId, projectId);
    emitEvent({ projectId, agentId: workerId, featureId: feature.id, type: passed ? 'feature:qa_passed' : 'feature:failed', data: { title: feature.title, status: newStatus } });

    const completedCount = (db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ? AND status IN ('qa_passed','passed','failed')").get(projectId) as CountResult).c;
    if (completedCount % 3 === 0) createCheckpoint(projectId, `${completedCount} Features 已处理`);
    if (passed && workspacePath) commitWorkspace(workspacePath, `feat: ${feature.id} — ${(feature.title || '').slice(0, 50)}`);
    await sleep(500);
  }
}

// ═══════════════════════════════════════
// Phase 6: PM 验收审查
// ═══════════════════════════════════════

async function phasePMAcceptance(
  projectId: string, settings: AppSettings,
  win: BrowserWindow | null, signal: AbortSignal, workspacePath: string,
): Promise<void> {
  const db = getDb();

  // 获取所有通过 QA 的 Feature
  const qaPassed = db.prepare("SELECT * FROM features WHERE project_id = ? AND status = 'qa_passed'")
    .all(projectId) as FeatureRow[];

  if (qaPassed.length === 0) {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '⏭️ Phase 6: 没有 Feature 需要 PM 验收' });
    return;
  }

  const pmAccId = `pm-acc-${Date.now().toString(36)}`;
  spawnAgent(projectId, pmAccId, 'pm', win);
  sendToUI(win, 'agent:log', { projectId, agentId: pmAccId, content: `📋 Phase 6: PM 验收审查 (${qaPassed.length} features)...` });

  const designContext = buildDesignContext(workspacePath, 6000);

  for (const feature of qaPassed) {
    if (signal.aborted) return;

    try {
      // 读取该 Feature 的文档上下文 + 实现的文件列表
      const featureDocCtx = buildFeatureDocContext(workspacePath, feature.id);
      const affectedFiles = safeJsonParse(feature.affected_files, []);
      let filePreview = '';
      for (const fp of affectedFiles.slice(0, 5)) {
        const fullPath = path.join(workspacePath, fp);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          filePreview += `### ${fp}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\`\n\n`;
        }
      }

      const acceptResult = await callLLM(settings, settings.strongModel, [
        { role: 'system', content: PM_ACCEPTANCE_PROMPT },
        {
          role: 'user',
          content: [
            `## 设计文档上下文\n${designContext}`,
            featureDocCtx ? `\n## Feature 文档\n${featureDocCtx}` : '',
            `\n## Feature 基本信息\nID: ${feature.id}\n标题: ${feature.title}\n描述: ${feature.description}\n验收标准: ${feature.acceptance_criteria}`,
            filePreview ? `\n## 实现代码预览\n${filePreview}` : '',
            `\n请对此 Feature 的实现进行产品验收审查。输出 JSON。`,
          ].filter(Boolean).join('\n'),
        },
      ], signal, 4096);

      const accCost = calcCost(settings.strongModel, acceptResult.inputTokens, acceptResult.outputTokens);
      updateAgentStats(pmAccId, projectId, acceptResult.inputTokens, acceptResult.outputTokens, accCost);

      const parseResult = parseStructuredOutput(acceptResult.content, PM_ACCEPTANCE_SCHEMA);
      let verdict = 'reject';
      let score = 0;
      let feedback = '';
      let summary = '';

      if (parseResult.ok) {
        verdict = parseResult.data.verdict;
        score = parseResult.data.score;
        feedback = parseResult.data.feedback || '';
        summary = parseResult.data.summary || '';
      } else {
        summary = `PM 验收输出解析失败: ${parseResult.error}`;
        addLog(projectId, pmAccId, 'error', summary);
      }

      // 更新 Feature 状态
      const finalStatus = verdict === 'accept' || verdict === 'conditional_accept' ? 'passed' : 'pm_rejected';
      db.prepare("UPDATE features SET status = ?, pm_verdict = ?, pm_verdict_score = ?, pm_verdict_feedback = ?, completed_at = CASE WHEN ? IN ('passed') THEN datetime('now') ELSE NULL END WHERE id = ? AND project_id = ?")
        .run(finalStatus, verdict, score, feedback, finalStatus, feature.id, projectId);

      const icon = verdict === 'accept' ? '✅' : verdict === 'conditional_accept' ? '⚠️' : '❌';
      sendToUI(win, 'agent:log', { projectId, agentId: pmAccId, content: `${icon} ${feature.id} PM 验收: ${verdict} (${score}/100) — ${summary}` });
      sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: finalStatus, agentId: pmAccId });

      if (verdict === 'reject' && feedback) {
        sendToUI(win, 'agent:log', { projectId, agentId: pmAccId, content: `  💬 反馈: ${feedback.slice(0, 300)}` });
      }
    } catch (err: any) {
      if (signal.aborted) return;
      // PM 验收失败 → 视为 conditional_accept (不阻断)
      sendToUI(win, 'agent:log', { projectId, agentId: pmAccId, content: `⚠️ ${feature.id} PM 验收出错 (视为通过): ${err.message}` });
      db.prepare("UPDATE features SET status = 'passed', pm_verdict = 'conditional_accept', pm_verdict_feedback = ?, completed_at = datetime('now') WHERE id = ? AND project_id = ?")
        .run(`PM 验收异常: ${err.message}`, feature.id, projectId);
      sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: 'passed', agentId: pmAccId });
    }
  }

  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(pmAccId);
  emitEvent({ projectId, agentId: pmAccId, type: 'phase:pm-acceptance:end', data: { reviewed: qaPassed.length } });
  createCheckpoint(projectId, `PM 验收完成 (${qaPassed.length} features)`);
}

// ═══════════════════════════════════════
// Phase 7: 汇总 + 用户验收等待
// ═══════════════════════════════════════

async function phaseFinalize(
  projectId: string, settings: AppSettings,
  win: BrowserWindow | null, signal: AbortSignal,
  workspacePath: string | null, projectName: string,
): Promise<void> {
  if (signal.aborted) return;

  const db = getDb();
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'pm_rejected' THEN 1 ELSE 0 END) as pm_rejected
    FROM features WHERE project_id = ?
  `).get(projectId) as { total: number; passed: number; failed: number; pm_rejected: number };

  const allPassed = stats.passed === stats.total;
  const finalStatus = allPassed ? 'awaiting_user_acceptance' : 'paused';

  db.prepare("UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?").run(finalStatus, projectId);
  sendToUI(win, 'project:status', { projectId, status: finalStatus });

  const summary = [
    `🏁 Phase 7: 项目汇总`,
    `  ✅ 通过: ${stats.passed}/${stats.total}`,
    stats.failed > 0 ? `  ❌ QA 失败: ${stats.failed}` : null,
    stats.pm_rejected > 0 ? `  🚫 PM 驳回: ${stats.pm_rejected}` : null,
    allPassed ? `  📬 等待用户最终验收` : `  ⏸️ 部分 Feature 未通过, 项目暂停`,
  ].filter(Boolean).join('\n');

  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: summary });
  db.prepare("UPDATE agents SET status = 'idle' WHERE project_id = ?").run(projectId);

  if (allPassed) {
    notify('📬 等待用户验收', `所有 ${stats.total} 个 Feature 已通过 PM 和 QA 审查`);
    sendToUI(win, 'project:awaiting-acceptance', { projectId, stats });
  } else {
    notify(
      stats.passed > 0 ? '⏸️ 项目部分完成' : '❌ 项目暂停',
      `${stats.passed}/${stats.total} features 通过`,
    );
  }

  if (workspacePath) commitWorkspace(workspacePath, `AgentForge: ${stats.passed}/${stats.total} features delivered`);

  emitEvent({
    projectId, agentId: 'system', type: 'project:complete',
    data: { status: finalStatus, passed: stats.passed, failed: stats.failed, pmRejected: stats.pm_rejected, total: stats.total },
  });
  createCheckpoint(projectId, `项目${allPassed ? '等待验收' : '暂停'} (${stats.passed}/${stats.total})`);

  // 提取跨项目经验
  if (workspacePath && stats.passed > 0) {
    try {
      const extracted = extractFromProjectMemory(workspacePath, projectName);
      if (extracted > 0) {
        sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `🌐 已将 ${extracted} 条经验提取到全局经验池` });
      }
    } catch { /* non-fatal */ }
  }
}

// ═══════════════════════════════════════
// Lesson Extraction Helper
// ═══════════════════════════════════════

async function extractLessons(
  projectId: string, qaId: string, feature: any, qaFeedback: string,
  filesWritten: string[], qaScore: number, qaAttempt: number,
  settings: AppSettings, signal: AbortSignal, workspacePath: string,
): Promise<void> {
  try {
    const lessonPrompt = buildLessonExtractionPrompt(feature.id, qaFeedback, filesWritten, `QA pass on attempt ${qaAttempt}, score ${qaScore}`);
    const lessonModel = resolveModel(selectModelTier({ type: 'lesson_extract' }).tier, settings);
    const lessonResult = await callLLM(settings, lessonModel, [
      { role: 'system', content: '你是经验提取助手，只输出经验条目。' },
      { role: 'user', content: lessonPrompt },
    ], signal, 1024);

    const lessonCost = calcCost(lessonModel, lessonResult.inputTokens, lessonResult.outputTokens);
    updateAgentStats(qaId, projectId, lessonResult.inputTokens, lessonResult.outputTokens, lessonCost);

    const lessons = lessonResult.content.trim();
    if (lessons) {
      appendProjectMemory(workspacePath, `### Lessons from ${feature.id} (QA attempt ${qaAttempt})\n${lessons}`);
      sendToUI(null, 'agent:log', { projectId, agentId: 'system', content: `📝 经验已记录:\n${lessons.slice(0, 200)}` });
      addLog(projectId, 'system', 'lesson', `[${feature.id}] ${lessons}`);
    }
  } catch (e: any) {
    sendToUI(null, 'agent:log', { projectId, agentId: 'system', content: `⚠️ 经验提取失败: ${e.message}` });
  }
}

// ═══════════════════════════════════════
// Utility Helpers
// ═══════════════════════════════════════

function safeJsonParse(str: string | null | undefined, fallback: any): any {
  if (!str) return fallback;
  try { return JSON.parse(str); }
  catch { return fallback; }
}

function ensureAgentsMd(workspacePath: string, wish: string) {
  const agentsDir = path.join(workspacePath, '.agentforge');
  const agentsPath = path.join(agentsDir, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) return;
  fs.mkdirSync(agentsDir, { recursive: true });

  let techInfo = '';
  const archPath = path.join(workspacePath, 'ARCHITECTURE.md');
  if (fs.existsSync(archPath)) {
    techInfo = fs.readFileSync(archPath, 'utf-8').split('\n').slice(0, 30).join('\n');
  }

  const content = [
    `# AGENTS.md — 项目规范`,
    `> 此文件由 AgentForge 自动生成，Agent 和用户均可编辑。`,
    ``,
    `## 项目概述`,
    wish.slice(0, 500),
    ``,
    `## 技术栈概要`,
    techInfo || '(待补充)',
    ``,
    `## 编码规范`,
    `- 使用项目已有的代码风格`,
    `- 文件组织遵循 ARCHITECTURE.md`,
    `- 所有新文件必须包含必要的 import/export`,
    `- 不要忽略异常`,
    ``,
    `## 常用命令`,
    `- 安装依赖: npm install / pip install -r requirements.txt`,
    `- 编译检查: npx tsc --noEmit`,
    `- 运行测试: npm test / pytest`,
    ``,
    `## 注意事项`,
    `- 修改已有文件用 edit_file，不要 write_file 重写`,
    `- 每个 Feature 完成后调用 task_complete`,
    ``,
  ].join('\n');

  fs.writeFileSync(agentsPath, content, 'utf-8');
}