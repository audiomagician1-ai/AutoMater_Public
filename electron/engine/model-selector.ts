/**
 * Dynamic Model Selection — 按任务复杂度自动选模型
 *
 * 对标: Cursor 2.0 / Factory Droids — Agent 按任务类型和复杂度
 * 动态选择最优模型 (强模型 vs 弱模型 vs 迷你模型)
 *
 * 策略:
 * - PM / Architect / QA 审查 → 强模型 (需要全局理解 + 高质量输出)
 * - Developer (复杂 feature, 多文件) → 强模型
 * - Developer (简单 feature, 单文件) → 弱模型
 * - Summarizer / Sub-agent → 弱模型
 * - 格式化 / 简单操作 → 迷你模型 (如果有)
 *
 * v5.0: planning 不再独立调用, 但保留 'planning' task type 供向后兼容
 *
 * v1.3.0: 初始实现
 */

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export type ModelTier = 'strong' | 'worker' | 'mini';

export type TaskType =
  | 'pm_analysis'
  | 'architecture'
  | 'planning'
  | 'development'
  | 'qa_review'
  | 'summarize'
  | 'research'       // sub-agent
  | 'lesson_extract' // auto lessons learned
  | 'format';        // simple formatting

export interface TaskComplexity {
  /** 任务类型 */
  type: TaskType;
  /** 特征复杂度评分 (0-10) */
  featureComplexity?: number;
  /** 涉及文件数量 */
  fileCount?: number;
  /** 是否有 QA 反馈需要修复 */
  hasQAFeedback?: boolean;
  /** 依赖的 feature 数量 */
  dependencyCount?: number;
  /** 第几次 QA 重试 */
  qaAttempt?: number;
}

export interface ModelSelection {
  tier: ModelTier;
  /** 选择理由 */
  reason: string;
}

// ═══════════════════════════════════════
// Selection Logic
// ═══════════════════════════════════════

/**
 * 根据任务复杂度选择模型层级
 */
export function selectModelTier(task: TaskComplexity): ModelSelection {
  switch (task.type) {
    // ── 必须用强模型的任务 ──
    case 'pm_analysis':
      return { tier: 'strong', reason: 'PM 需求分析需要全局理解能力' };

    case 'architecture':
      return { tier: 'strong', reason: '架构设计需要深度技术判断' };

    case 'qa_review':
      return { tier: 'strong', reason: 'QA 审查需要严格的代码理解' };

    // ── 可以用弱模型的任务 ──
    case 'planning':
      return { tier: 'worker', reason: '计划制定用标准模型即可' };

    case 'summarize':
      return { tier: 'worker', reason: '摘要生成用标准模型即可' };

    case 'lesson_extract':
      return { tier: 'worker', reason: '经验提取用标准模型即可' };

    case 'research':
      return { tier: 'worker', reason: '子 agent 研究用标准模型即可' };

    case 'format':
      return { tier: 'mini', reason: '简单格式化用最小模型' };

    // ── 开发任务: 按复杂度动态选择 ──
    case 'development': {
      const score = computeDevComplexity(task);
      if (score >= 7) {
        return { tier: 'strong', reason: `高复杂度开发任务 (score=${score}): 多文件/多依赖/QA重试` };
      }
      if (score >= 4) {
        return { tier: 'worker', reason: `中等复杂度开发任务 (score=${score})` };
      }
      return { tier: 'worker', reason: `标准开发任务 (score=${score})` };
    }

    default:
      return { tier: 'worker', reason: '默认使用标准模型' };
  }
}

/**
 * 计算开发任务的复杂度评分 (0-10)
 */
function computeDevComplexity(task: TaskComplexity): number {
  let score = task.featureComplexity ?? 3; // 基础复杂度

  // 涉及多文件 → 加分
  if (task.fileCount && task.fileCount > 5) score += 2;
  else if (task.fileCount && task.fileCount > 3) score += 1;

  // 有依赖 → 加分 (接口兼容性更重要)
  if (task.dependencyCount && task.dependencyCount >= 3) score += 2;
  else if (task.dependencyCount && task.dependencyCount >= 1) score += 1;

  // QA 反馈需修复 → 加分 (说明之前模型没做好)
  if (task.hasQAFeedback) score += 1;

  // 第 3 次 QA 重试 → 必须升级
  if (task.qaAttempt && task.qaAttempt >= 3) score += 2;

  return Math.min(10, score);
}

/**
 * 从 settings 解析模型名称
 */
export function resolveModel(
  tier: ModelTier,
  settings: { strongModel: string; workerModel: string; fastModel?: string },
): string {
  switch (tier) {
    case 'strong':
      return settings.strongModel;
    case 'worker':
      return settings.workerModel;
    case 'mini':
      // fastModel > workerModel (向下兼容)
      return settings.fastModel?.trim() || settings.workerModel;
  }
}

/**
 * 从 feature 数据估算复杂度评分
 */
export function estimateFeatureComplexity(feature: any): number {
  let score = 3; // 基础

  const desc = (feature.description || '') + ' ' + (feature.title || '');
  const wordCount = desc.split(/\s+/).length;

  // 长描述 → 复杂
  if (wordCount > 100) score += 2;
  else if (wordCount > 50) score += 1;

  // 验收标准多 → 复杂
  let criteria: string[] = [];
  try { criteria = JSON.parse(feature.acceptance_criteria || '[]'); } catch {}
  if (criteria.length > 5) score += 2;
  else if (criteria.length > 3) score += 1;

  // 关键词加分
  const complexKeywords = ['database', '数据库', 'auth', '认证', 'websocket', '实时',
    'concurrent', '并发', 'queue', '队列', 'cache', '缓存', 'migration', '迁移',
    'encryption', '加密', 'streaming', 'async', 'state machine', '状态机'];
  const lowerDesc = desc.toLowerCase();
  for (const kw of complexKeywords) {
    if (lowerDesc.includes(kw)) { score += 1; break; }
  }

  return Math.min(10, score);
}
