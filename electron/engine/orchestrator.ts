/**
 * Orchestrator — Agent 编排引擎 (5 阶段流水线)
 *
 * v5.0 流水线 (扁平化重构):
 *   Phase 1: PM 需求分析 → Feature 清单
 *   Phase 2: Architect 架构 + 产品设计 → ARCHITECTURE.md + design.md (合并原 P2+P3)
 *   Phase 3: 批量子需求拆分 + 测试规格 (批量化, 原 P4)
 *   Phase 4: Developer 实现 (ReAct, 内嵌 planning) + QA 审查 + PM 批量验收
 *   Phase 5: 汇总 + 用户验收等待
 *
 * 演进历程:
 *   v0.3: 4 阶段 (PM → Architect → Dev → QA)
 *   v2.5: 拆分为模块化架构
 *   v4.2: 7 阶段, 文档驱动, PM 验收闭环
 *   v5.0: 5 阶段, 批量化文档生成和验收, 移除独立 Planning, 移除 tech_lead
 */

import { BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { getDb } from '../db';
import { createLogger } from './logger';

const log = createLogger('orchestrator');

// ── 子模块 ──
import { callLLM, calcCost, getSettings, sleep, validateModel, NonRetryableError } from './llm-client';
import { sendToUI, addLog, notify, createStreamCallback } from './ui-bridge';
import {
  stopOrchestrator as _stopOrchestrator, registerOrchestrator, unregisterOrchestrator,
  isOrchestratorRunning,
  spawnAgent, updateAgentStats, checkBudget, lockNextFeature, getTeamPrompt,
} from './agent-manager';
import { reactDeveloperLoop, reactAgentLoop, getAgentReactStates as _getAgentReactStates, getContextSnapshots as _getContextSnapshots } from './react-loop';
import type { GenericReactResult } from './react-loop';
import { runQAReview, generateTestSkeleton } from './qa-loop';

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
import { detectImplicitChanges, runChangeRequest, type WishTriageResult } from './change-manager';
import { claimFiles, releaseFiles, getClaimsSummary, predictAffectedFiles, cleanupDecisionLog } from './decision-log';
import { incrementalUpdate, scanProjectSkeleton, type ProjectSkeleton } from './project-importer';
import type { GitProviderConfig } from './git-provider';

// ═══════════════════════════════════════
// Re-exports (保持向后兼容的 public API)
// ═══════════════════════════════════════

export { stopOrchestrator } from './agent-manager';
export { getAgentReactStates, getContextSnapshots } from './react-loop';
export type { AgentReactState, ReactIterationState, MessageTokenBreakdown, GenericReactConfig, GenericReactResult } from './react-loop';

// ═══════════════════════════════════════
// Main Orchestrator Entry Point
// ═══════════════════════════════════════

export async function runOrchestrator(projectId: string, win: BrowserWindow | null) {
  // ── v5.6: 防重入 — 如果已有编排流在跑，拒绝第二次调用 ──
  if (isOrchestratorRunning(projectId)) {
    log.warn(`Orchestrator already running for ${projectId}, ignoring duplicate call`);
    sendToUI(win, 'agent:log', {
      projectId, agentId: 'system',
      content: '⚠️ 编排器已在运行中，忽略重复启动请求',
    });
    return;
  }

  const abortCtrl = new AbortController();
  registerOrchestrator(projectId, abortCtrl);
  const signal = abortCtrl.signal;

  const db = getDb();
  const settings = getSettings();

  if (!settings || !settings.apiKey) {
    sendToUI(win, 'agent:error', { projectId, error: '请先在设置中配置 LLM API Key' });
    unregisterOrchestrator(projectId);
    return;
  }

  // ── v5.6: Pre-flight 模型可用性预检 ──
  {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '🔍 预检: 验证 LLM 模型可用性...' });
    const modelsToCheck = [...new Set([settings.strongModel, settings.workerModel, settings.fastModel].filter((m): m is string => Boolean(m)))];
    const errors: string[] = [];
    for (const m of modelsToCheck) {
      const err = await validateModel(settings, m!);
      if (err) errors.push(err);
    }
    if (errors.length > 0) {
      const errMsg = `模型预检失败，请在设置中修正:\n${errors.join('\n')}`;
      sendToUI(win, 'agent:error', { projectId, error: errMsg });
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `❌ ${errMsg}` });
      db.prepare("UPDATE projects SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(projectId);
      sendToUI(win, 'project:status', { projectId, status: 'paused' });
      unregisterOrchestrator(projectId);
      return;
    }
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `✅ 预检通过: ${modelsToCheck.join(', ')}` });
  }

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
  if (!project) {
    sendToUI(win, 'agent:error', { projectId, error: '项目不存在' });
    unregisterOrchestrator(projectId);
    return;
  }

  const workspacePath = project.workspace_path;
  if (workspacePath) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  ensureGlobalMemory();
  if (workspacePath) ensureProjectMemory(workspacePath);
  if (workspacePath) cleanupDecisionLog(workspacePath); // v5.5: 清理过期决策日志

  emitEvent({
    projectId, agentId: 'system', type: 'project:start',
    data: { wish: project.wish, name: project.name, workspace: workspacePath },
  });

  const existingFeatures = db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ?").get(projectId) as CountResult;
  const isResume = existingFeatures.c > 0;

  if (!isResume) {
    // ═══════════════════════════════════════
    // 首次运行: 完整的 5 阶段流水线 (v5.0)
    // ═══════════════════════════════════════
    const features = await phasePMAnalysis(projectId, project, settings, win, signal);
    if (!features || signal.aborted) { unregisterOrchestrator(projectId); return; }

    // v5.0: Phase 2 设计文档已合并到 Phase 3 架构设计, 不再独立调用

    await phaseArchitect(projectId, project, features, settings, win, signal, workspacePath);
    if (signal.aborted) { unregisterOrchestrator(projectId); return; }

    if (workspacePath) {
      await phaseReqsAndTestSpecs(projectId, features, settings, win, signal, workspacePath);
      if (signal.aborted) { unregisterOrchestrator(projectId); return; }
    }
  } else {
    // ═══════════════════════════════════════
    // Phase 0: PM 需求分诊 (Wish Triage) — 由 PM 执行, 非元 Agent
    // ═══════════════════════════════════════

    // ── v5.6: Circuit Breaker — 检查上次失败原因是否仍然存在 ──
    {
      const failedFeatures = db.prepare(
        "SELECT id, last_error, last_error_at FROM features WHERE project_id = ? AND status = 'failed' AND last_error IS NOT NULL"
      ).all(projectId) as Array<{ id: string; last_error: string; last_error_at: string }>;

      if (failedFeatures.length > 0) {
        // 检查是否全部都是不可重试错误
        const nonRetryable = failedFeatures.filter(f => f.last_error?.includes('[NonRetryable:'));
        if (nonRetryable.length === failedFeatures.length) {
          // 所有失败的 Feature 都是不可重试错误 → 不要盲目重跑
          const sampleError = nonRetryable[0].last_error;
          sendToUI(win, 'agent:log', {
            projectId, agentId: 'system',
            content: `🔴 Circuit Breaker: ${nonRetryable.length} 个 Feature 因不可重试错误失败 (如模型不可用、API Key 无效)。\n示例: ${sampleError}\n请在设置中修正后重新启动。`,
          });
          sendToUI(win, 'agent:error', {
            projectId,
            error: `所有 ${nonRetryable.length} 个失败的 Feature 都是配置类错误。请检查 LLM 设置后重试。`,
          });
          notify('🔴 AgentForge 需要修改配置', `${nonRetryable.length} 个 Feature 因模型/配置错误无法继续`);
          db.prepare("UPDATE projects SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(projectId);
          sendToUI(win, 'project:status', { projectId, status: 'paused' });
          unregisterOrchestrator(projectId);
          return;
        }

        // 有部分是不可重试的 → 清除可重试的 failed Feature 让它们重跑，不可重试的保持 failed
        if (nonRetryable.length > 0) {
          sendToUI(win, 'agent:log', {
            projectId, agentId: 'system',
            content: `⚠️ ${nonRetryable.length} 个 Feature 因不可重试错误保持 failed 状态，${failedFeatures.length - nonRetryable.length} 个可重试 Feature 将重新执行`,
          });
        }
      }

      // 将可重试的 failed Feature 重置为 todo (不可重试的保持 failed)
      db.prepare(
        "UPDATE features SET status = 'todo', locked_by = NULL WHERE project_id = ? AND status = 'failed' AND (last_error IS NULL OR last_error NOT LIKE '%[NonRetryable:%')"
      ).run(projectId);
    }

    // 元 Agent 只负责通用交互/路由, 不加载项目设计内容。
    // 分诊需要项目上下文(已有 Feature + 设计文档), 因此由 PM 角色执行。
    // 用户可能只是续跑未完成的 feature, 也可能带了新 wish。
    // 关键: 新 wish 可能隐含对已有 feature 的变更 — 用户不会主动说"这是变更"。
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '♻️ 项目续跑 — PM 检查是否有新需求或隐式变更...' });

    // 获取当前 wish (可能被用户更新过)
    const freshProject = db.prepare('SELECT wish FROM projects WHERE id = ?').get(projectId) as { wish: string };
    const currentWish = freshProject.wish;

    // 判断是否有新 wish 需要处理 (对比最近一次 wish 是否与现有 features 有偏差)
    // 如果 workspace 存在且有设计文档, 做分诊; 否则直接续跑
    let triage: WishTriageResult | null = null;

    if (workspacePath && currentWish?.trim()) {
      triage = await detectImplicitChanges(
        projectId, currentWish, settings, win, signal, workspacePath,
      );
      if (signal.aborted) { unregisterOrchestrator(projectId); return; }
    }

    if (triage && triage.category !== 'pure_new' && triage.implicitChanges.length > 0) {
      // ── 检测到隐式变更: 先执行变更流程 ──
      sendToUI(win, 'agent:log', {
        projectId, agentId: 'system',
        content: `🔀 检测到 ${triage.implicitChanges.length} 个隐式变更, 启动变更管理流程...`,
      });

      // 将隐式变更合成为变更描述
      const changeDescription = [
        `用户新需求: ${currentWish}`,
        '',
        '检测到的隐式变更:',
        ...triage.implicitChanges.map(c =>
          `- ${c.featureId} (${c.featureTitle}): ${c.changeDescription} [${c.severity}]`
        ),
        ...(triage.conflicts.length > 0 ? [
          '',
          '潜在冲突:',
          ...triage.conflicts.map(c => `- ${c.description} (涉及: ${c.involvedFeatures.join(', ')})`),
        ] : []),
      ].join('\n');

      // 创建变更请求记录
      const crId = `cr-auto-${Date.now().toString(36)}`;
      db.prepare("INSERT INTO change_requests (id, project_id, description, status) VALUES (?, ?, ?, 'analyzing')")
        .run(crId, projectId, changeDescription);

      // 执行级联更新
      const changeResult = await runChangeRequest(projectId, crId, changeDescription, win, signal);
      if (signal.aborted) { unregisterOrchestrator(projectId); return; }

      if (!changeResult.success) {
        sendToUI(win, 'agent:log', {
          projectId, agentId: 'system',
          content: `⚠️ 变更管理流程未完全成功: ${changeResult.error}. 继续开发已有任务。`,
        });
      }
    }

    if (triage && triage.newCapabilities.length > 0) {
      // ── 有新功能: 走 PM 增量分析 → 新增 Feature ──
      sendToUI(win, 'agent:log', {
        projectId, agentId: 'system',
        content: `🆕 检测到 ${triage.newCapabilities.length} 个新功能, 启动增量 PM 分析...`,
      });

      const incrementalFeatures = await phaseIncrementalPM(
        projectId, project, triage.newCapabilities, settings, win, signal, workspacePath,
      );
      if (signal.aborted) { unregisterOrchestrator(projectId); return; }

      // 为新 Feature 生成子需求 + 测试规格
      if (incrementalFeatures && incrementalFeatures.length > 0 && workspacePath) {
        await phaseReqsAndTestSpecs(projectId, incrementalFeatures, settings, win, signal, workspacePath);
        if (signal.aborted) { unregisterOrchestrator(projectId); return; }
      }
    }

    if (!triage || (triage.implicitChanges.length === 0 && triage.newCapabilities.length === 0)) {
      sendToUI(win, 'agent:log', {
        projectId, agentId: 'system',
        content: '♻️ 无新需求或变更, 继续处理未完成的 Feature...',
      });
    }
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
  // Phase 4a: Developer 实现 + QA 代码审查 (v5.0: 原 Phase 5)
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
    githubRepo: project2.github_repo ?? undefined,
    githubToken: project2.github_token ?? undefined,
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
  // Phase 4b: PM 批量验收审查 (v5.0: 原 Phase 6, 批量化)
  // ═══════════════════════════════════════
  if (workspacePath) {
    await phasePMAcceptance(projectId, settings, win, signal, workspacePath);
    if (signal.aborted) { unregisterOrchestrator(projectId); return; }
  }

  // ═══════════════════════════════════════
  // Phase 4c: 增量文档同步 (G6 — 代码变更后自动更新模块摘要和文档)
  // ═══════════════════════════════════════
  if (workspacePath) {
    await phaseIncrementalDocSync(projectId, win, signal, workspacePath);
    if (signal.aborted) { unregisterOrchestrator(projectId); return; }
  }

  // ═══════════════════════════════════════
  // Phase 4d: DevOps 自动构建验证 (G8)
  // ═══════════════════════════════════════
  if (workspacePath) {
    await phaseDevOpsBuild(projectId, settings, win, signal, workspacePath);
    if (signal.aborted) { unregisterOrchestrator(projectId); return; }
  }

  // ═══════════════════════════════════════
  // Phase 5: 汇总 + 用户验收等待 (v5.0: 原 Phase 7)
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
  sendToUI(win, 'agent:status', { projectId, agentId: pmId, status: 'working', currentTask: 'pm-analysis', featureTitle: '需求分析' });
  sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: '🧠 Phase 1: 产品经理开始分析需求...' });
  addLog(projectId, pmId, 'log', '开始分析需求: ' + project.wish);
  db.prepare("UPDATE projects SET status = 'initializing', updated_at = datetime('now') WHERE id = ?").run(projectId);
  sendToUI(win, 'project:status', { projectId, status: 'initializing' });

  let features: any[] = [];
  try {
    if (signal.aborted) return null;
    const pmPrompt = getTeamPrompt(projectId, 'pm') ?? PM_SYSTEM_PROMPT;
    const workspacePath = project.workspace_path || '';
    const gitConfig = { mode: (project.git_mode || 'local') as 'local' | 'github', workspacePath, githubRepo: project.github_repo ?? undefined, githubToken: project.github_token ?? undefined };

    // v5.5: PM 使用 ReAct 循环 — 可以读文件、搜索、发现信息不足时阻塞
    const pmReactResult = await reactAgentLoop({
      projectId, agentId: pmId, role: 'pm',
      systemPrompt: pmPrompt,
      userMessage: `用户需求:\n${project.wish}\n\n请分析此需求，拆解为 Feature 清单。\n\n**重要**: 如果需求中引用了本地文件/目录，请先用 read_file / list_files 等工具查看内容，再做分析。如果确实无法访问或信息严重不足，使用 report_blocked 工具阻塞。\n\n分析完成后，调用 task_complete 工具，在 summary 字段中输出完整的 JSON Feature 数组（不要 markdown 代码块包裹）。`,
      settings,
      workspacePath: workspacePath || null,
      gitConfig,
      win, signal,
      maxIterations: 15,
      model: settings.strongModel,
    });

    // 检查阻塞
    if (pmReactResult.blocked) {
      sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `🚫 PM 分析被阻塞: ${pmReactResult.blockReason}\n请在需求中补充信息后重新启动。` });
      addLog(projectId, pmId, 'warning', `BLOCKED: ${pmReactResult.blockReason}`);
      db.prepare("UPDATE projects SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(projectId);
      sendToUI(win, 'project:status', { projectId, status: 'paused' });
      notify('⚠️ AgentForge 需要你的帮助', `PM 分析遇到阻塞: ${pmReactResult.blockReason}`);
      return null;
    }

    // 提取 Feature JSON — 从 task_complete 的 summary 或最终文本中解析
    const textToParse = pmReactResult.finalText || '';
    addLog(projectId, pmId, 'output', textToParse);
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `✅ PM 分析完成 (${pmReactResult.totalInputTokens + pmReactResult.totalOutputTokens} tokens, $${pmReactResult.totalCost.toFixed(4)})` });

    const parseResult = parseStructuredOutput(textToParse, PM_FEATURE_SCHEMA);
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
      .run(pmReactResult.totalInputTokens, pmReactResult.totalOutputTokens, pmReactResult.totalCost, pmId);
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
  const insertFeature = db.prepare(`INSERT INTO features (id, project_id, category, priority, group_name, sub_group, title, description, depends_on, status, acceptance_criteria, notes, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?)`);
  db.transaction((items: any[]) => {
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      const groupId = f.group_name || f.category || 'default';
      insertFeature.run(
        f.id || `F${String(i + 1).padStart(3, '0')}`, projectId,
        f.category || 'core', f.priority ?? 1,
        f.group_name || f.category || '', f.sub_group || '',
        f.title || f.description || '', f.description || '',
        JSON.stringify(f.dependsOn || f.depends_on || []),
        JSON.stringify(f.acceptanceCriteria || f.acceptance_criteria || []),
        f.notes || '',
        groupId,
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
// Phase 0 Helper: 增量 PM 分析 (续跑时新增 Feature)
// ═══════════════════════════════════════

/**
 * 增量 PM 分析 — 当分诊检测到新功能时, 只新增 Feature 到已有项目, 不覆盖旧的。
 * 与 phasePMAnalysis 不同之处:
 *  - 输入是已筛选过的 newCapabilities (而非原始 wish)
 *  - 注入已有 Feature 列表作为上下文 (避免重复)
 *  - 只追加新 Feature, 不清空旧的
 */
async function phaseIncrementalPM(
  projectId: string, project: ProjectRow,
  newCapabilities: Array<{ title: string; description: string }>,
  settings: AppSettings, win: BrowserWindow | null, signal: AbortSignal,
  workspacePath: string | null,
): Promise<any[] | null> {
  const db = getDb();
  const pmId = `pm-incr-${Date.now().toString(36)}`;
  spawnAgent(projectId, pmId, 'pm', win);

  // 已有 Feature 列表 — 让 PM 知道不要重复
  const existingRows = db.prepare("SELECT id, title, status FROM features WHERE project_id = ?")
    .all(projectId) as Array<{ id: string; title: string; status: string }>;
  const existingList = existingRows.map(f => `- ${f.id}: ${f.title} [${f.status}]`).join('\n');

  // 计算新 Feature ID 起始号
  const maxIdNum = existingRows.reduce((max, f) => {
    const match = f.id.match(/F(\d+)/);
    return match ? Math.max(max, parseInt(match[1], 10)) : max;
  }, 0);

  const capsDescription = newCapabilities
    .map((c, i) => `${i + 1}. ${c.title}: ${c.description}`)
    .join('\n');

  sendToUI(win, 'agent:log', {
    projectId, agentId: pmId,
    content: `🆕 增量分析: 为 ${newCapabilities.length} 个新功能生成 Feature...`,
  });

  try {
    const pmPrompt = getTeamPrompt(projectId, 'pm') ?? PM_SYSTEM_PROMPT;
    const result = await callLLM(settings, settings.strongModel, [
      { role: 'system', content: pmPrompt },
      {
        role: 'user',
        content: [
          `## 增量需求 — 仅为以下新功能生成 Feature, 不要重复已有的`,
          '',
          `### 新功能列表`,
          capsDescription,
          '',
          `### 已有 Feature (不要重复!)`,
          existingList,
          '',
          `Feature ID 请从 F${String(maxIdNum + 1).padStart(3, '0')} 开始编号。`,
          '直接输出 JSON 数组。',
        ].join('\n'),
      },
    ], signal, 16384);

    const cost = calcCost(settings.strongModel, result.inputTokens, result.outputTokens);
    updateAgentStats(pmId, projectId, result.inputTokens, result.outputTokens, cost);

    const parseResult = parseStructuredOutput(result.content, PM_FEATURE_SCHEMA);
    if (!parseResult.ok) {
      sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `❌ 增量分析输出解析失败: ${parseResult.error}` });
      return null;
    }

    const newFeatures = parseResult.data;
    if (newFeatures.length === 0) {
      sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: '⚠️ 增量分析未产生新 Feature' });
      return null;
    }

    // 写入 DB (追加, 不覆盖)
    const insertFeature = db.prepare(
      `INSERT OR IGNORE INTO features (id, project_id, category, priority, group_name, sub_group, title, description, depends_on, status, acceptance_criteria, notes, group_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?)`
    );
    db.transaction((items: any[]) => {
      for (let i = 0; i < items.length; i++) {
        const f = items[i];
        const groupId = f.group_name || f.category || 'default';
        insertFeature.run(
          f.id || `F${String(maxIdNum + i + 1).padStart(3, '0')}`, projectId,
          f.category || 'core', f.priority ?? 1,
          f.group_name || f.category || '', f.sub_group || '',
          f.title || f.description || '', f.description || '',
          JSON.stringify(f.dependsOn || f.depends_on || []),
          JSON.stringify(f.acceptanceCriteria || f.acceptance_criteria || []),
          f.notes || '',
          groupId,
        );
      }
    })(newFeatures);

    sendToUI(win, 'project:features-ready', { projectId, count: newFeatures.length });
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `✅ 新增 ${newFeatures.length} 个 Feature ($${cost.toFixed(4)})` });
    emitEvent({ projectId, agentId: pmId, type: 'phase:incremental-pm:end', data: { newCount: newFeatures.length } });

    return newFeatures;

  } catch (err: any) {
    if (signal.aborted) return null;
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `❌ 增量分析失败: ${err.message}` });
    return null;
  }
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
// Phase 2: Architect 技术架构 + 产品设计 (v5.0: 合并原 Phase 2+3)
// ═══════════════════════════════════════

async function phaseArchitect(
  projectId: string, project: ProjectRow, features: any[], settings: AppSettings,
  win: BrowserWindow | null, signal: AbortSignal, workspacePath: string | null,
): Promise<void> {
  if (signal.aborted) return;

  const db = getDb();
  const archId = `arch-${Date.now().toString(36)}`;
  spawnAgent(projectId, archId, 'architect', win);
  sendToUI(win, 'agent:status', { projectId, agentId: archId, status: 'working', currentTask: 'architecture', featureTitle: '架构 + 产品设计' });
  sendToUI(win, 'agent:log', { projectId, agentId: archId, content: '🏗️ Phase 2: 架构师开始设计技术方案 + 产品设计...' });
  addLog(projectId, archId, 'log', '开始架构 + 产品设计');

  try {
    const featureSummary = features.map(f =>
      `- ${f.id}: [${f.category || 'core'}] ${f.title || f.description} (priority: ${f.priority ?? 1})\n  验收: ${JSON.stringify(f.acceptance_criteria || f.acceptanceCriteria || [])}`
    ).join('\n');

    const [onChunk] = createStreamCallback(win, projectId, archId);
    sendToUI(win, 'agent:stream-start', { projectId, agentId: archId, label: '架构 + 产品设计' });
    const archPrompt = getTeamPrompt(projectId, 'architect') ?? ARCHITECT_SYSTEM_PROMPT;
    const archResult = await callLLM(settings, settings.strongModel, [
      { role: 'system', content: archPrompt },
      { role: 'user', content: `用户需求:\n${project.wish}\n\nFeature 清单 (${features.length} 个):\n${featureSummary}\n\n请完成以下两份文档:\n\n1. **产品设计文档** — 产品愿景、功能全景、用户流程、数据模型概要、非功能性需求\n2. **技术架构文档 (ARCHITECTURE.md)** — 技术选型、目录结构、核心数据模型、模块设计、API 接口、编码规范\n\n两份文档合并为一份完整输出, 先产品设计后技术架构。` },
    ], signal, 16384, 2, onChunk);
    sendToUI(win, 'agent:stream-end', { projectId, agentId: archId });

    const archCost = calcCost(settings.strongModel, archResult.inputTokens, archResult.outputTokens);
    addLog(projectId, archId, 'output', archResult.content.slice(0, 3000));

    // v5.0: 同时写入设计文档和架构文档
    if (workspacePath) {
      // 写入设计文档到 doc-manager
      writeDoc(workspacePath, 'design', archResult.content, archId, '初始版本: 架构师生成设计+架构文档');

      // 写入 ARCHITECTURE.md
      const archBlocks = parseFileBlocks(archResult.content);
      if (archBlocks.length > 0) {
        writeFileBlocks(workspacePath, archBlocks);
        sendToUI(win, 'agent:log', { projectId, agentId: archId, content: '📐 ARCHITECTURE.md 已写入工作区' });
      } else {
        fs.writeFileSync(path.join(workspacePath, 'ARCHITECTURE.md'), archResult.content, 'utf-8');
        sendToUI(win, 'agent:log', { projectId, agentId: archId, content: '📐 ARCHITECTURE.md 已写入工作区 (直接输出)' });
      }
      sendToUI(win, 'workspace:changed', { projectId });
    }

    updateAgentStats(archId, projectId, archResult.inputTokens, archResult.outputTokens, archCost);
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(archId);
    sendToUI(win, 'agent:log', { projectId, agentId: archId, content: `✅ 架构 + 产品设计完成 (${archResult.inputTokens + archResult.outputTokens} tokens, $${archCost.toFixed(4)})` });
    emitEvent({ projectId, agentId: archId, type: 'phase:architect:end', data: { tokens: archResult.inputTokens + archResult.outputTokens, cost: archCost }, inputTokens: archResult.inputTokens, outputTokens: archResult.outputTokens, costUsd: archCost });
    createCheckpoint(projectId, '架构 + 产品设计完成');
  } catch (err: any) {
    if (signal.aborted) return;
    sendToUI(win, 'agent:log', { projectId, agentId: archId, content: `⚠️ 架构设计失败 (非致命): ${err.message}` });
    db.prepare("UPDATE agents SET status = 'error' WHERE id = ?").run(archId);
  }
}

// ═══════════════════════════════════════
// Phase 3: 批量子需求拆分 + 测试规格 (v5.0: 批量化, 原 Phase 4)
// ═══════════════════════════════════════

const BATCH_DOC_SIZE = 5; // 每批处理的 Feature 数
const PHASE3_TIMEOUT_MS = 300_000; // Phase 3 单次 LLM 调用超时 5 分钟 (子需求生成量大)

async function phaseReqsAndTestSpecs(
  projectId: string, features: any[], settings: AppSettings,
  win: BrowserWindow | null, signal: AbortSignal, workspacePath: string,
): Promise<void> {
  const db = getDb();
  const designContext = buildDesignContext(workspacePath, 4000);

  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `📋 Phase 3: 批量生成 ${features.length} 个 Feature 的子需求和测试规格 (每批 ${BATCH_DOC_SIZE} 个)...` });

  // ── 3a: 批量子需求文档 ──
  const batches: any[][] = [];
  for (let i = 0; i < features.length; i += BATCH_DOC_SIZE) {
    batches.push(features.slice(i, i + BATCH_DOC_SIZE));
  }

  for (let bi = 0; bi < batches.length; bi++) {
    if (signal.aborted) return;
    const batch = batches[bi];
    const batchIds = batch.map((f: any, i: number) => f.id || `F${features.indexOf(f) + 1}`);

    // 批量子需求: 一次调用生成多个 Feature 的子需求
    try {
      const pmReqId = `pm-req-batch-${Date.now().toString(36)}`;
      const batchFeatureDesc = batch.map((f: any) => {
        const fid = f.id || `F${features.indexOf(f) + 1}`;
        return `### Feature ${fid}\n标题: ${f.title || f.description}\n描述: ${f.description}\n验收标准: ${JSON.stringify(f.acceptance_criteria || f.acceptanceCriteria || [])}\n依赖: ${JSON.stringify(f.dependsOn || f.depends_on || [])}\n备注: ${f.notes || '无'}`;
      }).join('\n\n');

      const reqResult = await callLLM(settings, settings.strongModel, [
        { role: 'system', content: PM_SPLIT_REQS_PROMPT },
        {
          role: 'user',
          content: `## 设计文档上下文\n${designContext}\n\n## Feature 列表 (${batch.length} 个, 请为每个单独输出子需求文档)\n\n${batchFeatureDesc}\n\n请为以上每个 Feature 分别编写详细子需求文档。用 "---FEATURE: Fxxx---" 分隔每个 Feature 的文档。`,
        },
      ], signal, 16384, 2, undefined, PHASE3_TIMEOUT_MS);

      const reqCost = calcCost(settings.strongModel, reqResult.inputTokens, reqResult.outputTokens);
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  📄 批次 ${bi + 1}/${batches.length} 子需求生成完成 ($${reqCost.toFixed(4)})` });

      // 解析批量输出, 按 Feature 分割
      const sections = splitBatchOutput(reqResult.content, batchIds);
      for (const fid of batchIds) {
        const content = sections[fid] || reqResult.content; // fallback: 整个输出
        const reqVer = writeDoc(workspacePath, 'requirement', content, pmReqId, `${fid} 初始子需求`, fid);
        db.prepare("UPDATE features SET requirement_doc_ver = ? WHERE id = ? AND project_id = ?")
          .run(reqVer, fid, projectId);
      }
    } catch (err: any) {
      if (signal.aborted) return;
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ⚠️ 批次 ${bi + 1} 子需求生成失败: ${err.message}${err.message.includes('abort') ? ' (可能是 LLM 响应超时，将继续处理下一批)' : ''}` });
    }

    // 批量测试规格: 一次调用生成多个 Feature 的测试规格
    try {
      const qaSpecId = `qa-spec-batch-${Date.now().toString(36)}`;
      const batchReqDocs = batchIds.map(fid => {
        const content = readDoc(workspacePath, 'requirement', fid);
        return content ? `### Feature ${fid}\n${content}` : null;
      }).filter(Boolean).join('\n\n---\n\n');

      if (batchReqDocs) {
        const specResult = await callLLM(settings, settings.strongModel, [
          { role: 'system', content: QA_TEST_SPEC_PROMPT },
          {
            role: 'user',
            content: `## 多个 Feature 的子需求文档\n\n${batchReqDocs}\n\n请为以上每个 Feature 分别编写功能测试规格文档。用 "---FEATURE: Fxxx---" 分隔每个 Feature 的文档。`,
          },
        ], signal, 16384, 2, undefined, PHASE3_TIMEOUT_MS);

        const specCost = calcCost(settings.strongModel, specResult.inputTokens, specResult.outputTokens);
        sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  🧪 批次 ${bi + 1}/${batches.length} 测试规格生成完成 ($${specCost.toFixed(4)})` });

        const specSections = splitBatchOutput(specResult.content, batchIds);
        for (const fid of batchIds) {
          const content = specSections[fid] || specResult.content;
          const specVer = writeDoc(workspacePath, 'test_spec', content, qaSpecId, `${fid} 初始测试规格`, fid);
          db.prepare("UPDATE features SET test_spec_doc_ver = ? WHERE id = ? AND project_id = ?")
            .run(specVer, fid, projectId);
        }
      }
    } catch (err: any) {
      if (signal.aborted) return;
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ⚠️ 批次 ${bi + 1} 测试规格生成失败: ${err.message}${err.message.includes('abort') ? ' (可能是 LLM 响应超时，将继续处理下一批)' : ''}` });
    }

    createCheckpoint(projectId, `Phase 3: 批次 ${bi + 1}/${batches.length} 文档已生成`);
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
  createCheckpoint(projectId, `Phase 3 完成: ${features.length} Feature 文档已生成`);
}

/**
 * 解析批量 LLM 输出, 按 Feature ID 分割
 * 支持格式: "---FEATURE: F001---" 或 "## Feature F001" 等分隔符
 */
function splitBatchOutput(content: string, featureIds: string[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (let i = 0; i < featureIds.length; i++) {
    const fid = featureIds[i];
    // 尝试多种分隔符模式
    const patterns = [
      new RegExp(`---\\s*FEATURE:\\s*${fid}\\s*---([\\s\\S]*?)(?=---\\s*FEATURE:|$)`, 'i'),
      new RegExp(`##\\s*Feature\\s*${fid}\\b([\\s\\S]*?)(?=##\\s*Feature\\s*F\\d|$)`, 'i'),
      new RegExp(`#\\s*${fid}\\b([\\s\\S]*?)(?=#\\s*F\\d|$)`, 'i'),
    ];

    for (const pat of patterns) {
      const match = content.match(pat);
      if (match && match[1]?.trim()) {
        result[fid] = match[1].trim();
        break;
      }
    }
  }

  return result;
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
      sendToUI(win, 'agent:status', { projectId, agentId: workerId, status: 'idle', currentTask: null });
      break;
    }

    db.prepare("UPDATE agents SET status = 'working', current_task = ?, last_active_at = datetime('now') WHERE id = ? AND project_id = ?")
      .run(feature.id, workerId, projectId);
    sendToUI(win, 'agent:status', { projectId, agentId: workerId, status: 'working', currentTask: feature.id, featureTitle: feature.title || feature.description });
    sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: 'in_progress', agentId: workerId });
    sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `🔨 开始: ${feature.id} — ${feature.title || feature.description}` });

    // v4.2: 如果有子需求和测试规格, 注入到 feature 对象供 react-loop 使用
    if (workspacePath) {
      const docContext = buildFeatureDocContext(workspacePath, feature.id);
      if (docContext) {
        feature._docContext = docContext;
      }
    }

    // v5.5: 共享决策日志 — 声明计划修改的文件, 检测与其他 Worker 的冲突
    if (workspacePath) {
      const plannedFiles = predictAffectedFiles(feature);
      const conflicts = claimFiles(workspacePath, workerId, feature.id, plannedFiles);
      if (conflicts.length > 0) {
        const conflictMsg = conflicts.map(c =>
          `⚠️ ${c.otherWorkerId}(${c.otherFeatureId}) 正在修改: ${c.overlappingFiles.join(', ')}`
        ).join('\n');
        sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `🔒 文件冲突检测:\n${conflictMsg}\n将注意避免冲突修改` });
        // Inject conflict awareness into feature context for the developer
        feature._conflictWarning = `注意: 以下文件正被其他 Worker 修改，请协调避免冲突:\n${conflictMsg}`;
      }
      // Inject other workers' active claims as context
      const otherClaims = getClaimsSummary(workspacePath, workerId);
      if (otherClaims) {
        feature._otherWorkerClaims = otherClaims;
      }
    }

    let passed = false;
    let qaFeedback = '';

    // v6.0 (G14): TDD 模式 — QA 先生成测试骨架, Developer 的目标变为让测试通过
    if (settings.tddMode && workspacePath) {
      try {
        sendToUI(win, 'agent:log', { projectId, agentId: qaId, content: `📝 TDD: 为 ${feature.id} 生成测试骨架...` });
        sendToUI(win, 'agent:status', { projectId, agentId: qaId, status: 'working', currentTask: feature.id, featureTitle: `TDD: ${feature.title || ''}` });
        const tddResult = await generateTestSkeleton(settings, signal, feature, workspacePath, projectId);
        if (tddResult.files.length > 0) {
          const tddFiles = tddResult.files.map(f => f.path).join(', ');
          sendToUI(win, 'agent:log', { projectId, agentId: qaId, content: `  ✅ TDD 测试骨架已写入: ${tddFiles}` });
          // 将测试骨架信息注入到 feature 上下文，让 developer 知道要通过这些测试
          feature._tddTests = tddResult.files.map(f => f.path);
          feature._tddContext = `[TDD 模式] 以下测试文件已预先生成，你的目标是让这些测试全部通过:\n${tddFiles}\n请先阅读测试文件了解验收标准，然后编写实现代码。`;
        }
        db.prepare("UPDATE agents SET current_task = NULL WHERE id = ? AND project_id = ?").run(qaId, projectId);
        sendToUI(win, 'agent:status', { projectId, agentId: qaId, status: 'idle' });
      } catch (err: any) {
        sendToUI(win, 'agent:log', { projectId, agentId: qaId, content: `  ⚠️ TDD 测试骨架生成失败 (将继续正常开发): ${err.message}` });
      }
    }
    let lastErrorMsg = '';  // v5.6: 记录最后一个错误，用于 circuit-breaker

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
          sendToUI(win, 'agent:status', { projectId, agentId: qaId, status: 'working', currentTask: feature.id, featureTitle: feature.title || feature.description });
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
        lastErrorMsg = err.message || 'Unknown error';
        // v5.6: 不可重试错误 → 直接终止 QA 重试循环
        if (err instanceof NonRetryableError) {
          lastErrorMsg = `[NonRetryable:${err.statusCode}] ${err.message}`;
          sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `🛑 ${feature.id} 不可重试错误: ${err.message}` });
          addLog(projectId, workerId, 'error', `[${feature.id}] NonRetryable: ${err.message}`);
          break;
        }
        sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `❌ ${feature.id} 错误: ${err.message}` });
        addLog(projectId, workerId, 'error', `[${feature.id}] ${err.message}`);
        if (qaAttempt >= maxQARetries) break;
        await sleep(2000);
      }
    }

    if (signal.aborted) break;

    // v5.5: 释放决策日志中的文件声明
    if (workspacePath) {
      releaseFiles(workspacePath, workerId, feature.id);
    }

    // QA pass → 进入 pm_pending 状态 (等 Phase 6 PM 验收); QA fail → 直接 failed
    const newStatus = passed ? 'qa_passed' : 'failed';
    db.prepare("UPDATE features SET status = ?, locked_by = NULL, last_error = ?, last_error_at = CASE WHEN ? = 'failed' THEN datetime('now') ELSE NULL END WHERE id = ? AND project_id = ?")
      .run(newStatus, passed ? null : lastErrorMsg, newStatus, feature.id, projectId);
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
// Phase 4 (v5.0): PM 批量验收审查 (原 Phase 6)
// ═══════════════════════════════════════

const BATCH_ACCEPT_SIZE = 4; // 每批验收的 Feature 数

async function phasePMAcceptance(
  projectId: string, settings: AppSettings,
  win: BrowserWindow | null, signal: AbortSignal, workspacePath: string,
): Promise<void> {
  const db = getDb();

  // 获取所有通过 QA 的 Feature
  const qaPassed = db.prepare("SELECT * FROM features WHERE project_id = ? AND status = 'qa_passed'")
    .all(projectId) as FeatureRow[];

  if (qaPassed.length === 0) {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '⏭️ Phase 4: 没有 Feature 需要 PM 验收' });
    return;
  }

  const pmAccId = `pm-acc-${Date.now().toString(36)}`;
  spawnAgent(projectId, pmAccId, 'pm', win);
  sendToUI(win, 'agent:log', { projectId, agentId: pmAccId, content: `📋 Phase 4: PM 批量验收审查 (${qaPassed.length} features, 每批 ${BATCH_ACCEPT_SIZE} 个)...` });

  const designContext = buildDesignContext(workspacePath, 6000);

  // 分批验收
  const accBatches: FeatureRow[][] = [];
  for (let i = 0; i < qaPassed.length; i += BATCH_ACCEPT_SIZE) {
    accBatches.push(qaPassed.slice(i, i + BATCH_ACCEPT_SIZE));
  }

  for (let bi = 0; bi < accBatches.length; bi++) {
    if (signal.aborted) return;
    const batch = accBatches[bi];

    try {
      // 构建批量 Feature 信息
      const batchInfo = batch.map(feature => {
        const featureDocCtx = buildFeatureDocContext(workspacePath, feature.id);
        const affectedFiles = safeJsonParse(feature.affected_files, []);
        let filePreview = '';
        for (const fp of affectedFiles.slice(0, 3)) {
          const fullPath = path.join(workspacePath, fp);
          if (fs.existsSync(fullPath)) {
            const content = fs.readFileSync(fullPath, 'utf-8');
            filePreview += `#### ${fp}\n\`\`\`\n${content.slice(0, 1000)}\n\`\`\`\n`;
          }
        }
        return [
          `### Feature ${feature.id}`,
          `标题: ${feature.title}`,
          `描述: ${feature.description}`,
          `验收标准: ${feature.acceptance_criteria}`,
          featureDocCtx ? `文档摘要: ${featureDocCtx.slice(0, 500)}` : '',
          filePreview ? `代码预览:\n${filePreview}` : '',
        ].filter(Boolean).join('\n');
      }).join('\n\n---\n\n');

      const acceptResult = await callLLM(settings, settings.strongModel, [
        { role: 'system', content: PM_ACCEPTANCE_PROMPT },
        {
          role: 'user',
          content: `## 设计文档上下文\n${designContext}\n\n## ${batch.length} 个 Feature 待验收\n\n${batchInfo}\n\n请逐个输出每个 Feature 的验收审查结果。输出 JSON 数组, 每项包含: feature_id, verdict, score, summary, feedback。`,
        },
      ], signal, 8192);

      const accCost = calcCost(settings.strongModel, acceptResult.inputTokens, acceptResult.outputTokens);
      updateAgentStats(pmAccId, projectId, acceptResult.inputTokens, acceptResult.outputTokens, accCost);

      // 尝试解析为数组
      let verdicts: Array<{ feature_id: string; verdict: string; score: number; summary?: string; feedback?: string }> = [];
      try {
        const parsed = parseStructuredOutput(acceptResult.content, PM_ACCEPTANCE_SCHEMA);
        if (parsed.ok) {
          // 如果返回的是单个对象 (向后兼容), 包装为数组
          verdicts = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
        }
      } catch {
        // fallback: 尝试直接 JSON.parse
        try {
          const raw = JSON.parse(acceptResult.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
          verdicts = Array.isArray(raw) ? raw : [raw];
        } catch { /* parse failed */ }
      }

      // 应用结果到每个 Feature
      for (const feature of batch) {
        const v = verdicts.find(v => v.feature_id === feature.id) || verdicts[batch.indexOf(feature)];
        const verdict = v?.verdict || 'conditional_accept';
        const score = v?.score || 70;
        const feedback = v?.feedback || '';
        const summary = v?.summary || '';

        const finalStatus = verdict === 'accept' || verdict === 'conditional_accept' ? 'passed' : 'pm_rejected';
        db.prepare("UPDATE features SET status = ?, pm_verdict = ?, pm_verdict_score = ?, pm_verdict_feedback = ?, completed_at = CASE WHEN ? IN ('passed') THEN datetime('now') ELSE NULL END WHERE id = ? AND project_id = ?")
          .run(finalStatus, verdict, score, feedback, finalStatus, feature.id, projectId);

        const icon = verdict === 'accept' ? '✅' : verdict === 'conditional_accept' ? '⚠️' : '❌';
        sendToUI(win, 'agent:log', { projectId, agentId: pmAccId, content: `${icon} ${feature.id} PM 验收: ${verdict} (${score}/100) — ${summary}` });
        sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: finalStatus, agentId: pmAccId });
      }

      sendToUI(win, 'agent:log', { projectId, agentId: pmAccId, content: `  📋 批次 ${bi + 1}/${accBatches.length} 验收完成 ($${accCost.toFixed(4)})` });
    } catch (err: any) {
      if (signal.aborted) return;
      // 批次验收失败 → 全部视为 conditional_accept
      sendToUI(win, 'agent:log', { projectId, agentId: pmAccId, content: `⚠️ 批次 ${bi + 1} PM 验收出错 (全部视为通过): ${err.message}` });
      for (const feature of batch) {
        db.prepare("UPDATE features SET status = 'passed', pm_verdict = 'conditional_accept', pm_verdict_feedback = ?, completed_at = datetime('now') WHERE id = ? AND project_id = ?")
          .run(`PM 验收异常: ${err.message}`, feature.id, projectId);
        sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: 'passed', agentId: pmAccId });
      }
    }
  }

  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(pmAccId);
  emitEvent({ projectId, agentId: pmAccId, type: 'phase:pm-acceptance:end', data: { reviewed: qaPassed.length } });
  createCheckpoint(projectId, `PM 验收完成 (${qaPassed.length} features)`);
}

// ═══════════════════════════════════════
// Phase 4c: 增量文档同步 (G6)
// ═══════════════════════════════════════

/**
 * 开发完成后，根据 git diff 检测变更文件，更新受影响模块的摘要和文档。
 * 仅对"导入已有项目"或已有 skeleton 缓存的项目生效。
 */
async function phaseIncrementalDocSync(
  projectId: string,
  win: BrowserWindow | null, signal: AbortSignal,
  workspacePath: string,
): Promise<void> {
  const skeletonPath = path.join(workspacePath, '.agentforge/analysis/skeleton.json');
  if (!fs.existsSync(skeletonPath)) {
    log.debug('No skeleton.json found, skipping incremental doc sync');
    return;
  }

  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '📝 Phase 4c: 增量文档同步 — 根据代码变更更新模块摘要...' });

  try {
    const skeleton: ProjectSkeleton = JSON.parse(fs.readFileSync(skeletonPath, 'utf-8'));

    // 获取自上次分析以来的变更文件 (git diff)
    let changedFiles: string[] = [];
    try {
      const { execSync } = require('child_process');
      const diffOutput = execSync('git diff --name-only HEAD~5 HEAD', {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim();
      if (diffOutput) {
        changedFiles = diffOutput.split('\n').filter(Boolean);
      }
    } catch {
      // 如果 git diff 失败（如首次提交），尝试 git status
      try {
        const { execSync } = require('child_process');
        const statusOutput = execSync('git diff --name-only --cached', {
          cwd: workspacePath,
          encoding: 'utf-8',
          timeout: 10_000,
        }).trim();
        if (statusOutput) {
          changedFiles = statusOutput.split('\n').filter(Boolean);
        }
      } catch { /* no git available */ }
    }

    if (changedFiles.length === 0) {
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '  ↳ 无代码变更，跳过文档同步' });
      return;
    }

    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ↳ 检测到 ${changedFiles.length} 个文件变更，更新受影响模块...` });

    const result = await incrementalUpdate(
      workspacePath,
      changedFiles,
      skeleton,
      signal,
      (phase, step, progress) => {
        sendToUI(win, 'project:import-progress', { projectId, phase, step, progress });
      },
    );

    if (result.updatedModules.length > 0) {
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ✅ 更新了 ${result.updatedModules.length} 个模块摘要: ${result.updatedModules.join(', ')}` });
    } else {
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '  ↳ 变更文件不属于已知模块，无需更新' });
    }

    emitEvent({ projectId, agentId: 'system', type: 'phase:dev:end', data: { incrementalDocSync: true, updatedModules: result.updatedModules.length } });
  } catch (err: any) {
    if (signal.aborted) return;
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ⚠️ 增量文档同步失败 (非致命): ${err.message}` });
    log.warn('Incremental doc sync failed', err);
  }
}

// ═══════════════════════════════════════
// Phase 4d: DevOps 自动构建验证 (G8)
// ═══════════════════════════════════════

/**
 * 自动构建 + lint 验证。DevOps 角色执行以下步骤:
 *   1. 安装依赖 (npm install / pip install)
 *   2. 编译/类型检查 (tsc / py_compile)
 *   3. 运行完整测试套件
 *   4. 汇报构建状态
 */
async function phaseDevOpsBuild(
  projectId: string, settings: AppSettings,
  win: BrowserWindow | null, signal: AbortSignal,
  workspacePath: string,
): Promise<void> {
  if (signal.aborted) return;

  const db = getDb();
  const devopsId = `devops-${Date.now().toString(36)}`;
  spawnAgent(projectId, devopsId, 'devops', win);
  sendToUI(win, 'agent:status', { projectId, agentId: devopsId, status: 'working', currentTask: 'build-verify', featureTitle: '构建验证' });
  sendToUI(win, 'agent:log', { projectId, agentId: devopsId, content: '🚀 Phase 4d: DevOps 自动构建验证...' });

  const buildSteps: Array<{ name: string; cmd: string; critical: boolean }> = [];

  // 检测项目类型，选择合适的构建步骤
  const hasPackageJson = fs.existsSync(path.join(workspacePath, 'package.json'));
  const hasRequirements = fs.existsSync(path.join(workspacePath, 'requirements.txt'));
  const hasPyproject = fs.existsSync(path.join(workspacePath, 'pyproject.toml'));
  const hasCargoToml = fs.existsSync(path.join(workspacePath, 'Cargo.toml'));
  const hasGoMod = fs.existsSync(path.join(workspacePath, 'go.mod'));

  if (hasPackageJson) {
    buildSteps.push({ name: '安装依赖', cmd: 'npm install --prefer-offline 2>&1', critical: true });
    // 检查是否有 tsc
    const pkg = JSON.parse(fs.readFileSync(path.join(workspacePath, 'package.json'), 'utf-8'));
    const hasTsc = pkg.devDependencies?.typescript || pkg.dependencies?.typescript;
    if (hasTsc || fs.existsSync(path.join(workspacePath, 'tsconfig.json'))) {
      buildSteps.push({ name: '类型检查', cmd: 'npx tsc --noEmit 2>&1', critical: false });
    }
    // 检查 lint
    if (pkg.devDependencies?.eslint || pkg.dependencies?.eslint || pkg.scripts?.lint) {
      buildSteps.push({ name: 'Lint', cmd: pkg.scripts?.lint ? 'npm run lint 2>&1' : 'npx eslint . --ext .ts,.tsx,.js,.jsx 2>&1', critical: false });
    }
    // 测试
    if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
      buildSteps.push({ name: '测试', cmd: 'npm test 2>&1', critical: false });
    }
    // build
    if (pkg.scripts?.build) {
      buildSteps.push({ name: '构建', cmd: 'npm run build 2>&1', critical: true });
    }
  } else if (hasRequirements || hasPyproject) {
    if (hasRequirements) buildSteps.push({ name: '安装依赖', cmd: 'pip install -r requirements.txt 2>&1', critical: true });
    if (hasPyproject) buildSteps.push({ name: '安装依赖', cmd: 'pip install -e . 2>&1', critical: true });
    buildSteps.push({ name: '语法检查', cmd: 'python -m py_compile $(find . -name "*.py" -not -path "*/venv/*" -not -path "*/.venv/*" | head -50) 2>&1', critical: false });
    buildSteps.push({ name: '测试', cmd: 'pytest --tb=short 2>&1 || python -m pytest --tb=short 2>&1 || echo "No pytest"', critical: false });
  } else if (hasCargoToml) {
    buildSteps.push({ name: '构建', cmd: 'cargo build 2>&1', critical: true });
    buildSteps.push({ name: '测试', cmd: 'cargo test 2>&1', critical: false });
  } else if (hasGoMod) {
    buildSteps.push({ name: '构建', cmd: 'go build ./... 2>&1', critical: true });
    buildSteps.push({ name: '测试', cmd: 'go test ./... 2>&1', critical: false });
  }

  if (buildSteps.length === 0) {
    sendToUI(win, 'agent:log', { projectId, agentId: devopsId, content: '  ↳ 未检测到已知构建系统，跳过' });
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(devopsId);
    sendToUI(win, 'agent:status', { projectId, agentId: devopsId, status: 'idle' });
    return;
  }

  let allPassed = true;
  const results: Array<{ name: string; ok: boolean; output: string }> = [];
  const { execSync } = require('child_process');

  for (const step of buildSteps) {
    if (signal.aborted) break;
    sendToUI(win, 'agent:log', { projectId, agentId: devopsId, content: `  🔧 ${step.name}...` });

    try {
      const output = execSync(step.cmd, {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
      results.push({ name: step.name, ok: true, output: output.slice(-500) });
      sendToUI(win, 'agent:log', { projectId, agentId: devopsId, content: `  ✅ ${step.name} 成功` });
    } catch (err: any) {
      const output = (err.stdout || '') + (err.stderr || '');
      results.push({ name: step.name, ok: false, output: output.slice(-500) });
      if (step.critical) {
        allPassed = false;
        sendToUI(win, 'agent:log', { projectId, agentId: devopsId, content: `  ❌ ${step.name} 失败 (关键步骤):\n${output.slice(-300)}` });
      } else {
        sendToUI(win, 'agent:log', { projectId, agentId: devopsId, content: `  ⚠️ ${step.name} 失败 (非关键):\n${output.slice(-200)}` });
      }
    }
  }

  const passedCount = results.filter(r => r.ok).length;
  const summary = allPassed
    ? `✅ 构建验证全部通过 (${passedCount}/${results.length} 步骤)`
    : `⚠️ 构建验证部分失败 (${passedCount}/${results.length} 步骤通过)`;

  sendToUI(win, 'agent:log', { projectId, agentId: devopsId, content: summary });
  addLog(projectId, devopsId, 'log', summary);

  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(devopsId);
  sendToUI(win, 'agent:status', { projectId, agentId: devopsId, status: 'idle' });
  emitEvent({ projectId, agentId: devopsId, type: 'phase:dev:end', data: { devops: true, allPassed, steps: results.length, passed: passedCount } });

  if (workspacePath && allPassed) {
    commitWorkspace(workspacePath, 'AgentForge: DevOps build verification passed');
  }
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
    } catch (err) {
      log.warn('Cross-project experience extraction failed', { error: String(err) });
    }
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
  catch (err) {
    log.debug('JSON parse failed, using fallback', { input: str?.slice(0, 50) });
    return fallback;
  }
}

function ensureAgentsMd(workspacePath: string, wish: string) {
  const agentsDir = path.join(workspacePath, '.agentforge');
  const agentsPath = path.join(agentsDir, 'AGENTS.md');
  fs.mkdirSync(agentsDir, { recursive: true });

  // v6.0 (G15): 每次运行都重新生成 AGENTS.md (而非仅首次)
  // 读取实际的架构信息
  let techInfo = '';
  const archPath = path.join(workspacePath, 'ARCHITECTURE.md');
  if (fs.existsSync(archPath)) {
    techInfo = fs.readFileSync(archPath, 'utf-8').split('\n').slice(0, 50).join('\n');
  }

  // 读取 package.json / pyproject.toml 获取依赖信息
  let depsInfo = '';
  const pkgPath = path.join(workspacePath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = Object.keys(pkg.dependencies || {}).slice(0, 20);
      const devDeps = Object.keys(pkg.devDependencies || {}).slice(0, 10);
      depsInfo = `### 依赖\n- 运行时: ${deps.join(', ') || '无'}\n- 开发: ${devDeps.join(', ') || '无'}`;
    } catch { /* parse error */ }
  }

  // 读取 .gitignore 获取忽略规则
  let gitignoreInfo = '';
  const gitignorePath = path.join(workspacePath, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const ignoreRules = fs.readFileSync(gitignorePath, 'utf-8').split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 15);
    gitignoreInfo = `### .gitignore 规则\n${ignoreRules.map(r => `- ${r}`).join('\n')}`;
  }

  // 读取 tsconfig.json 获取编译配置
  let tsInfo = '';
  const tsConfigPath = path.join(workspacePath, 'tsconfig.json');
  if (fs.existsSync(tsConfigPath)) {
    try {
      const tsConfig = JSON.parse(fs.readFileSync(tsConfigPath, 'utf-8'));
      const co = tsConfig.compilerOptions || {};
      tsInfo = `### TypeScript 配置\n- target: ${co.target || 'N/A'}\n- module: ${co.module || 'N/A'}\n- strict: ${co.strict ?? 'N/A'}\n- outDir: ${co.outDir || 'N/A'}`;
    } catch { /* parse error */ }
  }

  // 检测目录结构
  let dirStructure = '';
  try {
    const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map(e => e.name);
    const files = entries.filter(e => e.isFile()).map(e => e.name);
    dirStructure = `### 项目结构\n- 目录: ${dirs.join(', ') || '无'}\n- 根文件: ${files.slice(0, 15).join(', ')}`;
  } catch { /* read error */ }

  const content = [
    `# AGENTS.md — 项目规范`,
    `> 此文件由 AgentForge 自动生成和维护，Agent 和用户均可编辑。`,
    `> 最后更新: ${new Date().toISOString().slice(0, 19)}`,
    ``,
    `## 项目概述`,
    wish.slice(0, 800),
    ``,
    `## 技术栈概要`,
    techInfo || '(待补充 — 架构文档生成后自动填充)',
    ``,
    depsInfo || '',
    tsInfo || '',
    dirStructure || '',
    gitignoreInfo || '',
    ``,
    `## 编码规范`,
    `- 使用项目已有的代码风格和缩进`,
    `- 文件组织遵循 ARCHITECTURE.md`,
    `- 所有新文件必须包含必要的 import/export`,
    `- 不要忽略异常，使用适当的错误处理`,
    `- 优先使用 edit_file 而非 write_file 修改已有文件`,
    `- 新增文件前先搜索是否已有类似功能`,
    ``,
    `## 常用命令`,
    `- 安装依赖: npm install / pip install -r requirements.txt`,
    `- 编译检查: npx tsc --noEmit`,
    `- 运行测试: npm test / pytest`,
    `- 构建: npm run build (如可用)`,
    ``,
    `## 注意事项`,
    `- 修改已有文件用 edit_file，不要 write_file 重写`,
    `- 每个 Feature 完成后调用 task_complete`,
    `- 遇到信息不足时使用 report_blocked 阻塞`,
    `- 发现设计问题使用 rfc_propose 提案`,
    ``,
  ].filter(Boolean).join('\n');

  fs.writeFileSync(agentsPath, content, 'utf-8');
}