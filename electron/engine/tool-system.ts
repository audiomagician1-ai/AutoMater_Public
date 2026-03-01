/**
 * Tool System — Agent 工具注册表与执行器
 * 
 * v0.8: 初始工具集 (file/search/shell/git/github)
 * v1.0: edit_file (str_replace), read_file 带行号+分页, search_files 带上下文,
 *       glob_files, 改进 ACI 设计 (参考 Claude Code / SWE-agent)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { readWorkspaceFile, readDirectoryTree } from './file-writer';
import { commit as gitCommit, getDiff, getLog as gitLog, createIssue, listIssues, type GitProviderConfig } from './git-provider';
import { execInSandbox, runTest as sandboxRunTest, runLint as sandboxRunLint, type SandboxConfig } from './sandbox-executor';
import { readMemoryForRole, appendProjectMemory, appendRoleMemory } from './memory-system';

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
  action?: 'read' | 'write' | 'edit' | 'search' | 'shell' | 'git' | 'github';
}

/** 工具执行上下文 */
export interface ToolContext {
  workspacePath: string;
  projectId: string;
  gitConfig: GitProviderConfig;
}

// ═══════════════════════════════════════
// Tool Definitions (给 LLM 看的 schema)
// v1.0: 16 个工具 (新增 edit_file, glob_files; 增强 read_file, search_files)
// ═══════════════════════════════════════

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: '读取工作区中指定文件的内容，返回带行号的文本。支持分页读取大文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作区的文件路径' },
        offset: { type: 'number', description: '起始行号 (从1开始)，默认1' },
        limit: { type: 'number', description: '读取行数，默认300，最大1000' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '创建新文件或完全覆盖已有文件。自动创建目录。仅用于创建新文件，修改已有文件请用 edit_file。',
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
    name: 'edit_file',
    description: '对已有文件进行精确的文本替换编辑。使用 old_string/new_string 模式，只修改需要改的部分，无需重写整个文件。如果 old_string 为空则追加到文件末尾。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作区的文件路径' },
        old_string: { type: 'string', description: '要被替换的原始文本（必须精确匹配，包含缩进）。为空则追加到文件末尾。' },
        new_string: { type: 'string', description: '替换后的新文本' },
      },
      required: ['path', 'old_string', 'new_string'],
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
    name: 'glob_files',
    description: '按 glob 模式查找文件路径。例如 "**/*.ts" 查找所有 TypeScript 文件。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob 模式，如 "src/**/*.ts", "*.json", "**/*test*"' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'search_files',
    description: '在工作区文件中搜索文本模式。返回匹配行及前后各2行上下文。',
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
    description: '在工作区中执行 shell 命令。用于安装依赖(npm install)、运行测试、编译检查等。超时60秒。',
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
    parameters: { type: 'object', properties: {} },
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
  // ── v1.2: Sandbox 工具 ──
  {
    name: 'run_test',
    description: '在沙箱中运行项目测试 (自动检测 npm test/pytest/cargo test/go test)。超时 180 秒。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'run_lint',
    description: '在沙箱中运行 lint 和类型检查 (自动检测 tsc/eslint/py_compile)。超时 60 秒。',
    parameters: { type: 'object', properties: {} },
  },
  // ── v1.2: 记忆工具 ──
  {
    name: 'memory_read',
    description: '读取 Agent 记忆 (全局 + 项目 + 角色)。用于回忆之前的经验和约定。',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: '角色 (developer/qa/architect/pm)，默认 developer', default: 'developer' },
      },
    },
  },
  {
    name: 'memory_append',
    description: '向项目记忆追加一条经验/约定。用于记录重要发现、踩坑记录、架构决策。',
    parameters: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: '要记录的经验条目 (简短清晰)' },
        layer: { type: 'string', enum: ['project', 'role'], description: '写入层: project(项目级) 或 role(角色级)', default: 'project' },
        role: { type: 'string', description: '角色 (仅 layer=role 时需要)', default: 'developer' },
      },
      required: ['entry'],
    },
  },
  // ── v1.3: Sub-agent 工具 ──
  {
    name: 'spawn_researcher',
    description: '启动一个只读研究子 Agent。子 Agent 可以读取文件、搜索代码、查看目录，但不能修改任何内容。用于在不打断当前工作的情况下调研问题。最多 8 轮工具调用。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要研究的问题，包括足够的背景信息' },
      },
      required: ['question'],
    },
  },
];

// ═══════════════════════════════════════
// Tool Executor
// ═══════════════════════════════════════

export function executeTool(call: ToolCall, ctx: ToolContext): ToolResult {
  try {
    switch (call.name) {

      // ── read_file: 带行号 + 分页 ──
      case 'read_file': {
        const filePath = call.arguments.path;
        const content = readWorkspaceFile(ctx.workspacePath, filePath);
        if (content === null) return { success: false, output: `文件不存在: ${filePath}`, action: 'read' };

        const lines = content.split('\n');
        const offset = Math.max(1, call.arguments.offset ?? 1);
        const limit = Math.min(1000, Math.max(1, call.arguments.limit ?? 300));
        const start = offset - 1;
        const end = Math.min(start + limit, lines.length);

        const numbered = lines.slice(start, end)
          .map((line, i) => `${String(start + i + 1).padStart(4)}| ${line}`)
          .join('\n');

        const header = `[${filePath}] ${lines.length} 行, 显示 ${offset}-${end}`;
        const hasMore = end < lines.length ? `\n... 还有 ${lines.length - end} 行 (用 offset=${end + 1} 继续)` : '';
        return { success: true, output: `${header}\n${numbered}${hasMore}`, action: 'read' };
      }

      // ── write_file: 创建/覆盖 ──
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

      // ── edit_file: str_replace 精确编辑 (v1.0 核心新增) ──
      case 'edit_file': {
        const filePath = call.arguments.path;
        const oldStr = call.arguments.old_string;
        const newStr = call.arguments.new_string;
        const normalized = path.normalize(filePath);
        if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
          return { success: false, output: `路径不安全: ${filePath}`, action: 'edit' };
        }
        const absPath = path.join(ctx.workspacePath, normalized);
        if (!fs.existsSync(absPath)) {
          return { success: false, output: `文件不存在: ${filePath}`, action: 'edit' };
        }
        let content = fs.readFileSync(absPath, 'utf-8');

        if (!oldStr && oldStr !== '') {
          return { success: false, output: 'old_string 参数缺失', action: 'edit' };
        }

        if (oldStr === '') {
          // 追加模式
          content = content + newStr;
          fs.writeFileSync(absPath, content, 'utf-8');
          return { success: true, output: `已追加到 ${normalized} (${Buffer.byteLength(newStr, 'utf-8')} bytes added)`, action: 'edit' };
        }

        // 精确匹配替换
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) {
          // 尝试忽略行尾空白匹配
          const trimmedOld = oldStr.split('\n').map((l: string) => l.trimEnd()).join('\n');
          const trimmedContent = content.split('\n').map((l: string) => l.trimEnd()).join('\n');
          const trimOccurrences = trimmedContent.split(trimmedOld).length - 1;
          if (trimOccurrences === 0) {
            return { success: false, output: `未找到匹配的文本 (0 occurrences)。请确保 old_string 精确匹配文件内容（包含缩进和空白）。`, action: 'edit' };
          }
          // 用 trimmed 版本替换
          const newTrimmedContent = trimmedContent.replace(trimmedOld, newStr);
          fs.writeFileSync(absPath, newTrimmedContent, 'utf-8');
          return { success: true, output: `已编辑 ${normalized} (1 处替换, trimmed match)`, action: 'edit' };
        }
        if (occurrences > 1) {
          return { success: false, output: `old_string 匹配了 ${occurrences} 处，需要更精确的上下文使其唯一。`, action: 'edit' };
        }

        content = content.replace(oldStr, newStr);
        fs.writeFileSync(absPath, content, 'utf-8');
        return { success: true, output: `已编辑 ${normalized} (1 处替换)`, action: 'edit' };
      }

      // ── list_files ──
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

      // ── glob_files: 按模式查找文件 (v1.0 新增) ──
      case 'glob_files': {
        const pattern = call.arguments.pattern;
        try {
          // 使用 PowerShell/bash 实现简单 glob
          let cmd: string;
          if (process.platform === 'win32') {
            // PowerShell: Get-ChildItem -Recurse with filter
            const psPattern = pattern.replace(/\*\*\//g, '').replace(/\*/g, '*');
            cmd = `powershell -NoProfile -Command "Get-ChildItem -Recurse -File -Filter '${psPattern}' | ForEach-Object { $_.FullName.Substring((Get-Location).Path.Length + 1).Replace('\\\\', '/') }"`;
          } else {
            cmd = `find . -type f -name "${pattern.replace(/\*\*\//g, '')}" | head -50`;
          }
          const output = execSync(cmd, {
            cwd: ctx.workspacePath,
            encoding: 'utf-8',
            maxBuffer: 256 * 1024,
            timeout: 10000,
          });
          const files = output.trim().split('\n')
            .filter(f => f && !f.includes('node_modules') && !f.includes('.git'))
            .slice(0, 50);
          return { success: true, output: files.length > 0 ? files.join('\n') : '无匹配文件', action: 'search' };
        } catch {
          return { success: true, output: '无匹配文件', action: 'search' };
        }
      }

      // ── search_files: 带上下文行 ──
      case 'search_files': {
        const pattern = call.arguments.pattern;
        const include = call.arguments.include || '*';
        try {
          let cmd: string;
          if (process.platform === 'win32') {
            // PowerShell Select-String with context
            const escapedPattern = pattern.replace(/'/g, "''");
            const includeFilter = include === '*' ? '' : ` -Include '${include}'`;
            cmd = `powershell -NoProfile -Command "Get-ChildItem -Recurse -File${includeFilter} | Where-Object { $_.FullName -notmatch 'node_modules|.git|dist' } | Select-String -Pattern '${escapedPattern}' -Context 2,2 | Select-Object -First 25 | Out-String -Width 200"`;
          } else {
            cmd = `grep -rn --include="${include}" -C 2 "${pattern.replace(/"/g, '\\"')}" . | head -80`;
          }
          const output = execSync(cmd, {
            cwd: ctx.workspacePath,
            encoding: 'utf-8',
            maxBuffer: 512 * 1024,
            timeout: 15000,
          });
          return { success: true, output: output.trim().slice(0, 5000) || '无匹配', action: 'search' };
        } catch {
          return { success: true, output: '无匹配', action: 'search' };
        }
      }

      // ── run_command (v1.2: 通过 sandbox executor 执行) ──
      case 'run_command': {
        const command = call.arguments.command;
        const sandboxCfg: SandboxConfig = { workspacePath: ctx.workspacePath, timeoutMs: 60_000 };
        const result = execInSandbox(command, sandboxCfg);
        if (result.success) {
          return { success: true, output: (result.stdout || '(无输出)').slice(0, 8000), action: 'shell' };
        } else if (result.timedOut) {
          return { success: false, output: `命令超时 (${Math.round(result.duration / 1000)}s):\n${result.stderr.slice(0, 2000)}`, action: 'shell' };
        } else {
          return { success: false, output: `命令失败 (exit ${result.exitCode}):\n${result.stderr.slice(0, 3000)}${result.stdout ? '\n--- stdout ---\n' + result.stdout.slice(0, 2000) : ''}`, action: 'shell' };
        }
      }

      // ── run_test (v1.2) ──
      case 'run_test': {
        const sandboxCfg: SandboxConfig = { workspacePath: ctx.workspacePath };
        const result = sandboxRunTest(sandboxCfg);
        const output = result.stdout + (result.stderr ? '\n[stderr] ' + result.stderr : '');
        return {
          success: result.success,
          output: `[run_test] exit=${result.exitCode} duration=${result.duration}ms${result.timedOut ? ' TIMEOUT' : ''}\n${output.slice(0, 8000)}`,
          action: 'shell',
        };
      }

      // ── run_lint (v1.2) ──
      case 'run_lint': {
        const sandboxCfg: SandboxConfig = { workspacePath: ctx.workspacePath };
        const result = sandboxRunLint(sandboxCfg);
        return {
          success: result.success,
          output: `[run_lint] exit=${result.exitCode}\n${result.stdout.slice(0, 8000)}`,
          action: 'shell',
        };
      }

      // ── memory_read (v1.2) ──
      case 'memory_read': {
        const role = call.arguments.role || 'developer';
        const mem = readMemoryForRole(ctx.workspacePath, role);
        return { success: true, output: mem.combined || '(无记忆)', action: 'read' };
      }

      // ── memory_append (v1.2) ──
      case 'memory_append': {
        const entry = call.arguments.entry;
        const layer = call.arguments.layer || 'project';
        const role = call.arguments.role || 'developer';
        if (layer === 'role') {
          appendRoleMemory(ctx.workspacePath, role, entry);
          return { success: true, output: `已写入 ${role} 角色记忆: ${entry.slice(0, 100)}`, action: 'write' };
        } else {
          appendProjectMemory(ctx.workspacePath, entry);
          return { success: true, output: `已写入项目记忆: ${entry.slice(0, 100)}`, action: 'write' };
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
        return { success: true, output: diff.slice(0, 8000) || '无未提交变更', action: 'git' };
      }

      case 'git_log': {
        const count = call.arguments.count ?? 10;
        const logs = gitLog(ctx.workspacePath, count);
        return { success: true, output: logs.join('\n') || '无提交记录', action: 'git' };
      }

      case 'github_create_issue': {
        return { success: true, output: `[async] 正在创建 Issue: ${call.arguments.title}`, action: 'github' };
      }

      case 'github_list_issues': {
        return { success: true, output: '[async] 正在查询 Issues...', action: 'github' };
      }

      case 'task_complete': {
        return { success: true, output: `任务完成: ${call.arguments.summary}`, action: 'write' };
      }

      // spawn_researcher 是异步工具，同步入口返回提示
      case 'spawn_researcher': {
        return { success: true, output: '[async] 正在启动研究子 Agent...', action: 'read' };
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
