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
];
