import { useAppStore } from '../stores/app-store';

interface ProjectStats {
  features?: { total?: number; done?: number; in_progress?: number; reviewing?: number; passed?: number; failed?: number };
  agents?: { total?: number; total_tokens?: number; total_cost?: number; active_count?: number };
}

export function StatusBar({ stats }: { stats: ProjectStats | null }) {
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const logs = useAppStore(s => s.logs);

  const f = stats?.features || {};
  const a = stats?.agents || {};
  const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
  const totalTokens = a.total_tokens ?? 0;
  const totalCost = a.total_cost ?? 0;
  const isActive = (f.in_progress ?? 0) > 0 || (f.reviewing ?? 0) > 0;

  return (
    <div className="h-7 bg-slate-900/95 backdrop-blur-sm border-t border-slate-800/80 flex items-center px-4 gap-5 text-[11px] text-slate-500 flex-shrink-0 relative overflow-hidden">
      {/* Subtle gradient stripe */}
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-forge-500/[0.02] to-transparent pointer-events-none" />

      {/* Active indicator pulse */}
      {isActive && (
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-emerald-500 to-cyan-500 animate-breathe" />
      )}

      {currentProjectId ? (
        <>
          <span className="relative z-10">
            Features: <span className="text-emerald-400 font-medium">{f.passed ?? 0}</span>
            <span className="text-slate-600">/{f.total ?? 0}</span>
          </span>
          {(f.in_progress ?? 0) > 0 && <span className="relative z-10">开发: <span className="text-blue-400 font-medium">{f.in_progress}</span></span>}
          {(f.reviewing ?? 0) > 0 && <span className="relative z-10">审查: <span className="text-amber-400 font-medium">{f.reviewing}</span></span>}
          {(f.failed ?? 0) > 0 && <span className="relative z-10">失败: <span className="text-red-400 font-medium">{f.failed}</span></span>}
          <span className="relative z-10 flex items-center gap-1">
            <span className={`w-1 h-1 rounded-full ${isActive ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
            Agents: {a.total ?? 0}
          </span>
          {totalTokens > 0 && <span className="relative z-10">Tokens: {(totalTokens / 1000).toFixed(1)}k</span>}
          {totalCost > 0 && <span className="relative z-10">成本: <span className="text-amber-400">${totalCost.toFixed(4)}</span></span>}
          <div className="flex-1 text-right truncate ml-4 relative z-10">
            {lastLog && <span className="text-slate-600 animate-slide-in">{lastLog.content}</span>}
          </div>
        </>
      ) : (
        <span className="relative z-10">无活跃项目 — 在许愿台创建你的第一个项目</span>
      )}
    </div>
  );
}
