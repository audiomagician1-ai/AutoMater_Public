/**
 * Sub-Agent — 只读研究子 Agent (spawn_researcher)
 *
 * Developer Agent 在 ReAct 循环中可以 spawn 一个轻量子 agent，
 * 用于调研问题、查询文件、搜索代码等「只读」操作，不写文件。
 *
 * 对标: Claude Code 的 Task 工具 — 子 agent 继承有限上下文，
 * 只做查询/分析，返回结论给父 agent。
 *
 * v1.3.0: 初始实现
 */

import { readWorkspaceFile, readDirectoryTree } from './file-writer';
import { execInSandbox, type SandboxConfig } from './sandbox-executor';
import { readMemoryForRole } from './memory-system';
import { exec } from 'child_process';
import { promisify } from 'util';
import { maskOldToolOutputs } from './scratchpad';

const execAsync = promisify(exec);
import type { ToolContext } from './tool-system';
import type { FileTreeNode, OpenAIFunctionTool, LLMMessage, LLMToolCall } from './types';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface ResearchResult {
  success: boolean;
  /** LLM 生成的研究结论 */
  conclusion: string;
  /** 子 agent 阅读的文件列表 */
  filesRead: string[];
  /** 消耗的 tokens */
  inputTokens: number;
  outputTokens: number;
}

/** 子 agent 可用的只读工具 */
interface MiniTool {
  name: string;
  execute: (args: Record<string, string | number | undefined>, ctx: ToolContext) => string | Promise<string>;
}

// ═══════════════════════════════════════
// Mini Tool Set (read-only)
// ═══════════════════════════════════════

const MINI_TOOLS: MiniTool[] = [
  {
    name: 'read_file',
    execute(args, ctx) {
      const content = readWorkspaceFile(ctx.workspacePath, String(args.path ?? ''));
      if (!content) return `文件不存在: ${args.path}`;
      const lines = content.split('\n');
      const offset = Math.max(1, Number(args.offset ?? 1));
      const limit = Math.min(500, Number(args.limit ?? 200));
      const start = offset - 1;
      const end = Math.min(start + limit, lines.length);
      return lines.slice(start, end)
        .map((l, i) => `${String(start + i + 1).padStart(4)}| ${l}`)
        .join('\n');
    },
  },
  {
    name: 'list_files',
    execute(args, ctx) {
      const tree = readDirectoryTree(ctx.workspacePath, String(args.directory ?? ''), Number(args.max_depth ?? 3));
      const format = (nodes: FileTreeNode[], indent = ''): string => {
        return nodes.map(n => {
          if (n.type === 'dir') return `${indent}${n.name}/\n${n.children ? format(n.children, indent + '  ') : ''}`;
          return `${indent}${n.name}`;
        }).join('\n');
      };
      return format(tree) || '(空目录)';
    },
  },
  {
    name: 'search_files',
    async execute(args, ctx) {
      try {
        const pattern = String(args.pattern || '').replace(/'/g, "''").replace(/\$/g, '`$').replace(/[`(){}|]/g, '`$&');
        const cmd = process.platform === 'win32'
          ? `powershell -NoProfile -Command "Get-ChildItem -Recurse -File | Where-Object { $_.FullName -notmatch 'node_modules|.git|dist' } | Select-String -Pattern '${pattern}' -Context 1,1 | Select-Object -First 15 | Out-String -Width 200"`
          : `grep -rn --include="*" -C 1 "${String(args.pattern || '').replace(/"/g, '\\"')}" . 2>/dev/null | head -40`;
        const { stdout } = await execAsync(cmd, { cwd: ctx.workspacePath, encoding: 'utf-8', timeout: 10000, maxBuffer: 256 * 1024 });
        return stdout.trim().slice(0, 3000) || '无匹配';
      } catch { return '无匹配'; }
    },
  },
  {
    name: 'memory_read',
    execute(args, ctx) {
      const mem = readMemoryForRole(ctx.workspacePath, String(args.role || 'developer'));
      return mem.combined || '(无记忆)';
    },
  },
];

const MINI_TOOL_MAP = new Map(MINI_TOOLS.map(t => [t.name, t]));

const RESEARCHER_TOOLS_FOR_LLM: OpenAIFunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件内容 (带行号)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          offset: { type: 'number', description: '起始行号' },
          limit: { type: 'number', description: '读取行数' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出目录文件',
      parameters: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: '目录路径' },
          max_depth: { type: 'number', description: '最大深度' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '搜索文件内容',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '搜索模式' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: '研究完成，输出最终结论',
      parameters: {
        type: 'object',
        properties: {
          conclusion: { type: 'string', description: '研究结论' },
        },
        required: ['conclusion'],
      },
    },
  },
];

// ═══════════════════════════════════════
// Sub-Agent Execution
// ═══════════════════════════════════════

const RESEARCHER_SYSTEM_PROMPT = `你是一位代码研究助手。你的任务是阅读项目代码并回答问题。

## 规则
- 你只能读取和搜索文件，不能修改任何内容
- ⭐ 先用 search_files 搜索关键词定位目标行号，再用 read_file(offset, limit) 精读目标区域
- 用 list_files 了解结构，但避免无目的地 read_file 整个文件
- 高效完成: 最多 8 轮工具调用，然后必须调用 done 给出结论
- 结论要具体、有引用（提到文件名和行号）

## 可用工具
- search_files: 搜索文件内容 (优先使用!)
- read_file: 读取文件 (带行号，必须用 offset+limit)
- list_files: 列出目录
- done: 完成研究，输出结论`;

/**
 * 执行子 agent 研究任务
 *
 * @param question 研究问题
 * @param ctx 工具上下文 (workspacePath, projectId, gitConfig)
 * @param callLLMWithTools 父 agent 的 LLM 调用函数 (注入依赖)
 * @param model 使用的模型
 * @param signal AbortSignal
 * @returns 研究结果
 */
export async function runResearcher(
  question: string,
  ctx: ToolContext,
  callLLMFn: (
    messages: Array<{ role: string; content: string | null | Array<Record<string, unknown>> }>,
    tools: OpenAIFunctionTool[],
  ) => Promise<{ message: LLMMessage; inputTokens: number; outputTokens: number }>,
  signal?: AbortSignal,
): Promise<ResearchResult> {
  const MAX_ITERATIONS = 8;
  const filesRead: string[] = [];
  let totalIn = 0;
  let totalOut = 0;

  const messages: Array<{ role: string; content: string | null | Array<Record<string, unknown>>; tool_calls?: LLMToolCall[]; tool_call_id?: string }> = [
    { role: 'system', content: RESEARCHER_SYSTEM_PROMPT },
    { role: 'user', content: `请研究以下问题:\n\n${question}` },
  ];

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (signal?.aborted) break;

    try {
      const result = await callLLMFn(messages, RESEARCHER_TOOLS_FOR_LLM as OpenAIFunctionTool[]);
      totalIn += result.inputTokens;
      totalOut += result.outputTokens;

      const msg = result.message;

      // 无 tool calls → 结束
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return {
          success: true,
          conclusion: (typeof msg.content === 'string' ? msg.content : '') || '未能得出结论',
          filesRead,
          inputTokens: totalIn,
          outputTokens: totalOut,
        };
      }

      messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });

      for (const tc of msg.tool_calls) {
        let toolArgs: Record<string, unknown>;
        try {
          toolArgs = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
        } catch { toolArgs = {}; }

        // done 工具 → 结束
        if (tc.function.name === 'done') {
          return {
            success: true,
            conclusion: String(toolArgs.conclusion || '研究完成'),
            filesRead,
            inputTokens: totalIn,
            outputTokens: totalOut,
          };
        }

        // 执行只读工具
        const tool = MINI_TOOL_MAP.get(tc.function.name);
        let output = '未知工具';
        if (tool) {
          try {
            output = await Promise.resolve(tool.execute(toolArgs as Record<string, string | number | undefined>, ctx));
            if (tc.function.name === 'read_file' && toolArgs.path) {
              filesRead.push(String(toolArgs.path));
            }
          } catch (err: unknown) {
            output = `工具执行错误: ${(err instanceof Error ? err.message : String(err))}`;
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: output.slice(0, 3000),
        });
      }

      // v19.0: Observation Masking — 子 Agent 每 3 轮清理旧 tool 输出
      if ((iter + 1) % 3 === 0 && messages.length > 10) {
        maskOldToolOutputs(messages, 4);
      }
    } catch (err: unknown) {
      if (signal?.aborted) break;
      return {
        success: false,
        conclusion: `研究中断: ${(err instanceof Error ? err.message : String(err))}`,
        filesRead,
        inputTokens: totalIn,
        outputTokens: totalOut,
      };
    }
  }

  return {
    success: true,
    conclusion: '达到最大迭代次数，请参考已收集的信息',
    filesRead,
    inputTokens: totalIn,
    outputTokens: totalOut,
  };
}
