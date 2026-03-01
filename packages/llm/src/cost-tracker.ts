/**
 * Token & 成本追踪器
 * 
 * 参考 agent-swarm CostTracker:
 * - 持久化到 JSONL 文件
 * - 按 feature / agent / date 聚合
 * - 预算控制与告警
 */

import type { CostRecord, ModelConfig } from '@agentforge/shared';
import { eventBus } from '@agentforge/shared';

export class CostTracker {
  private records: CostRecord[] = [];
  private modelPricing = new Map<string, ModelConfig>();
  private budgetUsd: number;

  constructor(budgetUsd: number = 50) {
    this.budgetUsd = budgetUsd;
  }

  /** 注册模型定价 */
  registerModel(config: ModelConfig): void {
    this.modelPricing.set(config.id, config);
  }

  /** 计算并记录成本 */
  record(params: {
    agentId: string;
    featureIds: string[];
    model: string;
    inputTokens: number;
    outputTokens: number;
  }): CostRecord {
    const pricing = this.modelPricing.get(params.model);
    const costUsd = pricing
      ? (params.inputTokens / 1000) * pricing.inputPricePer1k
        + (params.outputTokens / 1000) * pricing.outputPricePer1k
      : 0;

    const record: CostRecord = {
      timestamp: new Date().toISOString(),
      agentId: params.agentId,
      featureIds: params.featureIds,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      costUsd,
    };

    this.records.push(record);

    // 发送事件
    const totalUsd = this.getTotalCost();
    eventBus.emit('cost:record', { agentId: params.agentId, costUsd, totalUsd });

    // 预算检查
    if (totalUsd >= this.budgetUsd * 0.8) {
      eventBus.emit('cost:budget-warning', { currentUsd: totalUsd, budgetUsd: this.budgetUsd });
    }

    return record;
  }

  /** 总成本 */
  getTotalCost(): number {
    return this.records.reduce((sum, r) => sum + r.costUsd, 0);
  }

  /** 按 Agent 聚合 */
  costByAgent(): Map<string, number> {
    const result = new Map<string, number>();
    for (const r of this.records) {
      result.set(r.agentId, (result.get(r.agentId) ?? 0) + r.costUsd);
    }
    return result;
  }

  /** 按 Feature 聚合 */
  costByFeature(): Map<string, number> {
    const result = new Map<string, number>();
    for (const r of this.records) {
      const share = r.costUsd / Math.max(r.featureIds.length, 1);
      for (const fid of r.featureIds) {
        result.set(fid, (result.get(fid) ?? 0) + share);
      }
    }
    return result;
  }

  /** 是否超预算 */
  isOverBudget(): boolean {
    return this.getTotalCost() >= this.budgetUsd;
  }

  /** 导出所有记录 */
  exportRecords(): CostRecord[] {
    return [...this.records];
  }

  /** 从记录恢复 */
  importRecords(records: CostRecord[]): void {
    this.records = [...records];
  }
}
