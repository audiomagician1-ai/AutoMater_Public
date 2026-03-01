/**
 * Agent Manager — Agent 生命周期管理
 *
 * 运行注册表、spawn、stats更新、预算防护、feature原子锁定、停止
 * 从 orchestrator.ts 拆出 (v2.5)
 */

import { BrowserWindow } from 'electron';
import { getDb } from '../db';
import { sendToUI } from './ui-bridge';

// ═══════════════════════════════════════
// 运行中的编排器注册表（支持停止）
// ═══════════════════════════════════════

const runningOrchestrators = new Map<string, AbortController>();

export function getRunningOrchestrators() {
  return runningOrchestrators;
}

export function registerOrchestrator(projectId: string, ctrl: AbortController) {
  runningOrchestrators.set(projectId, ctrl);
}

export function unregisterOrchestrator(projectId: string) {
  runningOrchestrators.delete(projectId);
}

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
// Agent 生命周期
// ═══════════════════════════════════════

export function spawnAgent(projectId: string, id: string, role: string, win: BrowserWindow | null) {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO agents (id, project_id, role, status) VALUES (?, ?, ?, ?)').run(id, projectId, role, 'working');
  sendToUI(win, 'agent:spawned', { projectId, agentId: id, role });
}

export function updateAgentStats(agentId: string, projectId: string, inputTokens: number, outputTokens: number, cost: number) {
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

// ═══════════════════════════════════════
// 预算防护
// ═══════════════════════════════════════

export function checkBudget(projectId: string, settings: any): { ok: boolean; spent: number; budget: number } {
  const db = getDb();
  const row = db.prepare('SELECT SUM(total_cost_usd) as total FROM agents WHERE project_id = ?').get(projectId) as any;
  const spent = row?.total ?? 0;
  const budget = settings.dailyBudgetUsd ?? 50;
  return { ok: spent < budget, spent, budget };
}

// ═══════════════════════════════════════
// Feature 原子锁定（解决多 Worker 竞态）
// ═══════════════════════════════════════

export function lockNextFeature(projectId: string, workerId: string): any | null {
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
