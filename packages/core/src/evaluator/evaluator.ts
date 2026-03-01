/**
 * Evaluator — Post-session 验证器
 * 
 * 参考 agent-swarm evaluator.py:
 * - 验证 Worker 的输出是否真正完成了 Feature
 * - 生成重试 Prompt (含失败诊断)
 */

import type { FeatureDetail } from '@agentforge/shared';
import { eventBus } from '@agentforge/shared';

export interface EvalResult {
  verdict: 'pass' | 'partial' | 'fail' | 'error';
  passedIds: string[];
  failedIds: string[];
  shouldRetry: boolean;
  retryPrompt?: string;
  message: string;
}

export class Evaluator {
  private maxRetries: number;

  constructor(maxRetries: number = 3) {
    this.maxRetries = maxRetries;
  }

  /**
   * 评估 session 结果
   * 
   * 验证流程:
   * 1. 检查 session 是否成功完成 (没有进程崩溃)
   * 2. 检查输出是否包含预期的 acceptance criteria 标记
   * 3. (TODO) 运行独立测试验证
   */
  evaluate(params: {
    featureIds: string[];
    features: FeatureDetail[];
    agentId: string;
    sessionSuccess: boolean;
    output: string;
    attempt: number;
  }): EvalResult {
    const { featureIds, features, agentId, sessionSuccess, output, attempt } = params;

    // Session 崩溃
    if (!sessionSuccess) {
      const shouldRetry = attempt < this.maxRetries;
      return {
        verdict: 'error',
        passedIds: [],
        failedIds: featureIds,
        shouldRetry,
        retryPrompt: shouldRetry
          ? this.buildRetryPrompt(features, 'Session crashed or timed out. Please retry.')
          : undefined,
        message: 'Agent session failed (crash/timeout)',
      };
    }

    // 简单验证: 检查输出是否提及每个 feature ID
    const passedIds: string[] = [];
    const failedIds: string[] = [];

    for (const fid of featureIds) {
      // 基础判断: 输出中是否包含该 feature 的完成标记
      const hasFeatureRef = output.includes(fid);
      const hasCompletionMarker = output.toLowerCase().includes('completed')
        || output.toLowerCase().includes('done')
        || output.toLowerCase().includes('passed');

      if (hasFeatureRef && hasCompletionMarker) {
        passedIds.push(fid);
      } else {
        failedIds.push(fid);
      }
    }

    // 全部通过
    if (failedIds.length === 0) {
      eventBus.emit('eval:pass', { featureIds: passedIds, agentId });
      return {
        verdict: 'pass',
        passedIds,
        failedIds: [],
        shouldRetry: false,
        message: `All ${passedIds.length} features passed`,
      };
    }

    // 部分通过
    if (passedIds.length > 0) {
      eventBus.emit('eval:pass', { featureIds: passedIds, agentId });
    }

    const shouldRetry = attempt < this.maxRetries;
    if (shouldRetry) {
      const failedFeatures = features.filter(f => failedIds.includes(f.id));
      eventBus.emit('eval:retry', { featureIds: failedIds, agentId, attempt });
      return {
        verdict: 'partial',
        passedIds,
        failedIds,
        shouldRetry: true,
        retryPrompt: this.buildRetryPrompt(failedFeatures, `Features ${failedIds.join(', ')} were not clearly completed.`),
        message: `${passedIds.length} passed, ${failedIds.length} failed — will retry`,
      };
    }

    eventBus.emit('eval:fail', { featureIds: failedIds, agentId, reason: 'Max retries exceeded' });
    return {
      verdict: 'fail',
      passedIds,
      failedIds,
      shouldRetry: false,
      message: `${failedIds.length} features failed after ${attempt} attempts`,
    };
  }

  /**
   * 构建重试 Prompt (from agent-swarm Evaluator)
   * 包含: 失败原因 + acceptance criteria + affected_files
   */
  private buildRetryPrompt(failedFeatures: FeatureDetail[], reason: string): string {
    let prompt = `# RETRY — Previous attempt failed\n\n**Reason**: ${reason}\n\n`;
    prompt += '## Features to complete:\n\n';

    for (const f of failedFeatures) {
      prompt += `### ${f.id}: ${f.title}\n`;
      prompt += `**Acceptance Criteria** (ALL must be met):\n`;
      for (const c of f.acceptanceCriteria) {
        prompt += `- [ ] ${c}\n`;
      }
      if (f.testCommands.length > 0) {
        prompt += `\n**Test Commands**:\n`;
        for (const cmd of f.testCommands) {
          prompt += `- \`${cmd}\`\n`;
        }
      }
      prompt += '\n';
    }

    prompt += '**IMPORTANT**: When you complete each feature, explicitly state the feature ID and "COMPLETED".\n';
    return prompt;
  }
}
