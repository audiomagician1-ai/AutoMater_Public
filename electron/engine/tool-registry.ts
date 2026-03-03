/**
 * Tool Registry — 工具注册中心 (hub)
 *
 * 类型定义 + Schema格式化 + 角色过滤。
 * v18.1: 拆分 → tool-definitions.ts (1470行数据) + tool-permissions.ts (170行权限)
 */

import type { OpenAIFunctionTool } from './types';
import { TOOL_DEFINITIONS } from './tool-definitions';
import { type AgentRole, ROLE_TOOLS } from './tool-permissions';
import { safeParseToolArgs } from './safe-json';

// Re-export for backward compatibility
export { TOOL_DEFINITIONS } from './tool-definitions';
export { type AgentRole, ROLE_TOOLS } from './tool-permissions';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema — accepted: arbitrary JSON Schema
}

export interface ToolCall {
  name: string;
  arguments: Record<string, any>; // accepted: LLM-parsed JSON args
}

export interface ToolResult {
  success: boolean;
  output: string;
  /** 操作类型 (用于 UI 展示) */
  action?:
    | 'read'
    | 'write'
    | 'edit'
    | 'search'
    | 'shell'
    | 'git'
    | 'github'
    | 'web'
    | 'think'
    | 'plan'
    | 'computer'
    | 'complete'
    | 'blocked';
  /** 附带图片 Base64 (截图/浏览器截图等) */
  _imageBase64?: string;
}

/** v16.0: 项目级 Agent 权限开关 */
export interface AgentPermissions {
  /** 允许读取沙箱外（绝对路径）文件/目录 */
  externalRead?: boolean;
  /** 允许写入沙箱外（绝对路径）文件 */
  externalWrite?: boolean;
  /** 允许执行 shell 命令（run_command / sandbox_exec） */
  shellExec?: boolean;
  /** Agent 单次 read_file 默认行数限制 (默认300, 最大2000) */
  readFileLineLimit?: number;
}

/** 工具执行上下文 (由 orchestrator 注入) */
export interface ToolContext {
  workspacePath: string;
  projectId: string;
  gitConfig: import('./git-provider').GitProviderConfig;
  /** Vision LLM 回调 (用于视觉验证工具) */
  callVision?: import('./visual-tools').VisionCallback;
  /** 当前 Worker ID — 用于文件级写锁 (构想A) */
  workerId?: string;
  /** 当前 Feature ID — 用于文件级写锁 (构想A) */
  featureId?: string;
  /** v16.0: 项目级权限开关 */
  permissions?: AgentPermissions;
  /** v23.0: 当前调用角色 — 用于 meta-agent 路径安全防护 */
  role?: import('./tool-permissions').AgentRole;
}

// ═══════════════════════════════════════
// Formatting & Filtering
// ═══════════════════════════════════════

/** 将 ToolDefinition 转为 OpenAI function-calling 格式 */
function toOpenAITool(def: ToolDefinition): OpenAIFunctionTool {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    },
  };
}

/**
 * 按角色返回工具列表 (OpenAI function-calling 格式)
 *
 * 合并三个来源:
 *   1. 内置工具 (TOOL_DEFINITIONS 中角色白名单内的)
 *   2. MCP 服务器发现的工具 (按 allowedRoles 过滤)
 *   3. Skill 目录加载的工具 (按 allowedRoles 过滤)
 *
 * @param role - Agent 角色
 * @param gitMode - git 模式 ('local' | 'github')
 */
export function getToolsForRole(role: AgentRole, gitMode: string = 'local'): OpenAIFunctionTool[] {
  const allowed = new Set(ROLE_TOOLS[role] || ROLE_TOOLS.developer);

  if (gitMode !== 'github') {
    // 非 GitHub 模式下移除所有 GitHub API 工具
    for (const name of [...allowed]) {
      if (name.startsWith('github_')) allowed.delete(name);
    }
    // 远程 sync 工具也需要 remote，移除
    allowed.delete('git_pull');
    allowed.delete('git_push');
    allowed.delete('git_fetch');
  }

  // 1. 内置工具
  const builtinTools = TOOL_DEFINITIONS.filter(t => allowed.has(t.name)).map(toOpenAITool);

  // 2. MCP 工具 (延迟导入避免循环依赖)
  const mcpTools = getExternalMcpTools(role);

  // 3. Skill 工具 (延迟导入避免循环依赖)
  const skillTools = getExternalSkillTools(role);

  return [...builtinTools, ...mcpTools, ...skillTools] as OpenAIFunctionTool[];
}

/** 返回所有工具 (OpenAI format)，可选按 gitMode 过滤 GitHub 工具 */
export function getToolsForLLM(gitMode: string = 'local'): OpenAIFunctionTool[] {
  const builtinTools = TOOL_DEFINITIONS.filter(t => {
    if (gitMode !== 'github' && t.name.startsWith('github_')) return false;
    return true;
  }).map(toOpenAITool);

  const mcpTools = getExternalMcpTools();
  const skillTools = getExternalSkillTools();

  return [...builtinTools, ...mcpTools, ...skillTools] as OpenAIFunctionTool[];
}
/**
 * 从 MCP Manager 获取外部工具 (OpenAI format)。
 * 使用延迟 require 避免模块初始化时的循环依赖。
 */
function getExternalMcpTools(_role?: string): OpenAIFunctionTool[] {
  try {
    // Lazy import to avoid circular dependency

    const { mcpManager } = require('./mcp-client') as typeof import('./mcp-client');
    const allTools = mcpManager.getAllTools();

    return allTools.map(t =>
      toOpenAITool({
        name: `mcp_${t.serverId}_${t.name}`,
        description: `[MCP] ${t.description}`,
        parameters: t.inputSchema,
      }),
    );
  } catch {
    /* silent: MCP tools load failed */
    return [];
  }
}

/**
 * 从 Skill Manager 获取外部工具 (OpenAI format)。
 */
function getExternalSkillTools(role?: string): OpenAIFunctionTool[] {
  try {
    // Lazy import to avoid circular dependency

    const { skillManager } = require('./skill-loader') as typeof import('./skill-loader');
    const defs = role ? skillManager.getDefinitionsForRole(role) : skillManager.getAllDefinitions();
    return defs.map(toOpenAITool);
  } catch {
    /* silent: skill definitions load failed */
    return [];
  }
}

/** 解析 LLM 返回的 tool_calls (OpenAI 格式 → ToolCall[]) */
export function parseToolCalls(message: {
  tool_calls?: Array<{ function: { name: string; arguments: string | Record<string, unknown> } }>;
}): ToolCall[] {
  if (!message?.tool_calls) return [];
  return message.tool_calls.map(tc => ({
    name: tc.function.name,
    arguments:
      typeof tc.function.arguments === 'string' ? safeParseToolArgs(tc.function.arguments) : tc.function.arguments,
  }));
}

/** 判断一个工具是否需要异步执行 */
export function isAsyncTool(toolName: string): boolean {
  // MCP 和 Skill 工具始终异步执行
  if (toolName.startsWith('mcp_') || toolName.startsWith('skill_')) return true;

  return (
    toolName.startsWith('github_') ||
    toolName.startsWith('browser_') ||
    toolName.startsWith('sandbox_') ||
    toolName.startsWith('git_') ||
    toolName.startsWith('deploy_') ||
    toolName.startsWith('supabase_') ||
    toolName.startsWith('cloudflare_') ||
    [
      'web_search',
      'fetch_url',
      'http_request',
      'web_search_boost',
      'deep_research',
      'run_blackbox_tests',
      'analyze_image',
      'compare_screenshots',
      'visual_assert',
      'spawn_agent',
      'spawn_parallel',
      'spawn_researcher',
      'read_file',
      'read_many_files',
      'code_graph_query', // v17.0: async file ops
      'generate_image',
      'edit_image',
      'glob_files',
      'run_command',
      'run_test',
      'run_lint', // v17.1: execSync → async migration
      'wait_for_process', // v19.0: 阻塞等待后台进程完成
      'search_files',
      'code_search', // v17.1: codeSearch fallback async
      'download_file',
      'search_images', // v19.0
    ].includes(toolName)
  );
}
