/**
 * Shared Engine Types — 引擎层公共类型定义
 *
 * 消除 `any` 类型，为所有 DB row / settings / feature 等提供强类型。
 * 所有引擎模块应从此文件 import 类型，而非各自 `as any`。
 *
 * v2.6.0: 初始创建（代码质量审计产物）
 */

// ═══════════════════════════════════════
// Application Settings
// ═══════════════════════════════════════

/** 单个模型的定价信息 (USD per 1K tokens) */
export interface ModelPricing {
  input: number;
  output: number;
}

export interface AppSettings {
  llmProvider: 'openai' | 'anthropic' | 'custom';
  apiKey: string;
  baseUrl: string;
  /** 强模型 — PM / 架构设计 / QA 审查 */
  strongModel: string;
  /** 工作模型 — Developer 编码 / Planner */
  workerModel: string;
  /** 快速模型 — 摘要 / 格式化 / 子Agent (留空则用 workerModel) */
  fastModel?: string;
  /** 并行 Worker 数量 (0 = 不限) */
  workerCount: number;
  /** 每日预算上限 USD (0 = 不限) */
  dailyBudgetUsd: number;
  /** TDD 模式: QA 先生成测试骨架, Developer 围绕测试编码 (G14) */
  tddMode?: boolean;
  /** 用户自定义模型定价 (优先于内置价格表)。key = 模型名, value = $/1K tokens */
  modelPricing?: Record<string, ModelPricing>;
  /** 界面缩放因子 */
  zoomFactor?: number;
}

// ═══════════════════════════════════════
// Database Row Types (match db.ts schema)
// ═══════════════════════════════════════

export type ProjectStatus =
  | 'initializing'
  | 'analyzing'
  | 'developing'
  | 'paused'
  | 'delivered'
  | 'awaiting_user_acceptance'
  | 'error';

export interface ProjectRow {
  id: string;
  name: string;
  wish: string;
  status: ProjectStatus;
  workspace_path: string | null;
  config: string;  // JSON
  git_mode: 'local' | 'github';
  github_repo: string | null;
  github_token: string | null;
  created_at: string;
  updated_at: string;
}

export type FeatureStatus =
  | 'todo'
  | 'in_progress'
  | 'reviewing'
  | 'qa_passed'
  | 'pm_rejected'
  | 'passed'
  | 'failed';

export interface FeatureRow {
  id: string;
  project_id: string;
  category: string;
  priority: number;
  group_name: string | null;
  title: string;
  description: string;
  depends_on: string;       // JSON array of feature IDs
  status: FeatureStatus;
  locked_by: string | null;
  acceptance_criteria: string; // JSON array
  affected_files: string;      // JSON array
  notes: string;
  created_at: string;
  completed_at: string | null;
  /** v4.2: 子需求文档版本 */
  requirement_doc_ver: number;
  /** v4.2: 测试规格文档版本 */
  test_spec_doc_ver: number;
  /** v4.2: PM 验收结果 */
  pm_verdict: string | null;
  pm_verdict_score: number | null;
  pm_verdict_feedback: string | null;
}

export interface AgentRow {
  id: string;
  project_id: string;
  role: string;
  status: 'idle' | 'working' | 'error';
  current_task: string | null;
  session_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  created_at: string;
  last_active_at: string | null;
}

export interface AgentLogRow {
  id: number;
  project_id: string;
  agent_id: string;
  type: string;
  content: string;
  created_at: string;
}

// ═══════════════════════════════════════
// Aggregate Query Results
// ═══════════════════════════════════════

export interface CountResult {
  c: number;
}

export interface FeatureStatsResult {
  total: number;
  passed: number;
  failed: number;
  in_progress: number;
}

export interface CostStatsResult {
  total_tokens: number;
  total_cost: number;
}

// ═══════════════════════════════════════
// Common Constants (shared across modules)
// ═══════════════════════════════════════

/** Directories to ignore when scanning workspace files */
export const WORKSPACE_IGNORE_DIRS = new Set([
  'node_modules', '.git', '__pycache__', 'dist', 'build', '.next',
  'coverage', '.cache', 'target', 'vendor', '.agentforge', '.venv', 'venv',
]);

// ═══════════════════════════════════════
// Team Member — Per-member LLM / MCP / Skill Config (v11.0)
// ═══════════════════════════════════════

/** 成员级 LLM 配置 — 覆盖全局设置 (每个字段可选, 缺省 fallback 到全局) */
export interface MemberLLMConfig {
  provider?: 'openai' | 'anthropic' | 'custom';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** 成员级 MCP 服务器定义 (与全局 McpServerConfig 结构一致) */
export interface MemberMcpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

/** 成员级 Skill 引用 */
export interface MemberSkillRef {
  name: string;
  /** 可选: 自定义该 Skill 的参数 / 覆盖 */
  override?: Record<string, unknown>;
}

/** Code file extensions for analysis */
export const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.cs', '.rb',
  '.c', '.cpp', '.h', '.hpp', '.swift', '.kt',
  '.vue', '.svelte',
]);

// ═══════════════════════════════════════
// Workflow Presets (v12.0)
// ═══════════════════════════════════════

/** 工作流阶段标识 — 与 orchestrator 的实际 phase 函数一一对应 */
export type WorkflowStageId =
  | 'pm_analysis'
  | 'pm_triage'
  | 'architect'
  | 'docs_gen'
  | 'dev_implement'
  | 'qa_review'
  | 'pm_acceptance'
  | 'devops_build'
  | 'incremental_doc_sync'
  | 'static_analysis'
  | 'security_audit'
  | 'perf_benchmark'
  | 'finalize';

/** 工作流中每个阶段的配置 */
export interface WorkflowStage {
  id: WorkflowStageId;
  label: string;
  icon: string;
  color: string;
  /** 阶段级参数覆盖 (如 maxIterations, model tier 等) */
  config?: Record<string, unknown>;
  /** 是否可跳过 (用户可在运行前 toggle) */
  skippable?: boolean;
}

/** 工作流预设记录 (DB row) */
export interface WorkflowPresetRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  icon: string;
  /** JSON: WorkflowStage[] */
  stages: string;
  is_active: number;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

/** 解析后的工作流预设 */
export interface WorkflowPreset {
  id: string;
  projectId: string;
  name: string;
  description: string;
  icon: string;
  stages: WorkflowStage[];
  isActive: boolean;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}
