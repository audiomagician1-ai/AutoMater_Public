# AgentForge 全自动化迭代计划 — GitHub + Supabase + Cloudflare

> 撰写日期: 2026-03-02
> 版本: v1.0
> 作者: 开发助手 (基于代码审计结果)
> 状态: **全部 4 个 Iteration 已完成 ✅**
> 
> ⚠️ **实际完成度 (2026-03-02)**:
> - Iteration 1 (密钥管理 + Phase 0 + DevOps 增强): ✅ 已完成 → `secret-manager.ts` + `project_secrets` 表 + `bootstrap-phase.ts` + devops 角色增强
> - Iteration 2 (GitHub 深度集成): ✅ 已完成 → `git-provider.ts` Branch/PR/Sync + `issue-watcher.ts` + `worker-phase.ts` 全自动分支→PR→Issue闭环
> - Iteration 3 (Supabase + Cloudflare): ✅ 已完成 → `supabase-tools.ts` + `cloudflare-tools.ts` + 13个工具 + bootstrap凭证验证增强
> - Iteration 4 (CI/CD Pipeline): ✅ 已完成 → `deploy-phase.ts` ReAct DevOps Agent + 6个扩展部署工具 + 7步全自动部署Pipeline
> 
> 最新项目状态请查看 **CLAUDE.md**。

---

## 零、现状摸底

### 已有能力 (已实现 & 可用)

| 能力 | 实现位置 | 完整度 |
|------|---------|--------|
| `git init` / `git add` / `git commit` / `git push origin HEAD` | `git-provider.ts:53-129` | ✅ 完整 |
| `git diff` / `git log` | `git-provider.ts:131-152` | ✅ 完整 |
| GitHub Issue 创建 | `git-provider.ts:181-208` + `tool-executor.ts:625-629` | ✅ 完整 |
| GitHub Issue 列表查询 | `git-provider.ts:229-251` + `tool-executor.ts:632-637` | ✅ 完整 |
| GitHub Issue 关闭 | `git-provider.ts:210-227` | ✅ 函数存在，但 **无对应 Tool 定义** |
| GitHub Issue 评论 | `git-provider.ts:253-271` | ✅ 函数存在，但 **无对应 Tool 定义** |
| GitHub 连接测试 | `git-provider.ts:273-281` | ✅ IPC 调用可用 |
| Docker Compose 生成 + 部署 | `deploy-tools.ts:102-225` | ✅ 完整 |
| PM2 配置 + 启动 | `deploy-tools.ts:250-307` | ✅ 完整 |
| Nginx 配置生成 | `deploy-tools.ts:365-465` | ✅ 完整 |
| Dockerfile 生成 | `deploy-tools.ts:575-649` | ✅ 完整 |
| 端口检测 + 健康检查 | `deploy-tools.ts:474-543` | ✅ 完整 |
| Docker Sandbox (容器隔离执行) | `docker-sandbox.ts` + 5个工具 | ✅ 完整 |
| 密钥存储 | `projects` 表: `github_token` 字段 | ⚠️ 仅 GitHub Token |
| DB Schema | `db.ts:307-365` — `git_mode`, `github_repo`, `github_token` | ⚠️ 仅 GitHub |

### 关键缺口

| 缺口 | 严重度 | 说明 |
|------|--------|------|
| **无 GitHub Branch / PR 管理** | 🔴 高 | 没有 `git checkout -b` / `git pull` / `github_create_pr` / `github_merge_pr` |
| **无 Issue→Feature 自动关联** | 🔴 高 | Issue 和 Feature 完全独立，无法从 Issue 驱动开发 |
| **无 Supabase 集成** | 🔴 高 | 零实现 |
| **无 Cloudflare 集成** | 🔴 高 | 零实现 |
| **无统一密钥管理** | 🟡 中 | GitHub Token 直接存 SQLite 明文，无加密、无统一接口 |
| **DevOps Phase 只做构建验证** | 🟡 中 | `devops-phase.ts` 只跑 `npm install` / `tsc` / `build`，不做部署 |
| **无 Phase 0 (环境初始化)** | 🟡 中 | 先编码后装依赖，顺序错误 |
| **deploy-tools.ts 无对应 Agent Tool** | 🟡 中 | 模块完整但未注册为 Agent 可调用的工具 |
| **`closeIssue` / `addIssueComment` 无 Tool 定义** | 🟡 中 | 函数实现存在但 Agent 无法调用 |
| **devops 角色工具过少** | 🟡 中 | devops 角色连 `read_file` / `write_file` / `list_files` 都没有 |

---

## 一、迭代总览

分 **4 个迭代 (Iteration)**，每个迭代独立可交付，按依赖顺序排列：

```
Iteration 1: 基础设施层 — 密钥管理 + Phase 0 + DevOps 角色增强
     ↓
Iteration 2: GitHub 深度集成 — Branch/PR + Issue驱动开发循环
     ↓
Iteration 3: 外部平台集成 — Supabase + Cloudflare 自动化管理
     ↓
Iteration 4: 全自动 CI/CD Pipeline — 端到端闭环
```

---

## 二、Iteration 1: 基础设施层 (预计 3-4 天)

> **目标**: 为后续三个迭代打好地基。没有密钥管理和环境初始化，后续一切无从谈起。

### I1.1 统一密钥/凭证管理系统

**动机**: 当前 `github_token` 直接明文存在 `projects` 表中。Supabase/Cloudflare 需要更多密钥（API Key、Access Token、Service Role Key 等），不能继续每加一个平台就在 `projects` 表加一列。

**设计**:

```sql
-- 新表: project_secrets
CREATE TABLE IF NOT EXISTS project_secrets (
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,          -- 如 'github_token', 'supabase_url', 'cloudflare_api_token'
  value TEXT NOT NULL,        -- 加密后的值 (AES-256-GCM)
  provider TEXT NOT NULL,     -- 'github' | 'supabase' | 'cloudflare' | 'custom'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, key),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

```typescript
// electron/engine/secret-manager.ts
import crypto from 'crypto';

// 加密密钥派生: 基于 machineId + appKey
function deriveKey(): Buffer { ... }

export function setSecret(projectId: string, key: string, value: string, provider: string): void;
export function getSecret(projectId: string, key: string): string | null;
export function listSecrets(projectId: string, provider?: string): Array<{ key: string; provider: string; maskedValue: string }>;
export function deleteSecret(projectId: string, key: string): void;

// 批量获取某个 provider 的所有密钥 → 方便注入环境变量
export function getProviderSecrets(projectId: string, provider: string): Record<string, string>;
```

**迁移**：自动把 `projects.github_token` 迁移到 `project_secrets` 表中。

**UI**: 项目设置页面增加"密钥管理"面板，支持 GitHub / Supabase / Cloudflare 三类密钥的 CRUD。

**文件变更**:
- 新增: `electron/engine/secret-manager.ts`
- 修改: `electron/db.ts` (新表 + 迁移)
- 修改: `electron/ipc/project.ts` (密钥 CRUD IPC)
- 修改: `electron/preload.ts` (暴露密钥 API)
- 修改: `src/pages/` (设置 UI)

### I1.2 Phase 0: 环境初始化

**动机**: 当前 Developer Agent (Phase 4a) 开始编码时，依赖尚未安装。DevOps Phase (4d) 才跑 `npm install`，这导致 Developer 经常在 ReAct 循环中自己跑 `npm install`，浪费 token 和时间。

**设计**: 在 `orchestrator.ts` 的 Phase 1 (PM 分析) 之前插入 Phase 0:

```typescript
// orchestrator.ts — runOrchestrator() 开头
// ═══════════════ Phase 0: 环境初始化 ═══════════════
if (workspacePath && !signal.aborted) {
  await phaseEnvironmentBootstrap(projectId, win, signal, workspacePath);
}
```

```typescript
// phases/bootstrap-phase.ts
export async function phaseEnvironmentBootstrap(
  projectId: string, win: BrowserWindow | null,
  signal: AbortSignal, workspacePath: string
): Promise<void> {
  // 1. 检测项目类型 (package.json / requirements.txt / Cargo.toml / go.mod)
  // 2. 安装依赖 (npm ci / pip install -r / cargo build / go mod download)
  // 3. 验证安装成功 (检查 node_modules/ 存在 或 exit code 0)
  // 4. 注入密钥到 .env (从 secret-manager 读取，写入 .env.local，加入 .gitignore)
  // 5. 运行 git init + 远程设置 (如果 git_mode === 'github')
}
```

**文件变更**:
- 新增: `electron/engine/phases/bootstrap-phase.ts`
- 修改: `electron/engine/orchestrator.ts` (插入 Phase 0)
- 修改: `electron/engine/phases/shared.ts` (导出依赖)

### I1.3 DevOps 角色增强

**动机**: 当前 devops 角色工具白名单严重不足——连 `read_file` / `write_file` / `list_files` 都没有，无法读取配置文件或写入部署脚本。

**设计**: 扩充 `ROLE_TOOLS.devops`:

```typescript
devops: [
  'think', 'task_complete', 'todo_write', 'todo_read',
  // 文件操作 (完整读写)
  'read_file', 'write_file', 'edit_file', 'batch_edit',
  'list_files', 'glob_files', 'search_files',
  // 命令执行
  'run_command', 'check_process', 'run_test',
  // HTTP
  'http_request', 'fetch_url',
  // Git + GitHub
  'git_commit', 'git_diff', 'git_log',
  'github_create_issue', 'github_list_issues',
  'github_close_issue', 'github_add_comment',       // 新增
  'github_create_pr', 'github_list_prs',             // Iteration 2
  'github_pull', 'github_create_branch',             // Iteration 2
  // 部署工具 (新增)
  'deploy_compose', 'deploy_dockerfile', 'deploy_health_check',
  // 外部平台 (Iteration 3)
  'supabase_cli', 'cloudflare_cli',
  // Docker Sandbox
  'sandbox_init', 'sandbox_exec', 'sandbox_write', 'sandbox_read', 'sandbox_destroy',
  // 记忆
  'memory_read', 'memory_append',
  // 搜索
  'web_search', 'fetch_url',
],
```

**同时**: 注册 `closeIssue` 和 `addIssueComment` 为正式 Agent Tool:

```typescript
// tool-registry.ts — 新增 Tool 定义
{
  name: 'github_close_issue',
  description: '关闭 GitHub Issue（仅 GitHub 模式下可用）。',
  parameters: {
    type: 'object',
    properties: { issue_number: { type: 'number', description: 'Issue 编号' } },
    required: ['issue_number'],
  },
},
{
  name: 'github_add_comment',
  description: '在 GitHub Issue 上添加评论（仅 GitHub 模式下可用）。',
  parameters: {
    type: 'object',
    properties: {
      issue_number: { type: 'number', description: 'Issue 编号' },
      body: { type: 'string', description: '评论内容 (支持 Markdown)' },
    },
    required: ['issue_number', 'body'],
  },
},
```

**文件变更**:
- 修改: `electron/engine/tool-registry.ts` (新 Tool 定义 + devops 角色扩充)
- 修改: `electron/engine/tool-executor.ts` (新增 async handler)
- 修改: `electron/engine/tool-registry.ts` `isAsyncTool()` (新增 github_close_issue, github_add_comment)

---

## 三、Iteration 2: GitHub 深度集成 (预计 5-7 天)

> **目标**: 实现完整的 Git 工作流 (Branch/PR/Pull) + Issue 驱动自动开发闭环。

### I2.1 git-provider.ts 扩展 — Branch & PR

**新增函数**:

```typescript
// git-provider.ts — 新增

// ═══════ Branch 管理 ═══════
export async function createBranch(config: GitProviderConfig, branchName: string): Promise<boolean>;
export async function checkoutBranch(config: GitProviderConfig, branchName: string): Promise<boolean>;
export async function getCurrentBranch(workspacePath: string): Promise<string>;
export async function listBranches(workspacePath: string): Promise<string[]>;
export async function deleteBranch(config: GitProviderConfig, branchName: string): Promise<boolean>;

// ═══════ Pull / Fetch / Merge ═══════
export async function pull(config: GitProviderConfig, branch?: string): Promise<{ success: boolean; output: string; conflicts?: string[] }>;
export async function fetch(config: GitProviderConfig): Promise<boolean>;
export async function mergeBranch(config: GitProviderConfig, from: string): Promise<{ success: boolean; conflicts?: string[] }>;

// ═══════ GitHub PR (全新) ═══════
export interface PullRequest {
  number: number;
  title: string;
  state: string;
  body?: string;
  head: string;   // source branch
  base: string;   // target branch
  html_url: string;
  merged: boolean;
  mergeable: boolean | null;
}

export async function createPR(
  config: GitProviderConfig,
  title: string, body: string,
  head: string, base?: string   // base 默认 'main'
): Promise<PullRequest | null>;

export async function listPRs(
  config: GitProviderConfig,
  state?: 'open' | 'closed' | 'all'
): Promise<PullRequest[]>;

export async function mergePR(
  config: GitProviderConfig,
  prNumber: number,
  method?: 'merge' | 'squash' | 'rebase'
): Promise<boolean>;

export async function closePR(config: GitProviderConfig, prNumber: number): Promise<boolean>;

// ═══════ GitHub Issue 增强 ═══════
export async function getIssue(config: GitProviderConfig, issueNumber: number): Promise<GitHubIssue | null>;
export async function updateIssue(
  config: GitProviderConfig, issueNumber: number,
  updates: { title?: string; body?: string; labels?: string[]; state?: 'open' | 'closed' }
): Promise<boolean>;
export async function listIssueComments(config: GitProviderConfig, issueNumber: number): Promise<Array<{ user: string; body: string; created_at: string }>>;
```

### I2.2 新 Agent Tools — Git 工作流

在 `tool-registry.ts` 注册完整的 Git/GitHub 工具集:

| Tool 名 | 描述 | 异步 | 谁可用 |
|---------|------|------|--------|
| `github_create_branch` | 创建并切换到新分支 | ✅ | developer, devops |
| `github_checkout_branch` | 切换分支 | ✅ | developer, devops |
| `github_pull` | 拉取远程最新代码 | ✅ | developer, devops |
| `github_create_pr` | 创建 Pull Request | ✅ | developer, devops |
| `github_list_prs` | 列出 PR | ✅ | developer, devops, pm |
| `github_merge_pr` | 合并 PR | ✅ | devops |
| `github_close_issue` | 关闭 Issue | ✅ | developer, devops |
| `github_add_comment` | Issue 评论 | ✅ | developer, devops, pm |
| `github_get_issue` | 获取 Issue 详情 | ✅ | all roles |
| `github_update_issue` | 更新 Issue 标签/状态 | ✅ | developer, devops |

### I2.3 Issue 驱动自动开发闭环

**这是最关键的全新功能**——从 GitHub Issue 自动触发开发流程。

**设计**:

```
┌─────────────────────────────────────────────────────────┐
│                   Issue 驱动开发闭环                       │
│                                                          │
│  GitHub Issue (open)                                     │
│       ↓ [轮询/Webhook]                                   │
│  issue-watcher.ts: 检测新 Issue                          │
│       ↓                                                  │
│  PM Agent: 分析 Issue → 拆解为 Feature                    │
│       ↓                                                  │
│  DevOps: 创建 feature 分支 (feature/issue-42)            │
│       ↓                                                  │
│  Developer Agent: 在分支上实现 Feature                    │
│       ↓                                                  │
│  QA Agent: 审查 + 测试                                   │
│       ↓                                                  │
│  DevOps: 提交 + Push + 创建 PR                           │
│       ↓                                                  │
│  (可选) 自动 merge PR / 等待人工 review                   │
│       ↓                                                  │
│  DevOps: Issue 添加评论(修复说明) + 关闭 Issue            │
│       ↓                                                  │
│  合并到 main → 触发 Iteration 4 的 CI/CD                 │
└─────────────────────────────────────────────────────────┘
```

**新模块**: `electron/engine/issue-watcher.ts`

```typescript
// issue-watcher.ts
// 定时轮询 GitHub Issues (可配置间隔, 默认 60s)
// 或者通过 IPC 手动触发扫描

export interface IssueWatcherConfig {
  pollIntervalMs: number;      // 轮询间隔
  autoCreateFeature: boolean;  // 是否自动创建 Feature
  autoCreateBranch: boolean;   // 是否自动创建分支
  labelFilter?: string[];      // 只处理带特定标签的 Issue
  ignoredLabels?: string[];    // 忽略带这些标签的 Issue
}

export function startIssueWatcher(projectId: string, config: IssueWatcherConfig): void;
export function stopIssueWatcher(projectId: string): void;

// 手动处理单个 Issue
export async function processIssue(projectId: string, issueNumber: number): Promise<{
  featureId: string;     // 创建的 Feature ID
  branchName: string;    // 创建的分支名
}>;
```

**Feature ↔ Issue 关联**: 在 `features` 表增加字段:

```sql
ALTER TABLE features ADD COLUMN github_issue_number INTEGER;
ALTER TABLE features ADD COLUMN github_pr_number INTEGER;
ALTER TABLE features ADD COLUMN github_branch TEXT;
```

**Orchestrator 集成**: 修改 `workerLoop` 结尾——Feature 完成时:

```typescript
// worker-phase.ts — workerLoop 完成后
if (feature.github_issue_number && gitConfig.mode === 'github') {
  // 1. Push 当前分支
  await commit(gitConfig, `feat: resolve #${feature.github_issue_number} — ${feature.title}`);
  // 2. 创建 PR (如果还没有)
  if (!feature.github_pr_number) {
    const pr = await createPR(gitConfig, feature.title, `Resolves #${feature.github_issue_number}\n\n${feature.description}`, feature.github_branch);
    if (pr) db.prepare("UPDATE features SET github_pr_number = ? WHERE id = ? AND project_id = ?").run(pr.number, feature.id, projectId);
  }
  // 3. 评论 Issue (进度通知)
  await addIssueComment(gitConfig, feature.github_issue_number, `✅ Feature implemented and PR #${feature.github_pr_number} created by AutoMater.`);
}
```

**文件变更**:
- 修改: `electron/engine/git-provider.ts` (大量新增)
- 新增: `electron/engine/issue-watcher.ts`
- 修改: `electron/engine/tool-registry.ts` (10+ 新 Tool)
- 修改: `electron/engine/tool-executor.ts` (async handlers)
- 修改: `electron/engine/phases/worker-phase.ts` (Issue 关联)
- 修改: `electron/db.ts` (features 表迁移)
- 修改: `electron/engine/types.ts` (FeatureRow 扩展)
- 修改: `electron/ipc/project.ts` (Issue 扫描 IPC)
- 修改: 前端 (Issue 看板 UI)

---

## 四、Iteration 3: 外部平台集成 (预计 7-10 天)

> **目标**: Agent 可以通过工具直接管理 Supabase 和 Cloudflare，实现从数据库到部署的全自动化。

### I3.1 Supabase 集成

**策略**: 通过 **Supabase CLI (npx supabase)** + **Supabase Management API** 双通道:
- CLI 用于本地开发环境操作 (init, migration, seed, functions)
- Management API 用于远程项目管理 (创建项目、查询状态、管理密钥)

**所需密钥** (存入 `project_secrets`):
```
supabase_access_token   — Supabase 个人 Access Token (Management API)
supabase_project_ref    — 项目 ref (如 abcdef123456)  
supabase_db_password    — 数据库密码
supabase_anon_key       — 匿名 API Key (前端用)
supabase_service_key    — Service Role Key (后端用)
supabase_project_url    — https://xxx.supabase.co
```

**新模块**: `electron/engine/supabase-tools.ts`

```typescript
// supabase-tools.ts
export interface SupabaseConfig {
  accessToken: string;
  projectRef: string;
  dbPassword?: string;
  workspacePath: string;
}

// ═══════ 项目管理 (Management API) ═══════
export async function listProjects(accessToken: string): Promise<Array<{ id: string; name: string; region: string; status: string }>>;
export async function getProjectStatus(config: SupabaseConfig): Promise<{ status: string; dbSize: string; apiUrl: string }>;

// ═══════ 数据库迁移 (CLI) ═══════
export async function initSupabase(workspacePath: string): Promise<{ success: boolean; output: string }>;  // npx supabase init
export async function createMigration(config: SupabaseConfig, name: string): Promise<string>;  // npx supabase migration new
export async function pushMigration(config: SupabaseConfig): Promise<{ success: boolean; output: string }>;  // npx supabase db push
export async function pullSchema(config: SupabaseConfig): Promise<{ success: boolean; output: string }>;  // npx supabase db pull
export async function resetDatabase(config: SupabaseConfig): Promise<{ success: boolean; output: string }>;  // npx supabase db reset

// ═══════ Edge Functions (CLI) ═══════
export async function deployFunction(config: SupabaseConfig, functionName: string): Promise<{ success: boolean; output: string }>;
export async function listFunctions(config: SupabaseConfig): Promise<Array<{ name: string; status: string }>>;

// ═══════ 环境变量 / Secrets ═══════
export async function setSupabaseSecret(config: SupabaseConfig, name: string, value: string): Promise<boolean>;
export async function listSupabaseSecrets(config: SupabaseConfig): Promise<string[]>;

// ═══════ 类型生成 ═══════
export async function generateTypes(config: SupabaseConfig): Promise<{ success: boolean; filePath: string }>;  // npx supabase gen types
```

**Agent Tools**:

| Tool 名 | 描述 | 谁可用 |
|---------|------|--------|
| `supabase_status` | 查询项目状态 | devops, developer |
| `supabase_migration_create` | 创建数据库迁移文件 | developer |
| `supabase_migration_push` | 推送迁移到远程 | devops |
| `supabase_db_pull` | 拉取远程 schema | developer, devops |
| `supabase_deploy_function` | 部署 Edge Function | devops |
| `supabase_gen_types` | 生成 TypeScript 类型 | developer |
| `supabase_set_secret` | 设置远程环境变量 | devops |

### I3.2 Cloudflare 集成

**策略**: 通过 **Wrangler CLI (npx wrangler)** + **Cloudflare API** 双通道:
- Wrangler 用于 Workers/Pages 部署
- Cloudflare API 用于 DNS、环境变量、KV 等管理

**所需密钥**:
```
cloudflare_api_token    — API Token (推荐细粒度 Token)
cloudflare_account_id   — 账户 ID
cloudflare_zone_id      — 域名 Zone ID (如需 DNS 管理)
```

**新模块**: `electron/engine/cloudflare-tools.ts`

```typescript
// cloudflare-tools.ts
export interface CloudflareConfig {
  apiToken: string;
  accountId: string;
  zoneId?: string;
  workspacePath: string;
}

// ═══════ Pages 部署 ═══════
export async function deployPages(config: CloudflareConfig, options?: {
  projectName?: string;
  directory?: string;   // 构建输出目录, 默认 'dist'
  branch?: string;
}): Promise<{ success: boolean; url: string; output: string }>;

export async function listPagesProjects(config: CloudflareConfig): Promise<Array<{ name: string; subdomain: string; latestDeployUrl: string }>>;

// ═══════ Workers 部署 ═══════
export async function deployWorker(config: CloudflareConfig, options?: {
  name?: string;
  entryPoint?: string;
}): Promise<{ success: boolean; url: string; output: string }>;

// ═══════ 环境变量 ═══════
export async function setWorkerSecret(config: CloudflareConfig, workerName: string, key: string, value: string): Promise<boolean>;
export async function setWorkerEnv(config: CloudflareConfig, workerName: string, vars: Record<string, string>): Promise<boolean>;

// ═══════ DNS 管理 ═══════
export async function listDNSRecords(config: CloudflareConfig): Promise<Array<{ type: string; name: string; content: string; proxied: boolean }>>;
export async function createDNSRecord(config: CloudflareConfig, record: { type: string; name: string; content: string; proxied?: boolean }): Promise<boolean>;
export async function deleteDNSRecord(config: CloudflareConfig, recordId: string): Promise<boolean>;

// ═══════ KV Namespace ═══════
export async function createKVNamespace(config: CloudflareConfig, title: string): Promise<string>;  // returns namespace ID
export async function bindKVToWorker(config: CloudflareConfig, workerName: string, binding: string, namespaceId: string): Promise<boolean>;

// ═══════ 状态查询 ═══════
export async function getDeploymentStatus(config: CloudflareConfig, projectName: string): Promise<{ url: string; status: string; lastDeploy: string }>;
```

**Agent Tools**:

| Tool 名 | 描述 | 谁可用 |
|---------|------|--------|
| `cloudflare_deploy_pages` | 部署静态站点到 Cloudflare Pages | devops |
| `cloudflare_deploy_worker` | 部署 Worker | devops |
| `cloudflare_set_secret` | 设置 Worker 环境变量 | devops |
| `cloudflare_dns_list` | 列出 DNS 记录 | devops |
| `cloudflare_dns_create` | 创建 DNS 记录 | devops |
| `cloudflare_status` | 查询部署状态 | devops, developer |

### I3.3 Phase 0 扩展 — 平台凭证验证

在 Phase 0 (bootstrap-phase.ts) 中增加凭证验证步骤:

```typescript
// bootstrap-phase.ts 增加
async function validatePlatformCredentials(projectId: string, win: BrowserWindow | null) {
  const secrets = listSecrets(projectId);
  
  // GitHub
  if (secrets.some(s => s.key === 'github_token')) {
    const ok = await testGitHubConnection(getSecret(projectId, 'github_repo'), getSecret(projectId, 'github_token'));
    sendToUI(win, 'agent:log', { content: ok.success ? '✅ GitHub 连接正常' : `❌ GitHub: ${ok.message}` });
  }
  
  // Supabase
  if (secrets.some(s => s.key === 'supabase_access_token')) {
    const status = await getProjectStatus({ ... });
    sendToUI(win, 'agent:log', { content: status ? '✅ Supabase 连接正常' : '❌ Supabase 连接失败' });
  }
  
  // Cloudflare
  if (secrets.some(s => s.key === 'cloudflare_api_token')) {
    // 验证 API Token 有效性
    sendToUI(win, 'agent:log', { content: '✅ Cloudflare 连接正常' });
  }
}
```

---

## 五、Iteration 4: 全自动 CI/CD Pipeline (预计 5-7 天)

> **目标**: 端到端闭环——代码完成 → 构建 → 部署 → 健康检查 → 通知。

### I4.1 DevOps Phase 升级为全功能部署阶段

**当前** `devops-phase.ts` 只做构建验证 (npm install → tsc → build)。

**升级后**完整流程:

```
Phase 4d: DevOps Pipeline
│
├── Step 1: 构建验证 (现有)
│   └── npm install → tsc → lint → test → build
│
├── Step 2: 数据库部署 (新)
│   └── if Supabase configured:
│       ├── supabase db push (执行迁移)
│       ├── supabase gen types (生成类型)
│       └── supabase functions deploy (部署 Edge Functions)
│
├── Step 3: 前端/Workers 部署 (新)
│   └── if Cloudflare configured:
│       ├── wrangler pages deploy dist/ (静态站点)
│       └── wrangler deploy (Workers)
│   └── else if Docker configured:
│       ├── docker compose build
│       └── docker compose up -d
│
├── Step 4: 环境变量同步 (新)
│   └── 从 project_secrets 同步到 Supabase/Cloudflare 远程环境
│
├── Step 5: 健康检查 (增强)
│   └── 对所有部署端点执行 healthCheck()
│
├── Step 6: Git 操作 (新)
│   └── git commit → git push → create PR (如果在 feature 分支)
│
└── Step 7: 通知 (新)
    └── GitHub Issue 评论部署结果 + 链接
```

**新模块**: `electron/engine/phases/deploy-phase.ts` (取代简单的 devops-phase)

### I4.2 deploy-tools.ts 注册为 Agent 工具

当前 `deploy-tools.ts` 有完整实现但 **没有对应 Agent Tool**。注册:

| Tool 名 | 映射 | 谁可用 |
|---------|------|--------|
| `deploy_compose_generate` | `generateComposeYaml()` | devops |
| `deploy_compose_up` | `deployWithCompose()` | devops |
| `deploy_compose_down` | `composeDown()` | devops |
| `deploy_dockerfile_generate` | `generateDockerfile()` | devops, developer |
| `deploy_pm2_start` | `pm2Start()` | devops |
| `deploy_pm2_status` | `pm2Status()` | devops |
| `deploy_nginx_generate` | `generateNginxConfig()` | devops |
| `deploy_health_check` | `healthCheck()` | devops, qa |
| `deploy_find_port` | `findAvailablePort()` | devops, developer |

### I4.3 端到端部署工作流

```
开发完成
  ↓
DevOps Agent (ReAct模式):
  ├── 分析项目类型和部署目标
  ├── 读取 ARCHITECTURE.md 获取部署需求
  ├── 使用适当的部署工具:
  │   ├── Cloudflare Pages (前端 SPA)
  │   ├── Supabase (数据库 + Edge Functions)  
  │   ├── Docker Compose (自建服务器)
  │   └── PM2 (直接部署)
  ├── 同步环境变量
  ├── 执行健康检查
  ├── Git commit + push
  └── 在 Issue 上评论部署结果
```

**关键设计决策**: DevOps Agent 升级为 **ReAct 模式** (使用 `reactAgentLoop()`)，而非当前的硬编码 for 循环。这使它能根据项目类型智能选择部署策略。

---

## 六、数据库 Schema 变更汇总

```sql
-- Iteration 1
CREATE TABLE IF NOT EXISTS project_secrets (...);  -- 密钥管理

-- Iteration 2  
ALTER TABLE features ADD COLUMN github_issue_number INTEGER;
ALTER TABLE features ADD COLUMN github_pr_number INTEGER;
ALTER TABLE features ADD COLUMN github_branch TEXT;

-- Iteration 3
-- 无额外表，密钥存在 project_secrets

-- Iteration 4
-- 可选: 部署历史记录表
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,       -- 'cloudflare_pages' | 'supabase' | 'docker' | 'pm2'
  status TEXT NOT NULL,         -- 'deploying' | 'success' | 'failed'
  url TEXT,
  commit_hash TEXT,
  feature_id TEXT,
  output TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

---

## 七、密钥需求清单

用户需要提供的密钥（按迭代）:

### Iteration 1-2 (GitHub)
| 密钥 | 用途 | 获取方式 |
|------|------|---------|
| `github_token` | GitHub API 全功能访问 | GitHub Settings → Developer Settings → Personal Access Tokens → Fine-grained → repo + issues + pull_requests 权限 |
| `github_repo` | 目标仓库 | 格式: `owner/repo` |

### Iteration 3 (Supabase)
| 密钥 | 用途 | 获取方式 |
|------|------|---------|
| `supabase_access_token` | Management API | supabase.com/dashboard → Account → Access Tokens |
| `supabase_project_ref` | 项目标识 | Dashboard → Project Settings → General → Reference ID |
| `supabase_project_url` | API 端点 | Dashboard → Project Settings → API → Project URL |
| `supabase_anon_key` | 前端 API 调用 | Dashboard → Project Settings → API → anon/public |
| `supabase_service_key` | 后端 API 调用 | Dashboard → Project Settings → API → service_role |
| `supabase_db_password` | 数据库直连 | 项目创建时设置 |

### Iteration 3 (Cloudflare)
| 密钥 | 用途 | 获取方式 |
|------|------|---------|
| `cloudflare_api_token` | API 全功能访问 | Cloudflare Dashboard → My Profile → API Tokens → Create Token |
| `cloudflare_account_id` | 账户标识 | Dashboard → 任意域名 → 右侧 Overview → Account ID |
| `cloudflare_zone_id` | 域名 Zone (DNS 管理) | Dashboard → 域名 → 右侧 Overview → Zone ID |

---

## 八、工作流全景图 (最终形态)

```
┌─────────────────────────────────────────────────────────────────┐
│                    AgentForge 全自动化工作流                       │
│                                                                  │
│  输入:                                                           │
│  ├── 用户 Wish (自然语言需求)                                     │
│  ├── GitHub Issue (外部触发)                                      │
│  └── 密钥配置 (GitHub + Supabase + Cloudflare)                   │
│                                                                  │
│  Phase 0: 环境初始化                                              │
│  ├── 依赖安装 (npm/pip/cargo)                                    │
│  ├── .env 密钥注入                                                │
│  ├── Git 初始化 + 远程设置                                        │
│  └── 平台凭证验证 (GitHub/Supabase/Cloudflare)                   │
│                                                                  │
│  Phase 1-3: PM → Architect → Docs (现有)                         │
│                                                                  │
│  Phase 4a: Developer 实现                                        │
│  ├── 从 main 创建 feature 分支                                   │
│  ├── ReAct 循环编码                                               │
│  ├── Supabase 迁移文件生成                                        │
│  └── 定期 commit + push                                          │
│                                                                  │
│  Phase 4b-4c: QA 审查 + 文档 (现有)                              │
│                                                                  │
│  Phase 4d: DevOps 全功能部署 (ReAct模式)                          │
│  ├── 构建验证                                                     │
│  ├── Supabase: db push + gen types + deploy functions            │
│  ├── Cloudflare: pages deploy / workers deploy                   │
│  ├── 健康检查                                                     │
│  ├── Git: push + PR + Issue 评论                                 │
│  └── 部署结果记录                                                 │
│                                                                  │
│  Phase 5: 交付 (现有)                                            │
│                                                                  │
│  Issue 闭环:                                                     │
│  ├── Feature 完成 → 自动关闭关联 Issue                            │
│  ├── PR 自动创建 + merge (可配置)                                 │
│  └── 部署 URL 自动评论到 Issue                                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 九、风险评估与缓解

| 风险 | 严重度 | 缓解策略 |
|------|--------|---------|
| **密钥泄露** (SQLite 被读取) | 🔴 高 | AES-256-GCM 加密 + machineId 派生密钥；.env 文件加入 .gitignore |
| **GitHub API 限流** (5000次/h) | 🟡 中 | 批量操作 + 指数退避 + 缓存 Issue/PR 列表 |
| **Supabase CLI 未安装** | 🟡 中 | Phase 0 自动检测 + 提示安装；或通过 `npx supabase` 免安装 |
| **Wrangler CLI 未安装** | 🟡 中 | 同上，`npx wrangler` |
| **部署失败无法回滚** | 🟡 中 | 每次部署前 Git tag 标记；Cloudflare Pages 天然支持回滚 |
| **分支冲突 (pull 时)** | 🟡 中 | Developer Agent 的 ReAct 循环可处理 merge conflict (已有 run_command 能力) |
| **Token 成本增加** (DevOps 升级 ReAct) | 🟢 低 | 使用 fast 层模型 (如 gpt-4o-mini)，限制 10 轮 |
| **多平台状态不一致** | 🟢 低 | 部署历史记录 + 健康检查轮询 |

---

## 十、优先级总结

| 顺序 | 迭代 | 预计工期 | 核心交付 | 依赖 |
|------|------|---------|---------|------|
| **1** | Iteration 1: 基础设施 | 3-4天 | 密钥管理 + Phase 0 + DevOps 增强 | 无 |
| **2** | Iteration 2: GitHub 深度集成 | 5-7天 | Branch/PR + Issue驱动开发 | I1 |
| **3** | Iteration 3: Supabase + Cloudflare | 7-10天 | 数据库/部署平台自动管理 | I1 |
| **4** | Iteration 4: CI/CD Pipeline | 5-7天 | 端到端自动部署闭环 | I1 + I2 + I3 |

**总计**: 约 20-28 天 (单人全栈)

**建议**: Iteration 2 和 Iteration 3 在 I1 完成后可以 **并行开发** (无交叉依赖)。

---

*本文档待评审后进入实施阶段。如需调整优先级或范围，请指定。*
