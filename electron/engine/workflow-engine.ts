/**
 * WorkflowEngine — DAG-driven 阶段执行引擎 (v25.0)
 *
 * 替代 orchestrator.ts 中的硬编码 if/else hasStage() 瀑布。
 * 根据 WorkflowStage[].transitions 驱动阶段间流转。
 *
 * 设计原则:
 *   1. 每个阶段有零或多个 transitions (success / failure / always)
 *   2. 无 transition 时默认: success → 数组中下一个, failure → 终止
 *   3. failure + maxRetries 支持 QA→Dev 循环
 *   4. 所有执行结果存入 phaseResults Map, 可供后续阶段消费
 *   5. Signal abort 在任何阶段间检查, 立即停止
 *
 * @module workflow-engine
 */

import { createLogger } from './logger';
import type {
  WorkflowStage,
  WorkflowStageId,
  WorkflowTransition,
  PhaseResult,
  PhaseStatus,
} from './types';

const log = createLogger('workflow-engine');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

/** 阶段执行器: 接受 stageId, 返回 PhaseResult (或 null 表示被中止) */
export type PhaseExecutor = (stageId: WorkflowStageId) => Promise<PhaseResult | null>;

/** 工作流执行结果 */
export interface WorkflowRunResult {
  /** 所有已执行阶段的结果 (按执行顺序) */
  results: PhaseResult[];
  /** 是否全部完成 (vs 被中止或失败) */
  completed: boolean;
  /** 终止原因 (如有) */
  terminationReason?: 'aborted' | 'stage_failed' | 'max_retries_exceeded';
  /** 总耗时 ms */
  durationMs: number;
}

// ═══════════════════════════════════════
// WorkflowEngine
// ═══════════════════════════════════════

export class WorkflowEngine {
  private stages: WorkflowStage[];
  private stageIndex: Map<WorkflowStageId, number>;
  private signal: AbortSignal;

  constructor(stages: WorkflowStage[], signal: AbortSignal) {
    this.stages = stages;
    this.signal = signal;
    this.stageIndex = new Map();
    stages.forEach((s, i) => this.stageIndex.set(s.id, i));
  }

  /**
   * 执行工作流 — 从第一个阶段开始, 按 transitions 驱动
   * @param executor - 阶段执行回调, 负责实际调用 phase 函数
   * @param onStageComplete - 可选: 每阶段完成后的回调 (用于 UI 通知)
   */
  async run(
    executor: PhaseExecutor,
    onStageComplete?: (result: PhaseResult, nextStageId: WorkflowStageId | null) => void,
  ): Promise<WorkflowRunResult> {
    const startTime = Date.now();
    const results: PhaseResult[] = [];
    const retryCounters = new Map<WorkflowStageId, number>();

    let currentIdx = 0;

    while (currentIdx < this.stages.length) {
      if (this.signal.aborted) {
        return { results, completed: false, terminationReason: 'aborted', durationMs: Date.now() - startTime };
      }

      const stage = this.stages[currentIdx];
      log.info(`[workflow] Executing stage: ${stage.id} (${stage.label})`);

      // 执行阶段
      const result = await executor(stage.id);

      // null = aborted during execution
      if (!result) {
        return { results, completed: false, terminationReason: 'aborted', durationMs: Date.now() - startTime };
      }

      results.push(result);
      log.info(`[workflow] Stage ${stage.id} completed: ${result.status} (${result.durationMs}ms)`);

      // 解析下一个阶段
      const nextStageId = this.resolveTransition(stage, result.status, retryCounters);

      if (onStageComplete) {
        onStageComplete(result, nextStageId);
      }

      if (nextStageId === null) {
        // 终止: 成功走完 (没有下一步) 或失败无 fallback
        if (result.status === 'failure') {
          // 检查是否因为 maxRetries 耗尽
          const retries = retryCounters.get(stage.id) ?? 0;
          const failTrans = stage.transitions?.find(t => t.condition === 'failure');
          if (failTrans && retries >= (failTrans.maxRetries ?? 3)) {
            return { results, completed: false, terminationReason: 'max_retries_exceeded', durationMs: Date.now() - startTime };
          }
          return { results, completed: false, terminationReason: 'stage_failed', durationMs: Date.now() - startTime };
        }
        // 成功且无后续 → 完成
        break;
      }

      // 跳转到目标阶段
      const targetIdx = this.stageIndex.get(nextStageId);
      if (targetIdx === undefined) {
        log.error(`[workflow] Transition target "${nextStageId}" not found in stages, terminating`);
        return { results, completed: false, terminationReason: 'stage_failed', durationMs: Date.now() - startTime };
      }
      currentIdx = targetIdx;
    }

    return { results, completed: true, durationMs: Date.now() - startTime };
  }

  /**
   * 解析 transition: 根据阶段结果状态 + transition 规则决定下一阶段
   * @returns 下一阶段 ID, 或 null 表示终止 (成功走完或失败无 fallback)
   */
  private resolveTransition(
    stage: WorkflowStage,
    status: PhaseStatus,
    retryCounters: Map<WorkflowStageId, number>,
  ): WorkflowStageId | null {
    const transitions = stage.transitions;

    if (!transitions || transitions.length === 0) {
      // 默认行为: success/partial/skipped → 数组中下一个, failure → 终止
      if (status === 'failure') return null;
      const currentIdx = this.stageIndex.get(stage.id)!;
      const nextIdx = currentIdx + 1;
      return nextIdx < this.stages.length ? this.stages[nextIdx].id : null;
    }

    // 有显式 transitions — 按优先级匹配
    const isSuccess = status === 'success' || status === 'partial' || status === 'skipped';
    const isFailure = status === 'failure';

    // 1. 尝试精确匹配 (success/failure)
    let matched: WorkflowTransition | undefined;
    if (isSuccess) {
      matched = transitions.find(t => t.condition === 'success');
    } else if (isFailure) {
      matched = transitions.find(t => t.condition === 'failure');
    }

    // 2. 回退到 always
    if (!matched) {
      matched = transitions.find(t => t.condition === 'always');
    }

    if (!matched) {
      // 无匹配 transition: success → 默认下一个, failure → 终止
      if (isSuccess) {
        const currentIdx = this.stageIndex.get(stage.id)!;
        const nextIdx = currentIdx + 1;
        return nextIdx < this.stages.length ? this.stages[nextIdx].id : null;
      }
      return null;
    }

    // 3. 检查 maxRetries (仅 failure 路径)
    if (isFailure && matched.maxRetries !== undefined) {
      const count = (retryCounters.get(stage.id) ?? 0) + 1;
      retryCounters.set(stage.id, count);
      if (count > matched.maxRetries) {
        log.warn(`[workflow] Stage ${stage.id} exceeded maxRetries (${matched.maxRetries}), terminating`);
        return null;
      }
    }

    return matched.target;
  }

  /** 获取阶段列表 (供 UI 显示进度) */
  getStages(): ReadonlyArray<WorkflowStage> {
    return this.stages;
  }
}

// ═══════════════════════════════════════
// 默认工作流预设 (带 DAG transitions)
// ═══════════════════════════════════════

/** 完整开发流程 — 线性 pipeline (无显式 transitions, 走默认 next) */
export const PRESET_FULL_DEVELOPMENT: WorkflowStage[] = [
  { id: 'pm_analysis', label: 'PM 需求分析', icon: '📋', color: '#3B82F6' },
  { id: 'architect', label: '架构设计', icon: '🏗️', color: '#8B5CF6' },
  { id: 'docs_gen', label: '文档生成', icon: '📝', color: '#10B981' },
  { id: 'dev_implement', label: '开发实现', icon: '⚡', color: '#F59E0B' },
  { id: 'pm_acceptance', label: 'PM 验收', icon: '✅', color: '#3B82F6' },
  { id: 'incremental_doc_sync', label: '文档同步', icon: '📄', color: '#10B981' },
  { id: 'devops_build', label: 'DevOps 部署', icon: '🚀', color: '#EF4444' },
  { id: 'finalize', label: '汇总', icon: '🎯', color: '#6B7280' },
];

/** 快速迭代流程 — 跳过架构和文档 */
export const PRESET_QUICK_ITERATION: WorkflowStage[] = [
  { id: 'pm_analysis', label: 'PM 需求分析', icon: '📋', color: '#3B82F6' },
  { id: 'dev_implement', label: '开发实现', icon: '⚡', color: '#F59E0B' },
  { id: 'finalize', label: '汇总', icon: '🎯', color: '#6B7280' },
];

/** QA 循环流程 — dev_implement 失败时回退重做 (最多 3 次) */
export const PRESET_QA_LOOP: WorkflowStage[] = [
  { id: 'pm_analysis', label: 'PM 需求分析', icon: '📋', color: '#3B82F6' },
  { id: 'architect', label: '架构设计', icon: '🏗️', color: '#8B5CF6' },
  { id: 'docs_gen', label: '文档生成', icon: '📝', color: '#10B981' },
  {
    id: 'dev_implement', label: '开发+QA', icon: '⚡', color: '#F59E0B',
    transitions: [
      { target: 'pm_acceptance', condition: 'success' },
      { target: 'dev_implement', condition: 'failure', maxRetries: 3 },
    ],
  },
  { id: 'pm_acceptance', label: 'PM 验收', icon: '✅', color: '#3B82F6' },
  { id: 'devops_build', label: 'DevOps 部署', icon: '🚀', color: '#EF4444' },
  { id: 'finalize', label: '汇总', icon: '🎯', color: '#6B7280' },
];
