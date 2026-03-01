import { useState, useEffect } from 'react';
import { useAppStore } from '../stores/app-store';

type Feature = {
  id: string; title: string; description: string; priority: number;
  category: string; status: string; locked_by: string | null;
};

const STATUS_COLS = [
  { key: 'todo',        label: '待做',   color: 'bg-slate-500',   ring: 'ring-slate-500/30' },
  { key: 'in_progress', label: '进行中', color: 'bg-blue-500',    ring: 'ring-blue-500/30' },
  { key: 'passed',      label: '已完成', color: 'bg-emerald-500', ring: 'ring-emerald-500/30' },
  { key: 'failed',      label: '失败',   color: 'bg-red-500',     ring: 'ring-red-500/30' },
];

export function BoardPage() {
  const { currentProjectId, featureStatuses } = useAppStore();
  const [features, setFeatures] = useState<Feature[]>([]);

  const load = async () => {
    if (!currentProjectId) return;
    const data = await window.agentforge.project.getFeatures(currentProjectId);
    setFeatures(data || []);
  };

  useEffect(() => { load(); }, [currentProjectId]);
  useEffect(() => { const t = setInterval(load, 4000); return () => clearInterval(t); }, [currentProjectId]);

  const enriched = features.map(f => ({
    ...f,
    status: featureStatuses.get(f.id) || f.status,
  }));

  if (!currentProjectId) {
    return <div className="h-full flex items-center justify-center text-slate-500"><p>请先在许愿台创建一个项目</p></div>;
  }

  const getByStatus = (s: string) => enriched.filter(f => f.status === s);
  const total = enriched.length;
  const passed = enriched.filter(f => f.status === 'passed').length;

  return (
    <div className="h-full flex flex-col p-6 gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">看板</h2>
        <div className="flex items-center gap-4">
          {total > 0 && (
            <div className="flex items-center gap-2">
              <div className="w-32 h-2 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 rounded-full transition-all duration-500" style={{ width: `${(passed / total) * 100}%` }} />
              </div>
              <span className="text-xs text-slate-400">{passed}/{total}</span>
            </div>
          )}
          <button onClick={load} className="text-sm text-slate-500 hover:text-slate-300">🔄</button>
        </div>
      </div>

      <div className="flex-1 flex gap-3 overflow-x-auto">
        {STATUS_COLS.map(col => {
          const items = getByStatus(col.key);
          return (
            <div key={col.key} className="flex-1 min-w-[220px] flex flex-col gap-2">
              <div className="flex items-center gap-2 px-2 py-1">
                <div className={`w-2 h-2 rounded-full ${col.color}`} />
                <span className="text-xs font-medium text-slate-400">{col.label}</span>
                <span className="text-[10px] text-slate-600 ml-auto">{items.length}</span>
              </div>
              <div className="flex-1 space-y-1.5 overflow-y-auto pr-1">
                {items.map(f => (
                  <div key={f.id} className="bg-slate-900 border border-slate-800 rounded-lg p-2.5 space-y-1 hover:border-slate-700 transition-colors">
                    <div className="flex items-start justify-between">
                      <span className="text-[10px] text-slate-600 font-mono">{f.id}</span>
                      <span className={`text-[10px] px-1 py-0.5 rounded ${f.priority === 0 ? 'bg-red-500/20 text-red-400' : f.priority === 1 ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-700 text-slate-500'}`}>P{f.priority}</span>
                    </div>
                    <p className="text-xs text-slate-300 leading-snug line-clamp-2">{f.title || f.description}</p>
                    {f.locked_by && <p className="text-[10px] text-forge-400">🔨 {f.locked_by}</p>}
                  </div>
                ))}
                {items.length === 0 && <div className="text-center py-6 text-slate-700 text-xs">—</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

