/**
 * Git Provider — 抽象 Git 操作层
 * 
 * 两种模式:
 * - local: 纯本地 git (现有行为)
 * - github: 本地 git + GitHub 远程 (push/issue/PR)
 * 
 * v0.8: 初始实现
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';

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

function hasGit(): boolean {
  try { execSync('git --version', { stdio: 'ignore' }); return true; } catch { return false; }
}

export function initRepo(config: GitProviderConfig): boolean {
  if (!hasGit()) return false;
  const { workspacePath, mode, githubRepo, githubToken } = config;

  try {
    const gitDir = path.join(workspacePath, '.git');
    if (!fs.existsSync(gitDir)) {
      execSync('git init', { cwd: workspacePath, stdio: 'ignore' });

      const gitignore = `node_modules/\ndist/\nbuild/\n.env\n.env.local\n*.pyc\n__pycache__/\n.DS_Store\nThumbs.db\n*.log\n.vscode/\n.idea/\n`;
      fs.writeFileSync(path.join(workspacePath, '.gitignore'), gitignore, 'utf-8');

      try {
        execSync('git config user.email "agent@automater.dev"', { cwd: workspacePath, stdio: 'ignore' });
        execSync('git config user.name "AutoMater"', { cwd: workspacePath, stdio: 'ignore' });
      } catch (err) {
        log.debug('Git user config failed (non-fatal)', { error: String(err) });
      }

      execSync('git add -A', { cwd: workspacePath, stdio: 'ignore' });
      execSync('git commit -m "Initial commit by AutoMater" --allow-empty', { cwd: workspacePath, stdio: 'ignore' });
    }

    // GitHub mode: add remote
    if (mode === 'github' && githubRepo && githubToken) {
      const remoteUrl = `https://${githubToken}@github.com/${githubRepo}.git`;
      try {
        execSync(`git remote remove origin`, { cwd: workspacePath, stdio: 'ignore' });
      } catch (err) {
        log.debug('No existing origin remote to remove');
      }
      execSync(`git remote add origin ${remoteUrl}`, { cwd: workspacePath, stdio: 'ignore' });
    }

    return true;
  } catch (err) {
    log.error('Git init failed', err);
    return false;
  }
}

export function commit(config: GitProviderConfig, message: string): GitCommitResult {
  const { workspacePath, mode } = config;
  if (!hasGit() || !fs.existsSync(path.join(workspacePath, '.git'))) {
    return { success: false };
  }

  try {
    execSync('git add -A', { cwd: workspacePath, stdio: 'ignore' });

    // Check for changes
    try {
      execSync('git diff --cached --quiet', { cwd: workspacePath, stdio: 'ignore' });
      return { success: false }; // no changes
    } catch { /* has changes — proceed to commit */ }

    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: workspacePath, stdio: 'ignore' });

    const hash = execSync('git rev-parse --short HEAD', { cwd: workspacePath, encoding: 'utf-8' }).trim();

    let pushed = false;
    if (mode === 'github') {
      try {
        execSync('git push origin HEAD', { cwd: workspacePath, stdio: 'ignore', timeout: 30000 });
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

export function getLog(workspacePath: string, maxCount: number = 20): string[] {
  if (!hasGit() || !fs.existsSync(path.join(workspacePath, '.git'))) return [];
  try {
    const output = execSync(`git log --oneline -${maxCount}`, { cwd: workspacePath, encoding: 'utf-8' });
    return output.trim().split('\n').filter(Boolean);
  } catch (err) {
    log.debug('Git log retrieval failed');
    return [];
  }
}

export function getDiff(workspacePath: string, commitRange?: string): string {
  if (!hasGit() || !fs.existsSync(path.join(workspacePath, '.git'))) return '';
  try {
    const cmd = commitRange ? `git diff ${commitRange}` : 'git diff HEAD';
    return execSync(cmd, { cwd: workspacePath, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
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
  body?: any
): Promise<any> {
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
    return {
      number: data.number,
      title: data.title,
      state: data.state,
      body: data.body,
      labels: (data.labels || []).map((l: any) => l.name),
      html_url: data.html_url,
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
    return (data || []).map((d: any) => ({
      number: d.number,
      title: d.title,
      state: d.state,
      body: d.body,
      labels: (d.labels || []).map((l: any) => l.name),
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
    return { success: true, message: `✅ 已连接: ${data.full_name} (${data.private ? '私有' : '公开'})` };
  } catch (err: unknown) {
    return { success: false, message: (err instanceof Error ? err.message : String(err)) };
  }
}
