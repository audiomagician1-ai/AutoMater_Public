/**
 * Task, memory, planning & thinking tool definitions.
 */
import type { ToolDef } from './types';

export const MEMORY_TOOLS: ToolDef[] = [
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
        layer: {
          type: 'string',
          enum: ['project', 'role'],
          description: '写入层: project(项目级) 或 role(角色级)',
          default: 'project',
        },
        role: { type: 'string', description: '角色 (仅 layer=role 时需要)', default: 'developer' },
      },
      required: ['entry'],
    },
  },
  {
    name: 'spawn_researcher',
    description:
      '启动一个只读研究子 Agent。子 Agent 可以读取文件、搜索代码、查看目录，但不能修改任何内容。用于在不打断当前工作的情况下调研问题。最多 8 轮工具调用。',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: '要研究的问题，包括足够的背景信息' } },
      required: ['question'],
    },
  },
  {
    name: 'report_blocked',
    description:
      '当你无法获取完成任务所需的关键信息时调用此工具。它会暂停流水线并通知用户。\n使用场景：用户引用了你无法访问的路径/资源、需求描述严重不足无法做出合理分析、存在矛盾需要用户澄清。\n注意：仅在信息缺失会导致输出严重偏离时使用，小的模糊点用 notes 标注即可。',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '阻塞原因：详细描述缺少什么信息' },
        suggestions: {
          type: 'array',
          items: { type: 'string' },
          description: '建议的解决方式（如"请提供 xxx 目录的文件列表"、"请确认使用的技术栈"等）',
        },
        partial_result: { type: 'string', description: '到目前为止能确定的部分结果（如果有的话）' },
      },
      required: ['reason', 'suggestions'],
    },
  },
  {
    name: 'rfc_propose',
    description:
      '提出设计变更请求 (RFC)。当你在实现过程中发现设计文档中的问题、矛盾、或更优方案时使用此工具。RFC 会被记录并通知 PM 和用户审批。\n使用场景：发现架构设计不合理、API 设计有冲突、依赖不兼容、性能瓶颈需要架构调整等。\n注意：不要滥用——只在确实需要修改设计时使用，小的实现细节自行决定即可。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'RFC 标题（简短，<30字）' },
        problem: { type: 'string', description: '当前设计的问题描述' },
        proposal: { type: 'string', description: '建议的变更方案' },
        impact: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: '影响范围：low=单个 feature, medium=多个 feature, high=整体架构',
        },
        affected_features: {
          type: 'array',
          items: { type: 'string' },
          description: '受影响的 Feature ID 列表',
        },
      },
      required: ['title', 'problem', 'proposal', 'impact'],
    },
  },
  {
    name: 'create_wish',
    description:
      '将一项需求/任务派发给项目开发团队执行。管家自身不应亲自编码或深度审查，而应把具体工作交给团队。调用后会自动创建需求并启动开发流水线（PM分析→架构设计→开发→QA→构建）。',
    parameters: {
      type: 'object',
      properties: {
        wish_content: {
          type: 'string',
          description:
            '需求描述 — 清晰、具体、可执行的任务说明。应包含：做什么、为什么、验收标准。不要过长（建议500字以内），团队会自行深入分析。',
        },
      },
      required: ['wish_content'],
    },
  },
  {
    name: 'think',
    description:
      '用于深度思考和推理的工具。写下你的分析、假设、计划，不会产生任何副作用。在面对复杂问题时，先用 think 理清思路再行动。',
    parameters: {
      type: 'object',
      properties: { thought: { type: 'string', description: '你的思考内容（推理过程、分析、计划等）' } },
      required: ['thought'],
    },
  },
  {
    name: 'todo_write',
    description: '创建/更新你的任务清单（全量替换）。用于规划复杂任务的执行步骤、跟踪进度。每次调用传入完整列表。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '任务唯一标识' },
              content: { type: 'string', description: '任务描述' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '状态' },
              priority: { type: 'string', enum: ['high', 'medium', 'low'], description: '优先级' },
            },
            required: ['id', 'content', 'status'],
          },
          description: '完整的任务列表',
        },
      },
      required: ['todos'],
    },
  },
  {
    name: 'todo_read',
    description: '读取你当前的任务清单。用于检查进度、决定下一步行动。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'scratchpad_write',
    description:
      '将关键信息写入持久化工作记忆（不会因上下文压缩而丢失）。当你做出重要决策、发现关键事实、或完成阶段性进度时，务必调用此工具记录。',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['decision', 'progress', 'key_fact'],
          description:
            '记录分类: decision=关键决策(如选择了某框架/改变了某方案), progress=阶段进度(如完成了某模块), key_fact=重要发现(如某API有限制/某文件结构特殊)',
        },
        content: {
          type: 'string',
          description: '要记录的内容。应简洁但完整，包含足够的上下文信息让未来的自己能理解。',
        },
      },
      required: ['category', 'content'],
    },
  },
  {
    name: 'scratchpad_read',
    description:
      '读取你的持久化工作记忆。包含之前记录的关键决策、进度、文件变更、错误记录等。在上下文被压缩后会自动注入，但你也可以主动读取。',
    parameters: { type: 'object', properties: {} },
  },
];
