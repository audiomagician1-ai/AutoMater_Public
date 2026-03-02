/**
 * Tool Executor — 工具同步/异步执行分发
 *
 * 接收 ToolCall + ToolContext，调用对应的实现模块，返回 ToolResult。
 * 不包含工具定义和权限逻辑（见 tool-registry.ts）。
 *
 * v2.6.0: 从 tool-system.ts 拆出
 * v5.0.0: 支持 MCP + Skill 外部工具代理执行
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createLogger } from './logger';
import { readWorkspaceFile, readDirectoryTree } from './file-writer';
import { commit as gitCommit, getDiff, getLog as gitLog, createIssue, listIssues } from './git-provider';
import { execInSandbox, execInSandboxAsync, isAsyncHandle, registerProcess, getActiveProcess, runTest as sandboxRunTest, runLint as sandboxRunLint, type SandboxConfig } from './sandbox-executor';
import { readMemoryForRole, appendProjectMemory, appendRoleMemory } from './memory-system';
import { webSearch, fetchUrl, httpRequest } from './web-tools';
import { think, todoWrite, todoRead, batchEdit, type TodoItem, type EditOperation } from './extended-tools';
import { takeScreenshot, mouseMove, mouseClick, keyboardType, keyboardHotkey } from './computer-use';
import {
  launchBrowser, closeBrowser, navigate as browserNavigateFn,
  browserScreenshot, browserSnapshot, browserClick, browserType,
  browserEvaluate, browserWait, browserNetwork,
} from './browser-tools';
import {
  analyzeImage, compareScreenshots, visualAssert,
  cacheScreenshot, getCachedScreenshot,
} from './visual-tools';
import type { ToolCall, ToolResult, ToolContext } from './tool-registry';
import { trimToolResult } from './context-collector';

const log = createLogger('tool-executor');

// v6.0: 全局工具输出截断限制
const TOOL_OUTPUT_MAX_TOKENS = 4000;

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

// ═══════════════════════════════════════
// v6.0: 搜索结果智能排序
// ═══════════════════════════════════════

/** 路径权重: 关键路径的匹配更重要 */
const PATH_WEIGHTS: Array<[RegExp, number]> = [
  [/\.(ts|tsx|js|jsx|py|rs|go|java|cpp|c|h)$/i, 1.5],   // 源文件
  [/index\.|main\.|app\.|server\./i, 1.3],                // 入口文件
  [/test|spec|__test__/i, 0.8],                           // 测试文件 (略降)
  [/\.md$/i, 0.6],                                         // 文档
  [/\.json$|\.yaml$|\.yml$/i, 0.7],                       // 配置
  [/node_modules|dist|build|\.min\./i, 0.1],              // 产出/vendor (大幅降权)
];

function getPathWeight(filepath: string): number {
  for (const [re, w] of PATH_WEIGHTS) {
    if (re.test(filepath)) return w;
  }
  return 1.0;
}

/**
 * 对 grep/Select-String 原始输出按文件分组、按匹配密度 × 路径权重排序，
 * 然后只输出 Top N 个最相关文件的匹配。
 */
function rankSearchResults(raw: string, pattern: string, workspacePath: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '无匹配';

  const lines = trimmed.split('\n');

  // Group by file
  const fileMatches = new Map<string, { lines: string[]; matchCount: number }>();

  for (const line of lines) {
    // Windows Select-String: "C:\path\file.ts:123:content" or just file paths
    // Unix grep: "./path/file.ts:123:content"
    const match = line.match(/^(?:\s*>?\s*)?(.+?)[:\(](\d+)/);
    if (!match) continue;

    let filepath = match[1].trim();
    // Normalize path: strip workspacePath prefix for display
    filepath = filepath.replace(workspacePath, '').replace(/^[\\/]+/, '');

    if (!fileMatches.has(filepath)) {
      fileMatches.set(filepath, { lines: [], matchCount: 0 });
    }
    const entry = fileMatches.get(filepath)!;
    entry.lines.push(line.trim());
    // Check if this line is a direct match (not context)
    if (!line.trim().startsWith('>') && line.includes(pattern.replace(/[.*+?^${}()|[\]\\]/g, ''))) {
      entry.matchCount++;
    } else {
      entry.matchCount += 0.5; // context lines count less
    }
  }

  if (fileMatches.size === 0) return trimmed.slice(0, 6000);

  // Score files: matchCount × pathWeight × density
  const scored = [...fileMatches.entries()].map(([filepath, data]) => {
    const pathWeight = getPathWeight(filepath);
    const density = data.matchCount / Math.max(data.lines.length, 1);
    const score = data.matchCount * pathWeight * (1 + density);
    return { filepath, data, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Emit top 15 files
  const output: string[] = [`搜索 "${pattern}" — ${fileMatches.size} 个文件匹配 (按相关性排序):\n`];
  const topN = scored.slice(0, 15);

  for (const { filepath, data, score } of topN) {
    output.push(`\n── ${filepath} (${data.matchCount} 处匹配, score=${score.toFixed(1)}) ──`);
    // Show max 6 lines per file
    const maxLines = Math.min(data.lines.length, 6);
    for (let i = 0; i < maxLines; i++) {
      output.push(data.lines[i]);
    }
    if (data.lines.length > maxLines) {
      output.push(`  ... 和 ${data.lines.length - maxLines} 行更多匹配`);
    }
  }

  if (scored.length > 15) {
    output.push(`\n... 还有 ${scored.length - 15} 个文件有匹配`);
  }

  return output.join('\n');
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

      case 'read_file': {
        const content = readWorkspaceFile(ctx.workspacePath, call.arguments.path);
        if (content === null) return { success: false, output: `文件不存在: ${call.arguments.path}`, action: 'read' };
        const lines = content.split('\n');
        const offset = Math.max(1, call.arguments.offset ?? 1);
        const limit = Math.min(1000, Math.max(1, call.arguments.limit ?? 300));
        const start = offset - 1;
        const end = Math.min(start + limit, lines.length);
        const numbered = lines.slice(start, end)
          .map((line, i) => `${String(start + i + 1).padStart(4)}| ${line}`)
          .join('\n');
        const header = `[${call.arguments.path}] ${lines.length} 行, 显示 ${offset}-${end}`;
        const hasMore = end < lines.length ? `\n... 还有 ${lines.length - end} 行 (用 offset=${end + 1} 继续)` : '';
        return { success: true, output: `${header}\n${numbered}${hasMore}`, action: 'read' };
      }

      case 'write_file': {
        const check = assertSafePath(call.arguments.path);
        if (!check.ok) return { success: false, output: check.error, action: 'write' };
        const absPath = path.join(ctx.workspacePath, check.normalized);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, call.arguments.content, 'utf-8');
        const size = Buffer.byteLength(call.arguments.content, 'utf-8');
        return { success: true, output: `已写入 ${check.normalized} (${size} bytes)`, action: 'write' };
      }

      case 'edit_file': {
        const check = assertSafePath(call.arguments.path);
        if (!check.ok) return { success: false, output: check.error, action: 'edit' };
        const absPath = path.join(ctx.workspacePath, check.normalized);
        if (!fs.existsSync(absPath)) return { success: false, output: `文件不存在: ${call.arguments.path}`, action: 'edit' };
        let content = fs.readFileSync(absPath, 'utf-8');
        const oldStr: string | undefined | null = call.arguments.old_string;
        const newStr: string = call.arguments.new_string;
        if (oldStr === undefined || oldStr === null) {
          return { success: false, output: 'old_string 参数缺失', action: 'edit' };
        }
        if (oldStr === '') {
          content = content + newStr;
          fs.writeFileSync(absPath, content, 'utf-8');
          return { success: true, output: `已追加到 ${check.normalized} (${Buffer.byteLength(newStr, 'utf-8')} bytes added)`, action: 'edit' };
        }
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) {
          const trimmedOld = oldStr.split('\n').map((l: string) => l.trimEnd()).join('\n');
          const trimmedContent = content.split('\n').map((l: string) => l.trimEnd()).join('\n');
          const trimOccurrences = trimmedContent.split(trimmedOld).length - 1;
          if (trimOccurrences === 0) {
            return { success: false, output: `未找到匹配的文本 (0 occurrences)。请确保 old_string 精确匹配文件内容（包含缩进和空白）。`, action: 'edit' };
          }
          const newTrimmedContent = trimmedContent.replace(trimmedOld, newStr);
          fs.writeFileSync(absPath, newTrimmedContent, 'utf-8');
          return { success: true, output: `已编辑 ${check.normalized} (1 处替换, trimmed match)`, action: 'edit' };
        }
        if (occurrences > 1) {
          return { success: false, output: `old_string 匹配了 ${occurrences} 处，需要更精确的上下文使其唯一。`, action: 'edit' };
        }
        content = content.replace(oldStr, newStr);
        fs.writeFileSync(absPath, content, 'utf-8');
        return { success: true, output: `已编辑 ${check.normalized} (1 处替换)`, action: 'edit' };
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

      case 'glob_files': {
        const pattern = call.arguments.pattern;
        try {
          let cmd: string;
          if (process.platform === 'win32') {
            const psPattern = pattern.replace(/\*\*\//g, '').replace(/\*/g, '*');
            cmd = `powershell -NoProfile -Command "Get-ChildItem -Recurse -File -Filter '${psPattern}' | ForEach-Object { $_.FullName.Substring((Get-Location).Path.Length + 1).Replace('\\\\', '/') }"`;
          } else {
            cmd = `find . -type f -name "${pattern.replace(/\*\*\//g, '')}" | head -50`;
          }
          const output = execSync(cmd, { cwd: ctx.workspacePath, encoding: 'utf-8', maxBuffer: 256 * 1024, timeout: 10000 });
          const files = output.trim().split('\n')
            .filter(f => f && !f.includes('node_modules') && !f.includes('.git'))
            .slice(0, 50);
          return { success: true, output: files.length > 0 ? files.join('\n') : '无匹配文件', action: 'search' };
        } catch (err) {
          return { success: true, output: '无匹配文件', action: 'search' };
        }
      }

      case 'search_files': {
        const pattern = call.arguments.pattern;
        const include = call.arguments.include || '*';
        try {
          let cmd: string;
          if (process.platform === 'win32') {
            const escapedPattern = pattern.replace(/'/g, "''");
            const includeFilter = include === '*' ? '' : ` -Include '${include}'`;
            cmd = `powershell -NoProfile -Command "Get-ChildItem -Recurse -File${includeFilter} | Where-Object { $_.FullName -notmatch 'node_modules|.git|dist|__pycache__|.next' } | Select-String -Pattern '${escapedPattern}' -Context 2,2 | Select-Object -First 50 | Out-String -Width 200"`;
          } else {
            cmd = `grep -rn --include="${include}" -C 2 "${pattern.replace(/"/g, '\\"')}" . | grep -v node_modules | head -120`;
          }
          const rawOutput = execSync(cmd, { cwd: ctx.workspacePath, encoding: 'utf-8', maxBuffer: 1024 * 1024, timeout: 20000 });

          // v6.0: 智能排序 — 按匹配密度 + 文件路径权重排序
          const ranked = rankSearchResults(rawOutput, pattern, ctx.workspacePath);
          return { success: true, output: ranked.slice(0, 6000) || '无匹配', action: 'search' };
        } catch (err) {
          return { success: true, output: '无匹配', action: 'search' };
        }
      }

      case 'run_command': {
        const background = call.arguments.background === true;
        const timeoutSec = call.arguments.timeout_seconds;
        const timeoutMs = timeoutSec ? timeoutSec * 1000 : (background ? 1800_000 : 60_000);
        const sandboxCfg: SandboxConfig = { workspacePath: ctx.workspacePath, timeoutMs };

        if (background) {
          // v6.0: 异步后台执行
          const handleOrErr = execInSandboxAsync(call.arguments.command, sandboxCfg);
          if (!isAsyncHandle(handleOrErr)) {
            // 安全检查失败, 返回同步错误
            return { success: false, output: handleOrErr.stderr || '命令被拦截', action: 'shell' };
          }
          const processId = `proc-${Date.now().toString(36)}`;
          registerProcess(processId, handleOrErr);
          return {
            success: true,
            output: `后台进程已启动 (PID: ${handleOrErr.pid}, ID: ${processId})\n命令: ${call.arguments.command}\n超时: ${Math.round(timeoutMs / 1000)}s\n\n使用 run_command 查询状态: {"command": "echo __CHECK_PROCESS__${processId}"}`,
            action: 'shell',
          };
        }

        // 同步执行
        const result = execInSandbox(call.arguments.command, sandboxCfg);
        if (result.success) {
          return { success: true, output: (result.stdout || '(无输出)').slice(0, 8000), action: 'shell' };
        } else if (result.timedOut) {
          return { success: false, output: `命令超时 (${Math.round(result.duration / 1000)}s):\n${result.stderr.slice(0, 2000)}`, action: 'shell' };
        } else {
          return { success: false, output: `命令失败 (exit ${result.exitCode}):\n${result.stderr.slice(0, 3000)}${result.stdout ? '\n--- stdout ---\n' + result.stdout.slice(0, 2000) : ''}`, action: 'shell' };
        }
      }

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

      case 'run_test': {
        const result = sandboxRunTest({ workspacePath: ctx.workspacePath });
        const output = result.stdout + (result.stderr ? '\n[stderr] ' + result.stderr : '');
        return { success: result.success, output: `[run_test] exit=${result.exitCode} duration=${result.duration}ms${result.timedOut ? ' TIMEOUT' : ''}\n${output.slice(0, 8000)}`, action: 'shell' };
      }

      case 'run_lint': {
        const result = sandboxRunLint({ workspacePath: ctx.workspacePath });
        return { success: result.success, output: `[run_lint] exit=${result.exitCode}\n${result.stdout.slice(0, 8000)}`, action: 'shell' };
      }

      case 'memory_read': {
        const mem = readMemoryForRole(ctx.workspacePath, call.arguments.role || 'developer');
        return { success: true, output: mem.combined || '(无记忆)', action: 'read' };
      }

      case 'memory_append': {
        const layer = call.arguments.layer || 'project';
        const role = call.arguments.role || 'developer';
        if (layer === 'role') {
          appendRoleMemory(ctx.workspacePath, role, call.arguments.entry);
          return { success: true, output: `已写入 ${role} 角色记忆: ${call.arguments.entry.slice(0, 100)}`, action: 'write' };
        }
        appendProjectMemory(ctx.workspacePath, call.arguments.entry);
        return { success: true, output: `已写入项目记忆: ${call.arguments.entry.slice(0, 100)}`, action: 'write' };
      }

      case 'git_commit': {
        const result = gitCommit(ctx.gitConfig, call.arguments.message);
        return result.success
          ? { success: true, output: `已提交 ${result.hash}${result.pushed ? ' (已 push)' : ''}`, action: 'git' }
          : { success: false, output: '无变更可提交', action: 'git' };
      }

      case 'git_diff': {
        const diff = getDiff(ctx.workspacePath);
        return { success: true, output: diff.slice(0, 8000) || '无未提交变更', action: 'git' };
      }

      case 'git_log': {
        const logs = gitLog(ctx.workspacePath, call.arguments.count ?? 10);
        return { success: true, output: logs.join('\n') || '无提交记录', action: 'git' };
      }

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
          `> 提出者: ${(call.arguments as any)._agentId || 'agent'}`,
          `> 时间: ${new Date().toISOString()}`,
        ].filter(Boolean).join('\n');

        // 如果有 projectId, 写入 change_requests 表
        if (ctx.projectId) {
          try {
            const { getDb } = require('../db') as typeof import('../db'); // eslint-disable-line @typescript-eslint/no-var-requires
            const db = getDb();
            const rfcId = `rfc-${Date.now().toString(36)}`;
            db.prepare(`INSERT INTO change_requests (id, project_id, description, status, affected_features)
              VALUES (?, ?, ?, 'pending', ?)`).run(
              rfcId, ctx.projectId, rfcDescription,
              JSON.stringify(affectedFeatures),
            );
          } catch (err) {
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
        const todos: TodoItem[] = call.arguments.todos || [];
        const agentId = (call.arguments as any)._agentId || 'default';
        return { success: true, output: todoWrite(agentId, todos), action: 'plan' };
      }

      case 'todo_read': {
        const agentId = (call.arguments as any)._agentId || 'default';
        return { success: true, output: todoRead(agentId), action: 'plan' };
      }

      case 'batch_edit': {
        const edits: EditOperation[] = call.arguments.edits || [];
        if (edits.length === 0) return { success: false, output: '编辑列表为空', action: 'edit' };
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
        } as any;
      }

      case 'mouse_click': {
        const result = mouseClick(call.arguments.x, call.arguments.y, call.arguments.button || 'left', call.arguments.double_click || false);
        return { success: result.success, output: result.success ? `鼠标${call.arguments.double_click ? '双' : ''}点击 (${call.arguments.x}, ${call.arguments.y}) [${call.arguments.button || 'left'}]` : `点击失败: ${result.error}`, action: 'computer' };
      }

      case 'mouse_move': {
        const result = mouseMove(call.arguments.x, call.arguments.y);
        return { success: result.success, output: result.success ? `鼠标移动到 (${call.arguments.x}, ${call.arguments.y})` : `移动失败: ${result.error}`, action: 'computer' };
      }

      case 'keyboard_type': {
        const result = keyboardType(call.arguments.text);
        return { success: result.success, output: result.success ? `已键入 ${call.arguments.text.length} 字符` : `键入失败: ${result.error}`, action: 'computer' };
      }

      case 'keyboard_hotkey': {
        const result = keyboardHotkey(call.arguments.combo);
        return { success: result.success, output: result.success ? `已按下 ${call.arguments.combo}` : `按键失败: ${result.error}`, action: 'computer' };
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
      case 'web_search':
      case 'fetch_url':
      case 'http_request':
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
      case 'analyze_image':
      case 'compare_screenshots':
      case 'visual_assert':
        return { success: true, output: `[async] ${call.name}...`, action: 'computer' };

      default: {
        // MCP / Skill 外部工具 — sync 入口返回 placeholder，实际由 async 路径执行
        if (call.name.startsWith('mcp_') || call.name.startsWith('skill_')) {
          return { success: true, output: `[async] ${call.name}...`, action: 'web' };
        }
        return { success: false, output: `未知工具: ${call.name}` };
      }
    }
  } catch (err: any) {
    return { success: false, output: `工具执行错误: ${err.message}` };
  }
}

// ═══════════════════════════════════════
// Async Tool Execution
// ═══════════════════════════════════════

export async function executeToolAsync(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const result = await executeToolAsyncRaw(call, ctx);
  // v6.0: 全局输出截断
  if (result.output && result.output.length > TOOL_OUTPUT_MAX_TOKENS * 1.5) {
    result.output = trimToolResult(result.output, TOOL_OUTPUT_MAX_TOKENS);
  }
  return result;
}

async function executeToolAsyncRaw(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  // ── GitHub ──
  if (call.name === 'github_create_issue') {
    const issue = await createIssue(ctx.gitConfig, call.arguments.title, call.arguments.body, call.arguments.labels || []);
    return issue
      ? { success: true, output: `Issue #${issue.number} 已创建: ${issue.html_url}`, action: 'github' }
      : { success: false, output: 'GitHub Issue 创建失败 (可能未配置 GitHub 模式)', action: 'github' };
  }

  if (call.name === 'github_list_issues') {
    const issues = await listIssues(ctx.gitConfig, call.arguments.state || 'open');
    if (issues.length === 0) return { success: true, output: '无 Issues', action: 'github' };
    const list = issues.map(i => `#${i.number} [${i.state}] ${i.title} ${i.labels.join(',')}`).join('\n');
    return { success: true, output: list, action: 'github' };
  }

  // ── Web ──
  if (call.name === 'web_search') {
    const result = await webSearch(call.arguments.query, call.arguments.max_results ?? 8);
    return result.success
      ? { success: true, output: result.content.slice(0, 6000), action: 'web' }
      : { success: false, output: `搜索失败: ${result.error}`, action: 'web' };
  }

  if (call.name === 'fetch_url') {
    const result = await fetchUrl(call.arguments.url, call.arguments.max_length ?? 15000);
    return result.success
      ? { success: true, output: result.content, action: 'web' }
      : { success: false, output: `抓取失败: ${result.error}`, action: 'web' };
  }

  if (call.name === 'http_request') {
    const result = await httpRequest({
      url: call.arguments.url,
      method: call.arguments.method,
      headers: call.arguments.headers,
      body: call.arguments.body,
      timeout: call.arguments.timeout,
    });
    const headersSummary = Object.entries(result.headers).slice(0, 10).map(([k, v]) => `${k}: ${v}`).join('\n');
    return { success: result.success, output: `HTTP ${result.status}\n--- Headers ---\n${headersSummary}\n--- Body ---\n${result.body}`.slice(0, 8000), action: 'web' };
  }

  // ── Browser ──
  if (call.name === 'browser_launch') {
    const result = await launchBrowser({ headless: call.arguments.headless });
    return { success: result.success, output: result.success ? '浏览器已启动' : `启动失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_navigate') {
    const result = await browserNavigateFn(call.arguments.url);
    return { success: result.success, output: result.success ? `已导航到: ${result.title}\nURL: ${result.url}` : `导航失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_screenshot') {
    const result = await browserScreenshot(call.arguments.full_page);
    if (result.success) {
      cacheScreenshot('latest', result.base64);
      return { success: true, output: `[browser_screenshot] ${Math.round(result.base64.length / 1024)}KB PNG`, action: 'computer', _imageBase64: result.base64 } as any;
    }
    return { success: false, output: `截图失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_snapshot') {
    const result = await browserSnapshot();
    return { success: result.success, output: result.success ? result.content : `快照失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_click') {
    const result = await browserClick(call.arguments.selector, { button: call.arguments.button });
    return { success: result.success, output: result.success ? `已点击: ${call.arguments.selector}` : `点击失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_type') {
    const result = await browserType(call.arguments.selector, call.arguments.text, { clear: call.arguments.clear });
    return { success: result.success, output: result.success ? `已输入 ${call.arguments.text.length} 字符到 ${call.arguments.selector}` : `输入失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_evaluate') {
    const result = await browserEvaluate(call.arguments.expression);
    return { success: result.success, output: result.success ? result.result : `执行失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_wait') {
    const result = await browserWait({ selector: call.arguments.selector, text: call.arguments.text, timeout: call.arguments.timeout });
    return { success: result.success, output: result.success ? '等待条件已满足' : `等待超时: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_network') {
    const result = await browserNetwork({ urlPattern: call.arguments.url_pattern });
    return { success: result.success, output: result.success ? result.requests : `网络监听失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_close') {
    await closeBrowser();
    return { success: true, output: '浏览器已关闭', action: 'computer' };
  }

  // ── Visual Verification ──
  if (call.name === 'analyze_image') {
    if (!ctx.callVision) return { success: false, output: '视觉分析不可用：未配置 Vision LLM', action: 'computer' };
    const base64 = getCachedScreenshot(call.arguments.image_label || 'latest');
    if (!base64) return { success: false, output: `未找到标签为 "${call.arguments.image_label || 'latest'}" 的截图。请先截图。`, action: 'computer' };
    const result = await analyzeImage(base64, call.arguments.question, ctx.callVision);
    return { success: result.success, output: result.success ? result.analysis : `分析失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'compare_screenshots') {
    if (!ctx.callVision) return { success: false, output: '视觉对比不可用：未配置 Vision LLM', action: 'computer' };
    const beforeBase64 = getCachedScreenshot(call.arguments.before_label);
    const afterBase64 = getCachedScreenshot(call.arguments.after_label || 'latest');
    if (!beforeBase64) return { success: false, output: `未找到 "before" 截图: "${call.arguments.before_label}"`, action: 'computer' };
    if (!afterBase64) return { success: false, output: `未找到 "after" 截图: "${call.arguments.after_label || 'latest'}"`, action: 'computer' };
    const result = await compareScreenshots(beforeBase64, afterBase64, call.arguments.description || '', ctx.callVision);
    return { success: result.success, output: result.success ? `差异分析 (粗略差异: ${result.pixelDiffPercent}%):\n${result.analysis}` : `对比失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'visual_assert') {
    if (!ctx.callVision) return { success: false, output: '视觉断言不可用：未配置 Vision LLM', action: 'computer' };
    const base64 = getCachedScreenshot(call.arguments.image_label || 'latest');
    if (!base64) return { success: false, output: `未找到标签为 "${call.arguments.image_label || 'latest'}" 的截图`, action: 'computer' };
    const result = await visualAssert(base64, call.arguments.assertion, ctx.callVision);
    return { success: result.success, output: result.success ? `视觉断言 ${result.passed ? '✅ PASS' : '❌ FAIL'} (置信度: ${result.confidence}%)\n断言: ${call.arguments.assertion}\n依据: ${result.reasoning}` : `断言失败: ${result.error}`, action: 'computer' };
  }

  // ── MCP 外部工具 ──
  if (call.name.startsWith('mcp_')) {
    return executeMcpTool(call);
  }

  // ── Skill 外部工具 ──
  if (call.name.startsWith('skill_')) {
    return executeSkillTool(call);
  }

  // Fallback to sync
  return executeTool(call, ctx);
}

// ═══════════════════════════════════════
// MCP & Skill Proxy Execution
// ═══════════════════════════════════════

/**
 * 执行 MCP 外部工具。
 *
 * 工具名格式: mcp_{serverId}_{originalName}
 * 通过 mcpManager 路由到正确的服务器连接。
 */
async function executeMcpTool(call: ToolCall): Promise<ToolResult> {
  try {
    const { mcpManager } = await import('./mcp-client');

    // 解析 serverId 和 原始工具名
    // 格式: mcp_{serverId}_{toolName}
    const withoutPrefix = call.name.slice(4); // 去掉 "mcp_"
    const underscoreIdx = withoutPrefix.indexOf('_');
    if (underscoreIdx === -1) {
      return { success: false, output: `Invalid MCP tool name format: ${call.name}` };
    }

    // serverId 可能包含下划线 (mcp_XXXX_YYYY 格式), 需要更智能地解析
    // 策略: 遍历所有已连接服务器，找到匹配的 tool
    const allTools = mcpManager.getAllTools();
    const matchedTool = allTools.find(t => `mcp_${t.serverId}_${t.name}` === call.name);

    if (!matchedTool) {
      return { success: false, output: `MCP tool not found: ${call.name}. Available: ${allTools.map(t => t.name).join(', ')}` };
    }

    const result = await mcpManager.callTool(matchedTool.name, matchedTool.serverId, call.arguments);

    const toolResult: ToolResult = {
      success: result.success,
      output: result.content.slice(0, 10_000),
      action: 'web',
    };

    // 如果包含图片，附加 _imageBase64
    if (result.imageBase64) {
      (toolResult as any)._imageBase64 = result.imageBase64;
    }

    return toolResult;
  } catch (err: any) {
    return { success: false, output: `MCP tool execution error: ${err.message}` };
  }
}

/**
 * 执行 Skill 外部工具。
 *
 * 工具名格式: skill_{originalName}
 * 通过 skillManager 查找并执行。
 */
async function executeSkillTool(call: ToolCall): Promise<ToolResult> {
  try {
    const { skillManager } = await import('./skill-loader');
    const result = await skillManager.executeSkill(call.name, call.arguments);
    return {
      success: result.success,
      output: result.output.slice(0, 10_000),
      action: 'shell',
    };
  } catch (err: any) {
    return { success: false, output: `Skill execution error: ${err.message}` };
  }
}

// ═══════════════════════════════════════
// Skill Evolution Tool Implementations (v5.1)
// ═══════════════════════════════════════

function executeSkillAcquire(call: ToolCall, ctx: ToolContext): ToolResult {
  try {
    const { skillEvolution } = require('./skill-evolution') as typeof import('./skill-evolution'); // eslint-disable-line @typescript-eslint/no-var-requires
    const args = call.arguments;

    if (!args.name || !args.description || !args.trigger || !args.knowledge) {
      return { success: false, output: 'skill_acquire 需要 name, description, trigger, knowledge 参数' };
    }

    const skill = skillEvolution.acquire({
      name: args.name,
      description: args.description,
      trigger: args.trigger,
      tags: args.tags || [],
      knowledge: args.knowledge,
      execution: { type: 'prompt', promptTemplate: args.knowledge },
      source: {
        type: 'agent_acquired',
        projectId: ctx.projectId,
        agentId: (call.arguments as any)._agentId || 'unknown',
        timestamp: new Date().toISOString(),
      },
    });

    return {
      success: true,
      output: `✅ 新技能已习得:\n  ID: ${skill.id}\n  名称: ${skill.name}\n  成熟度: ${skill.maturity}\n  触发: ${skill.trigger}\n  标签: ${skill.tags.join(', ') || '无'}\n\n技能将在匹配的未来任务中自动推荐。使用 ≥3 次且成功率 ≥70% 后自动晋升为 proven。`,
      action: 'write',
    };
  } catch (err: any) {
    return { success: false, output: `技能习得失败: ${err.message}` };
  }
}

function executeSkillSearch(call: ToolCall): ToolResult {
  try {
    const { skillEvolution } = require('./skill-evolution') as typeof import('./skill-evolution'); // eslint-disable-line @typescript-eslint/no-var-requires
    const query = call.arguments.query || '';
    const maxResults = call.arguments.max_results ?? 3;

    const matches = skillEvolution.searchSkills(query, { maxResults });

    if (matches.length === 0) {
      return { success: true, output: `未找到与 "${query}" 相关的技能。你可以在发现可复用模式时用 skill_acquire 习得新技能。`, action: 'read' };
    }

    const sections: string[] = [`找到 ${matches.length} 个相关技能:`];

    for (const match of matches) {
      const knowledge = skillEvolution.loadKnowledge(match.skill.id);
      sections.push([
        `\n### ${match.skill.id}: ${match.skill.name}`,
        `成熟度: ${match.skill.maturity} | 使用: ${match.skill.usedCount}次 | 成功率: ${Math.round(match.skill.successRate * 100)}%`,
        `触发: ${match.skill.trigger}`,
        `匹配: ${match.matchReason} (相关度: ${match.relevance}%)`,
        knowledge ? `\n${knowledge.slice(0, 1500)}` : '',
      ].join('\n'));
    }

    return { success: true, output: sections.join('\n'), action: 'read' };
  } catch (err: any) {
    return { success: false, output: `技能搜索失败: ${err.message}` };
  }
}

function executeSkillImprove(call: ToolCall): ToolResult {
  try {
    const { skillEvolution } = require('./skill-evolution') as typeof import('./skill-evolution'); // eslint-disable-line @typescript-eslint/no-var-requires
    const args = call.arguments;

    if (!args.skill_id || !args.change_note) {
      return { success: false, output: 'skill_improve 需要 skill_id 和 change_note 参数' };
    }

    const skill = skillEvolution.improve(args.skill_id, {
      knowledge: args.knowledge,
      trigger: args.trigger,
      changeNote: args.change_note,
      author: (args as any)._agentId ? `agent:${(args as any)._agentId}` : 'agent:unknown',
    });

    if (!skill) {
      return { success: false, output: `技能 ${args.skill_id} 不存在` };
    }

    return {
      success: true,
      output: `✅ 技能已改进:\n  ID: ${skill.id}\n  名称: ${skill.name}\n  版本: v${skill.version}\n  变更: ${args.change_note}`,
      action: 'write',
    };
  } catch (err: any) {
    return { success: false, output: `技能改进失败: ${err.message}` };
  }
}

function executeSkillRecordUsage(call: ToolCall, ctx: ToolContext): ToolResult {
  try {
    const { skillEvolution } = require('./skill-evolution') as typeof import('./skill-evolution'); // eslint-disable-line @typescript-eslint/no-var-requires
    const args = call.arguments;

    if (!args.skill_id || args.success === undefined) {
      return { success: false, output: 'skill_record_usage 需要 skill_id 和 success 参数' };
    }

    skillEvolution.recordUsage(
      args.skill_id,
      ctx.projectId,
      args.success,
      args.feedback,
      (args as any)._agentId,
    );

    return {
      success: true,
      output: `已记录技能 ${args.skill_id} 使用结果: ${args.success ? '✅ 成功' : '❌ 失败'}${args.feedback ? ` (反馈: ${args.feedback})` : ''}`,
      action: 'write',
    };
  } catch (err: any) {
    return { success: false, output: `记录使用失败: ${err.message}` };
  }
}
