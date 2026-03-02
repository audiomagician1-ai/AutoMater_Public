/**
 * Finalize Phase — 汇总 + 用户验收等待
 * Extracted from orchestrator.ts for maintainability.
 * @module phases/finalize-phase
 */

import {
  BrowserWindow, getDb, createLogger,
  sendToUI, notify,
  emitEvent, createCheckpoint,
  commitWorkspace,
  extractFromProjectMemory,
  type AppSettings,
} from './shared';
import { contributeToGlobal } from '../experience-library';

const log = createLogger('phase:finalize');

export async function phaseFinalize(
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
    notify(stats.passed > 0 ? '⏸️ 项目部分完成' : '❌ 项目暂停', `${stats.passed}/${stats.total} features 通过`);
  }

  if (workspacePath) await commitWorkspace(workspacePath, `AutoMater: ${stats.passed}/${stats.total} features delivered`);

  emitEvent({
    projectId, agentId: 'system', type: 'project:complete',
    data: { status: finalStatus, passed: stats.passed, failed: stats.failed, pmRejected: stats.pm_rejected, total: stats.total },
  });
  createCheckpoint(projectId, `项目${allPassed ? '等待验收' : '暂停'} (${stats.passed}/${stats.total})`);

  // Extract cross-project experience
  if (workspacePath && stats.passed > 0) {
    try {
      const extracted = extractFromProjectMemory(workspacePath, projectName);
      if (extracted > 0) {
        sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `🌐 已将 ${extracted} 条经验提取到全局经验池` });
      }
    } catch (err) {
      log.warn('Cross-project experience extraction failed', { error: String(err) });
    }

    // v22.0: 分层经验库 — 将高频使用的 patterns 贡献到全局
    try {
      const contributed = contributeToGlobal(workspacePath, projectName);
      if (contributed > 0) {
        sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `📚 已将 ${contributed} 条分层经验贡献到全局经验库` });
      }
    } catch (err) {
      log.warn('Experience library global contribution failed', { error: String(err) });
    }
  }
}
