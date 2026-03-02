import type { Feature } from './types';

/** 7-stage pipeline definition aligned with orchestrator phases */
const PIPELINE_STAGES = [
  { key: 'pm_analysis',    label: 'PM 分析',      icon: '🧠', color: 'bg-blue-500' },
  { key: 'design_doc',     label: '设计文档',     icon: '📐', color: 'bg-violet-500' },
  { key: 'architecture',   label: '架构设计',     icon: '🏗️', color: 'bg-indigo-500' },
  { key: 'sub_reqs',       label: '需求拆分+测试', icon: '📋', color: 'bg-cyan-500' },
  { key: 'development',    label: '开发实现',     icon: '🔨', color: 'bg-amber-500' },
  { key: 'qa_review',      label: 'QA 审查',      icon: '🧪', color: 'bg-emerald-500' },
  { key: 'acceptance',     label: '验收',         icon: '🎯', color: 'bg-orange-500' },
] as const;

export { PIPELINE_STAGES };

function inferPipelineStage(projectStatus: string, features: Feature[]): number {
  if (!projectStatus || projectStatus === 'idle') return -1;

  const total = features.length;
  if (total === 0) {
    if (projectStatus === 'initializing') return 0;
    return 0;
  }

  const allPassed = features.every(f => f.status === 'passed');
  const anyDeveloping = features.some(f => f.status === 'in_progress');
  const anyReviewing = features.some(f => f.status === 'reviewing');
  const anyFailed = features.some(f => f.status === 'failed');
  const hasReqDocs = features.some(f => (f.requirement_doc_ver ?? 0) > 0);
  const hasTestSpecs = features.some(f => (f.test_spec_doc_ver ?? 0) > 0);

  if (projectStatus === 'awaiting_user_acceptance' || allPassed) return 6;
  if (anyReviewing) return 5;
  if (anyDeveloping || anyFailed) return 4;
  if (hasReqDocs || hasTestSpecs) return 3;
  if (total > 0 && projectStatus === 'developing') return 4;
  if (projectStatus === 'initializing') return 1;
  return 2;
}

export function PipelineBar({ projectStatus, features }: { projectStatus: string; features: Feature[] }) {
  const activeStage = inferPipelineStage(projectStatus, features);

  return (
    <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-800/80 rounded-xl p-4 hover:border-slate-700/60 transition-all duration-300">
      <h4 className="text-[10px] uppercase tracking-wider text-slate-500 mb-3">流水线进度</h4>
      <div className="flex items-center gap-1">
        {PIPELINE_STAGES.map((stage, i) => {
          const isCompleted = i < activeStage;
          const isActive = i === activeStage;
          const isFuture = i > activeStage;

          return (
            <div key={stage.key} className="flex items-center flex-1">
              <div className="flex flex-col items-center gap-1 flex-1 min-w-0">
                <div className={`
                  w-8 h-8 rounded-lg flex items-center justify-center text-sm transition-all
                  ${isCompleted ? `${stage.color} text-white shadow-lg` : ''}
                  ${isActive ? `${stage.color} text-white shadow-lg ring-2 ring-white/20 animate-pulse` : ''}
                  ${isFuture ? 'bg-slate-800 text-slate-600' : ''}
                `}>
                  {isCompleted ? '✓' : stage.icon}
                </div>
                <span className={`text-[9px] leading-none text-center truncate w-full ${
                  isActive ? 'text-slate-200 font-medium' : isCompleted ? 'text-slate-400' : 'text-slate-600'
                }`}>
                  {stage.label}
                </span>
              </div>

              {i < PIPELINE_STAGES.length - 1 && (
                <div className={`h-0.5 w-4 flex-shrink-0 ${
                  i < activeStage ? 'bg-slate-600' : 'bg-slate-800'
                }`} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
