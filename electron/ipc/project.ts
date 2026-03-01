/**
 * 项目 IPC — 创建项目、启动 Agent 编排
 * v0.8: 支持 git_mode (local/github)
 */

import { ipcMain, BrowserWindow, app, shell, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { getDb } from '../db';
import { runOrchestrator, stopOrchestrator, getContextSnapshots, getAgentReactStates } from '../engine/orchestrator';
import { initRepo, commit as gitCommit, getLog as gitLog, testGitHubConnection, type GitProviderConfig } from '../engine/git-provider';
import { exportWorkspaceZip } from '../engine/workspace-git';

function generateId(): string {
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function getGitConfig(project: any): GitProviderConfig {
  return {
    mode: project.git_mode || 'local',
    workspacePath: project.workspace_path,
    githubRepo: project.github_repo || undefined,
    githubToken: project.github_token || undefined,
  };
}

export function setupProjectHandlers() {

  // ── 创建项目 ──
  ipcMain.handle('project:create', async (_event, name: string, options?: {
    workspacePath?: string;
    gitMode?: string;
    githubRepo?: string;
    githubToken?: string;
  }) => {
    const db = getDb();
    const id = generateId();
    const displayName = name.length > 50 ? name.slice(0, 50) + '...' : name;
    const gitMode = options?.gitMode || 'local';
    const githubRepo = options?.githubRepo || null;
    const githubToken = options?.githubToken || null;

    // 工作区目录: 用户指定 > 默认
    let workspacePath: string;
    if (options?.workspacePath?.trim()) {
      workspacePath = options.workspacePath.trim();
    } else {
      const workspacesRoot = path.join(app.getPath('userData'), 'workspaces');
      workspacePath = path.join(workspacesRoot, id);
    }
    fs.mkdirSync(workspacePath, { recursive: true });

    // Git init (根据模式)
    initRepo({ mode: gitMode as any, workspacePath, githubRepo: githubRepo || undefined, githubToken: githubToken || undefined });

    db.prepare(`
      INSERT INTO projects (id, name, wish, status, workspace_path, config, git_mode, github_repo, github_token)
      VALUES (?, ?, '', 'initializing', ?, '{}', ?, ?, ?)
    `).run(id, displayName, workspacePath, gitMode, githubRepo, githubToken);

    return { success: true, projectId: id, name: displayName, workspacePath };
  });

  // ── 设置/更新项目需求 (legacy: 更新 projects.wish 字段) ──
  ipcMain.handle('project:set-wish', async (_event, projectId: string, wish: string) => {
    const db = getDb();
    db.prepare(`UPDATE projects SET wish = ?, updated_at = datetime('now') WHERE id = ?`).run(wish, projectId);
    return { success: true };
  });

  // ══════════════ 需求队列 (v3.1) ══════════════

  /** 创建一条新需求 */
  ipcMain.handle('wish:create', async (_event, projectId: string, content: string) => {
    const db = getDb();
    const id = 'w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    db.prepare(`INSERT INTO wishes (id, project_id, content) VALUES (?, ?, ?)`).run(id, projectId, content);
    return { success: true, wishId: id };
  });

  /** 列出项目的所有需求 */
  ipcMain.handle('wish:list', (_event, projectId: string) => {
    const db = getDb();
    return db.prepare('SELECT * FROM wishes WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
  });

  /** 获取单条需求详情 */
  ipcMain.handle('wish:get', (_event, wishId: string) => {
    const db = getDb();
    return db.prepare('SELECT * FROM wishes WHERE id = ?').get(wishId);
  });

  /** 更新需求状态 / PM 分析 / 设计文档 */
  ipcMain.handle('wish:update', (_event, wishId: string, fields: {
    status?: string; pm_analysis?: string; design_doc?: string; content?: string;
  }) => {
    const db = getDb();
    const sets: string[] = [];
    const vals: any[] = [];
    if (fields.status !== undefined) { sets.push('status = ?'); vals.push(fields.status); }
    if (fields.pm_analysis !== undefined) { sets.push('pm_analysis = ?'); vals.push(fields.pm_analysis); }
    if (fields.design_doc !== undefined) { sets.push('design_doc = ?'); vals.push(fields.design_doc); }
    if (fields.content !== undefined) { sets.push('content = ?'); vals.push(fields.content); }
    if (sets.length === 0) return { success: false };
    sets.push("updated_at = datetime('now')");
    vals.push(wishId);
    db.prepare(`UPDATE wishes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return { success: true };
  });

  /** 删除需求 */
  ipcMain.handle('wish:delete', (_event, wishId: string) => {
    const db = getDb();
    db.prepare('DELETE FROM wishes WHERE id = ?').run(wishId);
    return { success: true };
  });

  // ══════════════ 团队成员 (v3.1) ══════════════

  /** 列出项目的团队成员 */
  ipcMain.handle('team:list', (_event, projectId: string) => {
    const db = getDb();
    return db.prepare('SELECT * FROM team_members WHERE project_id = ? ORDER BY created_at ASC').all(projectId);
  });

  /** 新增成员 */
  ipcMain.handle('team:add', (_event, projectId: string, member: {
    role: string; name: string; model?: string;
    capabilities?: string[]; system_prompt?: string; context_files?: string[];
    max_context_tokens?: number;
  }) => {
    const db = getDb();
    const id = 'tm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    db.prepare(`INSERT INTO team_members (id, project_id, role, name, model, capabilities, system_prompt, context_files, max_context_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, projectId, member.role, member.name,
      member.model || null,
      JSON.stringify(member.capabilities || []),
      member.system_prompt || null,
      JSON.stringify(member.context_files || []),
      member.max_context_tokens || 128000,
    );
    return { success: true, memberId: id };
  });

  /** 更新成员 */
  ipcMain.handle('team:update', (_event, memberId: string, fields: {
    role?: string; name?: string; model?: string;
    capabilities?: string[]; system_prompt?: string; context_files?: string[];
    max_context_tokens?: number;
  }) => {
    const db = getDb();
    const sets: string[] = [];
    const vals: any[] = [];
    if (fields.role !== undefined) { sets.push('role = ?'); vals.push(fields.role); }
    if (fields.name !== undefined) { sets.push('name = ?'); vals.push(fields.name); }
    if (fields.model !== undefined) { sets.push('model = ?'); vals.push(fields.model); }
    if (fields.capabilities !== undefined) { sets.push('capabilities = ?'); vals.push(JSON.stringify(fields.capabilities)); }
    if (fields.system_prompt !== undefined) { sets.push('system_prompt = ?'); vals.push(fields.system_prompt); }
    if (fields.context_files !== undefined) { sets.push('context_files = ?'); vals.push(JSON.stringify(fields.context_files)); }
    if (fields.max_context_tokens !== undefined) { sets.push('max_context_tokens = ?'); vals.push(fields.max_context_tokens); }
    if (sets.length === 0) return { success: false };
    vals.push(memberId);
    db.prepare(`UPDATE team_members SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return { success: true };
  });

  /** 删除成员 */
  ipcMain.handle('team:delete', (_event, memberId: string) => {
    const db = getDb();
    db.prepare('DELETE FROM team_members WHERE id = ?').run(memberId);
    return { success: true };
  });

  /** 批量初始化默认团队 */
  ipcMain.handle('team:init-defaults', (_event, projectId: string) => {
    const db = getDb();
    const existing = db.prepare('SELECT COUNT(*) as count FROM team_members WHERE project_id = ?').get(projectId) as { count: number };
    if (existing.count > 0) return { success: true, message: 'already initialized' };

    const defaults = [
      { role: 'pm', name: '产品经理', model: '', capabilities: ['需求分析', '功能拆解', 'PRD 撰写'], system_prompt: '你是一位资深产品经理，擅长将模糊需求转化为可执行的开发任务。' },
      { role: 'architect', name: '架构师', model: '', capabilities: ['系统设计', '技术选型', 'API 设计'], system_prompt: '你是一位系统架构师，擅长设计可扩展、高性能的软件架构。' },
      { role: 'developer', name: '开发者 A', model: '', capabilities: ['前端开发', '后端开发', '代码编写'], system_prompt: '你是一位全栈开发者，擅长高质量代码实现。' },
      { role: 'developer', name: '开发者 B', model: '', capabilities: ['前端开发', '后端开发', '代码编写'], system_prompt: '你是一位全栈开发者，擅长高质量代码实现。' },
      { role: 'qa', name: 'QA 工程师', model: '', capabilities: ['代码审查', '测试用例', 'Bug 检测'], system_prompt: '你是一位 QA 工程师，擅长发现代码缺陷和潜在问题。' },
    ];
    const stmt = db.prepare(`INSERT INTO team_members (id, project_id, role, name, model, capabilities, system_prompt, context_files, max_context_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 128000)`);
    for (const d of defaults) {
      const id = 'tm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      stmt.run(id, projectId, d.role, d.name, d.model, JSON.stringify(d.capabilities), d.system_prompt);
    }
    return { success: true, count: defaults.length };
  });

  // ── 列出项目 ──
  ipcMain.handle('project:list', () => {
    const db = getDb();
    return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  });

  // ── 获取单个项目 ──
  ipcMain.handle('project:get', (_event, id: string) => {
    const db = getDb();
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  });

  // ── 获取项目的 features ──
  ipcMain.handle('project:get-features', (_event, projectId: string) => {
    const db = getDb();
    return db.prepare('SELECT * FROM features WHERE project_id = ? ORDER BY priority ASC, id ASC').all(projectId);
  });

  // ── 获取项目的 agents ──
  ipcMain.handle('project:get-agents', (_event, projectId: string) => {
    const db = getDb();
    return db.prepare('SELECT * FROM agents WHERE project_id = ? ORDER BY created_at ASC').all(projectId);
  });

  // ── 获取项目日志 ──
  ipcMain.handle('project:get-logs', (_event, projectId: string, limit: number = 200) => {
    const db = getDb();
    return db.prepare('SELECT * FROM agent_logs WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit).reverse();
  });

  // ── 获取项目统计 ──
  ipcMain.handle('project:get-stats', (_event, projectId: string) => {
    const db = getDb();
    const featureStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as todo,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'reviewing' THEN 1 ELSE 0 END) as reviewing,
        SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM features WHERE project_id = ?
    `).get(projectId);
    const agentStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(total_input_tokens + total_output_tokens) as total_tokens,
        SUM(total_cost_usd) as total_cost
      FROM agents WHERE project_id = ?
    `).get(projectId);
    return { features: featureStats, agents: agentStats };
  });

  // ── 启动项目 (开始 Agent 编排) ──
  ipcMain.handle('project:start', async (_event, projectId: string) => {
    const win = BrowserWindow.getAllWindows()[0] ?? null;
    runOrchestrator(projectId, win).catch(err => {
      console.error('[Orchestrator] Fatal error:', err);
      win?.webContents.send('agent:error', { projectId, error: err.message });
    });
    return { success: true };
  });

  // ── 停止项目 ──
  ipcMain.handle('project:stop', (_event, projectId: string) => {
    stopOrchestrator(projectId);
    return { success: true };
  });

  // ── 删除项目 ──
  ipcMain.handle('project:delete', (_event, projectId: string) => {
    stopOrchestrator(projectId);
    const db = getDb();
    // 获取 workspace 路径以清理磁盘
    const project = db.prepare('SELECT workspace_path FROM projects WHERE id = ?').get(projectId) as { workspace_path?: string } | undefined;
    db.prepare('DELETE FROM agent_logs WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM agents WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM features WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    // 可选：清理工作区磁盘（异步，不阻塞）
    if (project?.workspace_path && fs.existsSync(project.workspace_path)) {
      fs.rm(project.workspace_path, { recursive: true, force: true }, () => {});
    }
    return { success: true };
  });

  // ── 打开工作区文件夹 ──
  ipcMain.handle('project:open-workspace', async (_event, projectId: string) => {
    const db = getDb();
    const project = db.prepare('SELECT workspace_path FROM projects WHERE id = ?').get(projectId) as { workspace_path?: string } | undefined;
    if (project?.workspace_path && fs.existsSync(project.workspace_path)) {
      await shell.openPath(project.workspace_path);
      return { success: true };
    }
    return { success: false, error: '工作区目录不存在' };
  });

  // ── 导出项目为 zip ──
  ipcMain.handle('project:export', async (_event, projectId: string) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    if (!project?.workspace_path || !fs.existsSync(project.workspace_path)) {
      return { success: false, error: '工作区目录不存在' };
    }

    // 先 commit 最新状态
    gitCommit(getGitConfig(project), 'Export snapshot');

    const win = BrowserWindow.getAllWindows()[0] ?? null;
    if (!win) return { success: false, error: '无窗口' };

    const safeName = project.name.replace(/[^\w\u4e00-\u9fff-]/g, '_').slice(0, 30);
    const result = await dialog.showSaveDialog(win, {
      title: '导出项目',
      defaultPath: path.join(app.getPath('desktop'), `${safeName}.zip`),
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
    });

    if (result.canceled || !result.filePath) return { success: false, error: '用户取消' };

    const ok = await exportWorkspaceZip(project.workspace_path, result.filePath);
    return ok ? { success: true, path: result.filePath } : { success: false, error: '打包失败' };
  });

  // ── Git commit ──
  ipcMain.handle('project:git-commit', (_event, projectId: string, message: string) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    if (!project?.workspace_path) return { success: false };
    const result = gitCommit(getGitConfig(project), message);
    return { success: result.success, hash: result.hash, pushed: result.pushed };
  });

  // ── Git log ──
  ipcMain.handle('project:git-log', (_event, projectId: string) => {
    const db = getDb();
    const project = db.prepare('SELECT workspace_path FROM projects WHERE id = ?').get(projectId) as { workspace_path?: string } | undefined;
    if (!project?.workspace_path) return [];
    return gitLog(project.workspace_path);
  });

  // ── GitHub 连接测试 ──
  ipcMain.handle('project:test-github', async (_event, repo: string, token: string) => {
    return testGitHubConnection(repo, token);
  });

  // ── 获取上下文快照 (v1.1) ──
  ipcMain.handle('project:get-context-snapshots', (_event, projectId: string) => {
    const snapshots = getContextSnapshots(projectId);
    const result: Record<string, any> = {};
    for (const [agentId, snap] of snapshots) {
      result[agentId] = snap;
    }
    return result;
  });

  // ── 获取 Agent ReAct 状态 (v1.1) ──
  ipcMain.handle('project:get-react-states', (_event, projectId: string) => {
    const states = getAgentReactStates(projectId);
    const result: Record<string, any> = {};
    for (const [agentId, state] of states) {
      result[agentId] = state;
    }
    return result;
  });
}

