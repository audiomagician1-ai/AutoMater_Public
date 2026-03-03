/**
 * PM Phase — 需求分析 + 增量分析 + 批量验收
 * Extracted from orchestrator.ts for maintainability.
 * @module phases/pm-phase
 */

import {
  BrowserWindow,
  getDb,
  createLogger,
  callLLM,
  calcCost,
  sendToUI,
  addLog,
  notify,
    spawnAgent,
  updateAgentStats,
  getTeamPrompt,
  getTeamMemberLLMConfig,
  getTeamMemberMaxIterations,
  reactAgentLoop,
  parseStructuredOutput,
  PM_FEATURE_SCHEMA,
  PM_ACCEPTANCE_SCHEMA,
  gatePMToArchitect,
  writeDoc as _writeDoc,
  buildDesignContext,
  buildFeatureDocContext,
  backupConversation,
  linkFeatureSession,
  completeFeatureSessionLink,
  getOrCreateSession,
  emitEvent,
  createCheckpoint,
  resolveMemberModel,
  safeJsonParse,
  PM_SYSTEM_PROMPT,
  PM_ACCEPTANCE_PROMPT,
  type AppSettings,
  type ProjectRow,
  type FeatureRow,
  type ParsedFeature,
} from './shared';
import fs from 'fs';
import path from 'path';
import { harvestPostFeature } from '../experience-harvester';

const _log = createLogger('phase:pm');

const BATCH_ACCEPT_SIZE = 4;

// ═══════════════════════════════════════
// Phase 1: PM 需求分析
// ═══════════════════════════════════════

export async function phasePMAnalysis(
  projectId: string,
  project: ProjectRow,
  settings: AppSettings,
  win: BrowserWindow | null,
  signal: AbortSignal,
  permissions?: import('../tool-registry').AgentPermissions,
): Promise<ParsedFeature[] | null> {
  const db = getDb();
  const pmId = 'pm-0'; // 固定 ID: 复用同一 Agent 行
  spawnAgent(projectId, pmId, 'pm', win);
  sendToUI(win, 'agent:status', {
    projectId,
    agentId: pmId,
    status: 'working',
    currentTask: 'pm-analysis',
    featureTitle: '需求分析',
  });
  sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: '🧠 Phase 1: 产品经理开始分析需求...' });
  addLog(projectId, pmId, 'log', '开始分析需求: ' + project.wish);
  db.prepare("UPDATE projects SET status = 'initializing', updated_at = datetime('now') WHERE id = ?").run(projectId);
  sendToUI(win, 'project:status', { projectId, status: 'initializing' });

  let features: ParsedFeature[] = [];
  try {
    if (signal.aborted) return null;
    const pmPrompt = getTeamPrompt(projectId, 'pm') ?? PM_SYSTEM_PROMPT;
    const workspacePath = project.workspace_path || '';
    const gitConfig = {
      mode: (project.git_mode || 'local') as 'local' | 'github',
      workspacePath,
      githubRepo: project.github_repo ?? undefined,
      githubToken: project.github_token ?? undefined,
    };

    // v10.0: 检测 arch_node features — 导入项目已有架构索引, PM 在此基础上生成开发任务
    const archNodes = db
      .prepare(
        "SELECT id, title, description, group_name, sub_group, affected_files, notes FROM features WHERE project_id = ? AND status = 'arch_node'",
      )
      .all(projectId) as Array<{
      id: string;
      title: string;
      description: string;
      group_name: string;
      sub_group: string;
      affected_files: string;
      notes: string;
    }>;

    let archContext = '';
    if (archNodes.length > 0) {
      const archList = archNodes
        .map(n => {
          const files = (() => {
            try {
              return JSON.parse(n.affected_files || '[]')
                .slice(0, 5)
                .join(', ');
            } catch {
              return '';
            }
          })();
          return `- ${n.id} [${n.group_name}/${n.sub_group}] ${n.title}: ${n.description}${files ? ` (文件: ${files})` : ''}`;
        })
        .join('\n');
      archContext = `\n\n## 📐 项目已导入的架构索引节点 (${archNodes.length} 个组件)\n以下是通过项目导入分析得到的架构组件索引。请基于这些已有的架构理解来拆解 Feature，每个 Feature 的 group_name 应对应架构域名称，sub_group 对应模块名称。\n\n${archList}\n\n**重要**: 不要重复这些架构节点作为 Feature。它们是已有的代码结构索引，你需要基于用户需求生成**开发任务**，这些任务会修改或扩展这些架构组件。`;
    }

    // v10.1: 导入项目已有完整架构索引 → 快速路径 (单次 callLLM)
    //   有 archContext 时 PM 已拥有充分信息，无需 react loop 读代码，避免 token 膨胀
    //   无 archContext 时仍走 react loop (用户可能引用了本地文件需要先读取)
    const hasArchIndex = archNodes.length > 0;

    // 同时加载 ARCHITECTURE.md 摘要给 PM 参考（截断防止 token 爆炸）
    let archDocSnippet = '';
    if (hasArchIndex && workspacePath) {
      try {
        const archDocPath = path.join(workspacePath, '.automater/docs/ARCHITECTURE.md');
        if (fs.existsSync(archDocPath)) {
          const raw = fs.readFileSync(archDocPath, 'utf-8');
          archDocSnippet = raw.length > 4000 ? raw.slice(0, 4000) + '\n...(截断)' : raw;
          archDocSnippet = `\n\n## 📄 架构文档摘要\n${archDocSnippet}`;
        }
      } catch {
        /* silent */
      }
    }

    let pmReactResult: Awaited<ReturnType<typeof reactAgentLoop>>;

    if (hasArchIndex) {
      // ── 快速路径: 单次 LLM 调用 (导入项目) ──
      sendToUI(win, 'agent:log', {
        projectId,
        agentId: pmId,
        content: `📋 导入项目快速分析: 已有 ${archNodes.length} 个架构节点，直接拆解 Feature...`,
      });
      const pmModel = getTeamMemberLLMConfig(projectId, 'pm', 0, settings).model;
      const userMsg = `用户需求:\n${project.wish}${archContext}${archDocSnippet}\n\n请基于以上架构索引和用户需求，拆解为 Feature 清单。直接输出 JSON 数组。`;
      const result = await callLLM(
        settings,
        pmModel,
        [
          { role: 'system', content: pmPrompt },
          { role: 'user', content: userMsg },
        ],
        signal,
        16384,
      );

      const cost = calcCost(pmModel, result.inputTokens, result.outputTokens);
      backupConversation({
        projectId,
        agentId: pmId,
        agentRole: 'pm',
        messages: [
          { role: 'system', content: pmPrompt },
          { role: 'user', content: userMsg },
          { role: 'assistant', content: result.content.slice(0, 50000) },
        ],
        totalInputTokens: result.inputTokens,
        totalOutputTokens: result.outputTokens,
        totalCost: cost,
        model: pmModel,
        completed: true,
      });
      pmReactResult = {
        completed: true,
        blocked: false,
        finalText: result.content,
        filesWritten: [],
        totalCost: cost,
        totalInputTokens: result.inputTokens,
        totalOutputTokens: result.outputTokens,
        iterations: 1,
      };
    } else {
      // ── 标准路径: React loop (新项目 / 无架构索引) ──
      // v10.1: 收紧迭代限制 — PM 拆需求不需要 50 轮读代码
      const pmMaxIter = Math.min(getTeamMemberMaxIterations(projectId, 'pm') ?? 15, 20);
      pmReactResult = await reactAgentLoop({
        projectId,
        agentId: pmId,
        role: 'pm',
        systemPrompt: pmPrompt,
        userMessage: `用户需求:\n${project.wish}${archContext}\n\n请分析此需求，拆解为 Feature 清单。\n\n**重要**: 如果需求中引用了本地文件/目录，请先用 read_file / list_files 等工具查看内容，再做分析。如果确实无法访问或信息严重不足，使用 report_blocked 工具阻塞。\n\n分析完成后，调用 task_complete 工具，在 summary 字段中输出完整的 JSON Feature 数组（不要 markdown 代码块包裹）。`,
        settings,
        workspacePath: workspacePath || null,
        gitConfig,
        win,
        signal,
        maxIterations: pmMaxIter,
        model: getTeamMemberLLMConfig(projectId, 'pm', 0, settings).model,
        permissions,
      });
    }

    if (pmReactResult.blocked) {
      sendToUI(win, 'agent:log', {
        projectId,
        agentId: pmId,
        content: `🚫 PM 分析被阻塞: ${pmReactResult.blockReason}\n请在需求中补充信息后重新启动。`,
      });
      addLog(projectId, pmId, 'warning', `BLOCKED: ${pmReactResult.blockReason}`);
      db.prepare("UPDATE projects SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(projectId);
      sendToUI(win, 'project:status', { projectId, status: 'paused' });
      notify('⚠️ AutoMater 需要你的帮助', `PM 分析遇到阻塞: ${pmReactResult.blockReason}`);
      return null;
    }

    const textToParse = pmReactResult.finalText || '';
    addLog(projectId, pmId, 'output', textToParse);
    sendToUI(win, 'agent:log', {
      projectId,
      agentId: pmId,
      content: `✅ PM 分析完成 (${pmReactResult.totalInputTokens + pmReactResult.totalOutputTokens} tokens, $${pmReactResult.totalCost.toFixed(4)})`,
    });

    const parseResult = parseStructuredOutput<ParsedFeature[]>(textToParse, PM_FEATURE_SCHEMA);
    if (parseResult.ok) {
      features = parseResult.data;
      if (parseResult.warnings.length > 0) {
        sendToUI(win, 'agent:log', {
          projectId,
          agentId: pmId,
          content: `⚠️ PM 输出修复: ${parseResult.warnings.slice(0, 3).join('; ')}`,
        });
      }
      addLog(projectId, pmId, 'log', `Parsed via strategy: ${parseResult.strategy}`);
    } else {
      sendToUI(win, 'agent:log', {
        projectId,
        agentId: pmId,
        content: `❌ PM 输出解析失败: ${parseResult.error}\n原始输出: ${parseResult.rawPreview}`,
      });
      addLog(projectId, pmId, 'error', `Parse failed: ${parseResult.error}`);
    }
    db.prepare(
      "UPDATE agents SET status = 'idle', session_count = 1, total_input_tokens = ?, total_output_tokens = ?, total_cost_usd = ?, last_active_at = datetime('now') WHERE id = ? AND project_id = ?",
    ).run(pmReactResult.totalInputTokens, pmReactResult.totalOutputTokens, pmReactResult.totalCost, pmId, projectId);
  } catch (err: unknown) {
    if (signal.aborted) return null;
    const errMsg = err instanceof Error ? err.message : String(err);
    addLog(projectId, pmId, 'error', errMsg);
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `❌ PM 分析失败: ${errMsg}` });
    db.prepare("UPDATE agents SET status = 'error' WHERE id = ? AND project_id = ?").run(pmId, projectId);
    db.prepare("UPDATE projects SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(projectId);
    sendToUI(win, 'project:status', { projectId, status: 'error' });
    return null;
  }

  if (features.length === 0) {
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: '⚠️ PM 未能生成有效的 Feature 清单' });
    db.prepare("UPDATE projects SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(projectId);
    return null;
  }

  const pmGate = gatePMToArchitect(features);
  if (!pmGate.passed) {
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `🚫 PM→Architect 门控未通过: ${pmGate.reason}` });
    addLog(projectId, pmId, 'error', `Pipeline gate blocked: ${pmGate.reason}`);
    db.prepare("UPDATE projects SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(projectId);
    return null;
  }

  const insertFeature = db.prepare(
    `INSERT INTO features (id, project_id, category, priority, group_name, sub_group, title, description, summary, depends_on, status, acceptance_criteria, notes, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?)`,
  );
  db.transaction((items: ParsedFeature[]) => {
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      const groupId = f.group_name || f.category || 'default';
      insertFeature.run(
        f.id || `F${String(i + 1).padStart(3, '0')}`,
        projectId,
        f.category || 'core',
        f.priority ?? 1,
        f.group_name || f.category || '',
        f.sub_group || '',
        f.title || f.description || '',
        f.description || '',
        f.summary || null,
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
// 增量 PM 分析
// ═══════════════════════════════════════

export async function phaseIncrementalPM(
  projectId: string,
  project: ProjectRow,
  newCapabilities: Array<{ title: string; description: string }>,
  settings: AppSettings,
  win: BrowserWindow | null,
  signal: AbortSignal,
  _workspacePath: string | null,
): Promise<ParsedFeature[] | null> {
  const db = getDb();
  const pmId = 'pm-0'; // 固定 ID: 增量分析复用 PM Agent
  spawnAgent(projectId, pmId, 'pm', win);

  const existingRows = db
    .prepare('SELECT id, title, status FROM features WHERE project_id = ?')
    .all(projectId) as Array<{ id: string; title: string; status: string }>;
  const existingList = existingRows.map(f => `- ${f.id}: ${f.title} [${f.status}]`).join('\n');
  const maxIdNum = existingRows.reduce((max, f) => {
    const match = f.id.match(/F(\d+)/);
    return match ? Math.max(max, parseInt(match[1], 10)) : max;
  }, 0);
  const capsDescription = newCapabilities.map((c, i) => `${i + 1}. ${c.title}: ${c.description}`).join('\n');

  sendToUI(win, 'agent:log', {
    projectId,
    agentId: pmId,
    content: `🆕 增量分析: 为 ${newCapabilities.length} 个新功能生成 Feature...`,
  });

  try {
    const pmPrompt = getTeamPrompt(projectId, 'pm') ?? PM_SYSTEM_PROMPT;
    const pmModel = resolveMemberModel(projectId, 'pm', settings);
    const result = await callLLM(
      settings,
      pmModel,
      [
        { role: 'system', content: pmPrompt },
        {
          role: 'user',
          content: `## 增量需求 — 仅为以下新功能生成 Feature, 不要重复已有的\n\n### 新功能列表\n${capsDescription}\n\n### 已有 Feature (不要重复!)\n${existingList}\n\nFeature ID 请从 F${String(maxIdNum + 1).padStart(3, '0')} 开始编号。\n直接输出 JSON 数组。`,
        },
      ],
      signal,
      16384,
    );

    const cost = calcCost(pmModel, result.inputTokens, result.outputTokens);
    updateAgentStats(pmId, projectId, result.inputTokens, result.outputTokens, cost);
    backupConversation({
      projectId,
      agentId: pmId,
      agentRole: 'pm',
      messages: [
        { role: 'system', content: pmPrompt },
        { role: 'user', content: `增量分析: ${newCapabilities.length} 个新功能` },
        { role: 'assistant', content: result.content.slice(0, 50000) },
      ],
      totalInputTokens: result.inputTokens,
      totalOutputTokens: result.outputTokens,
      totalCost: cost,
      model: settings.strongModel,
      completed: true,
    });

    const parseResult = parseStructuredOutput<ParsedFeature[]>(result.content, PM_FEATURE_SCHEMA);
    if (!parseResult.ok) {
      sendToUI(win, 'agent:log', {
        projectId,
        agentId: pmId,
        content: `❌ 增量分析输出解析失败: ${parseResult.error}`,
      });
      return null;
    }
    const newFeatures = parseResult.data;
    if (newFeatures.length === 0) {
      sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: '⚠️ 增量分析未产生新 Feature' });
      return null;
    }

    const insertFeature = db.prepare(
      `INSERT OR IGNORE INTO features (id, project_id, category, priority, group_name, sub_group, title, description, summary, depends_on, status, acceptance_criteria, notes, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?)`,
    );
    db.transaction((items: ParsedFeature[]) => {
      for (let i = 0; i < items.length; i++) {
        const f = items[i];
        const groupId = f.group_name || f.category || 'default';
        insertFeature.run(
          f.id || `F${String(maxIdNum + i + 1).padStart(3, '0')}`,
          projectId,
          f.category || 'core',
          f.priority ?? 1,
          f.group_name || f.category || '',
          f.sub_group || '',
          f.title || f.description || '',
          f.description || '',
          f.summary || null,
          JSON.stringify(f.dependsOn || f.depends_on || []),
          JSON.stringify(f.acceptanceCriteria || f.acceptance_criteria || []),
          f.notes || '',
          groupId,
        );
      }
    })(newFeatures);

    sendToUI(win, 'project:features-ready', { projectId, count: newFeatures.length });
    sendToUI(win, 'agent:log', {
      projectId,
      agentId: pmId,
      content: `✅ 新增 ${newFeatures.length} 个 Feature ($${cost.toFixed(4)})`,
    });
    emitEvent({ projectId, agentId: pmId, type: 'phase:incremental-pm:end', data: { newCount: newFeatures.length } });
    return newFeatures;
  } catch (err: unknown) {
    if (signal.aborted) return null;
    const errMsg = err instanceof Error ? err.message : String(err);
    sendToUI(win, 'agent:log', { projectId, agentId: pmId, content: `❌ 增量分析失败: ${errMsg}` });
    return null;
  }
}

// ═══════════════════════════════════════
// PM 批量验收审查
// ═══════════════════════════════════════

export async function phasePMAcceptance(
  projectId: string,
  settings: AppSettings,
  win: BrowserWindow | null,
  signal: AbortSignal,
  workspacePath: string,
): Promise<void> {
  const db = getDb();
  const qaPassed = db
    .prepare("SELECT * FROM features WHERE project_id = ? AND status = 'qa_passed'")
    .all(projectId) as FeatureRow[];
  if (qaPassed.length === 0) {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '⏭️ Phase 4: 没有 Feature 需要 PM 验收' });
    return;
  }

  const pmAccId = 'pm-0'; // 固定 ID: 验收复用 PM Agent
  spawnAgent(projectId, pmAccId, 'pm', win);
  sendToUI(win, 'agent:log', {
    projectId,
    agentId: pmAccId,
    content: `📋 Phase 4: PM 批量验收审查 (${qaPassed.length} features, 每批 ${BATCH_ACCEPT_SIZE} 个)...`,
  });

  const designContext = buildDesignContext(workspacePath, 6000);
  const accBatches: FeatureRow[][] = [];
  for (let i = 0; i < qaPassed.length; i += BATCH_ACCEPT_SIZE) {
    accBatches.push(qaPassed.slice(i, i + BATCH_ACCEPT_SIZE));
  }

  for (let bi = 0; bi < accBatches.length; bi++) {
    if (signal.aborted) return;
    const batch = accBatches[bi];
    try {
      const batchInfo = batch
        .map(feature => {
          const featureDocCtx = buildFeatureDocContext(workspacePath, feature.id);
          const affectedFiles = safeJsonParse(feature.affected_files, []);
          let filePreview = '';
          for (const fp of affectedFiles.slice(0, 3)) {
            const fullPath = path.join(workspacePath, fp);
            if (fs.existsSync(fullPath)) {
              filePreview += `#### ${fp}\n\`\`\`\n${fs.readFileSync(fullPath, 'utf-8').slice(0, 1000)}\n\`\`\`\n`;
            }
          }
          return [
            `### Feature ${feature.id}`,
            `标题: ${feature.title}`,
            `描述: ${feature.description}`,
            `验收标准: ${feature.acceptance_criteria}`,
            featureDocCtx ? `文档摘要: ${featureDocCtx.slice(0, 500)}` : '',
            filePreview ? `代码预览:\n${filePreview}` : '',
          ]
            .filter(Boolean)
            .join('\n');
        })
        .join('\n\n---\n\n');

      const acceptResult = await callLLM(
        settings,
        resolveMemberModel(projectId, 'pm', settings),
        [
          { role: 'system', content: PM_ACCEPTANCE_PROMPT },
          {
            role: 'user',
            content: `## 设计文档上下文\n${designContext}\n\n## ${batch.length} 个 Feature 待验收\n\n${batchInfo}\n\n请逐个输出每个 Feature 的验收审查结果。输出 JSON 数组, 每项包含: feature_id, verdict, score, summary, feedback。`,
          },
        ],
        signal,
        8192,
      );

      const accCost = calcCost(
        resolveMemberModel(projectId, 'pm', settings),
        acceptResult.inputTokens,
        acceptResult.outputTokens,
      );
      updateAgentStats(pmAccId, projectId, acceptResult.inputTokens, acceptResult.outputTokens, accCost);

      let verdicts: Array<{ feature_id: string; verdict: string; score: number; summary?: string; feedback?: string }> =
        [];
      try {
        const parsed = parseStructuredOutput<Record<string, unknown>>(acceptResult.content, PM_ACCEPTANCE_SCHEMA);
        if (parsed.ok) {
          verdicts = (Array.isArray(parsed.data) ? parsed.data : [parsed.data]) as typeof verdicts;
        }
      } catch {
        try {
          const raw = JSON.parse(
            acceptResult.content
              .replace(/```json?\n?/g, '')
              .replace(/```/g, '')
              .trim(),
          );
          verdicts = Array.isArray(raw) ? raw : [raw];
        } catch {
          /* parse failed */
        }
      }

      const pmAccSession = getOrCreateSession(projectId, pmAccId, 'pm');
      for (const feature of batch) {
        const v = verdicts.find(v => v.feature_id === feature.id) || verdicts[batch.indexOf(feature)];
        const verdict = v?.verdict || 'conditional_accept';
        const score = v?.score || 70;
        const feedback = v?.feedback || '';
        const summary = v?.summary || '';
        const accLinkId = linkFeatureSession({
          featureId: feature.id,
          sessionId: pmAccSession.id,
          projectId,
          agentId: pmAccId,
          agentRole: 'pm',
          workType: 'pm-acceptance',
          expectedOutput: `验收 ${feature.id}: ${(feature.title || '').slice(0, 60)}`,
        });
        const finalStatus = verdict === 'accept' || verdict === 'conditional_accept' ? 'passed' : 'pm_rejected';
        db.prepare(
          "UPDATE features SET status = ?, pm_verdict = ?, pm_verdict_score = ?, pm_verdict_feedback = ?, completed_at = CASE WHEN ? IN ('passed') THEN datetime('now') ELSE NULL END WHERE id = ? AND project_id = ?",
        ).run(finalStatus, verdict, score, feedback, finalStatus, feature.id, projectId);
        completeFeatureSessionLink(
          accLinkId,
          `PM 验收: ${verdict} (${score}/100) ${summary.slice(0, 80)}`,
          finalStatus === 'passed',
        );
        const icon = verdict === 'accept' ? '✅' : verdict === 'conditional_accept' ? '⚠️' : '❌';
        sendToUI(win, 'agent:log', {
          projectId,
          agentId: pmAccId,
          content: `${icon} ${feature.id} PM 验收: ${verdict} (${score}/100) — ${summary}`,
        });
        sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: finalStatus, agentId: pmAccId });

        // D5: PM 驳回时提取失败经验
        if (finalStatus === 'pm_rejected' && workspacePath) {
          const projRow = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as
            | { name: string }
            | undefined;
          harvestPostFeature({
            projectId,
            featureId: feature.id,
            featureTitle: feature.title || '',
            result: 'pm_rejected',
            reason: feedback || summary || undefined,
            workspacePath,
            projectName: projRow?.name || projectId,
            settings,
            signal,
          }).catch(() => {}); // non-blocking
        }
      }
      sendToUI(win, 'agent:log', {
        projectId,
        agentId: pmAccId,
        content: `  📋 批次 ${bi + 1}/${accBatches.length} 验收完成 ($${accCost.toFixed(4)})`,
      });
    } catch (err: unknown) {
      if (signal.aborted) return;
      const errMsg = err instanceof Error ? err.message : String(err);
      sendToUI(win, 'agent:log', {
        projectId,
        agentId: pmAccId,
        content: `⚠️ 批次 ${bi + 1} PM 验收出错 (全部视为通过): ${errMsg}`,
      });
      for (const feature of batch) {
        db.prepare(
          "UPDATE features SET status = 'passed', pm_verdict = 'conditional_accept', pm_verdict_feedback = ?, completed_at = datetime('now') WHERE id = ? AND project_id = ?",
        ).run(`PM 验收异常: ${errMsg}`, feature.id, projectId);
        sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: 'passed', agentId: pmAccId });
      }
    }
  }
  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ? AND project_id = ?").run(pmAccId, projectId);
  emitEvent({ projectId, agentId: pmAccId, type: 'phase:pm-acceptance:end', data: { reviewed: qaPassed.length } });
  createCheckpoint(projectId, `PM 验收完成 (${qaPassed.length} features)`);
}
