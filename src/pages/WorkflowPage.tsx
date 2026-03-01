/**
 * WorkflowPage — 需求全生命周期工作流可视化
 *
 * 展示需求从提出到完成经过的每个 Agent 节点，
 * 以及每个 Agent 执行的具体内容。
 * 包含模拟按钮触发一次完整的需求流转演示。
 */

import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../stores/app-store';

// ═══════════════════════════════════════
// Pipeline stages definition
// ═══════════════════════════════════════

interface PipelineStage {
  id: string;
  agent: string;
  icon: string;
  label: string;
  description: string;
  color: string;
  outputs: string[];
}

const PIPELINE: PipelineStage[] = [
  { id: 'intake',    agent: '元Agent',   icon: '🤖', label: '需求接收',     description: '用户一站式交互入口：提交需求→路由给团队；查询设计/架构/进度→按需调取项目文档。默认轻量上下文，按需懒加载项目详情', color: 'bg-forge-500', outputs: ['需求文本', '路由决策', '查询结果'] },
  { id: 'pm',        agent: 'PM Agent',  icon: '🧠', label: 'PM 分析',      description: '产品经理加载项目上下文，判断新需求/变更迭代，拆分功能模块、定义验收标准', color: 'bg-violet-500', outputs: ['Feature 清单', '分诊结果', '验收标准'] },
  { id: 'architect', agent: 'Architect', icon: '🏗️', label: '架构+设计',   description: '架构师同时生成产品设计文档和技术架构文档，一次调用完成双重职责', color: 'bg-blue-500', outputs: ['设计文档', 'ARCHITECTURE.md', '技术选型'] },
  { id: 'docs',      agent: 'PM + QA',   icon: '📋', label: '批量文档',     description: '批量生成子需求文档和测试规格（每 5 个 Feature 一组，减少 60%+ 调用次数）', color: 'bg-cyan-500', outputs: ['子需求文档', '测试规格', '一致性检查'] },
  { id: 'dev',       agent: 'Developer', icon: '💻', label: '开发实现',     description: '开发者通过 ReAct 多轮工具调用（内嵌规划，不再独立 planning），编写代码、运行测试', color: 'bg-amber-500', outputs: ['源代码文件', '单元测试', 'Git 提交'] },
  { id: 'qa',        agent: 'QA + PM',   icon: '🧪', label: 'QA + PM 验收', description: 'QA 审查代码质量 → PM 批量验收（每 4 个 Feature 一组），双重质量闭环', color: 'bg-emerald-500', outputs: ['审查报告', '验收裁决', '通过/驳回'] },
  { id: 'accept',    agent: '用户',      icon: '🎯', label: '用户验收',     description: '所有 Feature 通过 QA + PM 审查后，用户进行最终验收', color: 'bg-orange-500', outputs: ['验收决定', '交付产出'] },
];

type SimState = 'idle' | 'running' | 'done';

interface SimStageState {
  status: 'pending' | 'active' | 'done';
  detail?: string;
}

// ═══════════════════════════════════════
// Main WorkflowPage
// ═══════════════════════════════════════

export function WorkflowPage() {
  const { currentProjectId } = useAppStore();
  const [simState, setSimState] = useState<SimState>('idle');
  const [stageStates, setStageStates] = useState<Record<string, SimStageState>>({});
  const [activeStageId, setActiveStageId] = useState<string | null>(null);

  // Initialize all as pending
  useEffect(() => {
    const init: Record<string, SimStageState> = {};
    PIPELINE.forEach(s => { init[s.id] = { status: 'pending' }; });
    setStageStates(init);
  }, []);

  // Simulation runner
  const handleSimulate = useCallback(async () => {
    setSimState('running');
    const states: Record<string, SimStageState> = {};
    PIPELINE.forEach(s => { states[s.id] = { status: 'pending' }; });

    for (const stage of PIPELINE) {
      states[stage.id] = { status: 'active', detail: `${stage.agent} 正在执行...` };
      setStageStates({ ...states });
      setActiveStageId(stage.id);

      // Simulate work (1.2s per stage)
      await new Promise(r => setTimeout(r, 1200));

      states[stage.id] = { status: 'done', detail: `${stage.outputs.join(', ')} ✓` };
      setStageStates({ ...states });
    }

    setActiveStageId(null);
    setSimState('done');
  }, []);

  const handleReset = () => {
    setSimState('idle');
    setActiveStageId(null);
    const init: Record<string, SimStageState> = {};
    PIPELINE.forEach(s => { init[s.id] = { status: 'pending' }; });
    setStageStates(init);
  };

  if (!currentProjectId) {
    return <div className="h-full flex items-center justify-center text-slate-500">请先选择一个项目</div>;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-bold text-slate-100">🔄 工作流</h1>
          <p className="text-xs text-slate-500 mt-0.5">需求从提出到交付的完整生命周期</p>
        </div>
        <div className="flex gap-2">
          {simState === 'idle' && (
            <button
              onClick={handleSimulate}
              className="px-4 py-2 rounded-lg bg-forge-600 hover:bg-forge-500 text-white text-sm transition-all flex items-center gap-2"
            >
              ▶ 模拟流转
            </button>
          )}
          {simState === 'running' && (
            <div className="flex items-center gap-2 text-sm text-forge-400">
              <span className="w-2 h-2 rounded-full bg-forge-400 animate-pulse" />
              模拟运行中...
            </div>
          )}
          {simState === 'done' && (
            <button
              onClick={handleReset}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm transition-all"
            >
              ⟲ 重置
            </button>
          )}
        </div>
      </div>

      {/* Pipeline visualization */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-4xl mx-auto space-y-0">
          {PIPELINE.map((stage, i) => {
            const ss = stageStates[stage.id] || { status: 'pending' };
            const isActive = ss.status === 'active';
            const isDone = ss.status === 'done';
            const isSelected = activeStageId === stage.id;

            return (
              <div key={stage.id}>
                {/* Stage card */}
                <div
                  className={`relative flex items-start gap-4 p-4 rounded-xl border transition-all cursor-pointer ${
                    isActive ? 'border-forge-500/50 bg-forge-500/5 ring-1 ring-forge-500/20 shadow-lg shadow-forge-500/10' :
                    isDone ? 'border-emerald-500/30 bg-emerald-500/5' :
                    'border-slate-800 bg-slate-900/30 hover:border-slate-700'
                  }`}
                  onClick={() => setActiveStageId(activeStageId === stage.id ? null : stage.id)}
                >
                  {/* Icon */}
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-xl shrink-0 ${
                    isDone ? 'bg-emerald-500/20' : isActive ? `${stage.color}/20` : 'bg-slate-800/50'
                  }`}>
                    {isDone ? '✅' : stage.icon}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-bold text-slate-200">{stage.label}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">{stage.agent}</span>
                      {isActive && <span className="text-[10px] text-forge-400 animate-pulse">● 执行中</span>}
                      {isDone && <span className="text-[10px] text-emerald-400">✓ 完成</span>}
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">{stage.description}</p>

                    {/* Outputs */}
                    {(isSelected || isDone) && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {stage.outputs.map(o => (
                          <span key={o} className={`text-[10px] px-2 py-0.5 rounded-lg border ${
                            isDone ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/5' : 'border-slate-700 text-slate-500 bg-slate-800/50'
                          }`}>{o}</span>
                        ))}
                      </div>
                    )}

                    {/* Simulation detail */}
                    {ss.detail && (
                      <div className={`mt-2 text-[10px] ${isDone ? 'text-emerald-400/70' : 'text-forge-400/70'}`}>
                        {ss.detail}
                      </div>
                    )}
                  </div>
                </div>

                {/* Connector arrow */}
                {i < PIPELINE.length - 1 && (
                  <div className="flex justify-center py-1">
                    <div className={`w-0.5 h-6 ${isDone ? 'bg-emerald-500/30' : 'bg-slate-800'} transition-colors`} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}