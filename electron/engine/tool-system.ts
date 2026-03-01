/**
 * Tool System — 向后兼容外观 (Backward-Compatible Facade)
 *
 * v2.6.0: 重构为模块化架构:
 *   - tool-registry.ts: 工具定义 + 角色权限 + Schema 格式化
 *   - tool-executor.ts: 同步/异步执行分发
 *   - tool-system.ts (本文件): 纯 re-export，确保现有 import 路径不变
 *
 * 所有消费方继续 `import { ... } from './tool-system'` 即可。
 */

// Re-export everything from the decomposed modules
export {
  // Types
  type ToolDefinition,
  type ToolCall,
  type ToolResult,
  type ToolContext,
  type AgentRole,

  // Definitions & Registry
  TOOL_DEFINITIONS,
  getToolsForRole,
  getToolsForLLM,
  parseToolCalls,
  isAsyncTool,
} from './tool-registry';

export {
  // Execution
  executeTool,
  executeToolAsync,
} from './tool-executor';
