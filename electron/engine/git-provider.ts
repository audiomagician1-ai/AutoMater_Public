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
  githubRepo?: string; // e.g. "owner/repo"
  githubToken?: string; // PAT
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
  /** Present when the issue is actually a PR (GitHub issues API returns PRs too) */
  pull_request?: Record<string, unknown>;
}

// ═══════════════════════════════════════
// Local Git Operations
// ═══════════════════════════════════════

async function hasGit(): Promise<boolean> {
  try {
    await execAsync('git --version');
    return true;
  } catch {
    return false;
  }
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
      } catch (_err) {
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
    } catch {
      /* has changes — proceed to commit */
    }

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
  } catch (_err) {
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
  } catch (_err) {
    log.debug('Git diff retrieval failed');
    return '';
  }
}

// ═══════════════════════════════════════
// v27.0: Git Status / File History / Checkout
// ═══════════════════════════════════════

export interface GitStatusEntry {
  /** X = index, Y = worktree (e.g. 'M', 'A', 'D', '?', ' ') */
  index: string;
  worktree: string;
  path: string;
}

/** git status --porcelain: 获取工作区变更状态 */
export async function getStatus(workspacePath: string): Promise<GitStatusEntry[]> {
  if (!(await hasGit()) || !fs.existsSync(path.join(workspacePath, '.git'))) return [];
  try {
    const { stdout } = await execAsync('git status --porcelain -uall', {
      cwd: workspacePath,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    });
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => ({
        index: line[0],
        worktree: line[1],
        path: line.slice(3),
      }));
  } catch (_err) {
    log.debug('Git status failed');
    return [];
  }
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
}

/** 获取结构化的 git log (含作者、日期、完整 hash) */
export async function getStructuredLog(workspacePath: string, maxCount: number = 50): Promise<GitLogEntry[]> {
  if (!(await hasGit()) || !fs.existsSync(path.join(workspacePath, '.git'))) return [];
  try {
    const SEP = '|||';
    const format = `%H${SEP}%h${SEP}%an${SEP}%aI${SEP}%s`;
    const { stdout } = await execAsync(`git log --format="${format}" -${maxCount}`, {
      cwd: workspacePath,
      encoding: 'utf-8',
      maxBuffer: 1024 * 512,
    });
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [hash, shortHash, author, date, ...msgParts] = line.split(SEP);
        return { hash, shortHash, author, date, message: msgParts.join(SEP) };
      });
  } catch (_err) {
    log.debug('Git structured log failed');
    return [];
  }
}

/** 获取单个文件的提交历史 (git log --follow) */
export async function getFileLog(
  workspacePath: string,
  filePath: string,
  maxCount: number = 30,
): Promise<GitLogEntry[]> {
  if (!(await hasGit()) || !fs.existsSync(path.join(workspacePath, '.git'))) return [];
  try {
    const SEP = '|||';
    const format = `%H${SEP}%h${SEP}%an${SEP}%aI${SEP}%s`;
    const { stdout } = await execAsync(
      `git log --follow --format="${format}" -${maxCount} -- "${filePath.replace(/"/g, '\\"')}"`,
      { cwd: workspacePath, encoding: 'utf-8', maxBuffer: 1024 * 512 },
    );
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [hash, shortHash, author, date, ...msgParts] = line.split(SEP);
        return { hash, shortHash, author, date, message: msgParts.join(SEP) };
      });
  } catch (_err) {
    log.debug('Git file log failed', { filePath });
    return [];
  }
}

/** 获取指定 commit 中某个文件的内容 (git show <hash>:<file>) */
export async function showFileAtCommit(
  workspacePath: string,
  commitHash: string,
  filePath: string,
): Promise<string | null> {
  if (!(await hasGit()) || !fs.existsSync(path.join(workspacePath, '.git'))) return null;
  try {
    // Normalize to forward slashes for git
    const gitPath = filePath.replace(/\\/g, '/');
    const { stdout } = await execAsync(`git show "${commitHash}:${gitPath}"`, {
      cwd: workspacePath,
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
    });
    return stdout;
  } catch (_err) {
    log.debug('Git show file at commit failed', { commitHash, filePath });
    return null;
  }
}

/** 回退单个文件到指定 commit 版本 (git checkout <hash> -- <file>) */
export async function checkoutFile(
  workspacePath: string,
  commitHash: string,
  filePath: string,
): Promise<{ success: boolean; error?: string }> {
  if (!(await hasGit()) || !fs.existsSync(path.join(workspacePath, '.git'))) {
    return { success: false, error: 'Git 未初始化' };
  }
  try {
    const gitPath = filePath.replace(/\\/g, '/');
    await execAsync(`git checkout "${commitHash}" -- "${gitPath}"`, { cwd: workspacePath });
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Git checkout file failed', { commitHash, filePath, error: msg });
    return { success: false, error: msg };
  }
}

/** 获取暂存区 diff (已 add 的变更) */
export async function getStagedDiff(workspacePath: string): Promise<string> {
  if (!(await hasGit()) || !fs.existsSync(path.join(workspacePath, '.git'))) return '';
  try {
    const { stdout } = await execAsync('git diff --cached', {
      cwd: workspacePath,
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } catch (_err) {
    log.debug('Git staged diff failed');
    return '';
  }
}

/** 获取两个 commit 之间单个文件的 diff */
export async function getFileDiff(workspacePath: string, commitHash: string, filePath: string): Promise<string> {
  if (!(await hasGit()) || !fs.existsSync(path.join(workspacePath, '.git'))) return '';
  try {
    const gitPath = filePath.replace(/\\/g, '/');
    const { stdout } = await execAsync(`git diff "${commitHash}^" "${commitHash}" -- "${gitPath}"`, {
      cwd: workspacePath,
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } catch (_err) {
    // 可能是首次提交 (没有 parent)
    try {
      const gitPath = filePath.replace(/\\/g, '/');
      const { stdout } = await execAsync(`git diff --no-index /dev/null "${gitPath}"`, {
        cwd: workspacePath,
        encoding: 'utf-8',
        maxBuffer: 2 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return '';
    }
  }
}

/** 获取某次 commit 变更的文件列表 */
export async function getCommitFiles(workspacePath: string, commitHash: string): Promise<string[]> {
  if (!(await hasGit()) || !fs.existsSync(path.join(workspacePath, '.git'))) return [];
  try {
    const { stdout } = await execAsync(`git diff-tree --no-commit-id --name-only -r "${commitHash}"`, {
      cwd: workspacePath,
      encoding: 'utf-8',
      maxBuffer: 1024 * 512,
    });
    return stdout.trim().split('\n').filter(Boolean);
  } catch (_err) {
    log.debug('Git commit files failed', { commitHash });
    return [];
  }
}

// ═══════════════════════════════════════
// GitHub API Operations
// ═══════════════════════════════════════

async function githubApi(
  endpoint: string,
  token: string,
  method: string = 'GET',
  body?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
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
  labels: string[] = [],
): Promise<GitHubIssue | null> {
  if (config.mode !== 'github' || !config.githubRepo || !config.githubToken) return null;
  try {
    const data = await githubApi(`/repos/${config.githubRepo}/issues`, config.githubToken, 'POST', {
      title,
      body,
      labels,
    });
    const d = data as Record<string, unknown>;
    return {
      number: d.number as number,
      title: d.title as string,
      state: d.state as string,
      body: d.body as string,
      labels: ((d.labels || []) as GitHubApiLabel[]).map(l => l.name),
      html_url: d.html_url as string,
    };
  } catch (err) {
    log.error('GitHub create issue failed', err);
    return null;
  }
}

export async function closeIssue(config: GitProviderConfig, issueNumber: number): Promise<boolean> {
  if (config.mode !== 'github' || !config.githubRepo || !config.githubToken) return false;
  try {
    await githubApi(`/repos/${config.githubRepo}/issues/${issueNumber}`, config.githubToken, 'PATCH', {
      state: 'closed',
    });
    return true;
  } catch (_err) {
    log.warn('GitHub close issue failed', { issueNumber });
    return false;
  }
}

export async function listIssues(
  config: GitProviderConfig,
  state: 'open' | 'closed' | 'all' = 'open',
): Promise<GitHubIssue[]> {
  if (config.mode !== 'github' || !config.githubRepo || !config.githubToken) return [];
  try {
    const data = await githubApi(`/repos/${config.githubRepo}/issues?state=${state}&per_page=50`, config.githubToken);
    return ((data || []) as GitHubApiIssue[]).map((d: GitHubApiIssue) => ({
      number: d.number,
      title: d.title,
      state: d.state,
      body: d.body,
      labels: (d.labels || []).map((l: GitHubApiLabel) => l.name),
      html_url: d.html_url,
    }));
  } catch (_err) {
    log.warn('GitHub list issues failed');
    return [];
  }
}

export async function addIssueComment(config: GitProviderConfig, issueNumber: number, body: string): Promise<boolean> {
  if (config.mode !== 'github' || !config.githubRepo || !config.githubToken) return false;
  try {
    await githubApi(`/repos/${config.githubRepo}/issues/${issueNumber}/comments`, config.githubToken, 'POST', { body });
    return true;
  } catch (_err) {
    log.warn('GitHub add comment failed', { issueNumber });
    return false;
  }
}

export async function testGitHubConnection(
  repo: string,
  token: string,
): Promise<{ success: boolean; message: string }> {
  try {
    const data = await githubApi(`/repos/${repo}`, token);
    const d = data as Record<string, unknown>;
    return { success: true, message: `✅ 已连接: ${d.full_name} (${d.private ? '私有' : '公开'})` };
  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ═══════════════════════════════════════
// v14.0: Branch Management
// ═══════════════════════════════════════

export interface BranchInfo {
  name: string;
  current: boolean;
}

export async function getCurrentBranch(workspacePath: string): Promise<string> {
  if (!(await hasGit()) || !fs.existsSync(path.join(workspacePath, '.git'))) return '';
  try {
    const { stdout } = await execAsync('git branch --show-current', { cwd: workspacePath, encoding: 'utf-8' });
    return stdout.trim();
  } catch {
    /* silent: git branch查询失败 */
    return '';
  }
}

export async function listBranches(workspacePath: string): Promise<BranchInfo[]> {
  if (!(await hasGit()) || !fs.existsSync(path.join(workspacePath, '.git'))) return [];
  try {
    const { stdout } = await execAsync('git branch --no-color', { cwd: workspacePath, encoding: 'utf-8' });
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => ({
        name: line.replace(/^\*?\s+/, '').trim(),
        current: line.startsWith('*'),
      }));
  } catch {
    /* silent: git branch解析失败 */
    return [];
  }
}

export async function createBranch(
  config: GitProviderConfig,
  branchName: string,
  baseBranch?: string,
): Promise<{ success: boolean; error?: string }> {
  const { workspacePath } = config;
  if (!(await hasGit()) || !fs.existsSync(path.join(workspacePath, '.git'))) {
    return { success: false, error: 'Git 未初始化' };
  }
  try {
    // Ensure clean working tree or stash
    const base = baseBranch || '';
    const cmd = base ? `git checkout -b "${branchName}" "${base}"` : `git checkout -b "${branchName}"`;
    await execAsync(cmd, { cwd: workspacePath });
    log.info(`Branch created: ${branchName}`, { baseBranch: base || '(current)' });
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Branch create failed', { branchName, error: msg });
    return { success: false, error: msg };
  }
}

export async function switchBranch(
  config: GitProviderConfig,
  branchName: string,
): Promise<{ success: boolean; error?: string }> {
  const { workspacePath } = config;
  if (!(await hasGit())) return { success: false, error: 'Git 不可用' };
  try {
    await execAsync(`git checkout "${branchName}"`, { cwd: workspacePath });
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

export async function deleteBranch(
  config: GitProviderConfig,
  branchName: string,
  force: boolean = false,
): Promise<{ success: boolean; error?: string }> {
  const { workspacePath } = config;
  if (!(await hasGit())) return { success: false, error: 'Git 不可用' };
  try {
    const flag = force ? '-D' : '-d';
    await execAsync(`git branch ${flag} "${branchName}"`, { cwd: workspacePath });
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

// ═══════════════════════════════════════
// v14.0: Remote Sync (Pull / Push / Fetch)
// ═══════════════════════════════════════

export async function gitPull(
  config: GitProviderConfig,
  remote: string = 'origin',
  branch?: string,
): Promise<{ success: boolean; output: string; error?: string }> {
  const { workspacePath } = config;
  if (!(await hasGit())) return { success: false, output: '', error: 'Git 不可用' };
  try {
    const branchArg = branch || '';
    const cmd = branchArg ? `git pull ${remote} ${branchArg}` : `git pull ${remote}`;
    const { stdout, stderr } = await execAsync(cmd, { cwd: workspacePath, encoding: 'utf-8', timeout: 60000 });
    return { success: true, output: (stdout + '\n' + stderr).trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: '', error: msg };
  }
}

export async function gitPush(
  config: GitProviderConfig,
  remote: string = 'origin',
  branch?: string,
  setUpstream: boolean = false,
): Promise<{ success: boolean; output: string; error?: string }> {
  const { workspacePath } = config;
  if (!(await hasGit())) return { success: false, output: '', error: 'Git 不可用' };
  try {
    const branchArg = branch || 'HEAD';
    const upstreamFlag = setUpstream ? '-u' : '';
    const cmd = `git push ${upstreamFlag} ${remote} ${branchArg}`.replace(/\s+/g, ' ').trim();
    const { stdout, stderr } = await execAsync(cmd, { cwd: workspacePath, encoding: 'utf-8', timeout: 60000 });
    return { success: true, output: (stdout + '\n' + stderr).trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: '', error: msg };
  }
}

export async function gitFetch(
  config: GitProviderConfig,
  remote: string = 'origin',
): Promise<{ success: boolean; output: string; error?: string }> {
  const { workspacePath } = config;
  if (!(await hasGit())) return { success: false, output: '', error: 'Git 不可用' };
  try {
    const { stdout, stderr } = await execAsync(`git fetch ${remote} --prune`, {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 60000,
    });
    return { success: true, output: (stdout + '\n' + stderr).trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: '', error: msg };
  }
}

// ═══════════════════════════════════════
// v14.0: GitHub Issue (single fetch)
// ═══════════════════════════════════════

export async function getIssue(config: GitProviderConfig, issueNumber: number): Promise<GitHubIssue | null> {
  if (config.mode !== 'github' || !config.githubRepo || !config.githubToken) return null;
  try {
    const data = await githubApi(`/repos/${config.githubRepo}/issues/${issueNumber}`, config.githubToken);
    const d = data as Record<string, unknown>;
    return {
      number: d.number as number,
      title: d.title as string,
      state: d.state as string,
      body: d.body as string,
      labels: ((d.labels || []) as GitHubApiLabel[]).map(l => l.name),
      html_url: d.html_url as string,
    };
  } catch (_err) {
    log.warn('GitHub get issue failed', { issueNumber });
    return null;
  }
}

// ═══════════════════════════════════════
// v14.0: GitHub Pull Request API
// ═══════════════════════════════════════

export interface GitHubPR {
  number: number;
  title: string;
  state: string;
  body?: string;
  head_branch: string;
  base_branch: string;
  html_url: string;
  merged: boolean;
  mergeable: boolean | null;
  draft: boolean;
}

export async function createPR(
  config: GitProviderConfig,
  title: string,
  body: string,
  headBranch: string,
  baseBranch: string = 'main',
  draft: boolean = false,
): Promise<GitHubPR | null> {
  if (config.mode !== 'github' || !config.githubRepo || !config.githubToken) return null;
  try {
    const data = await githubApi(`/repos/${config.githubRepo}/pulls`, config.githubToken, 'POST', {
      title,
      body,
      head: headBranch,
      base: baseBranch,
      draft,
    });
    return parsePR(data);
  } catch (err) {
    log.error('GitHub create PR failed', err);
    return null;
  }
}

export async function listPRs(
  config: GitProviderConfig,
  state: 'open' | 'closed' | 'all' = 'open',
): Promise<GitHubPR[]> {
  if (config.mode !== 'github' || !config.githubRepo || !config.githubToken) return [];
  try {
    const data = await githubApi(`/repos/${config.githubRepo}/pulls?state=${state}&per_page=50`, config.githubToken);
    return ((data || []) as Record<string, unknown>[]).map(parsePR);
  } catch (_err) {
    log.warn('GitHub list PRs failed');
    return [];
  }
}

export async function getPR(config: GitProviderConfig, prNumber: number): Promise<GitHubPR | null> {
  if (config.mode !== 'github' || !config.githubRepo || !config.githubToken) return null;
  try {
    const data = await githubApi(`/repos/${config.githubRepo}/pulls/${prNumber}`, config.githubToken);
    return parsePR(data);
  } catch (_err) {
    log.warn('GitHub get PR failed', { prNumber });
    return null;
  }
}

export async function mergePR(
  config: GitProviderConfig,
  prNumber: number,
  mergeMethod: 'merge' | 'squash' | 'rebase' = 'squash',
  commitTitle?: string,
): Promise<{ success: boolean; sha?: string; error?: string }> {
  if (config.mode !== 'github' || !config.githubRepo || !config.githubToken) {
    return { success: false, error: '未配置 GitHub 模式' };
  }
  try {
    const body: Record<string, unknown> = { merge_method: mergeMethod };
    if (commitTitle) body.commit_title = commitTitle;
    const data = await githubApi(
      `/repos/${config.githubRepo}/pulls/${prNumber}/merge`,
      config.githubToken,
      'PUT',
      body,
    );
    const d = data as Record<string, unknown>;
    return { success: d.merged === true, sha: d.sha as string };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('GitHub merge PR failed', { prNumber, error: msg });
    return { success: false, error: msg };
  }
}

/** Helper: parse GitHub PR API response into our GitHubPR type */
function parsePR(data: unknown): GitHubPR {
  const d = data as Record<string, unknown>;
  const head = d.head as Record<string, unknown> | undefined;
  const base = d.base as Record<string, unknown> | undefined;
  return {
    number: d.number as number,
    title: d.title as string,
    state: d.state as string,
    body: d.body as string | undefined,
    head_branch: (head?.ref as string) || '',
    base_branch: (base?.ref as string) || '',
    html_url: d.html_url as string,
    merged: (d.merged as boolean) || false,
    mergeable: d.mergeable as boolean | null,
    draft: (d.draft as boolean) || false,
  };
}
