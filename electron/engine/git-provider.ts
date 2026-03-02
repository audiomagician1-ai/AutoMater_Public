/**
 * Git Provider — 抽象 Git 操作层
 * 
 * 两种模式:
 * - local: 纯本地 git (现有行为)
 * - github: 本地 git + GitHub 远程 (push/issue/PR)
 * 
 * v0.8: 初始实现
 */

import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import type { GitHubApiLabel, GitHubApiIssue } from './types';

const execAsync = promisify(execCb);
const log = createLogger('git-provider');

export type GitMode = 'local' | 'github';

export interface GitProviderConfig {
  mode: GitMode;
  workspacePath: string;
  githubRepo?: string;   // e.g. "owner/repo"
  githubToken?: string;  // PAT
}

export interface GitCommitResult {
  success: boolean;
  hash?: string;
  pushed?: boolean;
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  body?: string;
  labels: string[];
  html_url: string;
}

// ═══════════════════════════════════════
// Local Git Operations
// ═══════════════════════════════════════

async function hasGit(): Promise<boolean> {
  try { await execAsync('git --version'); return true; } catch { return false; }
}

export async function initRepo(config: GitProviderConfig): Promise<boolean> {
  if (!(await hasGit())) return false;
  const { workspacePath, mode, githubRepo, githubToken } = config;

  try {
    const gitDir = path.join(workspacePath, '.git');
    if (!fs.existsSync(gitDir)) {
      await execAsync('git init', { cwd: workspacePath });

      const gitignore = `node_modules/\ndist/\nbuild/\n.env\n.env.local\n*.pyc\n__pycache__/\n.DS_Store\nThumbs.db\n*.log\n.vscode/\n.idea/\n`;
      fs.writeFileSync(path.join(workspacePath, '.gitignore'), gitignore, 'utf-8');

      try {
        await execAsync('git config user.email "agent@automater.dev"', { cwd: workspacePath });
        await execAsync('git config user.name "AutoMater"', { cwd: workspacePath });
      } catch (err) {
        log.debug('Git user config failed (non-fatal)', { error: String(err) });
      }

      await execAsync('git add -A', { cwd: workspacePath });
      await execAsync('git commit -m "Initial commit by AutoMater" --allow-empty', { cwd: workspacePath });
    }

    // GitHub mode: add remote
    if (mode === 'github' && githubRepo && githubToken) {
      const remoteUrl = `https://${githubToken}@github.com/${githubRepo}.git`;
      try {
        await execAsync(`git remote remove origin`, { cwd: workspacePath });
      } catch (err) {
        log.debug('No existing origin remote to remove');
      }
      await execAsync(`git remote add origin ${remoteUrl}`, { cwd: workspacePath });
    }

    return true;
  } catch (err) {
    log.error('Git init failed', err);
    return false;
  }
}

export async function commit(config: GitProviderConfig, message: string): Promise<GitCommitResult> {
  const { workspacePath, mode } = config;
  if (!(await hasGit()) || !fs.existsSync(path.join(workspacePath, '.git'))) {
    return { success: false };
  }

  try {
    await execAsync('git add -A', { cwd: workspacePath });

    // Check for changes
    try {
      await execAsync('git diff --cached --quiet', { cwd: workspacePath });
      return { success: false }; // no changes
    } catch { /* has changes — proceed to commit */ }

    await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: workspacePath });

    const { stdout } = await execAsync('git rev-parse --short HEAD', { cwd: workspacePath, encoding: 'utf-8' });
    const hash = stdout.trim();

    let pushed = false;
    if (mode === 'github') {
      try {
        await execAsync('git push origin HEAD', { cwd: workspacePath, timeout: 30000 });
        pushed = true;
      } catch (err) {
        log.error('Push failed', err);
      }
    }

    return { success: true, hash, pushed };
  } catch (err) {
    log.error('Git commit failed', err);
    return { success: false };
  }
}

export async function getLog(workspacePath: string, maxCount: number = 20): Promise<string[]> {
  if (!(await hasGit()) || !fs.existsSync(path.join(workspacePath, '.git'))) return [];
  try {
    const { stdout } = await execAsync(`git log --oneline -${maxCount}`, { cwd: workspacePath, encoding: 'utf-8' });
    return stdout.trim().split('\n').filter(Boolean);
  } catch (err) {
    log.debug('Git log retrieval failed');
    return [];
  }
}

export async function getDiff(workspacePath: string, commitRange?: string): Promise<string> {
  if (!(await hasGit()) || !fs.existsSync(path.join(workspacePath, '.git'))) return '';
  try {
    const cmd = commitRange ? `git diff ${commitRange}` : 'git diff HEAD';
    const { stdout } = await execAsync(cmd, { cwd: workspacePath, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
    return stdout;
  } catch (err) {
    log.debug('Git diff retrieval failed');
    return '';
  }
}

// ═══════════════════════════════════════
// GitHub API Operations
// ═══════════════════════════════════════

async function githubApi(
  endpoint: string,
  token: string,
  method: string = 'GET',
  body?: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }
  return res.json();
}

export async function createIssue(
  config: GitProviderConfig,
  title: string,
  body: string,
  labels: string[] = []
): Promise<GitHubIssue | null> {
  if (config.mode !== 'github' || !config.githubRepo || !config.githubToken) return null;
  try {
    const data = await githubApi(
      `/repos/${config.githubRepo}/issues`,
      config.githubToken,
      'POST',
      { title, body, labels }
    );
    const d = data as Record<string, unknown>;
    return {
      number: d.number as number,
      title: d.title as string,
      state: d.state as string,
      body: d.body as string,
      labels: ((d.labels || []) as GitHubApiLabel[]).map((l) => l.name),
      html_url: d.html_url as string,
    };
  } catch (err) {
    log.error('GitHub create issue failed', err);
    return null;
  }
}

export async function closeIssue(
  config: GitProviderConfig,
  issueNumber: number
): Promise<boolean> {
  if (config.mode !== 'github' || !config.githubRepo || !config.githubToken) return false;
  try {
    await githubApi(
      `/repos/${config.githubRepo}/issues/${issueNumber}`,
      config.githubToken,
      'PATCH',
      { state: 'closed' }
    );
    return true;
  } catch (err) {
    log.warn('GitHub close issue failed', { issueNumber });
    return false;
  }
}

export async function listIssues(
  config: GitProviderConfig,
  state: 'open' | 'closed' | 'all' = 'open'
): Promise<GitHubIssue[]> {
  if (config.mode !== 'github' || !config.githubRepo || !config.githubToken) return [];
  try {
    const data = await githubApi(
      `/repos/${config.githubRepo}/issues?state=${state}&per_page=50`,
      config.githubToken
    );
    return ((data || []) as GitHubApiIssue[]).map((d: GitHubApiIssue) => ({
      number: d.number,
      title: d.title,
      state: d.state,
      body: d.body,
      labels: (d.labels || []).map((l: GitHubApiLabel) => l.name),
      html_url: d.html_url,
    }));
  } catch (err) {
    log.warn('GitHub list issues failed');
    return [];
  }
}

export async function addIssueComment(
  config: GitProviderConfig,
  issueNumber: number,
  body: string
): Promise<boolean> {
  if (config.mode !== 'github' || !config.githubRepo || !config.githubToken) return false;
  try {
    await githubApi(
      `/repos/${config.githubRepo}/issues/${issueNumber}/comments`,
      config.githubToken,
      'POST',
      { body }
    );
    return true;
  } catch (err) {
    log.warn('GitHub add comment failed', { issueNumber });
    return false;
  }
}

export async function testGitHubConnection(repo: string, token: string): Promise<{ success: boolean; message: string }> {
  try {
    const data = await githubApi(`/repos/${repo}`, token);
    const d = data as Record<string, unknown>;
    return { success: true, message: `✅ 已连接: ${d.full_name} (${d.private ? '私有' : '公开'})` };
  } catch (err: unknown) {
    return { success: false, message: (err instanceof Error ? err.message : String(err)) };
  }
}
