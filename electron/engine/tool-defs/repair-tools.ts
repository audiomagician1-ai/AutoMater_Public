/**
 * Repair Tools — 管家自动修复管理工具 (v34.0)
 *
 * 提供给管家 Admin 模式的修复管理工具定义:
 *   - repair_diagnostics: 手动触发健康诊断
 *   - repair_history: 查看修复历史
 *   - repair_stats: 查看修复统计
 *   - repair_run_l1: 手动执行 L1 修复动作
 *   - repair_trigger_l3: 手动触发 L3 深度自修复
 */

import type { ToolDef } from './types';

export const REPAIR_TOOLS: ToolDef[] = [
  {
    name: 'repair_diagnostics',
    description:
      '手动执行健康诊断 — 扫描所有活跃项目，检测 7 种异常模式 (Feature循环失败/QA无限reject/Worker批量死亡/项目停滞/LLM连接失败/资源枯竭/僵尸Feature)。' +
      '返回检测到的异常列表及建议修复级别。可选指定项目 ID 进行单项目诊断。',
    parameters: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: '可选：仅诊断指定项目（留空扫描所有项目）',
        },
        auto_fix: {
          type: 'boolean',
          description: '是否自动执行建议的修复动作（默认 false，仅诊断不修复）',
        },
      },
    },
  },
  {
    name: 'repair_history',
    description:
      '查看项目的自动修复历史记录 — 包括修复动作、级别、状态(成功/失败)、token消耗、时间等。',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '项目 ID' },
        limit: { type: 'number', description: '返回记录数（默认 20）' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'repair_stats',
    description:
      '查看修复统计摘要 — 按级别(L1/L2/L3)和异常模式汇总修复次数、成功率。可指定项目或全局。',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '可选：指定项目（留空查看全局统计）' },
      },
    },
  },
  {
    name: 'repair_run_l1',
    description:
      '手动执行一个 L1 程序化修复动作。可用动作: release_lock(释放锁), restart_session(重启调度), reset_feature(重置Feature), ' +
      'switch_model(切换模型), mark_blocked(标记阻塞), adjust_scheduler(调整调度), gc_sessions(清理session)。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'release_lock',
            'restart_session',
            'reset_feature',
            'switch_model',
            'mark_blocked',
            'adjust_scheduler',
            'gc_sessions',
          ],
          description: '修复动作类型',
        },
        project_id: { type: 'string', description: '目标项目 ID' },
        feature_id: { type: 'string', description: '目标 Feature ID（部分动作需要）' },
        reason: { type: 'string', description: '修复原因说明' },
      },
      required: ['action', 'project_id'],
    },
  },
  {
    name: 'repair_trigger_l3',
    description:
      '手动触发 L3 深度自修复 — 使用 LLM 分析错误日志和源代码，在安全 git 分支上生成修复代码，' +
      '通过 tsc + vitest 质量门验证后自动合并。失败自动回滚。⚠️ 这会实际修改引擎源代码，请确认后执行。',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '相关项目 ID' },
        anomaly_pattern: {
          type: 'string',
          description: '异常模式（从 repair_diagnostics 获取）',
        },
        detail: {
          type: 'string',
          description: '错误详情描述（帮助 LLM 定位问题）',
        },
      },
      required: ['project_id', 'anomaly_pattern', 'detail'],
    },
  },
];
