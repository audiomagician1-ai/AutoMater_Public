/**
 * Agent 相关类型定义
 * 
 * 借鉴 Actant 的 Docker 隐喻：Template → Instance
 * 借鉴 agent-swarm 的角色专业化
 */

export type AgentRole =
  | 'pm'          // 产品经理：需求分析 → Feature 清单
  | 'architect'   // 架构师：技术选型 → 骨架代码
  | 'developer'   // 开发者：按 Feature 实现代码
  | 'qa'          // QA：白盒 + 黑盒测试
  | 'reviewer'    // Code Reviewer：代码质量审查
  | 'devops';     // DevOps：构建部署

export type AgentStatus =
  | 'idle'        // 空闲
  | 'working'     // 工作中
  | 'waiting'     // 等待依赖/审批
  | 'error'       // 出错
  | 'stopped';    // 已停止

export interface AgentTemplate {
  role: AgentRole;
  name: string;
  description: string;
  /** Prompt 模板路径 (相对于 prompts/) */
  promptTemplate: string;
  /** 推荐使用的模型等级 */
  modelTier: 'strong' | 'standard' | 'light';
  /** 单次 session 最大时间 (秒) */
  maxSessionDuration: number;
  /** 最大 context tokens */
  maxContextTokens: number;
}

export interface AgentInstance {
  id: string;
  projectId: string;
  role: AgentRole;
  status: AgentStatus;
  /** 当前正在处理的 Feature ID */
  currentTask: string | null;
  /** 累计 session 数 */
  sessionCount: number;
  /** 累计输入 tokens */
  totalInputTokens: number;
  /** 累计输出 tokens */
  totalOutputTokens: number;
  /** 累计成本 (USD) */
  totalCostUsd: number;
  createdAt: string;
  lastActiveAt: string | null;
}

/** 内置 Agent 模板定义 */
export const AGENT_TEMPLATES: Record<AgentRole, AgentTemplate> = {
  pm: {
    role: 'pm',
    name: '产品经理',
    description: '分析用户需求，拆解为可实现的 Feature 清单',
    promptTemplate: 'pm.md',
    modelTier: 'strong',
    maxSessionDuration: 600,
    maxContextTokens: 128000,
  },
  architect: {
    role: 'architect',
    name: '架构师',
    description: '技术选型、架构设计、生成骨架代码',
    promptTemplate: 'architect.md',
    modelTier: 'strong',
    maxSessionDuration: 600,
    maxContextTokens: 128000,
  },
  developer: {
    role: 'developer',
    name: '开发者',
    description: '按 Feature 实现代码并编写测试',
    promptTemplate: 'developer.md',
    modelTier: 'standard',
    maxSessionDuration: 300,
    maxContextTokens: 64000,
  },
  qa: {
    role: 'qa',
    name: 'QA 工程师',
    description: '白盒测试(代码审查) + 黑盒测试(功能验证)',
    promptTemplate: 'qa.md',
    modelTier: 'standard',
    maxSessionDuration: 300,
    maxContextTokens: 64000,
  },
  reviewer: {
    role: 'reviewer',
    name: 'Code Reviewer',
    description: '代码质量审查、安全审查',
    promptTemplate: 'reviewer.md',
    modelTier: 'standard',
    maxSessionDuration: 180,
    maxContextTokens: 64000,
  },
  devops: {
    role: 'devops',
    name: 'DevOps',
    description: '构建、测试、部署管理',
    promptTemplate: 'devops.md',
    modelTier: 'light',
    maxSessionDuration: 180,
    maxContextTokens: 32000,
  },
};
