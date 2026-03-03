/**
 * Session / Conversation History tool definitions.
 *
 * v27.0: 让 Agent 可以浏览对话历史记录，了解之前的工作上下文。
 */
import type { ToolDef } from './types';

export const SESSION_TOOLS: ToolDef[] = [
  {
    name: 'list_conversation_sessions',
    description:
      '列出对话历史会话列表。可按项目、Agent 角色过滤，也可查看全部。' +
      '返回每个 Session 的 ID、Agent 角色、创建时间、消息数、token 消耗、状态等摘要信息。' +
      '用于了解之前有哪些对话记录可供参考。',
    parameters: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: '项目 ID（不传则查当前项目）',
        },
        agent_id: {
          type: 'string',
          description: '按 Agent ID 过滤（如 pm、dev-1、qa、meta-agent）。不传则返回所有角色的会话',
        },
        limit: {
          type: 'number',
          description: '返回的最大会话数（默认 30，最大 100）',
          default: 30,
        },
      },
    },
  },
  {
    name: 'read_conversation_history',
    description:
      '读取指定 Session 的完整对话消息历史。包含所有 ReAct 循环的消息（system/user/assistant/tool）、' +
      '思维链、工具调用及其结果。可用于回溯之前的对话过程、了解之前 Agent 做了什么决策。' +
      '⚠️ 对话内容可能很长，建议先用 list_conversation_sessions 定位目标 Session 再读取。',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: '要读取的 Session ID（从 list_conversation_sessions 获取）',
        },
        max_messages: {
          type: 'number',
          description: '最多返回的消息条数（从最新往前取，默认 50，最大 200）。0 = 仅返回元信息不含消息',
          default: 50,
        },
        include_tool_results: {
          type: 'boolean',
          description: '是否包含 tool 角色的消息（工具输出，通常很长）。默认 false 以节省 token',
          default: false,
        },
      },
      required: ['session_id'],
    },
  },
];
