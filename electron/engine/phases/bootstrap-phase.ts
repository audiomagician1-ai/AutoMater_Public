/**
 * Bootstrap Phase (Phase 0) — 环境初始化
 *
 * 在所有 Agent 阶段之前执行:
 *   1. 检测项目类型 (Node/Python/Rust/Go)
 *   2. 安装依赖
 *   3. 密钥注入 (.env.local)
 *   4. Git 远程设置 (如果 github mode)
 *   5. 平台凭证验证 (GitHub/Supabase/Cloudflare)
 *
 * @module phases/bootstrap-phase
 */

import {
  BrowserWindow, createLogger, execAsync, fs, path,
  sendToUI, addLog,
  type AppSettings,
} from './shared';
import { getGitConfigFromSecrets, getProviderSecrets, listSecrets, getSecret, hasSecret } from '../secret-manager';
import { initRepo, testGitHubConnection } from '../git-provider';

const log = createLogger('phase:bootstrap');

interface BootstrapResult {
  dependenciesInstalled: boolean;
  envInjected: boolean;
  gitConfigured: boolean;
  credentialsValid: Record<string, boolean>;
}

export async function phaseEnvironmentBootstrap(
  projectId: string,
  settings: AppSettings,
  win: BrowserWindow | null,
  signal: AbortSignal,
  workspacePath: string,
): Promise<BootstrapResult> {
  const result: BootstrapResult = {
    dependenciesInstalled: false,
    envInjected: false,
    gitConfigured: false,
    credentialsValid: {},
  };

  if (signal.aborted) return result;
  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '🔧 Phase 0: 环境初始化...' });

  // ═══════════════════════════════════════
  // Step 1: 检测项目类型 & 安装依赖
  // ═══════════════════════════════════════
  const hasPackageJson = fs.existsSync(path.join(workspacePath, 'package.json'));
  const hasPackageLock = fs.existsSync(path.join(workspacePath, 'package-lock.json'));
  const hasPnpmLock = fs.existsSync(path.join(workspacePath, 'pnpm-lock.yaml'));
  const hasYarnLock = fs.existsSync(path.join(workspacePath, 'yarn.lock'));
  const hasRequirements = fs.existsSync(path.join(workspacePath, 'requirements.txt'));
  const hasPyproject = fs.existsSync(path.join(workspacePath, 'pyproject.toml'));
  const hasCargoToml = fs.existsSync(path.join(workspacePath, 'Cargo.toml'));
  const hasGoMod = fs.existsSync(path.join(workspacePath, 'go.mod'));

  if (hasPackageJson) {
    const hasNodeModules = fs.existsSync(path.join(workspacePath, 'node_modules'));
    if (!hasNodeModules) {
      // 智能选择包管理器
      let installCmd = 'npm install --prefer-offline 2>&1';
      if (hasPnpmLock) installCmd = 'pnpm install 2>&1';
      else if (hasYarnLock) installCmd = 'yarn install 2>&1';
      else if (hasPackageLock) installCmd = 'npm ci --prefer-offline 2>&1';

      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  📦 安装 Node.js 依赖: ${installCmd.split(' 2>&1')[0]}` });
      try {
        await execAsync(installCmd, { cwd: workspacePath, encoding: 'utf-8', timeout: 180_000, maxBuffer: 5 * 1024 * 1024 });
        result.dependenciesInstalled = true;
        sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '  ✅ 依赖安装成功' });
      } catch (err: unknown) {
        const errObj = err as { stderr?: string; message?: string };
        const msg = (errObj.stderr || errObj.message || '').slice(-300);
        sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ⚠️ 依赖安装失败 (非致命):\n${msg}` });
        log.warn('Node dependency install failed', { error: msg });
      }
    } else {
      result.dependenciesInstalled = true;
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '  📦 node_modules 已存在，跳过安装' });
    }
  } else if (hasRequirements || hasPyproject) {
    // Python: 检查 venv
    const hasVenv = fs.existsSync(path.join(workspacePath, 'venv')) || fs.existsSync(path.join(workspacePath, '.venv'));
    if (!hasVenv && hasRequirements) {
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '  🐍 安装 Python 依赖...' });
      try {
        await execAsync('pip install -r requirements.txt 2>&1', { cwd: workspacePath, encoding: 'utf-8', timeout: 180_000 });
        result.dependenciesInstalled = true;
        sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '  ✅ Python 依赖安装成功' });
      } catch (err: unknown) {
        const msg = (err as { stderr?: string }).stderr?.slice(-300) || '';
        sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ⚠️ Python 依赖安装失败 (非致命):\n${msg}` });
      }
    } else {
      result.dependenciesInstalled = true;
    }
  } else if (hasCargoToml) {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '  🦀 Rust 项目检测到 (依赖将在构建时安装)' });
    result.dependenciesInstalled = true;
  } else if (hasGoMod) {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '  🐹 Go 项目检测到' });
    try {
      await execAsync('go mod download 2>&1', { cwd: workspacePath, encoding: 'utf-8', timeout: 120_000 });
      result.dependenciesInstalled = true;
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '  ✅ Go 模块下载成功' });
    } catch { /* silent: go mod download可能失败,非阻塞 */
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '  ⚠️ Go 模块下载失败 (非致命)' });
    }
  } else {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '  ℹ️ 无已知包管理器，跳过依赖安装' });
  }

  if (signal.aborted) return result;

  // ═══════════════════════════════════════
  // Step 2: 密钥注入到 .env.local
  // ═══════════════════════════════════════
  const secrets = listSecrets(projectId);
  if (secrets.length > 0) {
    const envLines: string[] = [
      '# Auto-generated by AgentForge — DO NOT COMMIT',
      `# Project: ${projectId}`,
      `# Updated: ${new Date().toISOString()}`,
      '',
    ];

    // 收集所有 provider 的密钥
    for (const provider of ['github', 'supabase', 'cloudflare', 'custom'] as const) {
      const providerSecrets = getProviderSecrets(projectId, provider);
      const keys = Object.keys(providerSecrets);
      if (keys.length > 0) {
        envLines.push(`# === ${provider.toUpperCase()} ===`);
        for (const [key, value] of Object.entries(providerSecrets)) {
          // 转换 key 为环境变量格式 (UPPER_SNAKE_CASE)
          const envKey = key.toUpperCase().replace(/[^A-Z0-9]/g, '_');
          envLines.push(`${envKey}=${value}`);
        }
        envLines.push('');
      }
    }

    if (envLines.length > 4) {
      // 写入 .env.local
      const envPath = path.join(workspacePath, '.env.local');
      fs.writeFileSync(envPath, envLines.join('\n'), 'utf-8');

      // 确保 .gitignore 包含 .env.local
      const gitignorePath = path.join(workspacePath, '.gitignore');
      if (fs.existsSync(gitignorePath)) {
        const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
        if (!gitignore.includes('.env.local')) {
          fs.appendFileSync(gitignorePath, '\n.env.local\n');
        }
      }

      result.envInjected = true;
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  🔑 ${secrets.length} 个密钥已注入 .env.local` });
    }
  }

  if (signal.aborted) return result;

  // ═══════════════════════════════════════
  // Step 3: Git 远程设置
  // ═══════════════════════════════════════
  const gitConfig = getGitConfigFromSecrets(projectId, workspacePath);
  if (gitConfig.mode === 'github' && gitConfig.githubRepo && gitConfig.githubToken) {
    try {
      await initRepo(gitConfig);
      result.gitConfigured = true;
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  🔗 Git 远程已配置: ${gitConfig.githubRepo}` });
    } catch (_err) {
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '  ⚠️ Git 远程配置失败 (非致命)' });
    }
  }

  if (signal.aborted) return result;

  // ═══════════════════════════════════════
  // Step 4: 平台凭证验证
  // ═══════════════════════════════════════
  // GitHub
  if (hasSecret(projectId, 'github_token')) {
    const repo = getSecret(projectId, 'github_repo') || gitConfig.githubRepo;
    const token = getSecret(projectId, 'github_token') || gitConfig.githubToken;
    if (repo && token) {
      const testResult = await testGitHubConnection(repo, token);
      result.credentialsValid['github'] = testResult.success;
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ${testResult.success ? '✅' : '❌'} GitHub: ${testResult.message}` });
    }
  }

  // Supabase (actual connection test)
  if (hasSecret(projectId, 'supabase_access_token')) {
    const token = getSecret(projectId, 'supabase_access_token');
    const projectRef = getSecret(projectId, 'supabase_project_ref');
    if (token && projectRef) {
      try {
        const { testSupabaseConnection } = await import('../supabase-tools');
        const testResult = await testSupabaseConnection(token, projectRef);
        result.credentialsValid['supabase'] = testResult.success;
        sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ${testResult.success ? '✅' : '❌'} Supabase: ${testResult.message}` });
      } catch (err) {
        result.credentialsValid['supabase'] = false;
        sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ❌ Supabase: 连接测试异常 (${err instanceof Error ? err.message : String(err)})` });
      }
    } else {
      result.credentialsValid['supabase'] = false;
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ❌ Supabase: 缺少 ${!token ? 'access_token' : 'project_ref'}` });
    }
  }

  // Cloudflare (actual API token verify)
  if (hasSecret(projectId, 'cloudflare_api_token')) {
    const token = getSecret(projectId, 'cloudflare_api_token');
    if (token) {
      try {
        const { testCloudflareConnection } = await import('../cloudflare-tools');
        const testResult = await testCloudflareConnection(token);
        result.credentialsValid['cloudflare'] = testResult.success;
        sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ${testResult.success ? '✅' : '❌'} Cloudflare: ${testResult.message}` });
      } catch (err) {
        result.credentialsValid['cloudflare'] = false;
        sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ❌ Cloudflare: 连接测试异常 (${err instanceof Error ? err.message : String(err)})` });
      }
    } else {
      result.credentialsValid['cloudflare'] = false;
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: '  ❌ Cloudflare: API Token 为空' });
    }
  }

  // ═══════════════════════════════════════
  // 完成
  // ═══════════════════════════════════════
  const summary = [
    result.dependenciesInstalled ? '依赖✅' : '依赖⏭️',
    result.envInjected ? '密钥✅' : '密钥⏭️',
    result.gitConfigured ? 'Git✅' : 'Git⏭️',
    ...Object.entries(result.credentialsValid).map(([k, v]) => `${k}${v ? '✅' : '❌'}`),
  ].join(' | ');
  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  🔧 Phase 0 完成: ${summary}` });
  addLog(projectId, 'system', 'log', `Phase 0 环境初始化: ${summary}`);

  return result;
}
