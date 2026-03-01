/**
 * Feature 管理类型定义
 * 
 * 两层清单架构 (from agent-swarm):
 * - 索引层: 轻量级，供 Orchestrator 调度
 * - 详情层: 完整信息，供 Worker Agent 按需读取
 */

export type FeaturePriority = 0 | 1 | 2;  // 0=最高, 2=最低

export type FeatureStatus =
  | 'todo'          // 待做
  | 'locked'        // 已锁定 (某个 Agent 正在做)
  | 'in_progress'   // 开发中
  | 'testing'       // 测试中
  | 'passed'        // 已通过
  | 'failed';       // 失败

/** 索引层 (轻量，全量加载) */
export interface FeatureIndex {
  id: string;                   // F001, F002, ...
  category: string;             // 功能分类
  priority: FeaturePriority;
  group: string | null;         // Feature Group 名称
  description: string;          // 简短描述
  dependsOn: string[];          // 依赖的 Feature ID
  status: FeatureStatus;
  lockedBy: string | null;      // Agent Instance ID
  notes: string;
}

/** 详情层 (按需读取) */
export interface FeatureDetail extends FeatureIndex {
  title: string;
  acceptanceCriteria: string[];
  testCommands: string[];
  affectedFiles: string[];
  estimatedTime: string;         // e.g. "15min", "1h"
  completedAt: string | null;
  /** 实现时 Agent 的代码输出摘要 */
  implementationSummary: string | null;
}

/** RFC (变更请求) — 参考 agent-swarm RFC 机制 */
export type RFCType = 'split' | 'merge' | 'modify' | 'add' | 'remove' | 'reorder';
export type RFCStatus = 'pending' | 'approved' | 'rejected' | 'applied';

export interface RFC {
  id: string;                    // RFC-001, RFC-002, ...
  type: RFCType;
  targetFeatureIds: string[];
  proposedBy: string;            // Agent ID
  reason: string;
  details: Record<string, unknown>;
  status: RFCStatus;
  createdAt: string;
  resolvedAt: string | null;
}
