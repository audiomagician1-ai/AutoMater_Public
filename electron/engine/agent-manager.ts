/**
 * Agent Manager — Agent 生命周期管理
 *
 * 运行注册表、spawn、stats更新、预算防护、feature原子锁定、停止
 * 从 orchestrator.ts 拆出 (v2.5)
 */

import { BrowserWindow } from 'electron';
import { getDb } from '../db';
import { sendToUI } from './ui-bridge';
import type { MemberLLMConfig, AppSettings, FeatureRow } from './types';

// ═══════════════════════════════════════
// 运行中的编排器注册表（支持停止）
// ═══════════════════════════════════════

const runningOrchestrators = new Map<string, AbortController>();

export function getRunningOrchestrators() {
  return runningOrchestrators;
}

/**
 * 注册编排器。如果该 projectId 已有运行中的编排器，先 abort 旧的再注册新的。
 * 返回 true 表示是「全新启动」，false 表示「替换了旧实例」。
 */
export function registerOrchestrator(projectId: string, ctrl: AbortController): boolean {
  const existing = runningOrchestrators.get(projectId);
  if (existing) {
    existing.abort();
    runningOrchestrators.delete(projectId);
  }
  runningOrchestrators.set(projectId, ctrl);
  return !existing;
}

/**
 * 检查某个项目是否有编排器正在运行
 */
export function isOrchestratorRunning(projectId: string): boolean {
  return runningOrchestrators.has(projectId);
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
  // v5.1: 保留 analyzing 状态 — 暂停后仍可恢复导入分析
  const row = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId) as { status: string } | undefined;
  const newStatus = row?.status === 'analyzing' ? 'analyzing' : 'paused';
  db.prepare("UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, projectId);
  db.prepare(
    "UPDATE features SET status = 'todo', locked_by = NULL WHERE project_id = ? AND status IN ('in_progress', 'reviewing')",
  ).run(projectId);
  db.prepare("UPDATE agents SET status = 'idle', current_task = NULL WHERE project_id = ? AND status = 'working'").run(
    projectId,
  );
}

// ═══════════════════════════════════════
// Agent 生命周期
// ═══════════════════════════════════════

export function spawnAgent(projectId: string, id: string, role: string, win: BrowserWindow | null) {
  const db = getDb();
  // 先尝试插入（如果不存在），再更新状态为 working（保留累计的 stats）
  db.prepare('INSERT OR IGNORE INTO agents (id, project_id, role, status) VALUES (?, ?, ?, ?)').run(
    id,
    projectId,
    role,
    'working',
  );
  db.prepare("UPDATE agents SET status = 'working', role = ? WHERE id = ? AND project_id = ?").run(role, id, projectId);
  sendToUI(win, 'agent:spawned', { projectId, agentId: id, role });
}

export function updateAgentStats(
  agentId: string,
  projectId: string,
  inputTokens: number,
  outputTokens: number,
  cost: number,
) {
  const db = getDb();
  db.prepare(
    `
    UPDATE agents SET
      session_count = session_count + 1,
      total_input_tokens = total_input_tokens + ?,
      total_output_tokens = total_output_tokens + ?,
      total_cost_usd = total_cost_usd + ?,
      last_active_at = datetime('now')
    WHERE id = ? AND project_id = ?
  `,
  ).run(inputTokens, outputTokens, cost, agentId, projectId);
}

// ═══════════════════════════════════════
// 预算防护
// ═══════════════════════════════════════

/**
 * 检查项目预算是否超限。
 * budget=0 表示无上限 (永远返回 ok=true)。
 */
export function checkBudget(projectId: string, settings: AppSettings): { ok: boolean; spent: number; budget: number } {
  const db = getDb();
  const row = db.prepare('SELECT SUM(total_cost_usd) as total FROM agents WHERE project_id = ?').get(projectId) as
    | { total: number | null }
    | undefined;
  const spent = row?.total ?? 0;
  const budget = settings.dailyBudgetUsd ?? 0;
  // 0 = 无上限
  if (budget <= 0) {
    return { ok: true, spent, budget: 0 };
  }
  return { ok: spent < budget, spent, budget };
}

// ═══════════════════════════════════════
// v4.0: 团队自定义 Prompt 解析
// ═══════════════════════════════════════

/**
 * 查询项目的 team_members 表，返回指定角色的自定义 system_prompt。
 * 如果有多个同角色成员，可通过 agentIndex 区分（0-based, 对应 dev-1, dev-2...）。
 * 找不到或 prompt 为空时返回 null，调用方应 fallback 到内置 prompt。
 */
export function getTeamPrompt(projectId: string, role: string, agentIndex: number = 0): string | null {
  try {
    const db = getDb();
    const members = db
      .prepare('SELECT system_prompt FROM team_members WHERE project_id = ? AND role = ? ORDER BY created_at ASC')
      .all(projectId) as Array<{ system_prompt: string | null }>;

    if (members.length === 0) return null;

    // 选择对应 index 的成员，超出范围则取最后一个
    const member = members[Math.min(agentIndex, members.length - 1)];
    const prompt = member?.system_prompt?.trim();
    return prompt && prompt.length > 10 ? prompt : null;
  } catch {
    /* silent: DB/team lookup fallback */
    return null;
  }
}

// ═══════════════════════════════════════
// v11.0: 成员级 LLM / MCP / Skill 配置
// ═══════════════════════════════════════

/**
 * 获取指定角色成员的 LLM 配置。
 * 成员级配置优先，缺省字段 fallback 到全局 settings。
 * 返回 { provider, apiKey, baseUrl, model } — 全部已填充。
 */
export function getTeamMemberLLMConfig(
  projectId: string,
  role: string,
  agentIndex: number = 0,
  globalSettings: AppSettings,
): { provider: string; apiKey: string; baseUrl: string; model: string } {
  const defaultModel =
    role === 'developer' || role === 'devops' ? globalSettings.workerModel : globalSettings.strongModel;

  const fallback = {
    provider: globalSettings.llmProvider,
    apiKey: globalSettings.apiKey,
    baseUrl: globalSettings.baseUrl,
    model: defaultModel,
  };

  try {
    const db = getDb();
    const members = db
      .prepare('SELECT llm_config, model FROM team_members WHERE project_id = ? AND role = ? ORDER BY created_at ASC')
      .all(projectId) as Array<{ llm_config: string | null; model: string | null }>;

    if (members.length === 0) return fallback;

    const member = members[Math.min(agentIndex, members.length - 1)];

    // 先检查 v11.0 的 llm_config JSON
    if (member.llm_config) {
      try {
        const cfg = JSON.parse(member.llm_config) as MemberLLMConfig;
        return {
          provider: cfg.provider || fallback.provider,
          apiKey: cfg.apiKey || fallback.apiKey,
          baseUrl: cfg.baseUrl || fallback.baseUrl,
          model: cfg.model || fallback.model,
        };
      } catch {
        /* JSON parse error — fallback */
      }
    }

    // 向后兼容: 旧版 model 字段 (直接文本)
    if (member.model?.trim()) {
      return { ...fallback, model: member.model.trim() };
    }

    return fallback;
  } catch {
    /* silent: model config parse fallback */
    return fallback;
  }
}

/**
 * 获取成员级 MCP 服务器列表 (返回 JSON 解析后的数组)。
 * 为空时返回 [] (表示只用全局 MCP)。
 */
export function getTeamMemberMcpServers(
  projectId: string,
  role: string,
  agentIndex: number = 0,
): Record<string, unknown>[] {
  try {
    const db = getDb();
    const members = db
      .prepare('SELECT mcp_servers FROM team_members WHERE project_id = ? AND role = ? ORDER BY created_at ASC')
      .all(projectId) as Array<{ mcp_servers: string | null }>;
    if (members.length === 0) return [];
    const member = members[Math.min(agentIndex, members.length - 1)];
    if (!member.mcp_servers) return [];
    return JSON.parse(member.mcp_servers);
  } catch {
    /* silent: mcp_servers JSON parse fallback */
    return [];
  }
}

/**
 * 获取成员级 Skill 列表 (返回 skill 名称数组)。
 * 为空时返回 [] (表示只用全局 Skill)。
 */
export function getTeamMemberSkills(projectId: string, role: string, agentIndex: number = 0): string[] {
  try {
    const db = getDb();
    const members = db
      .prepare('SELECT skills FROM team_members WHERE project_id = ? AND role = ? ORDER BY created_at ASC')
      .all(projectId) as Array<{ skills: string | null }>;
    if (members.length === 0) return [];
    const member = members[Math.min(agentIndex, members.length - 1)];
    if (!member.skills) return [];
    return JSON.parse(member.skills);
  } catch {
    /* silent: skills JSON parse fallback */
    return [];
  }
}

/**
 * v18.0: 获取成员级最大迭代轮数
 * 返回 null 表示使用系统默认值
 */
export function getTeamMemberMaxIterations(projectId: string, role: string, agentIndex: number = 0): number | null {
  try {
    const db = getDb();
    const members = db
      .prepare('SELECT max_iterations FROM team_members WHERE project_id = ? AND role = ? ORDER BY created_at ASC')
      .all(projectId) as Array<{ max_iterations: number | null }>;
    if (members.length === 0) return null;
    const member = members[Math.min(agentIndex, members.length - 1)];
    return member.max_iterations ?? null;
  } catch {
    return null;
  }
}

export function lockNextFeature(projectId: string, workerId: string): FeatureRow | null {
  const db = getDb();
  const tryLock = db.transaction(() => {
    const passedRows = db
      .prepare("SELECT id FROM features WHERE project_id = ? AND status = 'passed'")
      .all(projectId) as { id: string }[];
    const passedSet = new Set(passedRows.map(r => r.id));

    // v6.0 (G10): 两层索引 — 优先从同 group 中选择 feature
    // 先检查当前 worker 正在处理的 group (如有)
    const currentGroup = db
      .prepare(
        "SELECT group_id FROM features WHERE project_id = ? AND locked_by = ? AND status = 'in_progress' LIMIT 1",
      )
      .get(projectId, workerId) as { group_id: string } | undefined;

    // 查询所有 todo features, 按 group 亲和力 + priority 排序
    let todos: FeatureRow[];
    if (currentGroup?.group_id) {
      // 同 group 优先 (group affinity ordering)
      todos = db
        .prepare(
          `SELECT * FROM features WHERE project_id = ? AND status = 'todo'
         ORDER BY CASE WHEN group_id = ? THEN 0 ELSE 1 END, priority ASC, id ASC`,
        )
        .all(projectId, currentGroup.group_id) as FeatureRow[];
    } else {
      todos = db
        .prepare("SELECT * FROM features WHERE project_id = ? AND status = 'todo' ORDER BY priority ASC, id ASC")
        .all(projectId) as FeatureRow[];
    }

    for (const f of todos) {
      let deps: string[] = [];
      try {
        deps = JSON.parse(f.depends_on || '[]');
      } catch {
        /* */
      }
      const depsOk = deps.every((d: string) => passedSet.has(d));
      if (!depsOk) continue;

      const result = db
        .prepare(
          "UPDATE features SET status = 'in_progress', locked_by = ?, locked_at = datetime('now') WHERE id = ? AND project_id = ? AND status = 'todo'",
        )
        .run(workerId, f.id, projectId);

      if (result.changes > 0) {
        return { ...f, status: 'in_progress' as const, locked_by: workerId };
      }
    }
    return null;
  });

  return tryLock();
}

/**
 * v6.0 (G10): 按 group 返回 Feature 统计摘要 (两层索引)
 * 用于大项目中快速了解各 group 进度, 而不需要加载所有 feature 详情
 */
export function getFeatureGroupSummary(projectId: string): Array<{
  groupId: string;
  total: number;
  done: number;
  inProgress: number;
  failed: number;
}> {
  const db = getDb();
  const rows = db
    .prepare(
      `
    SELECT
      COALESCE(group_id, 'default') as group_id,
      COUNT(*) as total,
      SUM(CASE WHEN status IN ('passed','qa_passed') THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN status IN ('in_progress','reviewing') THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM features WHERE project_id = ?
    GROUP BY group_id
    ORDER BY group_id
  `,
    )
    .all(projectId) as Array<{
    group_id: string | null;
    total: number;
    done: number;
    in_progress: number;
    failed: number;
  }>;

  return rows.map(r => ({
    groupId: r.group_id ?? '',
    total: r.total,
    done: r.done,
    inProgress: r.in_progress,
    failed: r.failed,
  }));
}
