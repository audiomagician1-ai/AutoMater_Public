import { useAppStore } from '../stores/app-store';

export function StatusBar({ stats }: { stats: any }) {
  const { currentProjectId, logs } = useAppStore();

  const f = stats?.features || {};
  const a = stats?.agents || {};
  const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
  const totalTokens = a.total_tokens ?? 0;
  const totalCost = a.total_cost ?? 0;

  return (
    <div className="h-7 bg-slate-900 border-t border-slate-800 flex items-center px-4 gap-5 text-[11px] text-slate-500 flex-shrink-0">
      {currentProjectId ? (
        <>
          <span>
            Features: <span className="text-emerald-400">{f.passed ?? 0}</span>
            <span className="text-slate-600">/{f.total ?? 0}</span>
          </span>
          {(f.in_progress ?? 0) > 0 && <span>开发: <span className="text-blue-400">{f.in_progress}</span></span>}
          {(f.reviewing ?? 0) > 0 && <span>审查: <span className="text-amber-400">{f.reviewing}</span></span>}
          {(f.failed ?? 0) > 0 && <span>失败: <span className="text-red-400">{f.failed}</span></span>}
          <span>Agents: {a.total ?? 0}</span>
          {totalTokens > 0 && <span>Tokens: {(totalTokens / 1000).toFixed(1)}k</span>}
          {totalCost > 0 && <span>成本: <span className="text-amber-400">${totalCost.toFixed(4)}</span></span>}
          <div className="flex-1 text-right truncate ml-4">
            {lastLog && <span className="text-slate-600">{lastLog.content}</span>}
          </div>
        </>
      ) : (
        <span>无活跃项目 — 在许愿台创建你的第一个项目</span>
      )}
    </div>
  );
}
