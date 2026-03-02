/**
 * Engine Constants — 集中管理引擎层的配置常量
 *
 * 所有 magic numbers 应在此处定义并添加取值依据注释。
 * 引擎模块通过 import { ... } from './constants' 使用。
 *
 * v12.1: 从 orchestrator/react-loop 等模块提取
 */

// ═══════════════════════════════════════
// ReAct Loop
// ═══════════════════════════════════════

/** ReAct 最大迭代次数。25 次足够完成单个 Feature 的实现+调试周期，
 *  超过通常意味着陷入循环。与 guards.ts DEFAULT_REACT_CONFIG.maxIterations 一致。 */
export const REACT_MAX_ITERATIONS = 25;

/** ReAct 最大 token 预算 (单次 Feature)。500K 约等于 Claude 3.5 的完整上下文窗口。 */
export const REACT_MAX_TOKENS = 500_000;

/** ReAct 最大成本预算 (单次 Feature, USD)。防止单个 Feature 耗费过多 LLM 费用。 */
export const REACT_MAX_COST_USD = 2.0;

// ═══════════════════════════════════════
// Pipeline Phases
// ═══════════════════════════════════════

/** Phase 3 (子需求+测试规格) 每批处理的 Feature 数量。
 *  5 个一批平衡了 LLM 上下文利用率和失败粒度。 */
export const BATCH_DOC_SIZE = 5;

/** Phase 3 单次 LLM 调用超时 (毫秒)。
 *  子需求生成量大，5 分钟足够处理 5 个 Feature 的完整拆解。 */
export const PHASE3_TIMEOUT_MS = 300_000;

/** PM 验收阶段每批处理的 Feature 数量。
 *  4 个一批让 PM 能对每个 Feature 给出细致的验收评审。 */
export const BATCH_ACCEPT_SIZE = 4;

/** Worker 拿到空任务后的等待间隔 (毫秒)。
 *  防止在所有 Feature 被锁定但未完成时 CPU 空转。 */
export const WORKER_POLL_INTERVAL_MS = 3_000;

/** Worker 连续拿不到任务的最大次数，超过则退出。
 *  防止依赖全部阻塞时无限空等。 */
export const WORKER_MAX_IDLE_POLLS = 5;

// ═══════════════════════════════════════
// QA & DevOps
// ═══════════════════════════════════════

/** QA 驳回后最大重试次数。3 次足以修复大部分问题，更多通常意味着需求本身有问题。 */
export const QA_MAX_RETRIES = 3;

/** DevOps 构建步骤超时 (毫秒)。2 分钟覆盖大部分前端/后端构建。 */
export const DEVOPS_BUILD_TIMEOUT_MS = 120_000;

/** DevOps 构建命令最大输出缓冲区 (字节)。1MB 足够捕获有意义的错误信息。 */
export const DEVOPS_MAX_BUFFER = 1024 * 1024;

// ═══════════════════════════════════════
// Token Estimation
// ═══════════════════════════════════════

/** 英文字符到 token 的估算比率 (chars / tokens)。
 *  1.5 适用于英文内容。中文内容约 0.5~0.7 (更差)。
 *  TODO: 引入 tiktoken 或区分中英文比例以提高精度。 */
export const CHARS_PER_TOKEN_EN = 1.5;

/** 中文字符到 token 的估算比率 */
export const CHARS_PER_TOKEN_ZH = 0.6;

// ═══════════════════════════════════════
// Budget Defaults
// ═══════════════════════════════════════

/** 每日默认预算上限 (USD)。0 = 不限。 */
export const DEFAULT_DAILY_BUDGET_USD = 10;

/** 单个 Feature 默认预算上限 (USD) */
export const DEFAULT_FEATURE_BUDGET_USD = 2.0;

/** 单个 Feature 默认 token 上限 */
export const DEFAULT_FEATURE_TOKEN_LIMIT = 500_000;

/** 单个 Feature 最大执行时间 (分钟) */
export const DEFAULT_FEATURE_TIME_LIMIT_MIN = 15;
