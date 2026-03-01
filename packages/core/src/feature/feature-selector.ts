/**
 * FeatureSelector — 线程安全的 Feature 状态管理器
 * 
 * 移植自 agent-swarm 的 feature_selector.py，TypeScript 版
 * 
 * 职责:
 * - 维护 feature_list.json (索引层)
 * - 原子选择 + 锁定最优 feature
 * - 加载 feature 详情 (详情层)
 * - 统计进度
 */

import type { FeatureIndex, FeatureDetail, FeatureStatus } from '@agentforge/shared';
import { eventBus } from '@agentforge/shared';

export class FeatureSelector {
  private features: FeatureIndex[] = [];
  private locked = new Set<string>();  // 简易锁 (单进程场景)

  constructor(features?: FeatureIndex[]) {
    if (features) this.features = features;
  }

  /** 加载 feature 清单 */
  loadFeatures(features: FeatureIndex[]): void {
    this.features = features;
  }

  /** 获取所有 features */
  getAllFeatures(): FeatureIndex[] {
    return [...this.features];
  }

  /**
   * 选择并锁定最优 feature(s)
   * 
   * 选择策略 (from agent-swarm):
   * 1. priority 升序 (0=最高)
   * 2. 依赖已满足优先
   * 3. 同 group 且 ≥3 个可用时批量认领 (最多 maxGroupSize)
   */
  selectAndLock(agentId: string, preferGroups: boolean = true, maxGroupSize: number = 8): FeatureIndex[] | null {
    // 找出所有可用的 feature
    const passedIds = new Set(
      this.features.filter(f => f.status === 'passed').map(f => f.id)
    );

    const available = this.features.filter(f => {
      if (f.status !== 'todo') return false;
      if (this.locked.has(f.id)) return false;
      // 检查依赖是否都已完成
      return f.dependsOn.every(dep => passedIds.has(dep));
    });

    if (available.length === 0) return null;

    // 按 priority 排序
    available.sort((a, b) => a.priority - b.priority);

    // 尝试 group 批量选择
    if (preferGroups) {
      const groupCounts = new Map<string, FeatureIndex[]>();
      for (const f of available) {
        if (f.group) {
          if (!groupCounts.has(f.group)) groupCounts.set(f.group, []);
          groupCounts.get(f.group)!.push(f);
        }
      }

      for (const [_, grouped] of groupCounts) {
        if (grouped.length >= 3) {
          const selected = grouped.slice(0, maxGroupSize);
          for (const f of selected) {
            this.lock(f.id, agentId);
          }
          return selected;
        }
      }
    }

    // 单个选择
    const selected = available[0];
    this.lock(selected.id, agentId);
    return [selected];
  }

  /** 锁定 */
  private lock(featureId: string, agentId: string): void {
    this.locked.add(featureId);
    const feature = this.features.find(f => f.id === featureId);
    if (feature) {
      feature.status = 'locked';
      feature.lockedBy = agentId;
      eventBus.emit('feature:locked', { featureId, agentId });
    }
  }

  /** 解锁 (失败时调用) */
  unlock(featureIds: string[]): void {
    for (const fid of featureIds) {
      this.locked.delete(fid);
      const feature = this.features.find(f => f.id === fid);
      if (feature && feature.status === 'locked') {
        feature.status = 'todo';
        feature.lockedBy = null;
      }
    }
  }

  /** 标记通过 */
  markPassed(featureIds: string[], agentId: string): void {
    for (const fid of featureIds) {
      this.locked.delete(fid);
      const feature = this.features.find(f => f.id === fid);
      if (feature) {
        const from = feature.status;
        feature.status = 'passed';
        feature.lockedBy = null;
        eventBus.emit('feature:status-changed', { featureId: fid, from, to: 'passed' });
        eventBus.emit('feature:completed', { featureId: fid, agentId });
      }
    }
  }

  /** 回滚通过标记 (Evaluator 验证失败时) */
  revertPassed(featureIds: string[]): void {
    for (const fid of featureIds) {
      const feature = this.features.find(f => f.id === fid);
      if (feature && feature.status === 'passed') {
        feature.status = 'todo';
        feature.lockedBy = null;
      }
    }
  }

  /** 更新 feature 状态 */
  updateStatus(featureId: string, status: FeatureStatus): void {
    const feature = this.features.find(f => f.id === featureId);
    if (feature) {
      const from = feature.status;
      feature.status = status;
      if (status === 'todo') {
        feature.lockedBy = null;
        this.locked.delete(featureId);
      }
      eventBus.emit('feature:status-changed', { featureId, from, to: status });
    }
  }

  /** 统计 */
  getStats(): {
    total: number;
    passed: number;
    locked: number;
    available: number;
    failed: number;
    passRate: number;
  } {
    const total = this.features.length;
    const passed = this.features.filter(f => f.status === 'passed').length;
    const locked = this.features.filter(f => f.status === 'locked').length;
    const failed = this.features.filter(f => f.status === 'failed').length;
    const passedIds = new Set(
      this.features.filter(f => f.status === 'passed').map(f => f.id)
    );
    const available = this.features.filter(f =>
      f.status === 'todo' && f.dependsOn.every(dep => passedIds.has(dep))
    ).length;

    return {
      total,
      passed,
      locked,
      available,
      failed,
      passRate: total > 0 ? passed / total : 0,
    };
  }

  /** 是否全部完成 */
  allDone(): boolean {
    return this.features.length > 0 && this.features.every(f => f.status === 'passed');
  }
}
