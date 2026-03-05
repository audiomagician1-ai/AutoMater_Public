/**
 * Cloudflare Tools — Wrangler CLI + Cloudflare API 封装
 *
 * 两个通道:
 * - Wrangler CLI (npx wrangler): Pages/Workers 部署
 * - Cloudflare API (https://api.cloudflare.com): DNS、环境变量、状态查询
 *
 * v14.0: 初始实现
 */

import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { createLogger } from './logger';

const execAsync = promisify(execCb);
const log = createLogger('cloudflare-tools');

const CF_API = 'https://api.cloudflare.com/client/v4';
const CLI_TIMEOUT = 180_000; // 3 minutes (deploys can be slow)

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface CloudflareConfig {
  apiToken: string;
  accountId: string;
  zoneId?: string;
  workspacePath: string;
}

export interface CliResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface PagesProject {
  name: string;
  subdomain: string;
  latestDeployUrl: string;
  productionBranch: string;
}

export interface DNSRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

export interface DeployResult {
  success: boolean;
  url: string;
  output: string;
  error?: string;
}

// ═══════════════════════════════════════
// API helpers
// ═══════════════════════════════════════

async function cfApi(
  endpoint: string,
  apiToken: string,
  method: string = 'GET',
  body?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${CF_API}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json() as { success: boolean; errors: Array<{ message: string }>; result: unknown };
  if (!json.success) {
    const errMsg = json.errors?.map(e => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API: ${errMsg}`);
  }
  return json.result;
}

// ═══════════════════════════════════════
// CLI helpers
// ═══════════════════════════════════════

async function runWrangler(
  args: string,
  workspacePath: string,
  env?: Record<string, string>,
): Promise<CliResult> {
  try {
    const envVars = { ...process.env, ...env };
    const { stdout, stderr } = await execAsync(
      `npx wrangler ${args}`,
      { cwd: workspacePath, encoding: 'utf-8', timeout: CLI_TIMEOUT, env: envVars },
    );
    return { success: true, output: (stdout + '\n' + stderr).trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errObj = err as { stdout?: string; stderr?: string };
    return {
      success: false,
      output: (errObj.stdout || '').trim(),
      error: (errObj.stderr || msg).trim(),
    };
  }
}

// ═══════════════════════════════════════
// Connection Test
// ═══════════════════════════════════════

export async function testCloudflareConnection(
  apiToken: string,
): Promise<{ success: boolean; message: string }> {
  try {
    const res = await fetch(`${CF_API}/user/tokens/verify`, {
      headers: { 'Authorization': `Bearer ${apiToken}` },
    });
    const json = await res.json() as { success: boolean; result: { status: string } };
    if (json.success && json.result.status === 'active') {
      return { success: true, message: '✅ Cloudflare API Token 有效 (active)' };
    }
    return { success: false, message: `Token 状态: ${json.result?.status || 'unknown'}` };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ═══════════════════════════════════════
// Pages Deployment (CLI)
// ═══════════════════════════════════════

/** 部署静态站点到 Cloudflare Pages */
export async function deployPages(
  config: CloudflareConfig,
  options?: {
    projectName?: string;
    directory?: string;
    branch?: string;
  },
): Promise<DeployResult> {
  const dir = options?.directory || 'dist';
  const projectFlag = options?.projectName ? `--project-name ${options.projectName}` : '';
  const branchFlag = options?.branch ? `--branch ${options.branch}` : '';
  const cmd = `pages deploy ${dir} ${projectFlag} ${branchFlag}`.trim();

  const result = await runWrangler(cmd, config.workspacePath, {
    CLOUDFLARE_API_TOKEN: config.apiToken,
    CLOUDFLARE_ACCOUNT_ID: config.accountId,
  });

  // Try to extract URL from output
  const urlMatch = result.output.match(/https:\/\/[^\s]+\.pages\.dev/);
  return {
    success: result.success,
    url: urlMatch?.[0] || '',
    output: result.output,
    error: result.error,
  };
}

/** 列出 Pages 项目 */
export async function listPagesProjects(
  config: CloudflareConfig,
): Promise<PagesProject[]> {
  try {
    const data = await cfApi(
      `/accounts/${config.accountId}/pages/projects`,
      config.apiToken,
    );
    return ((data || []) as Array<Record<string, unknown>>).map(p => ({
      name: p.name as string,
      subdomain: p.subdomain as string || '',
      latestDeployUrl: ((p.latest_deployment as Record<string, unknown>)?.url as string) || '',
      productionBranch: p.production_branch as string || 'main',
    }));
  } catch (err) {
    log.error('Cloudflare list pages failed', err);
    return [];
  }
}

// ═══════════════════════════════════════
// Workers Deployment (CLI)
// ═══════════════════════════════════════

/** 部署 Cloudflare Worker */
export async function deployWorker(
  config: CloudflareConfig,
  options?: {
    name?: string;
    entryPoint?: string;
  },
): Promise<DeployResult> {
  const nameFlag = options?.name ? `--name ${options.name}` : '';
  const entryFlag = options?.entryPoint || '';
  const cmd = `deploy ${entryFlag} ${nameFlag}`.trim();

  const result = await runWrangler(cmd, config.workspacePath, {
    CLOUDFLARE_API_TOKEN: config.apiToken,
    CLOUDFLARE_ACCOUNT_ID: config.accountId,
  });

  const urlMatch = result.output.match(/https:\/\/[^\s]+\.workers\.dev/);
  return {
    success: result.success,
    url: urlMatch?.[0] || '',
    output: result.output,
    error: result.error,
  };
}

// ═══════════════════════════════════════
// Worker Secrets & Env
// ═══════════════════════════════════════

/** 设置 Worker Secret (通过 CLI) */
export async function setWorkerSecret(
  config: CloudflareConfig,
  workerName: string,
  key: string,
  value: string,
): Promise<boolean> {
  // Wrangler secret put 需要从 stdin 读取值
  try {
    const env = {
      ...process.env,
      CLOUDFLARE_API_TOKEN: config.apiToken,
      CLOUDFLARE_ACCOUNT_ID: config.accountId,
    };
    const child = require('child_process').spawn(
      'npx',
      ['wrangler', 'secret', 'put', key, '--name', workerName],
      { cwd: config.workspacePath, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stdin.write(value);
    child.stdin.end();

    return new Promise((resolve) => {
      child.on('close', (code: number) => resolve(code === 0));
      child.on('error', () => resolve(false));
      setTimeout(() => { child.kill(); resolve(false); }, 30_000);
    });
  } catch (err) { /* silent: 进程kill失败(可能已退出) */
    log.debug('Catch at cloudflare-tools.ts:250', { error: String(err) });
    return false;
  }
}

/** 批量设置 Worker 环境变量 (非 secret，通过 API) */
export async function setWorkerEnv(
  config: CloudflareConfig,
  workerName: string,
  vars: Record<string, string>,
): Promise<boolean> {
  try {
    // 使用 Workers API 设置环境变量
    const settings = await cfApi(
      `/accounts/${config.accountId}/workers/scripts/${workerName}/settings`,
      config.apiToken,
    ) as Record<string, unknown>;

    const existingBindings = (settings.bindings || []) as Array<Record<string, unknown>>;
    // 合并新的 plain_text 绑定
    const newBindings = Object.entries(vars).map(([name, text]) => ({
      type: 'plain_text',
      name,
      text,
    }));

    // 过滤掉同名的旧绑定
    const newNames = new Set(Object.keys(vars));
    const mergedBindings = [
      ...existingBindings.filter(b => !newNames.has(b.name as string)),
      ...newBindings,
    ];

    await cfApi(
      `/accounts/${config.accountId}/workers/scripts/${workerName}/settings`,
      config.apiToken,
      'PATCH',
      { settings: { bindings: mergedBindings } } as unknown as Record<string, unknown>,
    );
    return true;
  } catch (err) {
    log.error('Cloudflare set worker env failed', err);
    return false;
  }
}

// ═══════════════════════════════════════
// DNS Management (API)
// ═══════════════════════════════════════

/** 列出 DNS 记录 */
export async function listDNSRecords(
  config: CloudflareConfig,
): Promise<DNSRecord[]> {
  if (!config.zoneId) return [];
  try {
    const data = await cfApi(
      `/zones/${config.zoneId}/dns_records?per_page=100`,
      config.apiToken,
    );
    return ((data || []) as Array<Record<string, unknown>>).map(r => ({
      id: r.id as string,
      type: r.type as string,
      name: r.name as string,
      content: r.content as string,
      proxied: r.proxied as boolean || false,
      ttl: r.ttl as number || 1,
    }));
  } catch (err) {
    log.error('Cloudflare list DNS failed', err);
    return [];
  }
}

/** 创建 DNS 记录 */
export async function createDNSRecord(
  config: CloudflareConfig,
  record: { type: string; name: string; content: string; proxied?: boolean; ttl?: number },
): Promise<{ success: boolean; id?: string; error?: string }> {
  if (!config.zoneId) return { success: false, error: 'Zone ID 未配置' };
  try {
    const data = await cfApi(
      `/zones/${config.zoneId}/dns_records`,
      config.apiToken,
      'POST',
      { ...record, proxied: record.proxied ?? true, ttl: record.ttl ?? 1 },
    );
    return { success: true, id: (data as Record<string, unknown>).id as string };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 删除 DNS 记录 */
export async function deleteDNSRecord(
  config: CloudflareConfig,
  recordId: string,
): Promise<boolean> {
  if (!config.zoneId) return false;
  try {
    await cfApi(
      `/zones/${config.zoneId}/dns_records/${recordId}`,
      config.apiToken,
      'DELETE',
    );
    return true;
  } catch (err) {
    log.error('Cloudflare delete DNS record failed', err);
    return false;
  }
}

// ═══════════════════════════════════════
// Deployment Status
// ═══════════════════════════════════════

/** 查询 Pages 项目部署状态 */
export async function getDeploymentStatus(
  config: CloudflareConfig,
  projectName: string,
): Promise<{ url: string; status: string; lastDeploy: string; environment: string } | null> {
  try {
    const data = await cfApi(
      `/accounts/${config.accountId}/pages/projects/${projectName}`,
      config.apiToken,
    );
    const d = data as Record<string, unknown>;
    const latest = d.latest_deployment as Record<string, unknown> | undefined;
    return {
      url: latest?.url as string || '',
      status: latest?.latest_stage as string || (d.deployment_trigger as Record<string, unknown>)?.type as string || 'unknown',
      lastDeploy: latest?.created_on as string || '',
      environment: latest?.environment as string || 'production',
    };
  } catch (err) {
    log.error('Cloudflare get deployment status failed', err);
    return null;
  }
}
