/**
 * Deploy Phase — 全自动 CI/CD Pipeline (v15.0 — I4)
 *
 * 替代旧的 devops-phase.ts (硬编码 build-only)，升级为 ReAct 模式的
 * DevOps Agent 全流程部署:
 *
 *   Step 1: 构建验证 (npm install → tsc → lint → test → build)
 *   Step 2: 数据库部署 (Supabase migration push + gen types + deploy functions)
 *   Step 3: 前端/Workers 部署 (Cloudflare Pages/Workers or Docker Compose)
 *   Step 4: 环境变量同步 (project_secrets → remote platforms)
 *   Step 5: 健康检查 (all deployed endpoints)
 *   Step 6: Git 操作 (commit → push → create PR if feature branch)
 *   Step 7: 通知 (GitHub Issue comment with deploy result + links)
 *
 * 设计决策:
 *   - DevOps Agent 使用 reactAgentLoop (ReAct 模式)，根据项目配置智能选择部署策略
 *   - 项目检测逻辑仅收集上下文，具体决策由 LLM 做出
 *   - 旧的 phaseDevOpsBuild 作为快速模式保留 (无部署目标时 fallback)
 *
 * @module phases/deploy-phase
 */

import {
  BrowserWindow, getDb, createLogger, execSync, fs, path, execAsync,
  sendToUI, addLog,
  spawnAgent, reactAgentLoop, getTeamMemberMaxIterations,
  emitEvent, commitWorkspace,
  resolveMemberModel,
  type AppSettings, type GenericReactResult,
} from './shared';

import type { GitProviderConfig } from '../git-provider';
import { hasSecret, listSecrets } from '../secret-manager';

const log = createLogger('phase:deploy');

// ═══════════════════════════════════════
// Deploy Context Detection
// ═══════════════════════════════════════

interface DeployContext {
  /** 项目类型 */
  projectType: string;
  /** 检测到的构建系统 */
  buildSystem: string | null;
  /** 是否配置了 Supabase */
  hasSupabase: boolean;
  /** 是否配置了 Cloudflare */
  hasCloudflare: boolean;
  /** 是否配置了 Docker */
  hasDocker: boolean;
  /** 是否配置了 GitHub (用于 PR/push) */
  hasGitHub: boolean;
  /** 当前 Git 分支 */
  currentBranch: string;
  /** 是否在 feature 分支上 */
  isFeatureBranch: boolean;
  /** 关联的 Issue 编号 (从分支名或 feature 表获取) */
  issueNumber: number | null;
  /** 可用密钥列表 (不含值，仅 key 名) */
  availableSecrets: string[];
  /** ARCHITECTURE.md 摘要 (部署相关) */
  architectureSummary: string;
  /** package.json scripts (如果存在) */
  scripts: Record<string, string>;
  /** 现有 Dockerfile */
  hasDockerfile: boolean;
  /** 现有 docker-compose.yml */
  hasComposeFile: boolean;
  /** 现有 nginx 配置 */
  hasNginxConf: boolean;
}

/**
 * 检测项目的部署上下文 — 收集所有部署决策所需信息
 */
function detectDeployContext(
  projectId: string,
  workspacePath: string,
  gitConfig: GitProviderConfig,
): DeployContext {
  const ctx: DeployContext = {
    projectType: 'unknown',
    buildSystem: null,
    hasSupabase: false,
    hasCloudflare: false,
    hasDocker: false,
    hasGitHub: gitConfig.mode === 'github',
    currentBranch: 'main',
    isFeatureBranch: false,
    issueNumber: null,
    availableSecrets: [],
    architectureSummary: '',
    scripts: {},
    hasDockerfile: false,
    hasComposeFile: false,
    hasNginxConf: false,
  };

  // 构建系统检测
  const hasPackageJson = fs.existsSync(path.join(workspacePath, 'package.json'));
  const hasRequirements = fs.existsSync(path.join(workspacePath, 'requirements.txt'));
  const hasPyproject = fs.existsSync(path.join(workspacePath, 'pyproject.toml'));
  const hasCargoToml = fs.existsSync(path.join(workspacePath, 'Cargo.toml'));
  const hasGoMod = fs.existsSync(path.join(workspacePath, 'go.mod'));

  if (hasPackageJson) {
    ctx.buildSystem = 'npm';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(workspacePath, 'package.json'), 'utf-8'));
      ctx.scripts = pkg.scripts || {};
      // 判断项目类型
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['next']) ctx.projectType = 'Next.js';
      else if (deps['nuxt']) ctx.projectType = 'Nuxt';
      else if (deps['react'] || deps['vue'] || deps['svelte']) ctx.projectType = 'SPA';
      else if (deps['express'] || deps['fastify'] || deps['hono'] || deps['koa']) ctx.projectType = 'Node.js API';
      else ctx.projectType = 'Node.js';
    } catch { /* parse error */ }
  } else if (hasRequirements || hasPyproject) {
    ctx.buildSystem = 'pip';
    ctx.projectType = 'Python';
  } else if (hasCargoToml) {
    ctx.buildSystem = 'cargo';
    ctx.projectType = 'Rust';
  } else if (hasGoMod) {
    ctx.buildSystem = 'go';
    ctx.projectType = 'Go';
  }

  // 平台配置检测
  ctx.hasSupabase = hasSecret(projectId, 'supabase_access_token')
    || fs.existsSync(path.join(workspacePath, 'supabase', 'config.toml'));
  ctx.hasCloudflare = hasSecret(projectId, 'cloudflare_api_token')
    || fs.existsSync(path.join(workspacePath, 'wrangler.toml'));
  ctx.hasDocker = fs.existsSync(path.join(workspacePath, 'Dockerfile'))
    || fs.existsSync(path.join(workspacePath, 'docker-compose.yml'));

  // Docker 相关文件
  ctx.hasDockerfile = fs.existsSync(path.join(workspacePath, 'Dockerfile'));
  ctx.hasComposeFile = fs.existsSync(path.join(workspacePath, 'docker-compose.yml'));
  ctx.hasNginxConf = fs.existsSync(path.join(workspacePath, 'nginx.conf'))
    || fs.existsSync(path.join(workspacePath, 'nginx'));

  // Git 分支 — SYNC-OK: git rev-parse <50ms, 同步上下文检测函数
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: workspacePath, encoding: 'utf-8', timeout: 5000 })
      .toString().trim();
    ctx.currentBranch = branch;
    ctx.isFeatureBranch = branch !== 'main' && branch !== 'master' && branch !== 'develop';

    // 从分支名提取 Issue 编号 (e.g., feature/issue-42-login, fix/42)
    const issueMatch = branch.match(/(?:issue-?|fix[/-]|feat[/-])(\d+)/i);
    if (issueMatch) ctx.issueNumber = parseInt(issueMatch[1], 10);
  } catch { /* not a git repo */ }

  // 如果分支没有 Issue 编号，尝试从 feature 表获取
  if (!ctx.issueNumber) {
    try {
      const db = getDb();
      const row = db.prepare(
        "SELECT github_issue_number FROM features WHERE project_id = ? AND github_branch = ? AND github_issue_number IS NOT NULL LIMIT 1"
      ).get(projectId, ctx.currentBranch) as { github_issue_number: number } | undefined;
      if (row) ctx.issueNumber = row.github_issue_number;
    } catch { /* no feature table yet */ }
  }

  // 可用密钥
  ctx.availableSecrets = listSecrets(projectId).map(s => `${s.key} (${s.provider})`);

  // ARCHITECTURE.md 摘要
  const archPath = path.join(workspacePath, 'ARCHITECTURE.md');
  if (fs.existsSync(archPath)) {
    const content = fs.readFileSync(archPath, 'utf-8');
    // 提取部署相关段落
    const deploySection = content.match(/## .*(?:deploy|部署|infrastructure|基础设施).*\n[\s\S]*?(?=\n## |\n---|\Z)/i);
    ctx.architectureSummary = deploySection
      ? deploySection[0].slice(0, 2000)
      : content.slice(0, 1500);
  }

  return ctx;
}

// ═══════════════════════════════════════
// Deploy System Prompt Builder
// ═══════════════════════════════════════

function buildDeploySystemPrompt(ctx: DeployContext): string {
  return `你是 DevOps Agent，负责项目的完整 CI/CD 部署流程。

## 你的任务
根据项目配置，按以下步骤执行部署流程。**只执行与当前项目匹配的步骤**。

### Step 1: 构建验证
- 安装依赖 → 类型检查/编译 → Lint → 测试 → 构建
- 如果构建失败（关键步骤），停止后续部署并报告

### Step 2: 数据库部署 (仅 Supabase 项目)
- \`supabase_migration_push\` — 执行数据库迁移
- \`supabase_gen_types\` — 生成最新类型定义
- \`supabase_deploy_function\` — 部署 Edge Functions

### Step 3: 应用部署 (根据项目类型选择)
- **Cloudflare Pages**: 前端 SPA/SSR 项目 → \`cloudflare_deploy_pages\`
- **Cloudflare Workers**: API/边缘函数 → \`cloudflare_deploy_worker\`
- **Docker Compose**: 自建服务器 → \`deploy_compose_up\` (需先生成 docker-compose.yml)
- **PM2**: 直接部署 Node.js → \`deploy_pm2_start\`

### Step 4: 环境变量同步
- 将 project_secrets 中的密钥同步到 Supabase/Cloudflare 远程环境
- \`supabase_set_secret\` / \`cloudflare_set_secret\`

### Step 5: 健康检查
- 对所有部署端点执行 \`deploy_health_check\`
- 验证服务正常运行

### Step 6: Git 操作
- \`git_commit\` — 提交所有变更
- \`git_push\` — 推送到远程
- 如果在 feature 分支: \`github_create_pr\`

### Step 7: 通知
- 在关联 Issue 上评论部署结果 → \`github_add_comment\`

## 当前项目信息
- **项目类型**: ${ctx.projectType}
- **构建系统**: ${ctx.buildSystem || '未检测到'}
- **npm scripts**: ${Object.keys(ctx.scripts).length > 0 ? Object.entries(ctx.scripts).map(([k, v]) => `${k}: ${v}`).join(', ') : 'N/A'}
- **Supabase**: ${ctx.hasSupabase ? '✅ 已配置' : '❌ 未配置'}
- **Cloudflare**: ${ctx.hasCloudflare ? '✅ 已配置' : '❌ 未配置'}
- **Docker**: ${ctx.hasDocker ? '✅ 已配置' : '❌ 未配置'} (Dockerfile: ${ctx.hasDockerfile}, Compose: ${ctx.hasComposeFile})
- **GitHub**: ${ctx.hasGitHub ? '✅ 已配置' : '❌ 未配置 (跳过 PR/push/Issue 通知)'}
- **当前分支**: ${ctx.currentBranch} ${ctx.isFeatureBranch ? '(feature 分支)' : '(主分支)'}
- **关联 Issue**: ${ctx.issueNumber ? `#${ctx.issueNumber}` : '无'}
- **可用密钥**: ${ctx.availableSecrets.length > 0 ? ctx.availableSecrets.join(', ') : '无'}
- **Nginx 配置**: ${ctx.hasNginxConf ? '已存在' : '无'}

${ctx.architectureSummary ? `## 架构文档 (部署相关)\n${ctx.architectureSummary}` : ''}

## 执行原则
1. **跳过不适用的步骤** — 未配置 Supabase 就跳过 Step 2，未配置 Cloudflare 且无 Docker 就只做构建验证
2. **构建失败即止** — 关键构建步骤失败后不要继续部署，但非关键步骤（lint/test）失败可继续
3. **使用 think 工具** 在每个步骤前分析当前状态和下一步行动
4. **使用 todo_write/todo_read** 跟踪部署进度
5. **最终使用 task_complete** 汇总部署结果 (成功/失败 + URL 列表 + 注意事项)
`;
}

// ═══════════════════════════════════════
// Phase Entry Point
// ═══════════════════════════════════════

/**
 * 全自动部署 Pipeline — 替代旧 phaseDevOpsBuild
 *
 * 如果检测到部署目标 (Supabase/Cloudflare/Docker)，使用 ReAct 模式的
 * DevOps Agent 执行完整 7 步部署流程。
 * 否则退化为快速构建验证 (兼容旧行为)。
 */
export async function phaseDeployPipeline(
  projectId: string,
  settings: AppSettings,
  win: BrowserWindow | null,
  signal: AbortSignal,
  workspacePath: string,
  gitConfig: GitProviderConfig,
): Promise<void> {
  if (signal.aborted) return;

  const db = getDb();
  const devopsId = 'devops-0';  // 固定 ID: 复用同一 DevOps Agent
  spawnAgent(projectId, devopsId, 'devops', win);
  sendToUI(win, 'agent:status', {
    projectId, agentId: devopsId, status: 'working',
    currentTask: 'deploy-pipeline', featureTitle: '部署 Pipeline',
  });
  sendToUI(win, 'agent:log', {
    projectId, agentId: devopsId,
    content: '🚀 Phase 4d: DevOps 全自动部署 Pipeline (v15.0)...',
  });

  // 检测部署上下文
  const deployCtx = detectDeployContext(projectId, workspacePath, gitConfig);
  const hasDeployTarget = deployCtx.hasSupabase || deployCtx.hasCloudflare || deployCtx.hasDocker;

  sendToUI(win, 'agent:log', {
    projectId, agentId: devopsId,
    content: [
      `📊 项目检测: ${deployCtx.projectType} (${deployCtx.buildSystem || '无构建系统'})`,
      `   Supabase: ${deployCtx.hasSupabase ? '✅' : '—'} | Cloudflare: ${deployCtx.hasCloudflare ? '✅' : '—'} | Docker: ${deployCtx.hasDocker ? '✅' : '—'} | GitHub: ${deployCtx.hasGitHub ? '✅' : '—'}`,
      `   分支: ${deployCtx.currentBranch}${deployCtx.issueNumber ? ` (Issue #${deployCtx.issueNumber})` : ''}`,
      hasDeployTarget ? '   → 使用 ReAct 全流程部署' : '   → 无部署目标, 使用快速构建验证',
    ].join('\n'),
  });

  if (!hasDeployTarget) {
    // ── 快速模式: 无部署目标，仅做构建验证 (兼容旧 devops-phase 行为) ──
    await quickBuildVerify(projectId, devopsId, settings, win, signal, workspacePath, gitConfig, deployCtx);
    return;
  }

  // ── ReAct 模式: 全流程部署 ──
  const systemPrompt = buildDeploySystemPrompt(deployCtx);
  const userMessage = `请执行完整的部署流程。项目工作目录: ${workspacePath}

首先用 think 工具分析项目状况并制定部署计划，然后按步骤执行。`;

  const model = resolveMemberModel(projectId, 'devops', settings);

  let result: GenericReactResult;
  try {
    result = await reactAgentLoop({
      projectId,
      agentId: devopsId,
      role: 'devops',
      systemPrompt,
      userMessage,
      settings,
      workspacePath,
      gitConfig,
      win,
      signal,
      maxIterations: getTeamMemberMaxIterations(projectId, 'devops') ?? 50,
      model,
      timeoutMs: 300_000, // 5 分钟超时 (部署可能较慢)
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Deploy pipeline ReAct error: ${msg}`);
    sendToUI(win, 'agent:log', {
      projectId, agentId: devopsId,
      content: `❌ 部署 Pipeline 异常: ${msg}`,
    });
    result = {
      completed: false, blocked: false,
      finalText: `部署异常: ${msg}`,
      filesWritten: [], totalCost: 0,
      totalInputTokens: 0, totalOutputTokens: 0, iterations: 0,
    };
  }

  // 汇总
  const summary = result.completed
    ? `✅ 部署 Pipeline 完成 (${result.iterations} 轮, $${result.totalCost.toFixed(4)})\n${result.finalText.slice(0, 500)}`
    : `⚠️ 部署 Pipeline 未完全完成 (${result.iterations} 轮)\n${result.finalText.slice(0, 500)}`;

  sendToUI(win, 'agent:log', { projectId, agentId: devopsId, content: summary });
  addLog(projectId, devopsId, 'log', summary);

  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(devopsId);
  sendToUI(win, 'agent:status', { projectId, agentId: devopsId, status: 'idle' });
  emitEvent({
    projectId, agentId: devopsId, type: 'phase:deploy:end',
    data: {
      completed: result.completed,
      iterations: result.iterations,
      cost: result.totalCost,
      filesWritten: result.filesWritten.length,
      hasDeployTarget: true,
    },
  });
}

// ═══════════════════════════════════════
// Quick Build Verify (fallback, 兼容旧 devops-phase)
// ═══════════════════════════════════════

async function quickBuildVerify(
  projectId: string,
  devopsId: string,
  _settings: AppSettings,
  win: BrowserWindow | null,
  signal: AbortSignal,
  workspacePath: string,
  gitConfig: GitProviderConfig,
  ctx: DeployContext,
): Promise<void> {
  const db = getDb();

  const buildSteps: Array<{ name: string; cmd: string; critical: boolean }> = [];

  if (ctx.buildSystem === 'npm') {
    buildSteps.push({ name: '安装依赖', cmd: 'npm install --prefer-offline 2>&1', critical: true });
    if (ctx.scripts.build || fs.existsSync(path.join(workspacePath, 'tsconfig.json'))) {
      buildSteps.push({ name: '类型检查', cmd: 'npx tsc --noEmit 2>&1', critical: false });
    }
    if (ctx.scripts.lint) {
      buildSteps.push({ name: 'Lint', cmd: 'npm run lint 2>&1', critical: false });
    }
    if (ctx.scripts.test && ctx.scripts.test !== 'echo "Error: no test specified" && exit 1') {
      buildSteps.push({ name: '测试', cmd: 'npm test 2>&1', critical: false });
    }
    if (ctx.scripts.build) {
      buildSteps.push({ name: '构建', cmd: 'npm run build 2>&1', critical: true });
    }
  } else if (ctx.buildSystem === 'pip') {
    if (fs.existsSync(path.join(workspacePath, 'requirements.txt'))) {
      buildSteps.push({ name: '安装依赖', cmd: 'pip install -r requirements.txt 2>&1', critical: true });
    }
    buildSteps.push({ name: '语法检查', cmd: 'python -m py_compile $(find . -name "*.py" -not -path "*/venv/*" | head -50) 2>&1', critical: false });
    buildSteps.push({ name: '测试', cmd: 'pytest --tb=short 2>&1 || echo "No pytest"', critical: false });
  } else if (ctx.buildSystem === 'cargo') {
    buildSteps.push({ name: '构建', cmd: 'cargo build 2>&1', critical: true });
    buildSteps.push({ name: '测试', cmd: 'cargo test 2>&1', critical: false });
  } else if (ctx.buildSystem === 'go') {
    buildSteps.push({ name: '构建', cmd: 'go build ./... 2>&1', critical: true });
    buildSteps.push({ name: '测试', cmd: 'go test ./... 2>&1', critical: false });
  }

  if (buildSteps.length === 0) {
    sendToUI(win, 'agent:log', {
      projectId, agentId: devopsId,
      content: '  ↳ 未检测到已知构建系统，跳过构建验证',
    });
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(devopsId);
    sendToUI(win, 'agent:status', { projectId, agentId: devopsId, status: 'idle' });
    return;
  }

  let allPassed = true;
  const results: Array<{ name: string; ok: boolean; output: string }> = [];

  for (const step of buildSteps) {
    if (signal.aborted) break;
    sendToUI(win, 'agent:log', {
      projectId, agentId: devopsId, content: `  🔧 ${step.name}...`,
    });
    try {
      const { stdout } = await execAsync(step.cmd, {
        cwd: workspacePath, encoding: 'utf-8', timeout: 120_000, maxBuffer: 1024 * 1024,
      });
      results.push({ name: step.name, ok: true, output: (stdout || '').slice(-500) });
      sendToUI(win, 'agent:log', {
        projectId, agentId: devopsId, content: `  ✅ ${step.name} 成功`,
      });
    } catch (err: unknown) {
      const errObj = err as { stdout?: string; stderr?: string; message?: string };
      const output = (errObj.stdout || '') + (errObj.stderr || '');
      results.push({ name: step.name, ok: false, output: output.slice(-500) });
      if (step.critical) {
        allPassed = false;
        sendToUI(win, 'agent:log', {
          projectId, agentId: devopsId,
          content: `  ❌ ${step.name} 失败 (关键步骤):\n${output.slice(-300)}`,
        });
      } else {
        sendToUI(win, 'agent:log', {
          projectId, agentId: devopsId,
          content: `  ⚠️ ${step.name} 失败 (非关键):\n${output.slice(-200)}`,
        });
      }
    }
  }

  // Git push (快速模式也支持)
  if (allPassed && gitConfig.mode === 'github') {
    try {
      await commitWorkspace(workspacePath, 'AutoMater: build verification passed');
      sendToUI(win, 'agent:log', {
        projectId, agentId: devopsId, content: '  📦 已提交并准备推送',
      });
      await execAsync('git push origin HEAD 2>&1', { cwd: workspacePath, encoding: 'utf-8', timeout: 30_000 });
      sendToUI(win, 'agent:log', {
        projectId, agentId: devopsId, content: '  🚀 已推送到远程仓库',
      });
    } catch (err: unknown) {
      sendToUI(win, 'agent:log', {
        projectId, agentId: devopsId,
        content: `  ⚠️ Git push 失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else if (allPassed && workspacePath) {
    await commitWorkspace(workspacePath, 'AutoMater: DevOps build verification passed');
  }

  const passedCount = results.filter(r => r.ok).length;
  const summary = allPassed
    ? `✅ 构建验证全部通过 (${passedCount}/${results.length} 步骤)`
    : `⚠️ 构建验证部分失败 (${passedCount}/${results.length} 步骤通过)`;

  sendToUI(win, 'agent:log', { projectId, agentId: devopsId, content: summary });
  addLog(projectId, devopsId, 'log', summary);

  db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(devopsId);
  sendToUI(win, 'agent:status', { projectId, agentId: devopsId, status: 'idle' });
  emitEvent({
    projectId, agentId: devopsId, type: 'phase:deploy:end',
    data: { completed: allPassed, steps: results.length, passed: passedCount, hasDeployTarget: false },
  });
}
