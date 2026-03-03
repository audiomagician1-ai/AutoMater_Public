/**
 * Tool Definitions — LLM function-calling schemas
 *
 * Pure data: 所有内置工具的 JSON Schema 定义。
 * 按功能分类拆分，此文件为聚合入口。
 */

export type { ToolDef } from './types';

import { FS_TOOLS } from './fs-tools';
import { SHELL_TOOLS } from './shell-tools';
import { GIT_TOOLS } from './git-tools';
import { MEMORY_TOOLS } from './memory-tools';
import { WEB_TOOLS } from './web-tools';
import { COMPUTER_TOOLS } from './computer-tools';
import { AGENT_TOOLS } from './agent-tools';
import { DEPLOY_TOOLS } from './deploy-tools';
import { ADMIN_TOOLS } from './admin-tools';
import { SESSION_TOOLS } from './session-tools';

export const TOOL_DEFINITIONS = [
  ...FS_TOOLS,
  ...SHELL_TOOLS,
  ...GIT_TOOLS,
  ...MEMORY_TOOLS,
  ...WEB_TOOLS,
  ...COMPUTER_TOOLS,
  ...AGENT_TOOLS,
  ...DEPLOY_TOOLS,
  ...ADMIN_TOOLS,
  ...SESSION_TOOLS,
] as const;

// Re-export category arrays for selective use
export {
  FS_TOOLS,
  SHELL_TOOLS,
  GIT_TOOLS,
  MEMORY_TOOLS,
  WEB_TOOLS,
  COMPUTER_TOOLS,
  AGENT_TOOLS,
  DEPLOY_TOOLS,
  ADMIN_TOOLS,
  SESSION_TOOLS,
};
