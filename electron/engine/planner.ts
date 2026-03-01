/**
 * Planner — 任务规划器
 * 
 * 参考 EchoAgent 的 todo-plus 系统和 agent-swarm 的三阶段工作流:
 * - Feature 级别: PM 拆解大粒度 Feature
 * - 子任务级别: Planner 将 Feature 拆解为具体 steps
 * - 动态重规划: 失败后根据错误信息调整计划
 * 
 * v0.8: 初始实现
 * v3.0: 使用 output-parser 替代 regex，Schema 校验步骤结构
 */

import { parseStructuredOutput, PLAN_STEPS_SCHEMA } from './output-parser';

export interface PlanStep {
  id: string;
  description: string;
  tool?: string;       // 建议使用的工具
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  result?: string;
  retries: number;
}

export interface FeaturePlan {
  featureId: string;
  goal: string;
  steps: PlanStep[];
  currentStepIndex: number;
  maxRetries: number;
  totalRetries: number;
}

/**
 * 从 LLM 分析结果中解析出计划步骤
 * LLM 应返回 JSON 格式的步骤列表
 */
export function parsePlanFromLLM(rawOutput: string, featureId: string, goal: string): FeaturePlan {
  const steps: PlanStep[] = [];
  
  // v3.0: 使用结构化解析器替代 regex
  const parseResult = parseStructuredOutput<Array<{ description: string; tool?: string }>>(
    rawOutput,
    PLAN_STEPS_SCHEMA,
  );

  if (parseResult.ok) {
    for (let i = 0; i < parseResult.data.length; i++) {
      const s = parseResult.data[i];
      steps.push({
        id: `${featureId}-S${String(i + 1).padStart(2, '0')}`,
        description: s.description || String(s),
        tool: s.tool || undefined,
        status: 'pending',
        retries: 0,
      });
    }
  }

  // 如果解析失败，生成一个简单的默认计划
  if (steps.length === 0) {
    steps.push(
      { id: `${featureId}-S01`, description: '分析需求和现有代码', tool: 'list_files', status: 'pending', retries: 0 },
      { id: `${featureId}-S02`, description: '实现核心逻辑', tool: 'write_file', status: 'pending', retries: 0 },
      { id: `${featureId}-S03`, description: '验证实现', tool: 'run_command', status: 'pending', retries: 0 },
      { id: `${featureId}-S04`, description: '提交完成', tool: 'task_complete', status: 'pending', retries: 0 },
    );
  }

  return {
    featureId,
    goal,
    steps,
    currentStepIndex: 0,
    maxRetries: 3,
    totalRetries: 0,
  };
}

/**
 * 推进计划: 标记当前步骤完成，返回下一步
 */
export function advancePlan(plan: FeaturePlan, result: string): PlanStep | null {
  if (plan.currentStepIndex >= plan.steps.length) return null;

  const current = plan.steps[plan.currentStepIndex];
  current.status = 'done';
  current.result = result;

  plan.currentStepIndex++;
  if (plan.currentStepIndex >= plan.steps.length) return null;

  const next = plan.steps[plan.currentStepIndex];
  next.status = 'in_progress';
  return next;
}

/**
 * 标记当前步骤失败
 */
export function failCurrentStep(plan: FeaturePlan, error: string): boolean {
  if (plan.currentStepIndex >= plan.steps.length) return false;

  const current = plan.steps[plan.currentStepIndex];
  current.retries++;
  plan.totalRetries++;

  if (current.retries >= plan.maxRetries) {
    current.status = 'failed';
    current.result = error;
    return false; // 不可重试
  }

  // 可重试
  current.result = `失败(${current.retries}/${plan.maxRetries}): ${error}`;
  return true;
}

/**
 * 获取计划进度摘要 (用于上下文压缩)
 */
export function getPlanSummary(plan: FeaturePlan): string {
  const lines = [`## 计划: ${plan.goal}`];
  for (const step of plan.steps) {
    const statusIcon = step.status === 'done' ? '✅' : step.status === 'failed' ? '❌' : step.status === 'in_progress' ? '🔨' : '⬜';
    lines.push(`${statusIcon} ${step.id}: ${step.description}`);
    if (step.result && step.status === 'done') {
      // 压缩已完成步骤的结果
      const compressed = step.result.length > 100 ? step.result.slice(0, 100) + '...' : step.result;
      lines.push(`   → ${compressed}`);
    }
  }
  lines.push(`\n进度: ${plan.steps.filter(s => s.status === 'done').length}/${plan.steps.length} 步完成`);
  return lines.join('\n');
}

/**
 * PLANNER_SYSTEM_PROMPT — 让 LLM 为 Feature 制定详细执行计划
 */
export const PLANNER_SYSTEM_PROMPT = `你是一位资深技术规划师。你的任务是为一个 Feature 制定详细的执行计划。

## 可用工具
你可以规划使用以下工具:
- read_file: 读取文件
- write_file: 写入文件
- list_files: 列出目录
- search_files: 搜索文件内容
- run_command: 执行命令 (npm install, pytest, tsc 等)
- git_commit: 提交变更
- task_complete: 标记完成

## 输出格式
直接输出 JSON 数组 (不要 markdown 代码块)，每个步骤包含:
[
  {"description": "步骤描述", "tool": "建议工具名"},
  ...
]

## 规则
- 步骤数量控制在 3-8 步
- 第一步通常是"了解现有代码结构"(list_files 或 read_file)
- 最后一步必须是 task_complete
- 如果需要安装依赖，在写代码之前执行
- 考虑边界情况和错误处理`;
