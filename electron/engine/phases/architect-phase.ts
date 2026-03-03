/**
 * Architect Phase — 技术架构 + 产品设计 (v5.0: 合并原 Phase 2+3)
 * Extracted from orchestrator.ts for maintainability.
 * @module phases/architect-phase
 */

import {
  BrowserWindow, getDb, createLogger, fs, path,
  callLLM, calcCost, sendToUI, addLog, createStreamCallback,
  spawnAgent, updateAgentStats, getTeamPrompt,
  parseFileBlocks, writeFileBlocks,
  writeDoc, backupConversation,
  emitEvent, createCheckpoint,
  resolveMemberModel,
  ARCHITECT_SYSTEM_PROMPT,
  type AppSettings, type ProjectRow, type ParsedFeature,
} from './shared';

const _log = createLogger('phase:architect');

export async function phaseArchitect(
  projectId: string, project: ProjectRow, features: ParsedFeature[], settings: AppSettings,
  win: BrowserWindow | null, signal: AbortSignal, workspacePath: string | null,
): Promise<void> {
  if (signal.aborted) return;

  const db = getDb();
  const archId = 'arch-0';  // 固定 ID: 复用同一 Architect Agent
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
    const archResult = await callLLM(settings, resolveMemberModel(projectId, 'architect', settings), [
      { role: 'system', content: archPrompt },
      { role: 'user', content: `用户需求:\n${project.wish}\n\nFeature 清单 (${features.length} 个):\n${featureSummary}\n\n请完成以下两份文档:\n\n1. **产品设计文档** — 产品愿景、功能全景、用户流程、数据模型概要、非功能性需求\n2. **技术架构文档 (ARCHITECTURE.md)** — 技术选型、目录结构、核心数据模型、模块设计、API 接口、编码规范\n\n两份文档合并为一份完整输出, 先产品设计后技术架构。` },
    ], signal, 16384, 2, onChunk);
    sendToUI(win, 'agent:stream-end', { projectId, agentId: archId });

    const archCost = calcCost(resolveMemberModel(projectId, 'architect', settings), archResult.inputTokens, archResult.outputTokens);
    addLog(projectId, archId, 'output', archResult.content.slice(0, 3000));

    if (workspacePath) {
      writeDoc(workspacePath, 'design', archResult.content, archId, '初始版本: 架构师生成设计+架构文档');
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
    backupConversation({ projectId, agentId: archId, agentRole: 'architect', messages: [{ role: 'system', content: archPrompt }, { role: 'user', content: `架构+产品设计 (${features.length} features)` }, { role: 'assistant', content: archResult.content.slice(0, 50000) }], totalInputTokens: archResult.inputTokens, totalOutputTokens: archResult.outputTokens, totalCost: archCost, model: settings.strongModel, completed: true });

    db.prepare("UPDATE agents SET status = 'idle' WHERE id = ? AND project_id = ?").run(archId, projectId);
    sendToUI(win, 'agent:log', { projectId, agentId: archId, content: `✅ 架构 + 产品设计完成 (${archResult.inputTokens + archResult.outputTokens} tokens, $${archCost.toFixed(4)})` });
    emitEvent({ projectId, agentId: archId, type: 'phase:architect:end', data: { tokens: archResult.inputTokens + archResult.outputTokens, cost: archCost }, inputTokens: archResult.inputTokens, outputTokens: archResult.outputTokens, costUsd: archCost });
    createCheckpoint(projectId, '架构 + 产品设计完成');
  } catch (err: unknown) {
    if (signal.aborted) return;
    const errMsg = err instanceof Error ? err.message : String(err);
    sendToUI(win, 'agent:log', { projectId, agentId: archId, content: `⚠️ 架构设计失败 (非致命): ${errMsg}` });
    db.prepare("UPDATE agents SET status = 'error' WHERE id = ? AND project_id = ?").run(archId, projectId);
  }
}
