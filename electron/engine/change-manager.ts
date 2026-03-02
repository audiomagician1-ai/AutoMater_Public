/**
 * Change Manager — 需求变更管理器
 *
 * 职责:
 *  1. 影响分析 — 变更描述 → 哪些文档/Feature 受影响
 *  2. 级联更新 — 自动触发 PM 更新设计文档 → PM 更新子需求 → QA 更新测试规格
 *  3. 一致性执行 — 变更完成后运行 doc-manager.checkConsistency()
 *  4. Feature 标记 — 受影响的 Feature 回退为 needs_rework
 *
 * 变更流程:
 *  用户提交变更 → PM 影响分析 → PM 更新 design.md → PM 更新 REQ docs
 *  → QA 更新 TEST docs → 一致性校验 → 标记受影响 Feature → 重新进入开发循环
 *
 * @module change-manager
 */

import { BrowserWindow } from 'electron';
import { getDb } from '../db';
import { callLLM, calcCost, getSettings } from './llm-client';
import { sendToUI, addLog } from './ui-bridge';
import { spawnAgent, updateAgentStats, getTeamPrompt } from './agent-manager';
import { writeDoc, readDoc, buildDesignContext, listDocs, checkConsistency } from './doc-manager';
import { PM_IMPACT_ANALYSIS_PROMPT, PM_UPDATE_DESIGN_PROMPT, QA_UPDATE_TEST_SPEC_PROMPT, PM_WISH_TRIAGE_PROMPT } from './prompts';
import { parseStructuredOutput } from './output-parser';
import { emitEvent } from './event-store';
import { createCheckpoint } from './mission';
import type { AppSettings, FeatureRow, ProjectRow } from './types';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

/** 变更请求记录 */
export interface ChangeRequest {
  id: string;
  projectId: string;
  description: string;
  status: 'pending' | 'analyzing' | 'updating' | 'completed' | 'failed';
  impactAnalysis: ImpactAnalysis | null;
  affectedFeatureIds: string[];
  createdAt: string;
  completedAt: string | null;
}

/** 影响分析结果 */
export interface ImpactAnalysis {
  /** 受影响的 Feature ID 列表 */
  affectedFeatures: Array<{
    featureId: string;
    reason: string;
    severity: 'major' | 'minor';
  }>;
  /** 需要更新的文档 */
  docsToUpdate: Array<{
    type: 'design' | 'requirement' | 'test_spec';
    id: string;
    changeDescription: string;
  }>;
  /** 是否需要新增 Feature */
  newFeaturesNeeded: Array<{
    title: string;
    description: string;
    reason: string;
  }>;
  /** 变更风险评估 */
  riskLevel: 'low' | 'medium' | 'high';
  riskNotes: string;
  /** 预估影响范围百分比 */
  impactPercent: number;
}

/** 影响分析 JSON Schema */
const IMPACT_ANALYSIS_SCHEMA = {
  topLevel: 'object' as const,
  fields: {
    affectedFeatures: { type: 'array' as const, required: true, default: [] },
    docsToUpdate:     { type: 'array' as const, required: true, default: [] },
    newFeaturesNeeded: { type: 'array' as const, required: false, default: [] },
    riskLevel:        { type: 'string' as const, required: true, enum: ['low', 'medium', 'high'], default: 'medium' },
    riskNotes:        { type: 'string' as const, required: false, default: '' },
    impactPercent:    { type: 'number' as const, required: false, default: 0, min: 0, max: 100 },
  },
};

// ═══════════════════════════════════════
// Change Request Lifecycle
// ═══════════════════════════════════════

/**
 * 执行完整的需求变更流程
 *
 * 1. PM 影响分析
 * 2. PM 更新设计文档
 * 3. PM 更新受影响的子需求
 * 4. QA 更新受影响的测试规格
 * 5. 一致性校验
 * 6. 标记受影响 Feature 为待返工
 */
export async function runChangeRequest(
  projectId: string,
  changeRequestId: string,
  description: string,
  win: BrowserWindow | null,
  signal: AbortSignal,
): Promise<{ success: boolean; error?: string }> {
  const db = getDb();
  const settings = getSettings();

  if (!settings?.apiKey) {
    return { success: false, error: '未配置 LLM API Key' };
  }

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
  if (!project?.workspace_path) {
    return { success: false, error: '项目无工作区路径' };
  }

  const workspacePath = project.workspace_path;

  // 更新状态
  db.prepare("UPDATE change_requests SET status = 'analyzing' WHERE id = ?").run(changeRequestId);
  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `🔄 开始处理需求变更: ${description.slice(0, 100)}...` });

  try {
    // ── Step 1: PM 影响分析 ──
    const impact = await analyzeImpact(projectId, description, settings, win, signal, workspacePath);
    if (!impact) {
      db.prepare("UPDATE change_requests SET status = 'failed' WHERE id = ?").run(changeRequestId);
      return { success: false, error: '影响分析失败' };
    }

    db.prepare("UPDATE change_requests SET impact_analysis = ?, status = 'updating' WHERE id = ?")
      .run(JSON.stringify(impact), changeRequestId);

    // 影响超过 50% 时警告
    if (impact.impactPercent > 50) {
      sendToUI(win, 'agent:log', {
        projectId, agentId: 'system',
        content: `⚠️ 变更影响范围较大 (${impact.impactPercent}%), 风险: ${impact.riskLevel}. ${impact.riskNotes}`,
      });
    }

    // ── Step 2: PM 更新设计文档 ──
    if (impact.docsToUpdate.some(d => d.type === 'design')) {
      await updateDesignDoc(projectId, description, impact, settings, win, signal, workspacePath);
      if (signal.aborted) return { success: false, error: 'Aborted' };
    }

    // ── Step 3: PM 更新子需求文档 ──
    const reqsToUpdate = impact.docsToUpdate.filter(d => d.type === 'requirement');
    for (const req of reqsToUpdate) {
      if (signal.aborted) return { success: false, error: 'Aborted' };
      await updateRequirementDoc(projectId, req.id, req.changeDescription, settings, win, signal, workspacePath);
    }

    // ── Step 4: QA 更新测试规格 ──
    const testsToUpdate = impact.docsToUpdate.filter(d => d.type === 'test_spec');
    for (const test of testsToUpdate) {
      if (signal.aborted) return { success: false, error: 'Aborted' };
      await updateTestSpecDoc(projectId, test.id, test.changeDescription, settings, win, signal, workspacePath);
    }

    // ── Step 5: 一致性校验 ──
    const allFeatures = db.prepare("SELECT id FROM features WHERE project_id = ?").all(projectId) as { id: string }[];
    const consistency = checkConsistency(workspacePath, allFeatures.map(f => f.id));
    if (!consistency.ok) {
      const issueList = consistency.issues.map(i => `  - [${i.severity}] ${i.description}`).join('\n');
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `⚠️ 变更后一致性检查:\n${issueList}` });
    } else {
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '✅ 变更后文档一致性检查通过' });
    }

    // ── Step 6: 标记受影响 Feature ──
    const affectedIds = impact.affectedFeatures.map(f => f.featureId);
    if (affectedIds.length > 0) {
      const placeholders = affectedIds.map(() => '?').join(',');
      db.prepare(`UPDATE features SET status = 'todo', locked_by = NULL WHERE id IN (${placeholders}) AND project_id = ? AND status IN ('passed', 'qa_passed', 'failed', 'pm_rejected')`)
        .run(...affectedIds, projectId);

      sendToUI(win, 'agent:log', {
        projectId, agentId: 'system',
        content: `🔄 ${affectedIds.length} 个 Feature 已标记为待返工: ${affectedIds.join(', ')}`,
      });
    }

    // 完成
    db.prepare("UPDATE change_requests SET status = 'completed', affected_features = ?, completed_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(affectedIds), changeRequestId);

    emitEvent({ projectId, agentId: 'system', type: 'change-request:completed', data: { changeRequestId, affectedCount: affectedIds.length } });
    createCheckpoint(projectId, `需求变更完成: ${description.slice(0, 50)} (影响 ${affectedIds.length} features)`);

    sendToUI(win, 'agent:log', {
      projectId, agentId: 'system',
      content: `✅ 需求变更处理完成! 影响 ${affectedIds.length} 个 Feature, 文档已级联更新。`,
    });

    return { success: true };

  } catch (err: unknown) {
    if (signal.aborted) return { success: false, error: 'Aborted' };
    db.prepare("UPDATE change_requests SET status = 'failed' WHERE id = ?").run(changeRequestId);
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `❌ 需求变更失败: ${(err instanceof Error ? err.message : String(err))}` });
    return { success: false, error: (err instanceof Error ? err.message : String(err)) };
  }
}

// ═══════════════════════════════════════
// Step 1: Impact Analysis
// ═══════════════════════════════════════

async function analyzeImpact(
  projectId: string, changeDescription: string, settings: AppSettings,
  win: BrowserWindow | null, signal: AbortSignal, workspacePath: string,
): Promise<ImpactAnalysis | null> {
  const db = getDb();
  const pmId = 'pm-0';  // 固定 ID: 影响分析复用 PM Agent
  spawnAgent(projectId, pmId, 'pm', win);
  sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: '🔍 PM 开始影响分析...' });

  // 收集上下文
  const designContext = buildDesignContext(workspacePath, 6000);
  const features = db.prepare("SELECT id, title, description, status FROM features WHERE project_id = ?")
    .all(projectId) as Array<{ id: string; title: string; description: string; status: string }>;
  const featureList = features.map(f => `- ${f.id} [${f.status}]: ${f.title}`).join('\n');

  // 列出现有文档
  const reqDocs = listDocs(workspacePath, 'requirement');
  const testDocs = listDocs(workspacePath, 'test_spec');
  const docList = [
    '设计文档: design.md',
    ...reqDocs.map(d => `子需求: ${d.id} (v${d.version})`),
    ...testDocs.map(d => `测试规格: ${d.id} (v${d.version})`),
  ].join('\n');

  try {
    const result = await callLLM(settings, settings.strongModel, [
      { role: 'system', content: PM_IMPACT_ANALYSIS_PROMPT },
      {
        role: 'user',
        content: [
          `## 需求变更描述\n${changeDescription}`,
          `\n## 当前设计文档\n${designContext}`,
          `\n## Feature 清单 (${features.length} 个)\n${featureList}`,
          `\n## 现有文档\n${docList}`,
          `\n请分析此变更的影响范围，输出 JSON。`,
        ].join('\n'),
      },
    ], signal, 8192);

    const cost = calcCost(settings.strongModel, result.inputTokens, result.outputTokens);
    updateAgentStats(pmId, projectId, result.inputTokens, result.outputTokens, cost);

    const parseResult = parseStructuredOutput<ImpactAnalysis>(result.content, IMPACT_ANALYSIS_SCHEMA);
    if (parseResult.ok) {
      const impact = parseResult.data;
      sendToUI(win, 'agent:log', {
        projectId, agentId: pmId,
        content: `✅ 影响分析完成: ${impact.affectedFeatures.length} features, ${impact.docsToUpdate.length} docs, 风险 ${impact.riskLevel} ($${cost.toFixed(4)})`,
      });
      addLog(projectId, pmId, 'output', JSON.stringify(impact, null, 2).slice(0, 3000));
      return impact;
    } else {
      sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `❌ 影响分析输出解析失败: ${parseResult.error}` });
      return null;
    }
  } catch (err: unknown) {
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `❌ 影响分析失败: ${(err instanceof Error ? err.message : String(err))}` });
    return null;
  }
}

// ═══════════════════════════════════════
// Step 2: Update Design Document
// ═══════════════════════════════════════

async function updateDesignDoc(
  projectId: string, changeDescription: string, impact: ImpactAnalysis,
  settings: AppSettings, win: BrowserWindow | null, signal: AbortSignal, workspacePath: string,
): Promise<void> {
  const pmId = 'pm-0';  // 固定 ID: 更新设计文档复用 PM Agent
  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '📝 PM 更新设计文档...' });

  const currentDesign = readDoc(workspacePath, 'design') || '(设计文档不存在)';
  const affectedSummary = impact.affectedFeatures
    .map(f => `- ${f.featureId}: ${f.reason} (${f.severity})`)
    .join('\n');

  try {
    const result = await callLLM(settings, settings.strongModel, [
      { role: 'system', content: PM_UPDATE_DESIGN_PROMPT },
      {
        role: 'user',
        content: [
          `## 需求变更\n${changeDescription}`,
          `\n## 影响范围\n${affectedSummary}`,
          `\n## 当前设计文档\n${currentDesign}`,
          `\n请更新设计文档以反映此变更。输出完整的更新后文档。`,
        ].join('\n'),
      },
    ], signal, 16384);

    const cost = calcCost(settings.strongModel, result.inputTokens, result.outputTokens);
    const version = writeDoc(workspacePath, 'design', result.content, pmId, `需求变更: ${changeDescription.slice(0, 100)}`);
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `✅ 设计文档更新至 v${version} ($${cost.toFixed(4)})` });
  } catch (err: unknown) {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `⚠️ 设计文档更新失败: ${(err instanceof Error ? err.message : String(err))}` });
  }
}

// ═══════════════════════════════════════
// Step 3: Update Requirement Document
// ═══════════════════════════════════════

async function updateRequirementDoc(
  projectId: string, featureId: string, changeDescription: string,
  settings: AppSettings, win: BrowserWindow | null, signal: AbortSignal, workspacePath: string,
): Promise<void> {
  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `📝 PM 更新 ${featureId} 子需求...` });

  const currentReq = readDoc(workspacePath, 'requirement', featureId);
  if (!currentReq) {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ⚠️ ${featureId} 无子需求文档, 跳过` });
    return;
  }

  const designContext = buildDesignContext(workspacePath, 3000);

  try {
    const result = await callLLM(settings, settings.strongModel, [
      { role: 'system', content: PM_UPDATE_DESIGN_PROMPT },
      {
        role: 'user',
        content: [
          `## 需求变更\n${changeDescription}`,
          `\n## 设计文档上下文\n${designContext}`,
          `\n## 当前子需求文档\n${currentReq}`,
          `\n请更新此子需求文档以反映变更。输出完整的更新后文档。在变更历史中添加新条目。`,
        ].join('\n'),
      },
    ], signal, 8192);

    const cost = calcCost(settings.strongModel, result.inputTokens, result.outputTokens);
    const pmId = 'pm-0';  // 固定 ID: 更新需求文档复用 PM Agent
    const version = writeDoc(workspacePath, 'requirement', result.content, pmId, `变更: ${changeDescription.slice(0, 80)}`, featureId);

    const db = getDb();
    db.prepare("UPDATE features SET requirement_doc_ver = ? WHERE id = ? AND project_id = ?")
      .run(version, featureId, projectId);

    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ✅ ${featureId} 子需求更新至 v${version} ($${cost.toFixed(4)})` });
  } catch (err: unknown) {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ⚠️ ${featureId} 子需求更新失败: ${(err instanceof Error ? err.message : String(err))}` });
  }
}

// ═══════════════════════════════════════
// Step 4: Update Test Spec Document
// ═══════════════════════════════════════

async function updateTestSpecDoc(
  projectId: string, featureId: string, changeDescription: string,
  settings: AppSettings, win: BrowserWindow | null, signal: AbortSignal, workspacePath: string,
): Promise<void> {
  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `📝 QA 更新 ${featureId} 测试规格...` });

  const currentSpec = readDoc(workspacePath, 'test_spec', featureId);
  const currentReq = readDoc(workspacePath, 'requirement', featureId);

  if (!currentReq) {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ⚠️ ${featureId} 无子需求文档, 跳过测试规格更新` });
    return;
  }

  try {
    const result = await callLLM(settings, settings.strongModel, [
      { role: 'system', content: QA_UPDATE_TEST_SPEC_PROMPT },
      {
        role: 'user',
        content: [
          `## 需求变更\n${changeDescription}`,
          `\n## 更新后的子需求文档\n${currentReq}`,
          currentSpec ? `\n## 当前测试规格\n${currentSpec}` : '\n## 当前测试规格\n(尚无, 需要新建)',
          `\n请${currentSpec ? '更新' : '编写'}测试规格文档。输出完整文档。`,
        ].join('\n'),
      },
    ], signal, 8192);

    const cost = calcCost(settings.strongModel, result.inputTokens, result.outputTokens);
    const qaId = 'qa-0';  // 固定 ID: 更新测试文档复用 QA Agent
    const version = writeDoc(workspacePath, 'test_spec', result.content, qaId, `变更: ${changeDescription.slice(0, 80)}`, featureId);

    const db = getDb();
    db.prepare("UPDATE features SET test_spec_doc_ver = ? WHERE id = ? AND project_id = ?")
      .run(version, featureId, projectId);

    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ✅ ${featureId} 测试规格更新至 v${version} ($${cost.toFixed(4)})` });
  } catch (err: unknown) {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ⚠️ ${featureId} 测试规格更新失败: ${(err instanceof Error ? err.message : String(err))}` });
  }
}

// ═══════════════════════════════════════
// Implicit Change Detection (v4.3.1)
// ═══════════════════════════════════════

/**
 * 需求分诊 (Wish Triage) — 用于检测新 wish 中隐含的对现有需求的变更
 *
 * 核心洞察: 用户不会说"我要变更需求"。他们会说"加个多语言功能"——
 * 但这暗含了对现有 UI 文案、数据模型、验证逻辑的变更。
 *
 * 此函数将新 wish 与现有 features/docs 进行语义比对, 输出结构化分诊结果:
 *  - pure_new: 完全是新功能, 不影响已有 feature
 *  - has_changes: 既有新功能, 也隐含对旧 feature 的变更
 *  - pure_change: 没有新功能, 纯粹是对现有功能的修改
 *
 * @returns 分诊结果, 包含新增 feature 候选和隐式变更清单
 */
export interface WishTriageResult {
  /** 分诊分类 */
  category: 'pure_new' | 'has_changes' | 'pure_change';
  /** 新增的功能描述 (供后续 PM Phase 1 生成新 Feature) */
  newCapabilities: Array<{
    title: string;
    description: string;
  }>;
  /** 对现有 Feature 的隐式变更 */
  implicitChanges: Array<{
    featureId: string;
    featureTitle: string;
    changeDescription: string;
    severity: 'major' | 'minor';
  }>;
  /** 可能的冲突/矛盾 */
  conflicts: Array<{
    description: string;
    involvedFeatures: string[];
  }>;
  /** 分诊理由 (human-readable) */
  reasoning: string;
}

/** Wish Triage JSON Schema */
const WISH_TRIAGE_SCHEMA = {
  topLevel: 'object' as const,
  fields: {
    category:         { type: 'string' as const, required: true, enum: ['pure_new', 'has_changes', 'pure_change'], default: 'has_changes' },
    newCapabilities:  { type: 'array' as const,  required: true, default: [] },
    implicitChanges:  { type: 'array' as const,  required: true, default: [] },
    conflicts:        { type: 'array' as const,  required: false, default: [] },
    reasoning:        { type: 'string' as const, required: true, default: '' },
  },
};

/**
 * 需求分诊 — 由 PM 角色执行 (需要项目上下文: 已有 Feature + 设计文档)
 *
 * 注意: 元 Agent 是通用管家, 不加载项目设计内容, 只负责需求接收/路由。
 * 分诊涉及与已有 Feature 的比对和设计文档的理解, 因此必须由 PM 执行。
 */
export async function detectImplicitChanges(
  projectId: string,
  newWish: string,
  settings: AppSettings,
  win: BrowserWindow | null,
  signal: AbortSignal,
  workspacePath: string,
): Promise<WishTriageResult | null> {
  const db = getDb();
  const pmId = 'pm-0';  // 固定 ID: 分诊复用 PM Agent

  sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: '🔎 Phase 0: 分诊新需求 — 识别隐式变更...' });

  // 收集现有上下文
  const existingFeatures = db.prepare(
    "SELECT id, title, description, summary, status, acceptance_criteria FROM features WHERE project_id = ? ORDER BY priority ASC"
  ).all(projectId) as Array<{ id: string; title: string; description: string; summary: string | null; status: string; acceptance_criteria: string }>;

  const featureList = existingFeatures.map(f => {
    let criteria = '';
    try { criteria = JSON.parse(f.acceptance_criteria || '[]').join('; '); } catch { /* silent: acceptance_criteria JSON parse */ }
    // D3: 优先使用 summary 减少 token，fallback 到 description
    const desc = f.summary || f.description;
    return `- **${f.id}** [${f.status}]: ${f.title}\n  摘要: ${desc}\n  验收: ${criteria}`;
  }).join('\n');

  const designContext = buildDesignContext(workspacePath, 4000);

  try {
    const result = await callLLM(settings, settings.strongModel, [
      { role: 'system', content: PM_WISH_TRIAGE_PROMPT },
      {
        role: 'user',
        content: [
          `## 新的用户需求\n${newWish}`,
          `\n## 现有 Feature 清单 (${existingFeatures.length} 个)\n${featureList}`,
          designContext ? `\n## 当前设计文档\n${designContext}` : '',
          `\n请分析此新需求是纯新增、含隐式变更、还是纯变更。输出 JSON。`,
        ].filter(Boolean).join('\n'),
      },
    ], signal, 8192);

    const cost = calcCost(settings.strongModel, result.inputTokens, result.outputTokens);
    updateAgentStats(pmId, projectId, result.inputTokens, result.outputTokens, cost);

    const parseResult = parseStructuredOutput<WishTriageResult>(result.content, WISH_TRIAGE_SCHEMA);
    if (!parseResult.ok) {
      sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `⚠️ 分诊输出解析失败: ${parseResult.error}. 默认视为 has_changes` });
      return {
        category: 'has_changes',
        newCapabilities: [{ title: '新需求', description: newWish }],
        implicitChanges: [],
        conflicts: [],
        reasoning: '分诊解析失败, 保守处理为含变更',
      };
    }

    const triage = parseResult.data;

    // 结果汇报
    const changeCount = triage.implicitChanges.length;
    const newCount = triage.newCapabilities.length;
    const conflictCount = triage.conflicts.length;

    const icon = triage.category === 'pure_new' ? '🆕' : triage.category === 'pure_change' ? '🔄' : '🔀';
    const details = [
      `${icon} 分诊结果: **${triage.category}**`,
      newCount > 0 ? `  🆕 新增功能: ${newCount} 项` : null,
      changeCount > 0 ? `  🔄 隐式变更: ${changeCount} 个现有 Feature` : null,
      conflictCount > 0 ? `  ⚠️ 潜在冲突: ${conflictCount} 处` : null,
      `  💡 ${triage.reasoning}`,
      `  ($${cost.toFixed(4)})`,
    ].filter(Boolean).join('\n');

    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: details });
    addLog(projectId, pmId, 'output', `Wish Triage: ${JSON.stringify(triage, null, 2).slice(0, 3000)}`);

    // 如果有隐式变更, 逐条通知
    for (const change of triage.implicitChanges) {
      sendToUI(win, 'agent:log', {
        projectId, agentId: pmId,
        content: `  🔄 ${change.featureId} (${change.featureTitle}): ${change.changeDescription} [${change.severity}]`,
      });
    }

    // 如果有冲突, 警告
    for (const conflict of triage.conflicts) {
      sendToUI(win, 'agent:log', {
        projectId, agentId: pmId,
        content: `  ⚡ 冲突: ${conflict.description} (涉及: ${conflict.involvedFeatures.join(', ')})`,
      });
    }

    emitEvent({
      projectId, agentId: pmId, type: 'wish:triaged',
      data: { category: triage.category, newCount, changeCount, conflictCount },
    });

    return triage;

  } catch (err: unknown) {
    if (signal.aborted) return null;
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `⚠️ 分诊失败: ${(err instanceof Error ? err.message : String(err))}. 默认视为纯新增` });
    return {
      category: 'pure_new',
      newCapabilities: [{ title: '新需求', description: newWish }],
      implicitChanges: [],
      conflicts: [],
      reasoning: `分诊异常 (${(err instanceof Error ? err.message : String(err))}), 保守处理为纯新增`,
    };
  }
}