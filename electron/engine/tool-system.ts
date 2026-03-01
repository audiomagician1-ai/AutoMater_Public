/**
 * Tool System — Agent 工具注册表与执行器
 * 
 * 参考 OpenClaw 的 JSON Schema tool + handler 模式
 * 参考 EchoAgent 的 skill_index + 多工具并行调用模式
 * 
 * 工具定义为 JSON Schema，handler 为纯函数。
 * Agent 通过 LLM function-calling 或结构化输出选择工具。
 * 
 * v0.8: 初始工具集 (file/search/shell/git/github)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { readWorkspaceFile, readDirectoryTree } from './file-writer';
import { commit as gitCommit, getDiff, getLog as gitLog, createIssue, listIssues, type GitProviderConfig } from './git-provider';

// ═══════════════════════════════════════
// Tool Interface
// ═══════════════════════════════════════

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema
}

export interface ToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  success: boolean;
  output: string;
  /** 操作类型 (用于 UI 展示) */
  action?: 'read' | 'write' | 'search' | 'shell' | 'git' | 'github';
}

/** 工具执行上下文 */
export interface ToolContext {
  workspacePath: string;
  projectId: string;
  gitConfig: GitProviderConfig;
}

// ═══════════════════════════════════════
// Tool Definitions (给 LLM 看的 schema)
// ═══════════════════════════════════════

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: '读取工作区中指定文件的内容。用于理解已有代码、配置文件等。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作区的文件路径' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '创建或覆盖工作区中的文件。自动创建目录。用于写代码、配置文件等。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作区的文件路径' },
        content: { type: 'string', description: '完整的文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: '列出工作区的文件目录树。用于了解项目结构。',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: '相对目录路径，默认为根目录', default: '' },
        max_depth: { type: 'number', description: '最大深度，默认3', default: 3 },
      },
    },
  },
  {
    name: 'search_files',
    description: '在工作区文件中搜索文本模式（grep）。用于查找引用、依赖、import 等。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索的文本模式' },
        include: { type: 'string', description: '文件类型过滤 (如 *.ts, *.py)', default: '*' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_command',
    description: '在工作区中执行 shell 命令。用于安装依赖(npm install)、运行测试、编译检查等。超时30秒。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell 命令' },
      },
      required: ['command'],
    },
  },
  {
    name: 'git_commit',
    description: '提交当前所有变更到 git。如配置了 GitHub 会自动 push。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '提交信息' },
      },
      required: ['message'],
    },
  },
  {
    name: 'git_diff',
    description: '查看当前未提交的变更（git diff）',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'git_log',
    description: '查看最近的 git 提交历史',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '显示条数，默认10', default: 10 },
      },
    },
  },
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
      properties: {
        state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
      },
    },
  },
  {
    name: 'task_complete',
    description: '标记当前任务已完成。必须在所有文件写入完毕且验证通过后调用。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '完成总结' },
        files_changed: { type: 'array', items: { type: 'string' }, description: '修改的文件列表' },
      },
      required: ['summary'],
    },
  },
];

// ═══════════════════════════════════════
// Tool Executor
// ═══════════════════════════════════════

export function executeTool(call: ToolCall, ctx: ToolContext): ToolResult {
  try {
    switch (call.name) {

      case 'read_file': {
        const filePath = call.arguments.path;
        const content = readWorkspaceFile(ctx.workspacePath, filePath);
        if (content === null) return { success: false, output: `文件不存在: ${filePath}`, action: 'read' };
        return { success: true, output: content, action: 'read' };
      }

      case 'write_file': {
        const filePath = call.arguments.path;
        const content = call.arguments.content;
        const normalized = path.normalize(filePath);
        if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
          return { success: false, output: `路径不安全: ${filePath}`, action: 'write' };
        }
        const absPath = path.join(ctx.workspacePath, normalized);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content, 'utf-8');
        const size = Buffer.byteLength(content, 'utf-8');
        return { success: true, output: `已写入 ${normalized} (${size} bytes)`, action: 'write' };
      }

      case 'list_files': {
        const dir = call.arguments.directory || '';
        const maxDepth = call.arguments.max_depth ?? 3;
        const tree = readDirectoryTree(ctx.workspacePath, dir, maxDepth);
        const formatTree = (nodes: any[], indent: string = ''): string => {
          return nodes.map(n => {
            if (n.type === 'dir') {
              return `${indent}${n.name}/\n${n.children ? formatTree(n.children, indent + '  ') : ''}`;
            }
            return `${indent}${n.name}`;
          }).join('\n');
        };
        return { success: true, output: formatTree(tree) || '(空目录)', action: 'read' };
      }

      case 'search_files': {
        const pattern = call.arguments.pattern;
        const include = call.arguments.include || '*';
        try {
          // 使用 grep -rn (跨平台足够)
          const cmd = process.platform === 'win32'
            ? `findstr /S /N /C:"${pattern.replace(/"/g, '')}" ${include}`
            : `grep -rn "${pattern.replace(/"/g, '\\"')}" --include="${include}" .`;
          const output = execSync(cmd, {
            cwd: ctx.workspacePath,
            encoding: 'utf-8',
            maxBuffer: 512 * 1024,
            timeout: 10000,
          });
          const lines = output.trim().split('\n').slice(0, 30);
          return { success: true, output: lines.join('\n') || '无匹配', action: 'search' };
        } catch {
          return { success: true, output: '无匹配', action: 'search' };
        }
      }

      case 'run_command': {
        const command = call.arguments.command;
        // 安全检查: 禁止危险命令
        const forbidden = ['rm -rf /', 'format ', 'del /s', 'shutdown', 'reboot'];
        if (forbidden.some(f => command.toLowerCase().includes(f))) {
          return { success: false, output: `命令被安全策略拦截: ${command}`, action: 'shell' };
        }
        try {
          const output = execSync(command, {
            cwd: ctx.workspacePath,
            encoding: 'utf-8',
            maxBuffer: 512 * 1024,
            timeout: 30000,
          });
          return { success: true, output: output.slice(0, 5000) || '(无输出)', action: 'shell' };
        } catch (err: any) {
          const stderr = err.stderr?.toString().slice(0, 2000) || err.message;
          return { success: false, output: `命令失败: ${stderr}`, action: 'shell' };
        }
      }

      case 'git_commit': {
        const result = gitCommit(ctx.gitConfig, call.arguments.message);
        if (result.success) {
          return { success: true, output: `已提交 ${result.hash}${result.pushed ? ' (已 push)' : ''}`, action: 'git' };
        }
        return { success: false, output: '无变更可提交', action: 'git' };
      }

      case 'git_diff': {
        const diff = getDiff(ctx.workspacePath);
        return { success: true, output: diff.slice(0, 5000) || '无未提交变更', action: 'git' };
      }

      case 'git_log': {
        const count = call.arguments.count ?? 10;
        const logs = gitLog(ctx.workspacePath, count);
        return { success: true, output: logs.join('\n') || '无提交记录', action: 'git' };
      }

      case 'github_create_issue': {
        // 异步操作，包装为同步返回 (告知已提交)
        return { success: true, output: `[async] 正在创建 Issue: ${call.arguments.title}`, action: 'github' };
      }

      case 'github_list_issues': {
        return { success: true, output: '[async] 正在查询 Issues...', action: 'github' };
      }

      case 'task_complete': {
        return { success: true, output: `任务完成: ${call.arguments.summary}`, action: 'write' };
      }

      default:
        return { success: false, output: `未知工具: ${call.name}` };
    }
  } catch (err: any) {
    return { success: false, output: `工具执行错误: ${err.message}` };
  }
}

/** 异步工具执行 (GitHub API 等) */
export async function executeToolAsync(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (call.name === 'github_create_issue') {
    const issue = await createIssue(
      ctx.gitConfig,
      call.arguments.title,
      call.arguments.body,
      call.arguments.labels || []
    );
    if (issue) {
      return { success: true, output: `Issue #${issue.number} 已创建: ${issue.html_url}`, action: 'github' };
    }
    return { success: false, output: 'GitHub Issue 创建失败 (可能未配置 GitHub 模式)', action: 'github' };
  }

  if (call.name === 'github_list_issues') {
    const issues = await listIssues(ctx.gitConfig, call.arguments.state || 'open');
    if (issues.length === 0) return { success: true, output: '无 Issues', action: 'github' };
    const list = issues.map(i => `#${i.number} [${i.state}] ${i.title} ${i.labels.join(',')}`).join('\n');
    return { success: true, output: list, action: 'github' };
  }

  // 其余工具走同步
  return executeTool(call, ctx);
}

/** 生成 LLM function-calling 的 tools 参数 (OpenAI 格式) */
export function getToolsForLLM(gitMode: string = 'local'): any[] {
  return TOOL_DEFINITIONS
    .filter(t => {
      // 非 GitHub 模式过滤掉 github 工具
      if (gitMode !== 'github' && t.name.startsWith('github_')) return false;
      return true;
    })
    .map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
}

/** 解析 LLM 返回的 tool_calls */
export function parseToolCalls(message: any): ToolCall[] {
  if (!message?.tool_calls) return [];
  return message.tool_calls.map((tc: any) => ({
    name: tc.function.name,
    arguments: typeof tc.function.arguments === 'string'
      ? JSON.parse(tc.function.arguments)
      : tc.function.arguments,
  }));
}
