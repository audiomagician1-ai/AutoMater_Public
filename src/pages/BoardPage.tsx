import { useState, useEffect } from 'react';
import { useAppStore } from '../stores/app-store';

type Feature = {
  id: string;
  title: string;
  description: string;
  priority: number;
  category: string;
  status: string;
  locked_by: string | null;
};

const STATUS_COLS = [
  { key: 'todo', label: '待做', color: 'bg-slate-500' },
  { key: 'in_progress', label: '进行中', color: 'bg-blue-500' },
  { key: 'passed', label: '已完成', color: 'bg-emerald-500' },
  { key: 'failed', label: '失败', color: 'bg-red-500' },
];

export function BoardPage() {
  const { currentProjectId, featureStatuses } = useAppStore();
  const [features, setFeatures] = useState<Feature[]>([]);
  const [loading, setLoading] = useState(false);

  const loadFeatures = async () => {
    if (!currentProjectId) return;
    setLoading(true);
    const data = await window.agentforge.project.getFeatures(currentProjectId);
    setFeatures(data || []);
    setLoading(false);
  };

  useEffect(() => { loadFeatures(); }, [currentProjectId]);

  // 合并实时状态
  const enrichedFeatures = features.map(f => ({
    ...f,
    status: featureStatuses.get(f.id) || f.status,
  }));

  if (!currentProjectId) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500">
        <p>请先在许愿台创建一个项目</p>
      </div>
    );
  }

  const getByStatus = (status: string) => enrichedFeatures.filter(f => f.status === status);

  return (
    <div className="h-full flex flex-col p-6 gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">看板</h2>
        <button onClick={loadFeatures} className="text-sm text-slate-400 hover:text-slate-200">🔄 刷新</button>
      </div>

      <div className="flex-1 flex gap-4 overflow-x-auto">
        {STATUS_COLS.map(col => {
          const items = getByStatus(col.key);
          return (
            <div key={col.key} className="flex-1 min-w-[240px] flex flex-col gap-2">
              {/* Column header */}
              <div className="flex items-center gap-2 px-2 py-1">
                <div className={`w-2.5 h-2.5 rounded-full ${col.color}`} />
                <span className="text-sm font-medium text-slate-300">{col.label}</span>
                <span className="text-xs text-slate-600 ml-auto">{items.length}</span>
              </div>

              {/* Cards */}
              <div className="flex-1 space-y-2 overflow-y-auto pr-1">
                {items.map(f => (
                  <div
                    key={f.id}
                    className="bg-slate-900 border border-slate-800 rounded-lg p-3 space-y-1.5 hover:border-slate-700 transition-colors"
                  >
                    <div className="flex items-start justify-between">
                      <span className="text-xs text-slate-500 font-mono">{f.id}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        f.priority === 0 ? 'bg-red-500/20 text-red-400' :
                        f.priority === 1 ? 'bg-amber-500/20 text-amber-400' :
                        'bg-slate-700 text-slate-400'
                      }`}>P{f.priority}</span>
                    </div>
                    <p className="text-sm text-slate-200 leading-snug">
                      {f.title || f.description}
                    </p>
                    {f.locked_by && (
                      <p className="text-xs text-forge-400">🔨 {f.locked_by}</p>
                    )}
                  </div>
                ))}
                {items.length === 0 && (
                  <div className="text-center py-8 text-slate-700 text-sm">空</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
