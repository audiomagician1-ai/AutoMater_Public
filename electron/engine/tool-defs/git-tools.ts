/**
 * Git + GitHub tool definitions.
 */
import type { ToolDef } from './types';

export const GIT_TOOLS: ToolDef[] = [
  // ── Git ──
  {
    name: 'git_commit',
    description: '提交当前所有变更到 git。如配置了 GitHub 会自动 push。',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: '提交信息' } },
      required: ['message'],
    },
  },
  {
    name: 'git_diff',
    description: '查看当前未提交的变更（git diff）',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_log',
    description: '查看最近的 git 提交历史',
    parameters: {
      type: 'object',
      properties: { count: { type: 'number', description: '显示条数，默认10', default: 10 } },
    },
  },

  // ── GitHub ──
  {
    name: 'github_create_issue',
    description: '在 GitHub 仓库创建 Issue (仅 GitHub 模式)',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Issue 标题' },
        body: { type: 'string', description: 'Issue 内容(Markdown)' },
        labels: { type: 'array', items: { type: 'string' }, description: '标签列表' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'github_list_issues',
    description: '列出 GitHub 仓库的 Issues (仅 GitHub 模式)',
    parameters: {
      type: 'object',
      properties: { state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' } },
    },
  },
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
    description: '在 GitHub Issue 上添加评论（仅 GitHub 模式下可用）。支持 Markdown。',
    parameters: {
      type: 'object',
      properties: {
        issue_number: { type: 'number', description: 'Issue 编号' },
        body: { type: 'string', description: '评论内容 (支持 Markdown)' },
      },
      required: ['issue_number', 'body'],
    },
  },
  {
    name: 'github_get_issue',
    description: '获取单个 GitHub Issue 的详细信息（仅 GitHub 模式下可用）。',
    parameters: {
      type: 'object',
      properties: { issue_number: { type: 'number', description: 'Issue 编号' } },
      required: ['issue_number'],
    },
  },

  // ── Branch Management ──
  {
    name: 'git_create_branch',
    description: '创建并切换到新的 Git 分支。可指定基础分支，默认从当前分支创建。',
    parameters: {
      type: 'object',
      properties: {
        branch_name: { type: 'string', description: '新分支名称（如 feature/login, fix/issue-42）' },
        base_branch: { type: 'string', description: '基础分支（可选，默认从当前分支创建）' },
      },
      required: ['branch_name'],
    },
  },
  {
    name: 'git_switch_branch',
    description: '切换到已存在的 Git 分支。',
    parameters: {
      type: 'object',
      properties: {
        branch_name: { type: 'string', description: '目标分支名称' },
      },
      required: ['branch_name'],
    },
  },
  {
    name: 'git_list_branches',
    description: '列出本地所有 Git 分支及当前分支。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_delete_branch',
    description: '删除本地 Git 分支。不能删除当前所在分支。',
    parameters: {
      type: 'object',
      properties: {
        branch_name: { type: 'string', description: '要删除的分支名称' },
        force: { type: 'boolean', description: '是否强制删除（未合并的分支需要强制删除）', default: false },
      },
      required: ['branch_name'],
    },
  },
  {
    name: 'git_pull',
    description: '从远程仓库拉取最新代码并合并到当前分支。',
    parameters: {
      type: 'object',
      properties: {
        remote: { type: 'string', description: '远程名称，默认 origin', default: 'origin' },
        branch: { type: 'string', description: '远程分支名（可选，默认跟踪分支）' },
      },
    },
  },
  {
    name: 'git_push',
    description: '将本地提交推送到远程仓库。',
    parameters: {
      type: 'object',
      properties: {
        remote: { type: 'string', description: '远程名称，默认 origin', default: 'origin' },
        branch: { type: 'string', description: '分支名（可选，默认 HEAD）' },
        set_upstream: { type: 'boolean', description: '是否设置上游跟踪（新分支首次 push 时需要）', default: false },
      },
    },
  },
  {
    name: 'git_fetch',
    description: '从远程仓库获取最新引用（不合并）。用于检查远程是否有新分支/提交。',
    parameters: {
      type: 'object',
      properties: {
        remote: { type: 'string', description: '远程名称，默认 origin', default: 'origin' },
      },
    },
  },

  // ── Pull Requests ──
  {
    name: 'github_create_pr',
    description: '创建 GitHub Pull Request。需要 GitHub 模式。创建前请确保已 push 分支到远程。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'PR 标题' },
        body: { type: 'string', description: 'PR 描述 (支持 Markdown)' },
        head_branch: { type: 'string', description: '源分支（要合并的分支）' },
        base_branch: { type: 'string', description: '目标分支，默认 main', default: 'main' },
        draft: { type: 'boolean', description: '是否创建为草稿 PR', default: false },
      },
      required: ['title', 'body', 'head_branch'],
    },
  },
  {
    name: 'github_list_prs',
    description: '列出 GitHub Pull Requests。需要 GitHub 模式。',
    parameters: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: '状态过滤，默认 open', default: 'open' },
      },
    },
  },
  {
    name: 'github_get_pr',
    description: '获取单个 GitHub Pull Request 的详细信息。',
    parameters: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'PR 编号' },
      },
      required: ['pr_number'],
    },
  },
  {
    name: 'github_merge_pr',
    description: '合并 GitHub Pull Request。支持 merge/squash/rebase 三种方式。',
    parameters: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'PR 编号' },
        merge_method: {
          type: 'string',
          enum: ['merge', 'squash', 'rebase'],
          description: '合并方式，默认 squash',
          default: 'squash',
        },
        commit_title: { type: 'string', description: '合并提交标题（可选）' },
      },
      required: ['pr_number'],
    },
  },
];
