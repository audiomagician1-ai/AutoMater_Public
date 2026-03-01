/**
 * 项目相关类型定义
 */

export type ProjectStatus =
  | 'initializing'   // PM + Architect 工作中
  | 'developing'     // 迭代开发中
  | 'reviewing'      // 最终审查中
  | 'delivered'      // 已交付
  | 'paused'         // 用户暂停
  | 'error';         // 出错

export interface ProjectConfig {
  /** 并行 Worker 数量 */
  workerCount: number;
  /** 每个 feature 最大重试次数 */
  maxRetries: number;
  /** LLM provider ID (用户配置的) */
  llmProviderId: string;
  /** PM/Architect 使用的模型 */
  strongModel: string;
  /** Developer/QA 使用的模型 */
  workerModel: string;
  /** 日预算 (USD) */
  dailyBudgetUsd: number;
  /** 是否启用 Docker 沙箱 */
  sandboxEnabled: boolean;
}

export interface Project {
  id: string;
  name: string;
  /** 用户原始需求描述 */
  wish: string;
  status: ProjectStatus;
  /** 本地工作目录绝对路径 */
  workspacePath: string;
  config: ProjectConfig;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  workerCount: 3,
  maxRetries: 3,
  llmProviderId: '',
  strongModel: '',
  workerModel: '',
  dailyBudgetUsd: 50,
  sandboxEnabled: false,
};
