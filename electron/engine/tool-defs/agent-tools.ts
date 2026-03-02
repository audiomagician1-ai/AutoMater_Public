/**
 * Skill evolution, sub-agent & Docker sandbox tool definitions.
 */
import type { ToolDef } from './types';

export const AGENT_TOOLS: ToolDef[] = [
  // ── Skill Evolution ──
  {
    name: 'skill_acquire',
    description:
      '习得新技能：当你发现一个可复用的多步骤模式/流程时，用此工具将其提炼为技能。技能会跨项目共享，帮助未来的任务。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名称（简短，<20字）' },
        description: { type: 'string', description: '技能描述（<50字）' },
        trigger: { type: 'string', description: '触发条件描述（什么场景下应使用此技能，<30字）' },
        tags: { type: 'array', items: { type: 'string' }, description: '分类标签（如 ["typescript","testing"]）' },
        knowledge: {
          type: 'string',
          description: '详细步骤说明（Markdown 格式，200-500字，包含具体的操作步骤和注意事项）',
        },
      },
      required: ['name', 'description', 'trigger', 'knowledge'],
    },
  },
  {
    name: 'skill_search',
    description: '搜索已有技能：输入当前任务描述，查找相关的已习得技能和经验。返回匹配的技能列表及其知识文档。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词或任务描述' },
        max_results: { type: 'number', description: '最大结果数，默认 3', default: 3 },
      },
      required: ['query'],
    },
  },
  {
    name: 'skill_improve',
    description: '改进已有技能：基于新的经验更新技能的步骤说明、触发条件或标签。每次改进自动版本递增。',
    parameters: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: '要改进的技能 ID（如 SK-001）' },
        knowledge: { type: 'string', description: '更新后的知识文档（Markdown 格式）' },
        trigger: { type: 'string', description: '更新后的触发条件（可选）' },
        change_note: { type: 'string', description: '本次改进说明（<50字）' },
      },
      required: ['skill_id', 'change_note'],
    },
  },
  {
    name: 'skill_record_usage',
    description:
      '记录技能使用结果：在使用了某个技能后，报告使用结果（成功/失败）和反馈。帮助系统追踪技能有效性并自动晋升成熟度。',
    parameters: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: '使用的技能 ID' },
        success: { type: 'boolean', description: '使用是否成功' },
        feedback: { type: 'string', description: '使用反馈或改进建议（可选）' },
      },
      required: ['skill_id', 'success'],
    },
  },

  // ── Sub-Agent Framework ──
  {
    name: 'spawn_agent',
    description:
      '启动一个子 Agent 执行委派任务。子 Agent 拥有自己的工具集和执行环境，完成后返回结论和产出文件列表。\n预设角色: researcher(只读研究)、coder(编码)、reviewer(审查)、tester(测试)、doc_writer(文档)、deployer(运维)。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '委派给子 Agent 的任务描述（要清晰具体，包含足够上下文）' },
        preset: {
          type: 'string',
          enum: ['researcher', 'coder', 'reviewer', 'tester', 'doc_writer', 'deployer'],
          description: '预设角色',
        },
        extra_prompt: { type: 'string', description: '额外的指令（追加到角色 prompt 之后，可选）' },
        max_iterations: { type: 'number', description: '最大工具调用轮次（可选，默认按角色预设）' },
      },
      required: ['task', 'preset'],
    },
  },
  {
    name: 'spawn_parallel',
    description: '并行启动多个子 Agent，各自独立执行，全部完成后汇总结果。适合可并行的调研/编码/测试任务。',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '任务 ID（用于结果匹配）' },
              task: { type: 'string', description: '任务描述' },
              preset: {
                type: 'string',
                enum: ['researcher', 'coder', 'reviewer', 'tester', 'doc_writer', 'deployer'],
                description: '预设角色',
              },
            },
            required: ['id', 'task', 'preset'],
          },
          description: '并行任务列表',
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'list_sub_agents',
    description: '列出当前正在运行的子 Agent 及其状态。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_sub_agent',
    description: '取消一个正在执行的子 Agent。',
    parameters: {
      type: 'object',
      properties: { agent_id: { type: 'string', description: '子 Agent ID（由 spawn_agent 返回）' } },
      required: ['agent_id'],
    },
  },

  // ── Docker Sandbox ──
  {
    name: 'sandbox_init',
    description:
      '创建一个 Docker 容器沙箱。用于在隔离环境中安装依赖、运行测试、执行不信任的代码。需要宿主机已安装 Docker。\n预设: node, python, rust, go, ubuntu。也可指定任意 Docker 镜像。',
    parameters: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description: 'Docker 镜像或预设名（node/python/rust/go/ubuntu），默认 node',
          default: 'node',
        },
        mount_workspace: { type: 'boolean', description: '是否将当前工作区挂载到容器（默认 false）', default: false },
        env: { type: 'object', description: '环境变量 (key-value)' },
        memory_limit: { type: 'string', description: '内存限制（如 512m, 2g），默认 1g' },
      },
    },
  },
  {
    name: 'sandbox_exec',
    description: '在 Docker 沙箱中执行命令。',
    parameters: {
      type: 'object',
      properties: {
        container_id: { type: 'string', description: '容器 ID (由 sandbox_init 返回)' },
        command: { type: 'string', description: '要执行的 shell 命令' },
        timeout: { type: 'number', description: '超时秒数，默认 60', default: 60 },
      },
      required: ['container_id', 'command'],
    },
  },
  {
    name: 'sandbox_write',
    description: '向 Docker 沙箱写入文件。',
    parameters: {
      type: 'object',
      properties: {
        container_id: { type: 'string', description: '容器 ID' },
        path: { type: 'string', description: '容器内文件路径' },
        content: { type: 'string', description: '文件内容' },
      },
      required: ['container_id', 'path', 'content'],
    },
  },
  {
    name: 'sandbox_read',
    description: '从 Docker 沙箱读取文件。',
    parameters: {
      type: 'object',
      properties: {
        container_id: { type: 'string', description: '容器 ID' },
        path: { type: 'string', description: '容器内文件路径' },
      },
      required: ['container_id', 'path'],
    },
  },
  {
    name: 'sandbox_destroy',
    description: '销毁 Docker 沙箱容器。',
    parameters: {
      type: 'object',
      properties: {
        container_id: { type: 'string', description: '容器 ID' },
      },
      required: ['container_id'],
    },
  },

  // ── Black-Box Test Runner ──
  {
    name: 'run_blackbox_tests',
    description:
      '运行自主黑盒测试 + 迭代修复循环。\n流程: 自动生成测试用例 → 执行 → 分析失败 → 自动修复 → 重跑 → 直到全部通过或达到轮次限制。\n支持: 单元测试(沙箱)、集成测试、API测试、E2E浏览器测试。',
    parameters: {
      type: 'object',
      properties: {
        feature_description: { type: 'string', description: '要测试的功能描述（需求/验收标准）' },
        acceptance_criteria: { type: 'string', description: '验收标准（每条一行）' },
        code_files: { type: 'array', items: { type: 'string' }, description: '相关代码文件路径列表' },
        max_rounds: { type: 'number', description: '最大修复轮次，默认 5', default: 5 },
        test_types: {
          type: 'array',
          items: { type: 'string', enum: ['unit', 'integration', 'e2e', 'api'] },
          description: '要运行的测试类型',
        },
        app_url: { type: 'string', description: '应用 URL (E2E 测试用，如 http://localhost:3000)' },
      },
      required: ['feature_description'],
    },
  },
];
