import { useState, useEffect } from 'react';
import type { Feature } from './types';

export function DocCompletionBar({ features, projectId }: { features: Feature[]; projectId: string }) {
  const [docStats, setDocStats] = useState<{ design: boolean; reqCount: number; testCount: number }>({
    design: false, reqCount: 0, testCount: 0,
  });

  useEffect(() => {
    if (!projectId) return;
    window.automater.project.listAllDocs(projectId).then(docs => {
      setDocStats({
        design: (docs?.design?.length ?? 0) > 0,
        reqCount: docs?.requirements?.length ?? 0,
        testCount: docs?.testSpecs?.length ?? 0,
      });
    }).catch(() => {});
  }, [projectId]);

  const total = features.length;
  const reqCoverage = total > 0 ? Math.round((docStats.reqCount / total) * 100) : 0;
  const testCoverage = total > 0 ? Math.round((docStats.testCount / total) * 100) : 0;

  return (
    <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-800/80 rounded-xl p-4 hover:border-slate-700/60 transition-all duration-300">
      <h4 className="text-[10px] uppercase tracking-wider text-slate-500 mb-3">文档完成度</h4>
      <div className="grid grid-cols-3 gap-4">
        {/* Design doc */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">📐 设计文档</span>
            <span className={docStats.design ? 'text-emerald-400' : 'text-slate-600'}>
              {docStats.design ? '✓ 已生成' : '— 待生成'}
            </span>
          </div>
          <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-500 ${docStats.design ? 'w-full bg-violet-500' : 'w-0'}`} />
          </div>
        </div>

        {/* Requirement docs */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">📋 需求文档</span>
            <span className="text-slate-500">{docStats.reqCount}/{total}</span>
          </div>
          <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-500"
              style={{ width: `${reqCoverage}%` }}
            />
          </div>
        </div>

        {/* Test specs */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">🧪 测试规格</span>
            <span className="text-slate-500">{docStats.testCount}/{total}</span>
          </div>
          <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-500"
              style={{ width: `${testCoverage}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
