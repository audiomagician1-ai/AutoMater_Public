/**
 * Supabase Tools — CLI + Management API 封装
 *
 * 两个通道:
 * - CLI (npx supabase): 本地开发操作 (init, migration, functions, gen types)
 * - Management API (https://api.supabase.com): 远程项目管理
 *
 * v14.0: 初始实现
 */

import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { createLogger } from './logger';

const execAsync = promisify(execCb);
const log = createLogger('supabase-tools');

const SUPABASE_API = 'https://api.supabase.com';
const CLI_TIMEOUT = 120_000; // 2 minutes

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface SupabaseConfig {
  accessToken: string;
  projectRef: string;
  dbPassword?: string;
  workspacePath: string;
}

export interface SupabaseProject {
  id: string;
  name: string;
  region: string;
  status: string;
  organization_id: string;
  created_at: string;
}

export interface SupabaseProjectStatus {
  status: string;
  dbHost: string;
  apiUrl: string;
  anonKey: string;
}

export interface CliResult {
  success: boolean;
  output: string;
  error?: string;
}

// ═══════════════════════════════════════
// Management API helpers
// ═══════════════════════════════════════

async function supabaseApi(
  endpoint: string,
  accessToken: string,
  method: string = 'GET',
  body?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${SUPABASE_API}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase API ${res.status}: ${text}`);
  }
  return res.json();
}

// ═══════════════════════════════════════
// CLI helpers
// ═══════════════════════════════════════

async function runSupabaseCLI(
  args: string,
  workspacePath: string,
  env?: Record<string, string>,
): Promise<CliResult> {
  try {
    const envVars = { ...process.env, ...env };
    const { stdout, stderr } = await execAsync(
      `npx supabase ${args}`,
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
// Project Management (Management API)
// ═══════════════════════════════════════

/** 列出所有 Supabase 项目 */
export async function listProjects(
  accessToken: string,
): Promise<SupabaseProject[]> {
  try {
    const data = await supabaseApi('/v1/projects', accessToken);
    return (data as SupabaseProject[]) || [];
  } catch (err) {
    log.error('Supabase list projects failed', err);
    return [];
  }
}

/** 获取项目状态 */
export async function getProjectStatus(
  config: SupabaseConfig,
): Promise<SupabaseProjectStatus | null> {
  try {
    const data = await supabaseApi(
      `/v1/projects/${config.projectRef}`,
      config.accessToken,
    );
    const d = data as Record<string, unknown>;
    return {
      status: d.status as string,
      dbHost: (d.database as Record<string, unknown>)?.host as string || '',
      apiUrl: `https://${config.projectRef}.supabase.co`,
      anonKey: (d.api_keys as Array<Record<string, string>>)?.find(k => k.name === 'anon')?.api_key || '',
    };
  } catch (err) {
    log.error('Supabase get project status failed', err);
    return null;
  }
}

/** 测试 Supabase 连接 */
export async function testSupabaseConnection(
  accessToken: string,
  projectRef: string,
): Promise<{ success: boolean; message: string }> {
  try {
    const data = await supabaseApi(`/v1/projects/${projectRef}`, accessToken);
    const d = data as Record<string, unknown>;
    return { success: true, message: `✅ 已连接 Supabase 项目: ${d.name} (${d.region}) [${d.status}]` };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ═══════════════════════════════════════
// Database Migrations (CLI)
// ═══════════════════════════════════════

/** 初始化 Supabase 本地配置 */
export async function initSupabase(workspacePath: string): Promise<CliResult> {
  return runSupabaseCLI('init', workspacePath);
}

/** 创建新的迁移文件 */
export async function createMigration(
  config: SupabaseConfig,
  name: string,
): Promise<CliResult> {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return runSupabaseCLI(`migration new ${safeName}`, config.workspacePath);
}

/** 推送迁移到远程数据库 */
export async function pushMigration(config: SupabaseConfig): Promise<CliResult> {
  return runSupabaseCLI('db push', config.workspacePath, {
    SUPABASE_ACCESS_TOKEN: config.accessToken,
    SUPABASE_DB_PASSWORD: config.dbPassword || '',
  });
}

/** 从远程拉取 schema */
export async function pullSchema(config: SupabaseConfig): Promise<CliResult> {
  return runSupabaseCLI('db pull', config.workspacePath, {
    SUPABASE_ACCESS_TOKEN: config.accessToken,
    SUPABASE_DB_PASSWORD: config.dbPassword || '',
  });
}

/** 重置本地数据库 (开发用) */
export async function resetDatabase(config: SupabaseConfig): Promise<CliResult> {
  return runSupabaseCLI('db reset', config.workspacePath, {
    SUPABASE_ACCESS_TOKEN: config.accessToken,
    SUPABASE_DB_PASSWORD: config.dbPassword || '',
  });
}

// ═══════════════════════════════════════
// Edge Functions (CLI)
// ═══════════════════════════════════════

/** 部署 Edge Function */
export async function deployFunction(
  config: SupabaseConfig,
  functionName: string,
): Promise<CliResult> {
  return runSupabaseCLI(
    `functions deploy ${functionName} --project-ref ${config.projectRef}`,
    config.workspacePath,
    { SUPABASE_ACCESS_TOKEN: config.accessToken },
  );
}

/** 列出 Edge Functions */
export async function listFunctions(
  config: SupabaseConfig,
): Promise<Array<{ name: string; status: string; version: number }>> {
  try {
    const data = await supabaseApi(
      `/v1/projects/${config.projectRef}/functions`,
      config.accessToken,
    );
    return ((data || []) as Array<Record<string, unknown>>).map(f => ({
      name: f.slug as string,
      status: f.status as string,
      version: f.version as number,
    }));
  } catch (err) {
    log.error('Supabase list functions failed', err);
    return [];
  }
}

// ═══════════════════════════════════════
// Secrets / Environment Variables
// ═══════════════════════════════════════

/** 设置远程项目 Secret */
export async function setSupabaseSecret(
  config: SupabaseConfig,
  name: string,
  value: string,
): Promise<boolean> {
  try {
    await supabaseApi(
      `/v1/projects/${config.projectRef}/secrets`,
      config.accessToken,
      'POST',
      { secrets: [{ name, value }] } as unknown as Record<string, unknown>,
    );
    return true;
  } catch (err) {
    log.error('Supabase set secret failed', err);
    return false;
  }
}

/** 列出远程项目 Secrets (仅名称) */
export async function listSupabaseSecrets(
  config: SupabaseConfig,
): Promise<string[]> {
  try {
    const data = await supabaseApi(
      `/v1/projects/${config.projectRef}/secrets`,
      config.accessToken,
    );
    return ((data || []) as Array<Record<string, unknown>>).map(s => s.name as string);
  } catch (err) {
    log.error('Supabase list secrets failed', err);
    return [];
  }
}

// ═══════════════════════════════════════
// Type Generation (CLI)
// ═══════════════════════════════════════

/** 从远程 schema 生成 TypeScript 类型 */
export async function generateTypes(
  config: SupabaseConfig,
  outputPath: string = 'src/types/supabase.ts',
): Promise<CliResult> {
  const absOutput = path.resolve(config.workspacePath, outputPath);
  const result = await runSupabaseCLI(
    `gen types typescript --project-id ${config.projectRef} --schema public`,
    config.workspacePath,
    { SUPABASE_ACCESS_TOKEN: config.accessToken },
  );

  if (result.success && result.output) {
    try {
      const fs = require('fs');
      const dir = path.dirname(absOutput);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absOutput, result.output, 'utf-8');
      return { success: true, output: `TypeScript 类型已生成: ${outputPath} (${Buffer.byteLength(result.output)} bytes)` };
    } catch (err) {
      return { success: false, output: '', error: `类型文件写入失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return result;
}
