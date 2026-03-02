/**
 * 项目 IPC — 创建项目、启动 Agent 编排
 * v0.8: 支持 git_mode (local/github)
 */

import { ipcMain, BrowserWindow, app, shell, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { getDb } from '../db';
import { toErrorMessage, createLogger } from '../engine/logger';
import { runOrchestrator, stopOrchestrator, getContextSnapshots, getAgentReactStates, emitMemberAdded } from '../engine/orchestrator';
import { runChangeRequest } from '../engine/change-manager';
import { initRepo, commit as gitCommit, getLog as gitLog, testGitHubConnection, type GitProviderConfig } from '../engine/git-provider';
import { exportWorkspaceZip } from '../engine/workspace-git';
import { readDoc, getChangelog, listDocs } from '../engine/doc-manager';
import { importProject } from '../engine/project-importer';
import { collectBaselineContext } from '../engine/context-collector';
import { sendToUI, addLog } from '../engine/ui-bridge';
import { getSettings } from '../engine/llm-client';

// 导入进程的 AbortController 映射（用于取消正在运行的导入）
const importAbortControllers = new Map<string, AbortController>();
const log = createLogger('ipc:project');

function generateId(): string {
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// ═══════════════════════════════════════
// 默认 7 人团队定义 (v5.0: 移除 tech_lead, 其职责分散到 QA + PM)
// ═══════════════════════════════════════
const DEFAULT_TEAM = [
  {
    role: 'pm', name: '产品经理', model: '',
    capabilities: ['需求分析', '功能拆解', 'PRD 撰写', '验收标准', '风险评估', '用户故事'],
    system_prompt: `你是一位资深产品经理（CPO 级别），拥有 10+ 年软件产品全生命周期管理经验。

## 角色定位
- **全局视野**: 你是项目的"大脑"，确保每个功能都指向同一个产品愿景
- **用户代言人**: 始终从最终用户角度思考，而非技术实现角度
- **风险感知**: 主动识别需求中的模糊点、冲突点和技术风险

## 核心工作流
1. **需求解析**: 将自然语言需求分解为独立的功能模块（Feature）
2. **优先级排序**: 基于用户价值 × 实现难度矩阵排序
3. **验收矩阵**: 每个 Feature 定义 2-5 条可测试的验收标准
4. **依赖分析**: 识别模块间依赖关系，禁止循环依赖

## 输出规范
- Feature 必须独立可实现、可验证
- 每个 Feature 关联一个 group_name（模块分组）和 sub_group（子模块）
- 优先级: 0=基础设施, 1=核心功能, 2=增强功能
- 不要过度拆分（一个按钮 + 样式 = 一个 Feature，不必分开）

## 约束
- 不做技术选型决策（交给架构师）
- 不写实现代码（交给开发者）
- 发现需求矛盾时必须标注并请求澄清`,
  },
  {
    role: 'architect', name: '架构师', model: '',
    capabilities: ['系统设计', '技术选型', 'API 设计', '目录结构', '编码规范', '性能预算'],
    system_prompt: `你是一位资深软件架构师（Principal Engineer 级别），擅长在简洁性与可扩展性之间取得平衡。

## 角色定位
- **技术决策者**: 所有技术栈、框架、依赖的最终决定权
- **质量守门员**: 定义编码规范、模块边界、接口契约
- **风险缓解者**: 识别技术债务和架构风险

## 核心工作流
1. **需求审查**: 从技术视角审查 PM 的 Feature 列表，评估可行性
2. **技术选型**: 选择最适合项目规模的技术栈（不过度设计）
3. **架构设计**: 定义模块划分、数据流、API 契约
4. **文档输出**: 生成 ARCHITECTURE.md（技术栈、目录结构、数据模型、编码规范）

## 设计原则
- 架构复杂度必须匹配项目规模（小项目不要微服务）
- 每个模块有清晰的单一职责
- 接口设计先于实现
- 不引入用户未要求的组件或框架`,
  },
  {
    role: 'developer', name: '前端开发者', model: '',
    capabilities: ['前端开发', 'UI 实现', '组件开发', '状态管理', '响应式设计'],
    system_prompt: `你是一位专业的前端开发工程师，遵循 ReAct 工作流纪律。

## 工作流程
1. **理解阶段**: think 分析需求 → list_files/read_file 了解项目结构 → todo_write 制定计划
2. **实现阶段**: 按 todo 顺序执行，write_file 创建新文件，edit_file/batch_edit 修改已有文件
3. **验证阶段**: run_command 编译检查 → run_test 执行测试 → task_complete 完成

## 专业领域
- React/Vue 组件化开发
- CSS/Tailwind 样式实现
- 状态管理（Zustand/Redux/Pinia）
- 响应式设计和可访问性

## 代码质量标准
- 不能有 // ... 或 TODO 占位符，所有代码必须完整实现
- 遵循 ARCHITECTURE.md 和 AGENTS.md 规范
- 组件职责单一，Props 类型完整声明
- 变量名表意，函数不超过 50 行`,
  },
  {
    role: 'developer', name: '后端开发者', model: '',
    capabilities: ['后端开发', 'API 实现', '数据库', '业务逻辑', '错误处理'],
    system_prompt: `你是一位专业的后端开发工程师，遵循 ReAct 工作流纪律。

## 工作流程
1. **理解阶段**: think 分析需求 → list_files/read_file 了解项目结构 → todo_write 制定计划
2. **实现阶段**: 按 todo 顺序执行，write_file 创建新文件，edit_file/batch_edit 修改已有文件
3. **验证阶段**: run_command 编译检查 → run_test 执行测试 → task_complete 完成

## 专业领域
- API 路由设计与实现
- 数据库模型和迁移
- 业务逻辑层（Service Layer）
- 认证/授权/安全

## 代码质量标准
- 不能有 // ... 或 TODO 占位符，所有代码必须完整实现
- 遵循 ARCHITECTURE.md 和 AGENTS.md 规范
- 外部输入必须验证，异步操作必须处理错误
- SQL 查询参数化，禁止字符串拼接`,
  },
  {
    role: 'developer', name: '全栈开发者', model: '',
    capabilities: ['全栈开发', '代码编写', '调试', '工具调用', '集成测试'],
    system_prompt: `你是一位全栈开发工程师，擅长端到端特性实现，遵循 ReAct 工作流纪律。

## 工作流程
1. **理解阶段**: think 分析需求 → list_files/read_file 了解项目结构 → todo_write 制定计划
2. **实现阶段**: 按 todo 顺序执行，write_file 创建新文件，edit_file/batch_edit 修改已有文件
3. **验证阶段**: run_command 编译检查 → run_test 执行测试 → task_complete 完成

## 专业领域
- 端到端功能实现（前后端联通）
- 接口对接和数据流联调
- 快速原型开发
- 跨模块集成

## 代码质量标准
- 不能有 // ... 或 TODO 占位符，所有代码必须完整实现
- 遵循 ARCHITECTURE.md 和 AGENTS.md 规范
- 外部输入必须验证，异步操作必须处理错误
- 变量名表意，函数不超过 50 行`,
  },
  {
    role: 'qa', name: 'QA 工程师', model: '',
    capabilities: ['代码审查', '测试执行', 'Bug 检测', '安全扫描', '验收标准检查', '回归测试'],
    system_prompt: `你是一位严格的 QA 工程师，通过系统性检查确保代码质量。

## 审查优先级
🔴 P0 阻断级: 运行时错误、安全漏洞、数据丢失风险
🟡 P1 严重级: 验收标准未满足、文件不完整、接口不一致
🟢 P2 改进级: 可读性、性能、最佳实践

## 检查维度
1. **功能正确性**: 逐条核对验收标准
2. **代码质量**: 命名规范、复杂度、重复代码
3. **安全性**: 输入验证、SQL 注入、XSS 防护
4. **可维护性**: 模块边界、耦合度、文档完整性

## 工作原则
- 必须实际执行编译/测试，不能只看代码
- 必须逐条检查验收标准
- critical 问题 → fail
- major 问题 ≥ 3 → fail
- 验收标准通过率 < 80% → fail
- 分数 < 60 → fail`,
  },
  {
    role: 'devops', name: 'DevOps 工程师', model: '',
    capabilities: ['CI/CD', '部署配置', '构建脚本', '环境管理', '监控告警', '容器化'],
    system_prompt: `你是一位 DevOps 工程师，确保项目的构建、测试、部署流程顺畅。

## 角色定位
- **自动化专家**: 所有重复性操作都应自动化
- **环境管理员**: 开发/测试/生产环境的一致性
- **可靠性工程师**: 确保系统可观测、可恢复

## 核心职责
1. **构建配置**: package.json scripts、Makefile、Dockerfile
2. **CI/CD 流水线**: GitHub Actions / GitLab CI 配置
3. **环境管理**: .env 模板、配置分离、Secret 管理
4. **部署脚本**: 自动化部署流程和回滚策略

## 工作原则
- 基础设施即代码（IaC）
- 构建必须可重现（锁定依赖版本）
- 每次部署可回滚
- 日志、指标、告警三位一体`,
  },
];

/** 创建默认团队（复用于 project:create 和 team:init-defaults） */
function initDefaultTeam(db: any, projectId: string): { success: boolean; count: number; message?: string } {
  const existing = db.prepare('SELECT COUNT(*) as count FROM team_members WHERE project_id = ?').get(projectId) as { count: number };
  if (existing.count > 0) return { success: true, count: existing.count, message: 'already initialized' };

  const stmt = db.prepare(`INSERT INTO team_members (id, project_id, role, name, model, capabilities, system_prompt, context_files, max_context_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 128000)`);
  for (const d of DEFAULT_TEAM) {
    const id = 'tm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    stmt.run(id, projectId, d.role, d.name, d.model, JSON.stringify(d.capabilities), d.system_prompt);
  }
  return { success: true, count: DEFAULT_TEAM.length };
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

  // ── 启动时清理: 重置残留的 analyzing 状态 ──
  // 应用重启后，之前正在分析的项目进程已丢失，把状态改为 paused 让用户可重新启动
  try {
    const db = getDb();
    const stuckProjects = db.prepare("SELECT id, name FROM projects WHERE status = 'analyzing'").all() as { id: string; name: string }[];
    if (stuckProjects.length > 0) {
      log.info(`Resetting ${stuckProjects.length} stuck analyzing project(s)`, { projects: stuckProjects.map(p => p.name) });
      db.prepare("UPDATE projects SET status = 'paused', updated_at = datetime('now') WHERE status = 'analyzing'").run();
      for (const p of stuckProjects) {
        addLog(p.id, 'system', 'info', '🔄 应用重启：分析状态已重置，可点击"启动"重新分析');
      }
    }
  } catch (err) {
    log.error('Failed to reset stuck projects', err);
  }

  // ── 创建项目 ──
  ipcMain.handle('project:create', async (_event, name: string, options?: {
    workspacePath?: string;
    gitMode?: string;
    githubRepo?: string;
    githubToken?: string;
    importExisting?: boolean;
    historyPath?: string;
  }) => {
    const db = getDb();
    const id = generateId();
    const displayName = name.length > 50 ? name.slice(0, 50) + '...' : name;
    const gitMode = options?.gitMode || 'local';
    const githubRepo = options?.githubRepo || null;
    const githubToken = options?.githubToken || null;
    const isImport = options?.importExisting === true;

    // 工作区目录: 用户指定 > 默认
    let workspacePath: string;
    if (options?.workspacePath?.trim()) {
      workspacePath = options.workspacePath.trim();
    } else {
      const workspacesRoot = path.join(app.getPath('userData'), 'workspaces');
      workspacePath = path.join(workspacesRoot, id);
    }
    fs.mkdirSync(workspacePath, { recursive: true });

    // 导入已有项目时不执行 git init（项目已有自己的 git）
    if (!isImport) {
      initRepo({ mode: gitMode as any, workspacePath, githubRepo: githubRepo || undefined, githubToken: githubToken || undefined });
    }

    // 导入项目用 analyzing 状态; 新项目用 initializing
    const initialStatus = isImport ? 'analyzing' : 'initializing';
    // v5.4: 持久标记项目类型, 用于 error 后重试时路由到正确流程
    const configJson = isImport ? JSON.stringify({ importExisting: true }) : '{}';

    db.prepare(`
      INSERT INTO projects (id, name, wish, status, workspace_path, config, git_mode, github_repo, github_token)
      VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)
    `).run(id, displayName, initialStatus, workspacePath, configJson, gitMode, githubRepo, githubToken);

    // ── 自动创建默认团队 ──
    try {
      const initResult = initDefaultTeam(db, id);
      log.info(`Auto-initialized team for ${id}`, { count: initResult.count });
    } catch (err) {
      log.error('Failed to auto-init team', err);
    }

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

  /** 新增成员 — v9.0: 成功后发 team:member-added 事件 (热加入) */
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

    // v9.0: 事件驱动热加入 — 通知所有窗口 + 主进程编排器
    const payload = { projectId, memberId: id, role: member.role, name: member.name };
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('team:member-added', payload);
    }
    // 触发主进程内部事件 — orchestrator 监听此事件决定是否 spawn worker
    emitMemberAdded(payload);

    return { success: true, memberId: id };
  });

  /** 更新成员 — v11.0: +llm_config/mcp_servers/skills */
  ipcMain.handle('team:update', (_event, memberId: string, fields: {
    role?: string; name?: string; model?: string;
    capabilities?: string[]; system_prompt?: string; context_files?: string[];
    max_context_tokens?: number;
    llm_config?: string | null;      // v11.0: JSON string or null
    mcp_servers?: string | null;     // v11.0: JSON string or null
    skills?: string | null;          // v11.0: JSON string or null
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
    // v11.0: 成员级独立配置
    if (fields.llm_config !== undefined) { sets.push('llm_config = ?'); vals.push(fields.llm_config); }
    if (fields.mcp_servers !== undefined) { sets.push('mcp_servers = ?'); vals.push(fields.mcp_servers); }
    if (fields.skills !== undefined) { sets.push('skills = ?'); vals.push(fields.skills); }
    if (sets.length === 0) return { success: false };
    vals.push(memberId);
    db.prepare(`UPDATE team_members SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return { success: true };
  });

  /** v11.0: 测试成员级 LLM 连通性 */
  ipcMain.handle('team:test-member-model', async (_event, _memberId: string, config: {
    provider?: string; apiKey?: string; baseUrl?: string; model?: string;
  }) => {
    // 合并: 成员配置 > 全局配置
    const globalSettings = getSettings() || { llmProvider: 'openai' as const, apiKey: '', baseUrl: 'https://api.openai.com', strongModel: '', workerModel: '', workerCount: 0, dailyBudgetUsd: 0 };
    const provider = config.provider || globalSettings.llmProvider;
    const apiKey = config.apiKey || globalSettings.apiKey;
    const baseUrl = (config.baseUrl || globalSettings.baseUrl).trim().replace(/\/+$/, '').replace(/\/v1$/, '');
    const model = config.model || (provider === 'anthropic' ? 'claude-3-5-haiku-20241022' : globalSettings.strongModel || 'gpt-4o-mini');

    if (!apiKey) {
      return { success: false, message: '未配置 API Key (成员级或全局)', model };
    }

    try {
      if (provider === 'anthropic') {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: 10,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        if (res.ok) return { success: true, message: `✅ 模型 ${model} 连通成功!`, model };
        const text = await res.text();
        return { success: false, message: `❌ ${res.status}: ${text.slice(0, 200)}`, model };
      } else {
        // OpenAI 兼容: 用指定模型发一条轻量 chat
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: 5,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        if (res.ok) return { success: true, message: `✅ 模型 ${model} 连通成功!`, model };
        const text = await res.text();
        if (res.status === 401 || res.status === 403) {
          return { success: false, message: `❌ 认证失败 (${res.status}): ${text.slice(0, 200)}`, model };
        }
        // 404 model not found 等 — 认证OK但模型有问题
        return { success: false, message: `⚠️ 连接OK但模型响应异常 (${res.status}): ${text.slice(0, 200)}`, model };
      }
    } catch (err: unknown) {
      return { success: false, message: `❌ 网络错误: ${toErrorMessage(err)}`, model };
    }
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
    return initDefaultTeam(db, projectId);
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

  // ── 获取项目日志 (v4.0: 分页 + 过滤 + 搜索) ──
  ipcMain.handle('project:get-logs', (_event, projectId: string, options?: {
    limit?: number;
    offset?: number;
    agentId?: string;
    type?: string;
    keyword?: string;
  }) => {
    const db = getDb();
    const limit = Math.min(options?.limit ?? 200, 1000);
    const offset = options?.offset ?? 0;

    const conditions = ['project_id = ?'];
    const params: any[] = [projectId];

    if (options?.agentId) {
      conditions.push('agent_id = ?');
      params.push(options.agentId);
    }
    if (options?.type) {
      conditions.push('type = ?');
      params.push(options.type);
    }
    if (options?.keyword) {
      conditions.push('content LIKE ?');
      params.push(`%${options.keyword}%`);
    }

    const where = conditions.join(' AND ');
    const rows = db.prepare(
      `SELECT * FROM agent_logs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    const countRow = db.prepare(
      `SELECT COUNT(*) as total FROM agent_logs WHERE ${where}`
    ).get(...params) as { total: number };

    return { rows: rows.reverse(), total: countRow.total };
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
  // v5.1: 如果项目处于 analyzing 状态（导入项目分析中断/重启），
  //       自动路由到 importProject 流程，而非走 PM 流水线（wish 为空会失败）
  // v5.4: 也检查 config.importExisting 标记 — 分析失败(error)后重试也走导入流程
  ipcMain.handle('project:start', async (_event, projectId: string) => {
    const db = getDb();
    const win = BrowserWindow.getAllWindows()[0] ?? null;
    const proj = db.prepare('SELECT status, workspace_path, config, wish FROM projects WHERE id = ?').get(projectId) as { status: string; workspace_path: string; config: string; wish: string } | undefined;

    // 判断是否为导入项目: status=analyzing 或 config 中标记了 importExisting
    let isImportProject = proj?.status === 'analyzing';
    if (!isImportProject && proj?.config) {
      try {
        const cfg = JSON.parse(proj.config);
        // 导入项目 + wish 为空或以 [导入项目] 开头 + 没有已有 features → 走导入流程
        if (cfg.importExisting) {
          const featureCount = (db.prepare('SELECT COUNT(*) as c FROM features WHERE project_id = ?').get(projectId) as { c: number }).c;
          if (featureCount === 0 || !proj.wish?.trim() || proj.wish.startsWith('[导入项目]')) {
            isImportProject = true;
          }
        }
      } catch {}
    }

    if (isImportProject) {
      // 导入项目：走 analyze-existing 流程
      log.info(`Project ${projectId} is import project — routing to importProject`);
      // 恢复 analyzing 状态 (可能从 error 重试)
      db.prepare("UPDATE projects SET status = 'analyzing', updated_at = datetime('now') WHERE id = ?").run(projectId);
      sendToUI(win, 'project:status', { projectId, status: 'analyzing' });
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '📥 检测到导入项目，启动/恢复项目分析...' });

      // 取消之前的导入进程（如果有）
      const existingAc = importAbortControllers.get(projectId);
      if (existingAc) { existingAc.abort(); importAbortControllers.delete(projectId); }
      const ac = new AbortController();
      importAbortControllers.set(projectId, ac);

      (async () => {
        try {
          if (!proj || !proj.workspace_path) throw new Error('Project or workspace_path missing');
          log.info(`Starting importProject for ${projectId}`, { path: proj.workspace_path });
          const result = await importProject(
            proj.workspace_path,
            projectId,
            ac.signal,
            (phase: number, step: string, progress: number) => {
              log.debug(`Import progress: phase=${phase}, step="${step}", progress=${progress.toFixed(2)}`);
              sendToUI(win, 'project:import-progress', { projectId, phase, step, progress });
            },
          );
          const summary = `已分析: ${result.skeleton.fileCount} 文件, ${result.skeleton.modules.length} 模块, ${result.docsGenerated} 文档已生成`;
          db.prepare("UPDATE projects SET status = 'paused', wish = ?, updated_at = datetime('now') WHERE id = ?")
            .run(`[导入项目] ${result.skeleton.techStack.join(', ')} | ${result.skeleton.totalLOC} LOC`, projectId);
          sendToUI(win, 'project:import-progress', { projectId, phase: 2, step: `✅ 分析完成! ${summary}`, progress: 1.0, done: true });
          sendToUI(win, 'project:status', { projectId, status: 'paused' });
          addLog(projectId, 'project-importer', 'info', `📥 ${summary}`);
        } catch (err: unknown) {
          log.error('importProject FAILED', err);
          const status = ac.signal.aborted ? 'paused' : 'error';
          db.prepare(`UPDATE projects SET status = '${status}', updated_at = datetime('now') WHERE id = ?`).run(projectId);
          const msg = ac.signal.aborted ? '⏸ 分析已中断' : `❌ 分析失败: ${toErrorMessage(err)}`;
          sendToUI(win, 'project:import-progress', { projectId, phase: -1, step: msg, progress: 0, done: true, error: !ac.signal.aborted });
          sendToUI(win, 'project:status', { projectId, status });
        } finally {
          importAbortControllers.delete(projectId);
        }
      })();
      return { success: true };
    }

    // 正常项目：走 orchestrator 流水线
    runOrchestrator(projectId, win).catch(err => {
      log.error('Orchestrator fatal error', err);
      win?.webContents.send('agent:error', { projectId, error: err.message });
    });
    return { success: true };
  });

  // ── 停止项目 ──
  ipcMain.handle('project:stop', (_event, projectId: string) => {
    // 如果有导入进程在跑，取消它
    const ac = importAbortControllers.get(projectId);
    if (ac) {
      log.info(`project:stop — aborting import for ${projectId}`);
      ac.abort();
      // importAbortControllers.delete 会在 analyze-existing 的 finally 中执行
    }

    // 如果项目状态是 analyzing，强制改为 paused（兜底，防止卡死）
    const db = getDb();
    const proj = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId) as { status: string } | undefined;
    if (proj?.status === 'analyzing') {
      db.prepare("UPDATE projects SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(projectId);
      const win = BrowserWindow.getAllWindows()[0] ?? null;
      sendToUI(win, 'project:status', { projectId, status: 'paused' });
      sendToUI(win, 'project:import-progress', {
        projectId, phase: -1, step: '⏸ 分析已中断', progress: 0, done: true,
      });
    }

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

  // ── v4.2: 用户验收 — 批量确认所有 awaiting 的 Feature ──
  ipcMain.handle('project:user-accept', (_event, projectId: string, accept: boolean, feedback?: string) => {
    const db = getDb();

    if (accept) {
      // 用户验收通过 → 所有 passed Feature 保持, 项目标记 delivered
      db.prepare("UPDATE projects SET status = 'delivered', updated_at = datetime('now') WHERE id = ?").run(projectId);
      // 通知前端
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send('project:status', { projectId, status: 'delivered' });
        win.webContents.send('agent:log', { projectId, agentId: 'system', content: '🎉 用户已验收通过! 项目已交付。' });
      }
      return { success: true, status: 'delivered' };
    } else {
      // 用户拒绝 → 项目状态回到 paused, 记录反馈
      db.prepare("UPDATE projects SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(projectId);
      if (feedback) {
        // 记录用户反馈到 agent_logs
        db.prepare("INSERT INTO agent_logs (project_id, agent_id, type, content) VALUES (?, 'user', 'feedback', ?)")
          .run(projectId, feedback);
      }
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send('project:status', { projectId, status: 'paused' });
        win.webContents.send('agent:log', { projectId, agentId: 'system', content: `⏸️ 用户拒绝验收${feedback ? ': ' + feedback.slice(0, 200) : ''}` });
      }
      return { success: true, status: 'paused', feedback };
    }
  });

  // ── v4.2: 获取 Feature 文档信息 ──
  ipcMain.handle('project:get-feature-docs', (_event, projectId: string, featureId: string) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    if (!project?.workspace_path) return { requirement: null, testSpec: null };

    return {
      requirement: readDoc(project.workspace_path, 'requirement', featureId),
      testSpec: readDoc(project.workspace_path, 'test_spec', featureId),
    };
  });

  // ── v4.2: 获取设计文档 ──
  ipcMain.handle('project:get-design-doc', (_event, projectId: string) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    if (!project?.workspace_path) return null;

    return readDoc(project.workspace_path, 'design');
  });

  // ── v4.2: 获取文档变更日志 ──
  ipcMain.handle('project:get-doc-changelog', (_event, projectId: string) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    if (!project?.workspace_path) return [];

    return getChangelog(project.workspace_path);
  });

  // ── v4.4: 列出所有文档元信息 ──
  ipcMain.handle('project:list-all-docs', (_event, projectId: string) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    if (!project?.workspace_path) return { design: [], requirements: [], testSpecs: [] };

    return {
      design: listDocs(project.workspace_path, 'design'),
      requirements: listDocs(project.workspace_path, 'requirement'),
      testSpecs: listDocs(project.workspace_path, 'test_spec'),
    };
  });

  // ── v4.4: 读取单个文档内容 ──
  ipcMain.handle('project:read-doc', (_event, projectId: string, type: string, id: string) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    if (!project?.workspace_path) return null;

    return readDoc(project.workspace_path, type as any, id);
  });

  // ── v4.3: 提交需求变更 ──
  ipcMain.handle('project:submit-change', async (_event, projectId: string, description: string) => {
    const db = getDb();
    const id = 'cr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    db.prepare("INSERT INTO change_requests (id, project_id, description) VALUES (?, ?, ?)")
      .run(id, projectId, description);

    const win = BrowserWindow.getAllWindows()[0];
    const abortCtrl = new AbortController();

    // 异步执行变更流程
    runChangeRequest(projectId, id, description, win, abortCtrl.signal)
      .catch(err => {
        log.error('ChangeRequest error', err);
      });

    return { success: true, changeRequestId: id };
  });

  // ── v4.3: 获取变更请求列表 ──
  ipcMain.handle('project:list-changes', (_event, projectId: string) => {
    const db = getDb();
    return db.prepare("SELECT * FROM change_requests WHERE project_id = ? ORDER BY created_at DESC")
      .all(projectId);
  });

  // ── v4.3: 获取影响分析 ──
  ipcMain.handle('project:get-impact-analysis', (_event, changeRequestId: string) => {
    const db = getDb();
    const row = db.prepare("SELECT * FROM change_requests WHERE id = ?").get(changeRequestId) as any;
    if (!row) return null;
    return {
      ...row,
      impactAnalysis: row.impact_analysis ? JSON.parse(row.impact_analysis) : null,
      affectedFeatures: row.affected_features ? JSON.parse(row.affected_features) : [],
    };
  });

  // ── 分析已有项目 (v5.1: Project Importer) ──
  ipcMain.handle('project:analyze-existing', async (_event, projectId: string) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    if (!project) return { success: false, error: 'Project not found' };

    const workspacePath = project.workspace_path;
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      return { success: false, error: 'Workspace path not found' };
    }

    // 如果已有导入进程在跑，先取消
    const existingAc = importAbortControllers.get(projectId);
    if (existingAc) {
      existingAc.abort();
      importAbortControllers.delete(projectId);
    }

    const ac = new AbortController();
    importAbortControllers.set(projectId, ac);

    const win = BrowserWindow.getAllWindows()[0] ?? null;

    // 更新状态为 analyzing
    db.prepare("UPDATE projects SET status = 'analyzing', updated_at = datetime('now') WHERE id = ?").run(projectId);
    sendToUI(win, 'project:status', { projectId, status: 'analyzing' });

    // 异步执行分析（不阻塞 IPC 返回）
    (async () => {
      try {
        log.info(`analyze-existing: starting importProject for ${projectId}`);
        const result = await importProject(
          workspacePath,
          projectId,
          ac.signal,
          (phase: number, step: string, progress: number) => {
            // 推送实时进度到前端
            log.debug(`analyze-existing progress: phase=${phase}, step="${step}", progress=${progress.toFixed(2)}`);
            sendToUI(win, 'project:import-progress', {
              projectId,
              phase,
              step,
              progress,
            });
          },
        );

        // 分析完成 → 更新项目状态 + wish 描述
        const summary = `已分析: ${result.skeleton.fileCount} 文件, ${result.skeleton.modules.length} 模块, ${result.docsGenerated} 文档已生成`;
        db.prepare("UPDATE projects SET status = 'paused', wish = ?, updated_at = datetime('now') WHERE id = ?")
          .run(`[导入项目] ${result.skeleton.techStack.join(', ')} | ${result.skeleton.totalLOC} LOC`, projectId);

        sendToUI(win, 'project:import-progress', {
          projectId,
          phase: 2,
          step: `✅ 分析完成! ${summary}`,
          progress: 1.0,
          done: true,
        });
        sendToUI(win, 'project:status', { projectId, status: 'paused' });

        addLog(projectId, 'project-importer', 'info', `📥 ${summary}`);
      } catch (err: unknown) {
        log.error('analyze-existing FAILED', err);
        // 被用户取消时不标记为 error，改为 paused 以允许重试
        const status = ac.signal.aborted ? 'paused' : 'error';
        db.prepare(`UPDATE projects SET status = '${status}', updated_at = datetime('now') WHERE id = ?`).run(projectId);
        const msg = ac.signal.aborted ? '⏸ 分析已中断，可重新启动' : `❌ 分析失败: ${toErrorMessage(err)}`;
        sendToUI(win, 'project:import-progress', {
          projectId,
          phase: -1,
          step: msg,
          progress: 0,
          done: true,
          error: !ac.signal.aborted,
        });
        sendToUI(win, 'project:status', { projectId, status });
        addLog(projectId, 'project-importer', ac.signal.aborted ? 'info' : 'error', msg);
      } finally {
        importAbortControllers.delete(projectId);
      }
    })();

    return { success: true, message: '分析已启动，请在 Overview 页面查看进度' };
  });

  // ── 文件夹选择对话框 (v5.1) ──
  ipcMain.handle('dialog:open-directory', async (_event, title?: string) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, {
      title: title || '选择文件夹',
      properties: ['openDirectory'],
    });
    return {
      canceled: result.canceled,
      filePaths: result.filePaths,
    };
  });

  // ── 基线上下文预览 (v5.6) ──
  ipcMain.handle('context:preview-baseline', (_event, projectId: string, role: string, tokenBudget?: number) => {
    const db = getDb();
    const project = db.prepare('SELECT workspace_path FROM projects WHERE id = ?').get(projectId) as { workspace_path?: string } | undefined;
    if (!project?.workspace_path || !fs.existsSync(project.workspace_path)) {
      return { success: false, error: 'Workspace not found' };
    }
    try {
      const snapshot = collectBaselineContext(project.workspace_path, role, tokenBudget || 128000);
      return { success: true, snapshot };
    } catch (err: unknown) {
      return { success: false, error: toErrorMessage(err) };
    }
  });
}




