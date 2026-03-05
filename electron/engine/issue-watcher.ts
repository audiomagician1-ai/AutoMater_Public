/**
 * Issue Watcher — GitHub Issue → Feature 自动关联
 *
 * 扫描项目 GitHub repo 的 open issues，自动创建对应 Feature 并关联。
 * 支持手动触发（IPC）和定时轮询。
 *
 * v14.0: 初始实现
 */

import { getDb } from '../db';
import { createLogger } from './logger';
import { listIssues, addIssueComment, type GitProviderConfig, type GitHubIssue } from './git-provider';
import type { FeatureRow, ProjectRow } from './types';

const log = createLogger('issue-watcher');

// ═══════════════════════════════════════
// Issue → Feature Mapping
// ═══════════════════════════════════════

/** 从 GitHub Issue label 推导 Feature 优先级 */
function issuePriority(labels: string[]): number {
  const lower = labels.map(l => l.toLowerCase());
  if (lower.includes('critical') || lower.includes('p0') || lower.includes('urgent')) return 1;
  if (lower.includes('high') || lower.includes('p1') || lower.includes('important')) return 2;
  if (lower.includes('low') || lower.includes('p3') || lower.includes('nice-to-have')) return 4;
  return 3; // default: medium
}

/** 从 Issue label 推导 Feature category */
function issueCategory(labels: string[]): string {
  const lower = labels.map(l => l.toLowerCase());
  if (lower.some(l => l.includes('bug') || l.includes('fix'))) return 'bugfix';
  if (lower.some(l => l.includes('feat') || l.includes('enhancement'))) return 'feature';
  if (lower.some(l => l.includes('doc'))) return 'documentation';
  if (lower.some(l => l.includes('refactor'))) return 'refactor';
  if (lower.some(l => l.includes('test'))) return 'testing';
  if (lower.some(l => l.includes('chore') || l.includes('infra'))) return 'infrastructure';
  return 'feature';
}

/** 为 Feature 生成 Git 分支名 */
function issueBranchName(issue: GitHubIssue): string {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `issue-${issue.number}/${slug}`;
}

export interface IssueSyncResult {
  scanned: number;
  created: number;
  skipped: number;
  errors: string[];
  features: Array<{ featureId: string; issueNumber: number; title: string }>;
}

/**
 * 扫描 GitHub Issues 并为每个未关联的 open issue 创建 Feature
 */
export async function syncIssuesToFeatures(
  projectId: string,
): Promise<IssueSyncResult> {
  const db = getDb();
  const result: IssueSyncResult = { scanned: 0, created: 0, skipped: 0, errors: [], features: [] };

  // 1. 获取项目信息
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
  if (!project) {
    result.errors.push(`项目 ${projectId} 不存在`);
    return result;
  }
  if (project.git_mode !== 'github' || !project.github_repo || !project.github_token) {
    result.errors.push('项目未配置 GitHub 模式');
    return result;
  }

  const gitConfig: GitProviderConfig = {
    mode: 'github',
    workspacePath: project.workspace_path || '',
    githubRepo: project.github_repo,
    githubToken: project.github_token,
  };

  // 2. 获取远程 open issues
  const issues = await listIssues(gitConfig, 'open');
  result.scanned = issues.length;
  log.info(`Scanned ${issues.length} open issues for project ${projectId}`);

  // 3. 获取已关联的 issue numbers
  const existingFeatures = db.prepare(
    'SELECT github_issue_number FROM features WHERE project_id = ? AND github_issue_number IS NOT NULL'
  ).all() as Array<{ github_issue_number: number }>;
  const linkedIssues = new Set(existingFeatures.map(f => f.github_issue_number));

  // 4. 为未关联的 issues 创建 Features
  const insertStmt = db.prepare(`
    INSERT INTO features (id, project_id, category, priority, group_name, title, description, depends_on, status, acceptance_criteria, affected_files, notes, github_issue_number, github_branch)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 'todo', '[]', '[]', ?, ?, ?)
  `);

  for (const issue of issues) {
    // 跳过 PR（GitHub API 的 issues 接口也返回 PR）
    if (issue.pull_request) {
      result.skipped++;
      continue;
    }

    if (linkedIssues.has(issue.number)) {
      result.skipped++;
      continue;
    }

    try {
      const featureId = `feat-issue-${issue.number}-${Date.now().toString(36)}`;
      const category = issueCategory(issue.labels);
      const priority = issuePriority(issue.labels);
      const branchName = issueBranchName(issue);
      const notes = `来自 GitHub Issue #${issue.number}: ${issue.html_url}\n标签: ${issue.labels.join(', ') || '无'}`;

      insertStmt.run(
        featureId,
        projectId,
        category,
        priority,
        'github-issues',  // group_name
        `[#${issue.number}] ${issue.title}`,
        issue.body || issue.title,
        notes,
        issue.number,
        branchName,
      );

      result.created++;
      result.features.push({ featureId, issueNumber: issue.number, title: issue.title });

      // 在 Issue 上添加评论，通知已接收
      try {
        await addIssueComment(
          gitConfig,
          issue.number,
          `🤖 **AutoMater** 已接收此 Issue 并创建开发任务 \`${featureId}\`\n\n分支: \`${branchName}\`\n优先级: P${priority} | 分类: ${category}\n\n开发完成后将自动提交 PR 并关闭此 Issue。`,
        );
      } catch (err) { /* silent: GitHub评论失败不影响Feature创建 */
        log.debug(`Failed to comment on issue #${issue.number} (non-fatal)`);
      }

      log.info(`Created feature ${featureId} for issue #${issue.number}: ${issue.title}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Issue #${issue.number}: ${msg}`);
      log.error(`Failed to create feature for issue #${issue.number}`, { error: msg });
    }
  }

  log.info(`Issue sync complete: scanned=${result.scanned} created=${result.created} skipped=${result.skipped}`);
  return result;
}

/**
 * 获取项目中所有 Issue-关联的 Features
 */
export function getIssueFeatures(projectId: string): Array<FeatureRow & { github_issue_number: number }> {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM features WHERE project_id = ? AND github_issue_number IS NOT NULL ORDER BY priority ASC, created_at DESC'
  ).all(projectId) as Array<FeatureRow & { github_issue_number: number }>;
}

// ═══════════════════════════════════════
// Polling Timer (optional auto-sync)
// ═══════════════════════════════════════

const pollingTimers = new Map<string, NodeJS.Timeout>();

/**
 * 启动定时轮询（每 N 分钟扫描一次）
 */
export function startIssuePolling(projectId: string, intervalMinutes: number = 10): void {
  stopIssuePolling(projectId);
  log.info(`Starting issue polling for ${projectId} every ${intervalMinutes}min`);

  const timer = setInterval(async () => {
    try {
      const result = await syncIssuesToFeatures(projectId);
      if (result.created > 0) {
        log.info(`Polling: created ${result.created} new features from GitHub issues`);
      }
    } catch (err) {
      log.error('Issue polling error', err);
    }
  }, intervalMinutes * 60 * 1000);

  pollingTimers.set(projectId, timer);
}

/**
 * 停止定时轮询
 */
export function stopIssuePolling(projectId: string): void {
  const existing = pollingTimers.get(projectId);
  if (existing) {
    clearInterval(existing);
    pollingTimers.delete(projectId);
    log.info(`Stopped issue polling for ${projectId}`);
  }
}

/**
 * 停止所有轮询
 */
export function stopAllPolling(): void {
  for (const [projectId, timer] of pollingTimers) {
    clearInterval(timer);
    log.info(`Stopped issue polling for ${projectId}`);
  }
  pollingTimers.clear();
}
