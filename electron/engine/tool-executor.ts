/**
 * Tool Executor — 工具同步/异步执行分发
 *
 * 接收 ToolCall + ToolContext，调用对应的实现模块，返回 ToolResult。
 * 不包含工具定义和权限逻辑（见 tool-registry.ts）。
 *
 * v2.6.0: 从 tool-system.ts 拆出
 * v5.0.0: 支持 MCP + Skill 外部工具代理执行
 * v6.1.0: 构想A — 文件级写锁 (write_file/edit_file/batch_edit)
 */

import fs from 'fs';
import path from 'path';
// execSync removed — v17.1: all shell execution now goes through async sandbox
import { acquireFileLock } from './file-lock';
import { createLogger } from './logger';
import { readDirectoryTree } from './file-writer';
import { codeSearch, formatSearchResult, codeSearchFiles, getRepoMap } from './code-search';
// git-provider, web-tools, browser-tools, visual-tools, deploy-tools, skill-evolution
// → functions used in async handler (tool-handlers-async.ts), not imported here
import { getActiveProcess } from './sandbox-executor';
import { readMemoryForRole, appendProjectMemory, appendRoleMemory } from './memory-system';
import { getDb } from '../db';

import { think, todoWrite, todoRead, batchEdit, type EditOperation } from './extended-tools';
import {
  agentScratchpadWrite,
  agentScratchpadRead,
  todoWritePersist,
  todoReadPersist,
  type TodoItemPersist,
} from './scratchpad';
import { takeScreenshot, mouseMove, mouseClick, keyboardType, keyboardHotkey } from './computer-use';
import { cacheScreenshot } from './visual-tools';
import type { ToolCall, ToolResult, ToolContext } from './tool-registry';
import type { FileTreeNode } from './types';
import { trimToolResult } from './context-collector';
import { configureSearch, getAvailableProviders } from './search-provider';
import { configureImageGen } from './image-gen';

const _log = createLogger('tool-executor');

// v6.0: 全局工具输出截断限制
const TOOL_OUTPUT_MAX_TOKENS = 4000;

// ═══════════════════════════════════════
// v23.0: Meta-Agent 路径安全防护
// ═══════════════════════════════════════

/**
 * 禁止 meta-agent 访问的路径模式。
 * 防止管家通过 read_file/list_files/search_files/code_search 读取
 * git 历史、开发文档、数据库等敏感信息。
 */
const META_AGENT_BLOCKED_PATTERNS = [
  /[\/\\]\.git[\/\\]/i,         // .git/ 目录内容
  /[\/\\]\.git$/i,               // .git 目录本身
  /^\.git[\/\\]/i,               // 相对路径 .git/
  /^\.git$/i,                     // 相对路径 .git
];

/**
 * 检查 meta-agent 是否被禁止访问该路径。
 * 如果用户已手动授权 allowGitAccess，则放行 .git/ 访问。
 * @returns 如果被禁止，返回错误消息；否则返回 null。
 */
export function checkMetaAgentPathBlock(inputPath: string, ctx: ToolContext): string | null {
  if (ctx.role !== 'meta-agent') return null;
  // 用户已手动授权 git 访问 → 放行
  if (ctx.metaAgentAllowGit) return null;
  const normalizedForCheck = path.normalize(inputPath || '').replace(/\\/g, '/');
  for (const pattern of META_AGENT_BLOCKED_PATTERNS) {
    if (pattern.test(inputPath) || pattern.test(normalizedForCheck)) {
      return `安全限制: 管家无权访问 ${inputPath}。请在「管家设置 → 基本设置」中开启「GitHub / Git 访问权限」后重试。`;
    }
  }
  return null;
}

// ═══════════════════════════════════════
// Path Security
// ═══════════════════════════════════════

function assertSafePath(filePath: string): { ok: true; normalized: string } | { ok: false; error: string } {
  const normalized = path.normalize(filePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return { ok: false, error: `路径不安全: ${filePath}` };
  }
  return { ok: true, normalized };
}

/**
 * v16.0: 写操作路径检查 — 支持绝对路径写入（需要 externalWrite 权限）
 */
function assertWritePath(
  filePath: string,
  ctx: ToolContext,
): { ok: true; normalized: string; absPath: string } | { ok: false; error: string } {
  const normalized = path.normalize(filePath);
  if (path.isAbsolute(normalized)) {
    if (!ctx.permissions?.externalWrite) {
      return { ok: false, error: `写入外部路径被拒绝: ${filePath}。请在全景页开启「写外部文件」权限。` };
    }
    return { ok: true, normalized, absPath: normalized };
  }
  if (normalized.startsWith('..')) {
    return { ok: false, error: `路径不安全: ${filePath}` };
  }
  return { ok: true, normalized, absPath: path.join(ctx.workspacePath, normalized) };
}

/**
 * v16.0: 检查是否为绝对路径的只读请求，需要 externalRead 权限
 */
export function checkExternalReadPermission(inputPath: string, ctx: ToolContext): { allowed: boolean; error?: string } {
  const normalized = path.normalize(inputPath || '');
  if (path.isAbsolute(normalized)) {
    if (!ctx.permissions?.externalRead) {
      return { allowed: false, error: `读取外部路径被拒绝: ${inputPath}。请在全景页开启「读外部文件」权限。` };
    }
  }
  return { allowed: true };
}

// ═══════════════════════════════════════
// Synchronous Tool Execution
// ═══════════════════════════════════════

export function executeTool(call: ToolCall, ctx: ToolContext): ToolResult {
  const result = executeToolRaw(call, ctx);
  // v6.0: 全局输出截断 — 防止超长 tool result 浪费上下文窗口
  if (result.output && result.output.length > TOOL_OUTPUT_MAX_TOKENS * 1.5) {
    result.output = trimToolResult(result.output, TOOL_OUTPUT_MAX_TOKENS);
  }
  return result;
}

function executeToolRaw(call: ToolCall, ctx: ToolContext): ToolResult {
  try {
    switch (call.name) {
      // v17.0: read_file → 已迁移到 executeToolAsyncRaw (async 路径)
      // 此处作为 fallback: 若意外走到同步路径, 仍提供基本读取能力
      case 'read_file': {
        const rfInput = call.arguments.path || '';
        // v23.0: meta-agent 路径安全防护
        const rfBlock = checkMetaAgentPathBlock(rfInput, ctx);
        if (rfBlock) return { success: false, output: rfBlock, action: 'read' };
        const rfNorm = path.normalize(rfInput);
        let rfTarget: string;
        if (path.isAbsolute(rfNorm)) {
          const perm = checkExternalReadPermission(rfInput, ctx);
          if (!perm.allowed) return { success: false, output: perm.error ?? 'Permission denied', action: 'read' };
          rfTarget = rfNorm;
        } else {
          if (rfNorm.startsWith('..')) return { success: false, output: `路径不安全: ${rfInput}`, action: 'read' };
          rfTarget = path.join(ctx.workspacePath, rfNorm);
        }
        if (!fs.existsSync(rfTarget) || !fs.statSync(rfTarget).isFile()) {
          return { success: false, output: `文件不存在: ${call.arguments.path}`, action: 'read' };
        }
        try {
          const rfContent = fs.readFileSync(rfTarget, 'utf-8');
          const rfLines = rfContent.split('\n');
          const rfOffset = Math.max(1, call.arguments.offset ?? 1);
          const rfLimit = Math.min(500, Math.max(1, call.arguments.limit ?? ctx.permissions?.readFileLineLimit ?? 200));
          const rfSlice = rfLines.slice(rfOffset - 1, rfOffset - 1 + rfLimit);
          const rfOut = rfSlice.map((l, i) => `${rfOffset + i}| ${l}`).join('\n');
          const rfHasMore = rfOffset - 1 + rfLimit < rfLines.length;
          return {
            success: true,
            output: `[${call.arguments.path}] ${rfLines.length} 行, 显示 ${rfOffset}-${Math.min(rfOffset - 1 + rfLimit, rfLines.length)}\n${rfOut}${rfHasMore ? `\n... 还有更多内容 (用 offset=${rfOffset + rfLimit} 继续)` : ''}`,
            action: 'read',
          };
        } catch (rfErr: unknown) {
          return {
            success: false,
            output: `读取失败: ${rfErr instanceof Error ? rfErr.message : String(rfErr)}`,
            action: 'read',
          };
        }
      }

      case 'write_file': {
        const check = assertWritePath(call.arguments.path, ctx);
        if (!check.ok) return { success: false, output: check.error, action: 'write' };
        // v6.1: 文件级写锁 — 多 Worker 并行时防止互相覆盖
        if (ctx.workerId && ctx.featureId) {
          const lock = acquireFileLock(ctx.workspacePath, check.normalized, ctx.workerId, ctx.featureId);
          if (!lock.acquired) {
            return {
              success: false,
              output: `🔒 文件被锁定: ${check.normalized} 正在被 ${lock.holder?.workerId} (${lock.holder?.featureId}) 修改。请稍后重试或选择其他文件。`,
              action: 'write',
            };
          }
        }
        const absPath = check.absPath;
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, call.arguments.content, 'utf-8');
        const size = Buffer.byteLength(call.arguments.content, 'utf-8');
        return { success: true, output: `已写入 ${check.normalized} (${size} bytes)`, action: 'write' };
      }

      case 'edit_file': {
        const check = assertWritePath(call.arguments.path, ctx);
        if (!check.ok) return { success: false, output: check.error, action: 'edit' };
        // v6.1: 文件级写锁
        if (ctx.workerId && ctx.featureId) {
          const lock = acquireFileLock(ctx.workspacePath, check.normalized, ctx.workerId, ctx.featureId);
          if (!lock.acquired) {
            return {
              success: false,
              output: `🔒 文件被锁定: ${check.normalized} 正在被 ${lock.holder?.workerId} (${lock.holder?.featureId}) 修改。请稍后重试或选择其他文件。`,
              action: 'edit',
            };
          }
        }
        const editAbsPath = check.absPath;
        if (!fs.existsSync(editAbsPath))
          return { success: false, output: `文件不存在: ${call.arguments.path}`, action: 'edit' };
        let content = fs.readFileSync(editAbsPath, 'utf-8');
        const oldStr: string | undefined | null = call.arguments.old_string;
        const newStr: string = call.arguments.new_string;
        if (oldStr === undefined || oldStr === null) {
          return { success: false, output: 'old_string 参数缺失', action: 'edit' };
        }
        if (oldStr === '') {
          content = content + newStr;
          fs.writeFileSync(editAbsPath, content, 'utf-8');
          return {
            success: true,
            output: `已追加到 ${check.normalized} (${Buffer.byteLength(newStr, 'utf-8')} bytes added)`,
            action: 'edit',
          };
        }
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) {
          const trimmedOld = oldStr
            .split('\n')
            .map((l: string) => l.trimEnd())
            .join('\n');
          const trimmedContent = content
            .split('\n')
            .map((l: string) => l.trimEnd())
            .join('\n');
          const trimOccurrences = trimmedContent.split(trimmedOld).length - 1;
          if (trimOccurrences === 0) {
            return {
              success: false,
              output: `未找到匹配的文本 (0 occurrences)。请确保 old_string 精确匹配文件内容（包含缩进和空白）。`,
              action: 'edit',
            };
          }
          const newTrimmedContent = trimmedContent.replace(trimmedOld, newStr);
          fs.writeFileSync(editAbsPath, newTrimmedContent, 'utf-8');
          return { success: true, output: `已编辑 ${check.normalized} (1 处替换, trimmed match)`, action: 'edit' };
        }
        if (occurrences > 1) {
          return {
            success: false,
            output: `old_string 匹配了 ${occurrences} 处，需要更精确的上下文使其唯一。`,
            action: 'edit',
          };
        }
        content = content.replace(oldStr, newStr);
        fs.writeFileSync(editAbsPath, content, 'utf-8');
        return { success: true, output: `已编辑 ${check.normalized} (1 处替换)`, action: 'edit' };
      }

      case 'list_files': {
        const dir = call.arguments.directory || '';
        // v23.0: meta-agent 路径安全防护
        const lfBlock = checkMetaAgentPathBlock(dir, ctx);
        if (lfBlock) return { success: false, output: lfBlock, action: 'read' };
        const maxDepth = call.arguments.max_depth ?? 3;
        const normalizedDir = path.normalize(dir || '.');
        let tree: FileTreeNode[];
        if (path.isAbsolute(normalizedDir)) {
          // v16.0: 绝对路径 — 需要 externalRead 权限
          const perm = checkExternalReadPermission(dir, ctx);
          if (!perm.allowed) return { success: false, output: perm.error ?? 'Permission denied', action: 'read' };
          tree = readDirectoryTree(normalizedDir, '', maxDepth);
        } else {
          tree = readDirectoryTree(ctx.workspacePath, dir, maxDepth);
        }
        const formatTree = (nodes: FileTreeNode[], indent: string = ''): string => {
          return nodes
            .map(n => {
              if (n.type === 'dir') {
                return `${indent}${n.name}/\n${n.children ? formatTree(n.children, indent + '  ') : ''}`;
              }
              return `${indent}${n.name}`;
            })
            .join('\n');
        };
        return { success: true, output: formatTree(tree) || '(空目录)', action: 'read' };
      }

      // v17.1: glob_files 已迁移到 executeToolAsyncRaw (不再阻塞主进程)
      case 'glob_files':
        return { success: false, output: 'glob_files should route to async path', action: 'search' };

      // v17.0: search_files → 升级为 ripgrep + 结构化搜索
      case 'search_files': {
        const searchPattern = call.arguments.pattern;
        const searchInclude = call.arguments.include;
        const includeArr = searchInclude && searchInclude !== '*' ? [searchInclude] : undefined;
        const result = codeSearch(ctx.workspacePath, searchPattern, {
          include: includeArr,
          maxResults: 50,
          context: 2,
        });
        return { success: true, output: formatSearchResult(result) || '无匹配', action: 'search' };
      }

      // v17.0: 新工具 code_search — 高级代码搜索
      case 'code_search': {
        const csPattern = call.arguments.pattern;
        const csInclude = call.arguments.include
          ? Array.isArray(call.arguments.include)
            ? call.arguments.include
            : [call.arguments.include]
          : undefined;
        const csExclude = call.arguments.exclude
          ? Array.isArray(call.arguments.exclude)
            ? call.arguments.exclude
            : [call.arguments.exclude]
          : undefined;
        const csResult = codeSearch(ctx.workspacePath, csPattern, {
          include: csInclude,
          exclude: csExclude,
          maxResults: call.arguments.max_results ?? 50,
          context: call.arguments.context ?? 2,
          caseSensitive: call.arguments.case_sensitive ?? false,
          fixedString: call.arguments.fixed_string ?? false,
          wholeWord: call.arguments.whole_word ?? false,
        });
        return { success: true, output: formatSearchResult(csResult), action: 'search' };
      }

      // v17.0: code_search_files — 文件名 glob 搜索
      case 'code_search_files': {
        const fResult = codeSearchFiles(ctx.workspacePath, call.arguments.pattern, {
          maxResults: call.arguments.max_results ?? 50,
        });
        if (fResult.files.length === 0) return { success: true, output: '无匹配文件', action: 'search' };
        const footer = fResult.truncated ? `\n... [已截断, 还有更多文件]` : '';
        return { success: true, output: fResult.files.join('\n') + footer, action: 'search' };
      }

      // v17.0: repo_map — 代码结构索引
      case 'repo_map': {
        const map = getRepoMap(ctx.workspacePath, {
          maxFiles: call.arguments.max_files ?? 80,
          maxSymbolsPerFile: call.arguments.max_symbols ?? 20,
          maxTotalLines: call.arguments.max_lines ?? 300,
        });
        return { success: true, output: map || '(空项目, 无代码文件)', action: 'read' };
      }

      // v17.1: run_command 已迁移到 executeToolAsyncRaw (不再阻塞主进程)
      case 'run_command':
        return { success: false, output: 'run_command should route to async path', action: 'shell' };

      // v6.0: 查询后台进程状态
      case 'check_process': {
        const procId = call.arguments.process_id;
        const handle = getActiveProcess(procId);
        if (!handle) {
          return { success: false, output: `进程 ${procId} 不存在或已结束`, action: 'read' };
        }
        const stdout = handle.getStdout();
        const stderr = handle.getStderr();
        return {
          success: true,
          output: `进程 ${procId} (PID: ${handle.pid}) 仍在运行\n\n--- stdout (最后2000字符) ---\n${stdout.slice(-2000)}\n${stderr ? '\n--- stderr (最后500字符) ---\n' + stderr.slice(-500) : ''}`,
          action: 'read',
        };
      }

      // v17.1: run_test 已迁移到 executeToolAsyncRaw (不再阻塞主进程)
      case 'run_test':
        return { success: false, output: 'run_test should route to async path', action: 'shell' };

      // v17.1: run_lint 已迁移到 executeToolAsyncRaw (不再阻塞主进程)
      case 'run_lint':
        return { success: false, output: 'run_lint should route to async path', action: 'shell' };

      case 'memory_read': {
        const mem = readMemoryForRole(ctx.workspacePath, call.arguments.role || 'developer');
        return { success: true, output: mem.combined || '(无记忆)', action: 'read' };
      }

      case 'memory_append': {
        const layer = call.arguments.layer || 'project';
        const role = call.arguments.role || 'developer';
        if (layer === 'role') {
          appendRoleMemory(ctx.workspacePath, role, call.arguments.entry);
          return {
            success: true,
            output: `已写入 ${role} 角色记忆: ${call.arguments.entry.slice(0, 100)}`,
            action: 'write',
          };
        }
        appendProjectMemory(ctx.workspacePath, call.arguments.entry);
        return { success: true, output: `已写入项目记忆: ${call.arguments.entry.slice(0, 100)}`, action: 'write' };
      }

      // git_commit / git_diff / git_log → moved to executeToolAsyncRaw (v6.0 async git)
      case 'git_commit':
      case 'git_diff':
      case 'git_log':
      // v14.0: Branch management + remote sync → async
      case 'git_create_branch':
      case 'git_switch_branch':
      case 'git_list_branches':
      case 'git_delete_branch':
      case 'git_pull':
      case 'git_push':
      case 'git_fetch':
        throw new Error(`${call.name} is now async-only; route through executeToolAsync`);

      case 'task_complete':
        return { success: true, output: `任务完成: ${call.arguments.summary}`, action: 'write' };

      case 'think':
        return { success: true, output: think(call.arguments.thought || ''), action: 'think' };

      case 'report_blocked': {
        // 这个工具的"执行"本身只是返回格式化结果 —
        // 真正的阻塞逻辑在 ReAct 循环中处理 (检测到 report_blocked 调用后暂停流水线)
        const reason = call.arguments.reason || '未说明原因';
        const suggestions: string[] = call.arguments.suggestions || [];
        const partial = call.arguments.partial_result || '';
        const output = [
          `🚫 BLOCKED: ${reason}`,
          '',
          '建议的解决方式:',
          ...suggestions.map((s: string, i: number) => `  ${i + 1}. ${s}`),
          partial ? `\n已完成的部分结果:\n${partial}` : '',
        ].join('\n');
        return { success: true, output, action: 'think' };
      }

      case 'rfc_propose': {
        // v5.5: RFC 设计变更提案 — 记录到 change_requests 表 + 通知用户
        const title = call.arguments.title || 'Untitled RFC';
        const problem = call.arguments.problem || '';
        const proposal = call.arguments.proposal || '';
        const impact = call.arguments.impact || 'medium';
        const affectedFeatures: string[] = call.arguments.affected_features || [];

        const rfcDescription = [
          `# RFC: ${title}`,
          '',
          `## 问题`,
          problem,
          '',
          `## 提议方案`,
          proposal,
          '',
          `## 影响范围: ${impact}`,
          affectedFeatures.length > 0 ? `受影响的 Features: ${affectedFeatures.join(', ')}` : '',
          '',
          `> 提出者: ${(call.arguments._agentId as string) || 'agent'}`,
          `> 时间: ${new Date().toISOString()}`,
        ]
          .filter(Boolean)
          .join('\n');

        // 如果有 projectId, 写入 change_requests 表
        if (ctx.projectId) {
          try {
            const db = getDb();
            const rfcId = `rfc-${Date.now().toString(36)}`;
            db.prepare(
              `INSERT INTO change_requests (id, project_id, description, status, affected_features)
              VALUES (?, ?, ?, 'pending', ?)`,
            ).run(rfcId, ctx.projectId, rfcDescription, JSON.stringify(affectedFeatures));
          } catch (_err) {
            // DB write failure is non-fatal
          }
        }

        return {
          success: true,
          output: `📋 RFC 已提交: "${title}" [${impact}]\n\nPM 和用户将审查此提案。你可以继续当前任务，但标记此处为可能需要修改的位置。\n\n${rfcDescription}`,
          action: 'think',
        };
      }

      case 'todo_write': {
        const todos: TodoItemPersist[] = call.arguments.todos || [];
        const agentId = (call.arguments._agentId as string) || 'default';
        // v19.0: 优先持久化到磁盘 scratchpad, fallback 到内存
        if (ctx.workspacePath) {
          return { success: true, output: todoWritePersist(ctx.workspacePath, agentId, todos), action: 'plan' };
        }
        return { success: true, output: todoWrite(agentId, todos as any), action: 'plan' };
      }

      case 'todo_read': {
        const agentId = (call.arguments._agentId as string) || 'default';
        // v19.0: 优先从磁盘 scratchpad 读, fallback 到内存
        if (ctx.workspacePath) {
          return { success: true, output: todoReadPersist(ctx.workspacePath, agentId), action: 'plan' };
        }
        return { success: true, output: todoRead(agentId), action: 'plan' };
      }

      case 'scratchpad_write': {
        const agentId = (call.arguments._agentId as string) || 'default';
        const category = (call.arguments.category as string) || 'key_fact';
        const content = (call.arguments.content as string) || '';
        if (!ctx.workspacePath) {
          return { success: false, output: '无工作区路径，scratchpad 不可用', action: 'think' };
        }
        if (!content) {
          return { success: false, output: '内容不能为空', action: 'think' };
        }
        const result = agentScratchpadWrite(ctx.workspacePath, agentId, category as any, content);
        return { success: true, output: result, action: 'think' };
      }

      case 'scratchpad_read': {
        const agentId = (call.arguments._agentId as string) || 'default';
        if (!ctx.workspacePath) {
          return { success: false, output: '无工作区路径，scratchpad 不可用', action: 'think' };
        }
        const result = agentScratchpadRead(ctx.workspacePath, agentId);
        return { success: true, output: result, action: 'read' };
      }

      case 'batch_edit': {
        const edits: EditOperation[] = call.arguments.edits || [];
        if (edits.length === 0) return { success: false, output: '编辑列表为空', action: 'edit' };
        // v6.1: 文件级写锁
        if (ctx.workerId && ctx.featureId && call.arguments.path) {
          const batchCheck = assertSafePath(call.arguments.path);
          if (batchCheck.ok) {
            const lock = acquireFileLock(ctx.workspacePath, batchCheck.normalized, ctx.workerId, ctx.featureId);
            if (!lock.acquired) {
              return {
                success: false,
                output: `🔒 文件被锁定: ${call.arguments.path} 正在被 ${lock.holder?.workerId} (${lock.holder?.featureId}) 修改。请稍后重试。`,
                action: 'edit',
              };
            }
          }
        }
        const result = batchEdit(ctx.workspacePath, call.arguments.path, edits);
        return { success: result.success, output: result.output, action: 'edit' };
      }

      case 'screenshot': {
        const result = takeScreenshot(call.arguments.scale ?? 0.75);
        if (!result.success) return { success: false, output: `截图失败: ${result.error}`, action: 'computer' };
        if (result.base64) cacheScreenshot('latest', result.base64);
        return {
          success: true,
          output: `[screenshot] ${result.width}x${result.height} PNG (${Math.round(result.base64.length / 1024)}KB base64)`,
          action: 'computer',
          ...(result.base64 ? { _imageBase64: result.base64 } : {}),
        };
      }

      case 'mouse_click': {
        const result = mouseClick(
          call.arguments.x,
          call.arguments.y,
          call.arguments.button || 'left',
          call.arguments.double_click || false,
        );
        return {
          success: result.success,
          output: result.success
            ? `鼠标${call.arguments.double_click ? '双' : ''}点击 (${call.arguments.x}, ${call.arguments.y}) [${call.arguments.button || 'left'}]`
            : `点击失败: ${result.error}`,
          action: 'computer',
        };
      }

      case 'mouse_move': {
        const result = mouseMove(call.arguments.x, call.arguments.y);
        return {
          success: result.success,
          output: result.success
            ? `鼠标移动到 (${call.arguments.x}, ${call.arguments.y})`
            : `移动失败: ${result.error}`,
          action: 'computer',
        };
      }

      case 'keyboard_type': {
        const result = keyboardType(call.arguments.text);
        return {
          success: result.success,
          output: result.success ? `已键入 ${call.arguments.text.length} 字符` : `键入失败: ${result.error}`,
          action: 'computer',
        };
      }

      case 'keyboard_hotkey': {
        const result = keyboardHotkey(call.arguments.combo);
        return {
          success: result.success,
          output: result.success ? `已按下 ${call.arguments.combo}` : `按键失败: ${result.error}`,
          action: 'computer',
        };
      }

      // ── Skill Evolution (v5.1) ──
      case 'skill_acquire': {
        return executeSkillAcquire(call, ctx);
      }
      case 'skill_search': {
        return executeSkillSearch(call);
      }
      case 'skill_improve': {
        return executeSkillImprove(call);
      }
      case 'skill_record_usage': {
        return executeSkillRecordUsage(call, ctx);
      }

      // Async tools — sync entry returns placeholder
      case 'github_create_issue':
      case 'github_list_issues':
      case 'spawn_researcher':
      case 'spawn_agent':
      case 'spawn_parallel':
      case 'web_search':
      case 'web_search_boost':
      case 'deep_research':
      case 'run_blackbox_tests':
      case 'fetch_url':
      case 'http_request':
      case 'download_file': // v19.0
      case 'search_images': // v19.0
      // v17.0: async file operations
      case 'read_many_files':
      case 'code_graph_query':
      case 'browser_launch':
      case 'browser_navigate':
      case 'browser_screenshot':
      case 'browser_snapshot':
      case 'browser_click':
      case 'browser_type':
      case 'browser_evaluate':
      case 'browser_wait':
      case 'browser_network':
      case 'browser_close':
      case 'browser_hover':
      case 'browser_select_option':
      case 'browser_press_key':
      case 'browser_fill_form':
      case 'browser_drag':
      case 'browser_tabs':
      case 'browser_file_upload':
      case 'browser_console':
      case 'analyze_image':
      case 'compare_screenshots':
      case 'visual_assert':
      case 'sandbox_init':
      case 'sandbox_exec':
      case 'sandbox_write':
      case 'sandbox_read':
      case 'sandbox_destroy':
      case 'generate_image':
      case 'edit_image':
      case 'deploy_compose_up':
      case 'deploy_compose_down':
      case 'deploy_health_check':
      case 'deploy_dockerfile':
      // v15.0: Extended deploy tools (I4)
      case 'deploy_compose_generate':
      case 'deploy_dockerfile_generate':
      case 'deploy_pm2_start':
      case 'deploy_pm2_status':
      case 'deploy_nginx_generate':
      case 'deploy_find_port':
      case 'github_close_issue':
      case 'github_add_comment':
      case 'github_get_issue':
      // v14.0: GitHub PR tools
      case 'github_create_pr':
      case 'github_list_prs':
      case 'github_get_pr':
      case 'github_merge_pr':
      // v14.0: Supabase tools
      case 'supabase_status':
      case 'supabase_migration_create':
      case 'supabase_migration_push':
      case 'supabase_db_pull':
      case 'supabase_deploy_function':
      case 'supabase_gen_types':
      case 'supabase_set_secret':
      // v14.0: Cloudflare tools
      case 'cloudflare_deploy_pages':
      case 'cloudflare_deploy_worker':
      case 'cloudflare_set_secret':
      case 'cloudflare_dns_list':
      case 'cloudflare_dns_create':
      case 'cloudflare_status':
        return { success: true, output: `[async] ${call.name}...`, action: 'computer' };

      // Sync-only tools
      case 'list_sub_agents': {
        // Lazy import: sub-agent-framework → tool-executor circular dep
        const { getActiveSubAgents } = require('./sub-agent-framework') as typeof import('./sub-agent-framework');
        const agents = getActiveSubAgents();
        if (agents.length === 0) return { success: true, output: '无活跃子 Agent', action: 'read' };
        const lines = agents.map(a => `${a.id} [${a.preset}] 运行 ${Math.round(a.runningMs / 1000)}s — ${a.task}`);
        return { success: true, output: `活跃子 Agent (${agents.length}):\n${lines.join('\n')}`, action: 'read' };
      }

      case 'cancel_sub_agent': {
        // Lazy import: sub-agent-framework → tool-executor circular dep
        const { cancelSubAgent } = require('./sub-agent-framework') as typeof import('./sub-agent-framework');
        const ok = cancelSubAgent(call.arguments.agent_id);
        return ok
          ? { success: true, output: `已取消子 Agent: ${call.arguments.agent_id}`, action: 'write' }
          : { success: false, output: `子 Agent ${call.arguments.agent_id} 不存在或已完成` };
      }

      // v8.0: 搜索引擎配置 (同步)
      case 'configure_search': {
        configureSearch({
          braveApiKey: call.arguments.brave_api_key,
          searxngUrl: call.arguments.searxng_url,
          tavilyApiKey: call.arguments.tavily_api_key,
          serperApiKey: call.arguments.serper_api_key,
        });
        const available = getAvailableProviders();
        return {
          success: true,
          output: `搜索引擎配置已更新\n可用引擎: [${available.join(', ')}]\n\n提示: 配置 API Key 后搜索质量将大幅提升。Brave (免费2000次/月): https://brave.com/search/api/`,
          action: 'web',
        };
      }

      // v9.0: 图像生成配置 (同步)
      case 'configure_image_gen': {
        configureImageGen({
          provider: call.arguments.provider,
          apiKey: call.arguments.api_key,
          baseUrl: call.arguments.base_url || 'https://api.openai.com',
          model: call.arguments.model,
        });
        return {
          success: true,
          output: `图像生成引擎已配置\nProvider: ${call.arguments.provider}\nModel: ${call.arguments.model || 'default'}\n\n现在可以使用 generate_image 和 edit_image 工具了。`,
          action: 'web',
        };
      }

      default: {
        // MCP / Skill 外部工具 — sync 入口返回 placeholder，实际由 async 路径执行
        if (call.name.startsWith('mcp_') || call.name.startsWith('skill_')) {
          return { success: true, output: `[async] ${call.name}...`, action: 'web' };
        }
        return { success: false, output: `未知工具: ${call.name}` };
      }
    }
  } catch (err: unknown) {
    return { success: false, output: `工具执行错误: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ═══════════════════════════════════════
// Async Tool Execution (→ tool-handlers-async.ts)
// ═══════════════════════════════════════

export { executeMcpTool, executeSkillTool } from './tool-handlers-external';
export {
  executeSkillAcquire,
  executeSkillSearch,
  executeSkillImprove,
  executeSkillRecordUsage,
} from './tool-handlers-external';

import {
  executeSkillAcquire,
  executeSkillSearch,
  executeSkillImprove,
  executeSkillRecordUsage,
} from './tool-handlers-external';
import { executeToolAsyncRaw } from './tool-handlers-async';

export async function executeToolAsync(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const result = await executeToolAsyncRaw(call, ctx);
  // v6.0: 全局输出截断
  if (result.output && result.output.length > TOOL_OUTPUT_MAX_TOKENS * 1.5) {
    result.output = trimToolResult(result.output, TOOL_OUTPUT_MAX_TOKENS);
  }
  return result;
}
