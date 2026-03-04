/**
 * Admin mode — project management tool definitions (v22.0).
 */
import type { ToolDef } from './types';

export const ADMIN_TOOLS: ToolDef[] = [
  {
    name: 'admin_list_members',
    description:
      '列出当前项目的所有团队成员及其配置（角色、名字、模型、提示词、上下文限制等）。管理模式下首先调用此工具了解当前团队构成。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'admin_add_member',
    description: '向当前项目添加新的团队成员。需指定角色(developer/qa/architect/pm/devops)、名字、可选的模型和提示词。',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['developer', 'qa', 'architect', 'pm', 'devops'], description: '成员角色' },
        name: { type: 'string', description: '成员名字（如 "高级前端开发"、"安全审查员"）' },
        model: { type: 'string', description: '使用的 LLM 模型（可选，留空使用项目默认）' },
        system_prompt: { type: 'string', description: '自定义系统提示词（可选，留空使用角色默认）' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          description: '能力标签列表（如 ["typescript","react"]）',
        },
        max_context_tokens: { type: 'number', description: '最大上下文 token 数（默认 256000）' },
        max_iterations: { type: 'number', description: '最大 ReAct 迭代轮数（默认不限，由全局配置决定）' },
      },
      required: ['role', 'name'],
    },
  },
  {
    name: 'admin_update_member',
    description: '修改已有团队成员的配置。⚠️ 此操作会改变成员行为，请先用 admin_list_members 确认当前配置后再修改。',
    parameters: {
      type: 'object',
      properties: {
        member_id: { type: 'string', description: '成员 ID（从 admin_list_members 获取）' },
        name: { type: 'string', description: '新名字' },
        role: { type: 'string', enum: ['developer', 'qa', 'architect', 'pm', 'devops'], description: '新角色' },
        model: { type: 'string', description: '新模型' },
        system_prompt: { type: 'string', description: '新系统提示词' },
        capabilities: { type: 'array', items: { type: 'string' }, description: '新能力标签' },
        max_context_tokens: { type: 'number', description: '新上下文 token 限制' },
        max_iterations: { type: 'number', description: '新最大迭代轮数' },
      },
      required: ['member_id'],
    },
  },
  {
    name: 'admin_remove_member',
    description: '从项目中移除一个团队成员。⚠️ 删除不可撤销，请确认后再执行。',
    parameters: {
      type: 'object',
      properties: {
        member_id: { type: 'string', description: '要移除的成员 ID' },
      },
      required: ['member_id'],
    },
  },
  {
    name: 'admin_list_workflows',
    description: '列出当前项目的所有工作流预设（含内置和自定义），以及当前激活的工作流。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'admin_activate_workflow',
    description: '切换项目的活跃工作流。同一项目只能有一个活跃工作流。',
    parameters: {
      type: 'object',
      properties: {
        preset_id: { type: 'string', description: '要激活的工作流预设 ID（从 admin_list_workflows 获取）' },
      },
      required: ['preset_id'],
    },
  },
  {
    name: 'admin_update_workflow',
    description: '修改工作流的名称、描述、阶段顺序等。可以增删或重排工作流阶段。内置工作流也可修改。',
    parameters: {
      type: 'object',
      properties: {
        preset_id: { type: 'string', description: '工作流预设 ID' },
        name: { type: 'string', description: '新名称' },
        description: { type: 'string', description: '新描述' },
        icon: { type: 'string', description: '新图标（emoji）' },
        stages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '阶段 ID（如 pm_analysis, dev_implement, qa_review）' },
              label: { type: 'string', description: '阶段显示名' },
              icon: { type: 'string', description: '阶段图标' },
              color: { type: 'string', description: '阶段颜色 CSS 类（如 bg-blue-500）' },
              skippable: { type: 'boolean', description: '是否可跳过' },
            },
            required: ['id', 'label'],
          },
          description: '完整的阶段列表（替换当前所有阶段）',
        },
      },
      required: ['preset_id'],
    },
  },
  {
    name: 'admin_update_project',
    description: '修改项目级配置：项目名称、需求描述、权限设置等。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '新项目名称' },
        wish: { type: 'string', description: '更新需求描述' },
        permissions: {
          type: 'object',
          properties: {
            externalRead: { type: 'boolean', description: '允许读取工作区外文件' },
            externalWrite: { type: 'boolean', description: '允许写入工作区外文件' },
            shellExec: { type: 'boolean', description: '允许执行 shell 命令' },
          },
          description: '权限设置',
        },
      },
    },
  },
  {
    name: 'admin_get_available_stages',
    description: '获取所有可用的工作流阶段定义列表。用于创建或修改工作流时选择阶段。',
    parameters: { type: 'object', properties: {} },
  },

  // ── v29.2: Self-Evolution Tools ──
  {
    name: 'admin_evolution_status',
    description:
      '查看自我进化引擎的当前状态：进化进度、基线适应度、进化历史、进化记忆摘要。' +
      '首次使用进化功能前，请先调用此工具了解当前状态。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'admin_evolution_preflight',
    description:
      '执行自我进化前的安全预检：检查 git 状态是否干净、验证不可变文件完整性、评估当前基线适应度(tsc + vitest + coverage)。' +
      '必须在启动进化迭代之前调用，确保一切就绪。评估可能需要 1-3 分钟。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'admin_evolution_evaluate',
    description:
      '执行一次只读的适应度评估（不修改任何代码）：运行 tsc --noEmit + vitest run，返回综合适应度得分。' +
      '用于在修改代码前后对比适应度变化。评估可能需要 1-2 分钟。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'admin_evolution_run',
    description:
      '执行一次自我进化迭代。在独立 git 分支上应用代码修改 → 运行适应度评估(tsc + vitest) → 通过则合并到基线、失败则自动回滚。' +
      '⚠️ 这是最核心的进化操作，会实际修改源代码。修改前会自动创建 git 快照用于灾难恢复。',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: '本次进化的描述（如 "优化 PM 阶段 system prompt 提升需求分析质量"）',
        },
        file_changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件路径（相对于项目根目录）' },
              content: { type: 'string', description: '文件新内容（write 操作必填）' },
              action: { type: 'string', enum: ['write', 'delete'], description: '操作类型（默认 write）' },
            },
            required: ['path'],
          },
          description: '要应用的文件修改列表。注意：vitest.config.ts、tsconfig.json 等不可变文件不可修改。',
        },
      },
      required: ['description', 'file_changes'],
    },
  },
  {
    name: 'admin_evolution_verify',
    description:
      '验证不可变文件的 SHA256 完整性。检查 vitest.config.ts、tsconfig.json、quality-gate.js 等关键文件是否被意外修改。',
    parameters: { type: 'object', properties: {} },
  },
];
