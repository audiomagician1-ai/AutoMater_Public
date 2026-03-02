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
  /** 项目导入预算上限 USD (0 = 不限, 默认 5.0) — 控制探针总花费 */
  importBudgetUsd?: number;
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
  /** v14.0: GitHub Issue 关联 */
  github_issue_number: number | null;
  github_pr_number: number | null;
  github_branch: string | null;
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
  'coverage', '.cache', 'target', 'vendor', '.automater', '.venv', 'venv',
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

// ═══════════════════════════════════════
// Feature Pipeline Types (v12.1 — 消除 any)
// ═══════════════════════════════════════

/**
 * ParsedFeature — PM LLM 输出归一化后的 Feature
 * PM 分析阶段解析 LLM JSON 后产出此类型，写入 DB 前的中间态
 */
export interface ParsedFeature {
  id: string;
  category: string;
  priority: number;
  group_name: string;
  sub_group: string;
  title: string;
  description: string;
  dependsOn: string[];          // LLM 倾向 camelCase
  depends_on?: string[];        // DB 使用 snake_case, 向后兼容
  acceptance_criteria: string[];
  acceptanceCriteria?: string[]; // LLM 可能输出 camelCase
  notes: string;
  group_id?: string;
}

/**
 * EnrichedFeature — 注入运行时上下文后的 Feature
 * 从 DB 读取 + 注入 doc/TDD/conflict 等上下文后的完整类型
 * 用于 workerLoop / reactDeveloperLoop / QA 等阶段
 */
export interface EnrichedFeature extends FeatureRow {
  /** v4.2: 关联的子需求+测试规格文档摘要 */
  _docContext?: string;
  /** v5.3: 文件锁冲突警告 */
  _conflictWarning?: string;
  /** v5.3: 其他 Worker 的文件占用信息 */
  _otherWorkerClaims?: string;
  /** v5.4: TDD 预生成的测试文件路径 */
  _tddTests?: string[];
  /** v5.4: TDD 上下文提示 */
  _tddContext?: string;
  /** v6.1 (构想D): 其他 Worker 的近期成果广播 */
  _teamContext?: string;
}

// ═══════════════════════════════════════
// LLM Message Types (v12.2 — 消除消息 any)
// ═══════════════════════════════════════

/** OpenAI function-call 格式的单个工具调用 */
export interface LLMToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 统一的 LLM chat message — 用于 react-loop / sub-agent 等的消息数组 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<Record<string, unknown>>;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** OpenAI tools 定义格式 */
export interface LLMToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ═══════════════════════════════════════
// MCP Types (v12.2)
// ═══════════════════════════════════════

/** JSON-RPC 请求 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 响应 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP content block */
export interface McpContentBlock {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

// ═══════════════════════════════════════
// Guards Schema Types (v12.2)
// ═══════════════════════════════════════

/** guards.ts schema field definition */
export interface GuardSchemaField {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
  validate?: (value: unknown) => string | null;
}

// ═══════════════════════════════════════
// Conversation / Session Types (v12.2)
// ═══════════════════════════════════════

/** conversation-backup 消息行 */
export interface ConversationMessage {
  role: string;
  content: string | null | Array<Record<string, unknown>>;
  tool_calls?: LLMToolCall[];
}

/** Git issue/PR types */
export interface GitIssue {
  number: number;
  title: string;
  state: string;
  labels: string[];
  body: string;
}

// ═══════════════════════════════════════
// File tree node (for formatTree) (v12.2)
// ═══════════════════════════════════════

export interface FileTreeNode {
  name: string;
  type: 'file' | 'dir' | 'directory';
  children?: FileTreeNode[];
}

// ═══════════════════════════════════════
// Accessibility tree node (for browser-tools) (v12.2)
// ═══════════════════════════════════════

export interface A11yTreeNode {
  role?: string;
  name?: string;
  value?: string;
  children?: A11yTreeNode[];
  [key: string]: unknown;
}

// ═══════════════════════════════════════
// QA Loop types (v12.2)
// ═══════════════════════════════════════

export interface QAIssue {
  severity: 'error' | 'warning' | 'info';
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
}

// ═══════════════════════════════════════
// OpenAI Tool Format (v12.3)
// ═══════════════════════════════════════

/** OpenAI function-calling 格式的工具定义 */
export interface OpenAIFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  [key: string]: unknown;
}

// ═══════════════════════════════════════
// DB Row Types for mapper functions (v12.3)
// ═══════════════════════════════════════

/** sessions 表原始行 */
export interface SessionRow {
  id: string;
  project_id: string | null;
  agent_id: string;
  agent_role: string;
  agent_seq: number;
  status: 'active' | 'completed' | 'archived';
  backup_path: string | null;
  created_at: string;
  completed_at: string | null;
  message_count: number;
  total_tokens: number;
  total_cost: number;
}

/** feature_sessions 表原始行 */
export interface FeatureSessionRow {
  id: string;
  feature_id: string;
  session_id: string;
  project_id: string;
  agent_id: string;
  agent_role: string;
  work_type: string;  // WorkType at runtime
  expected_output: string;
  actual_output: string | null;
  status: 'pending' | 'active' | 'completed' | 'failed';
  created_at: string;
  completed_at: string | null;
}

/** events 表原始行 */
export interface EventRow {
  id: number;
  project_id: string;
  agent_id: string;
  feature_id: string | null;
  type: string;
  data: string;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  created_at: string;
}

// ═══════════════════════════════════════
// Anthropic API types (v12.3)
// ═══════════════════════════════════════

/** Anthropic content block */
export interface AnthropicContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════
// Gate feature (v12.3) — minimal feature shape for guards
// ═══════════════════════════════════════

/** 最小 Feature 结构 — 用于 guards 门控检查 */
export interface GateFeature {
  id: string;
  title?: string;
  description?: string;
  status?: string;
  category?: string;
  dependsOn?: string[];
  depends_on?: string[];
  affected_files?: string;
  acceptance_criteria?: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════
// GitHub API types (v12.3)
// ═══════════════════════════════════════

/** GitHub label (API response) */
export interface GitHubApiLabel {
  name: string;
  [key: string]: unknown;
}

/** GitHub issue (API response) */
export interface GitHubApiIssue {
  number: number;
  title: string;
  state: string;
  body: string;
  labels: GitHubApiLabel[];
  html_url: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════
// QA Issue item from LLM (v12.3)
// ═══════════════════════════════════════

export interface QAIssueItem {
  severity: string;
  file?: string;
  line?: number;
  description: string;
  suggestion?: string;
}

// ═══════════════════════════════════════
// better-sqlite3 Statement type (v12.3)
// ═══════════════════════════════════════

/** Minimal better-sqlite3 Statement interface */
export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

// ═══════════════════════════════════════
// Skill Types (v12.2)
// ═══════════════════════════════════════

export interface SkillEntry {
  name: string;
  description?: string;
  trigger?: string;
  steps?: string[];
  [key: string]: unknown;
}

// ═══════════════════════════════════════
// Error Types — 统一引擎错误层次 (v12.1)
// ═══════════════════════════════════════

/** 引擎层基础错误 — 所有引擎错误的父类 */
export class EngineError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

/** 网络/API 错误 (LLM 调用失败、连接超时等) */
export class NetworkError extends EngineError {
  public readonly statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message, 'NETWORK_ERROR');
    this.name = 'NetworkError';
    this.statusCode = statusCode;
  }
}

/** 解析错误 (LLM 输出无法解析为有效 JSON 等) */
export class ParseError extends EngineError {
  constructor(message: string) {
    super(message, 'PARSE_ERROR');
    this.name = 'ParseError';
  }
}

/** 配置错误 (API Key 缺失、模型不存在等) */
export class ConfigError extends EngineError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigError';
  }
}

/** 工具执行错误 (文件读写失败、命令超时等) */
export class ToolError extends EngineError {
  public readonly toolName: string;
  constructor(message: string, toolName: string) {
    super(message, 'TOOL_ERROR');
    this.name = 'ToolError';
    this.toolName = toolName;
  }
}

