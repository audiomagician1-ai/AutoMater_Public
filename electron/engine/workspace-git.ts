/**
 * Workspace Git — 项目工作区 Git 管理 (高层接口)
 *
 * 委托底层操作给 git-provider.ts，消除重复实现。
 *
 * - 项目创建时 git init + .gitignore
 * - 每个 phase 结束时自动 commit
 * - 项目导出为 zip
 *
 * v4.5: 重构为 git-provider 的薄包装层
 */

import { execSync, exec as execCb } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(execCb);
import fs from 'fs';
import path from 'path';
import { initRepo, commit as gpCommit, getLog as gpGetLog, type GitProviderConfig } from './git-provider';
import { createLogger } from './logger';

const log = createLogger('workspace-git');

/**
 * 检测系统是否有 git (委托给 git-provider 内部实现,
 * 这里保留公开 API 以兼容现有调用方)
 */
export function hasGit(): boolean {
  try {
    execSync('git --version', { stdio: 'ignore' }); // SYNC-OK: <1ms 存在性探测, 仅启动时调用一次
    return true;
  } catch { /* silent: git not installed */
    return false;
  }
}

/**
 * 在工作区初始化 git (委托给 git-provider.initRepo)
 */
export async function initGitRepo(workspacePath: string): Promise<boolean> {
  const config: GitProviderConfig = { mode: 'local', workspacePath };
  return initRepo(config);
}

/**
 * 在工作区做一次 git commit (委托给 git-provider.commit)
 */
export async function commitWorkspace(workspacePath: string, message: string): Promise<boolean> {
  const config: GitProviderConfig = { mode: 'local', workspacePath };
  const result = await gpCommit(config, message);
  return result.success;
}

/**
 * 获取 git log（简短）(委托给 git-provider.getLog)
 */
export async function getGitLog(workspacePath: string, maxCount: number = 20): Promise<string[]> {
  return gpGetLog(workspacePath, maxCount);
}

/**
 * 将工作区打包为 zip (使用 PowerShell)
 */
export async function exportWorkspaceZip(workspacePath: string, outputPath: string): Promise<boolean> {
  try {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    const cmd = `powershell -NoProfile -Command "Compress-Archive -Path '${workspacePath}\\*' -DestinationPath '${outputPath}' -Force"`;
    await execAsync(cmd, { timeout: 60000 });
    return fs.existsSync(outputPath);
  } catch (err) {
    log.error('Workspace zip export failed', err);
    return false;
  }
}
