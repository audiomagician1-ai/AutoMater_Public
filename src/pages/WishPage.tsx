import { useState, useEffect } from 'react';
import { useAppStore } from '../stores/app-store';

const STATUS_LABELS: Record<string, { text: string; color: string; bg: string }> = {
  initializing: { text: '分析中', color: 'text-blue-400',    bg: 'bg-blue-500' },
  developing:   { text: '开发中', color: 'text-emerald-400', bg: 'bg-emerald-500' },
  reviewing:    { text: '审查中', color: 'text-amber-400',   bg: 'bg-amber-500' },
  delivered:    { text: '已交付', color: 'text-green-400',   bg: 'bg-green-500' },
  paused:       { text: '已暂停', color: 'text-slate-400',   bg: 'bg-slate-500' },
  error:        { text: '出错',   color: 'text-red-400',     bg: 'bg-red-500' },
};

export function WishPage() {
  const [wish, setWish] = useState('');
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState<any[]>([]);
  const [projectStats, setProjectStats] = useState<Record<string, any>>({});
  const { settingsConfigured, setPage, setCurrentProject, addLog, clearLogs, currentProjectId } = useAppStore();

  const loadProjects = async () => {
    const list = await window.agentforge.project.list();
    setProjects(list || []);
    // 加载每个项目的统计
    const stats: Record<string, any> = {};
    for (const p of (list || [])) {
      try {
        stats[p.id] = await window.agentforge.project.getStats(p.id);
      } catch { /* */ }
    }
    setProjectStats(stats);
  };

  useEffect(() => { loadProjects(); }, []);
  useEffect(() => {
    const t = setInterval(loadProjects, 6000);
    return () => clearInterval(t);
  }, []);

  const handleCreate = async () => {
    if (!wish.trim() || loading) return;
    if (!settingsConfigured) { setPage('settings'); return; }

    setLoading(true);
    clearLogs();
    try {
      const result = await window.agentforge.project.create(wish.trim());
      if (result.success) {
        setCurrentProject(result.projectId);
        addLog({ projectId: result.projectId, agentId: 'system', content: `🎯 新项目: ${result.name}` });
        await window.agentforge.project.start(result.projectId);
        setWish('');
        setPage('logs');
      }
    } catch (err: any) {
      addLog({ projectId: '', agentId: 'system', content: `❌ ${err.message}` });
    } finally {
      setLoading(false);
      loadProjects();
    }
  };

  const handleSelect = (id: string) => {
    setCurrentProject(id);
    setPage('board');
  };

  const handleStop = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await window.agentforge.project.stop(id);
    loadProjects();
  };

  const handleResume = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setCurrentProject(id);
    await window.agentforge.project.start(id);
    setPage('logs');
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await window.agentforge.project.delete(id);
    if (currentProjectId === id) setCurrentProject(null);
    loadProjects();
  };

  const handleExport = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const result = await window.agentforge.project.export(id);
    if (result.success) {
      addLog({ projectId: id, agentId: 'system', content: `📦 已导出: ${result.path}` });
    }
  };

  return (
    <div className="h-full flex flex-col p-6 gap-6 overflow-y-auto">
      {/* 创建区 */}
      <div className="max-w-2xl mx-auto w-full space-y-4">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold bg-gradient-to-r from-forge-400 to-purple-400 bg-clip-text text-transparent">
            AgentForge
          </h1>
          <p className="text-slate-500 text-sm">告诉我你想做什么，AI 团队帮你实现</p>
        </div>

        <div className="flex gap-2">
          <textarea
            value={wish}
            onChange={e => setWish(e.target.value)}
            placeholder="描述你的需求... (例: 一个 Todo App, 带用户认证和暗黑模式)"
            rows={3}
            className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-100 placeholder-slate-600 resize-none focus:outline-none focus:border-forge-500 transition-colors text-sm"
            onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) handleCreate(); }}
          />
          <button
            onClick={handleCreate}
            disabled={!wish.trim() || loading}
            className="px-5 py-2.5 rounded-lg font-medium text-sm transition-all self-end bg-forge-600 hover:bg-forge-500 text-white shadow-lg shadow-forge-600/20 disabled:bg-slate-800 disabled:text-slate-600 disabled:cursor-not-allowed disabled:shadow-none"
          >
            {loading ? '⏳' : '🚀 许愿'}
          </button>
        </div>

        {!settingsConfigured && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-amber-400 text-sm text-center">
            💡 首次使用请先 <button onClick={() => setPage('settings')} className="underline font-medium">配置 LLM</button>
          </div>
        )}
      </div>

      {/* 项目列表 */}
      {projects.length > 0 && (
        <div className="max-w-2xl mx-auto w-full space-y-3">
          <h3 className="text-sm font-medium text-slate-400">项目列表 ({projects.length})</h3>
          <div className="space-y-2">
            {projects.map(p => {
              const st = STATUS_LABELS[p.status] || { text: p.status, color: 'text-slate-500', bg: 'bg-slate-500' };
              const isActive = p.status === 'initializing' || p.status === 'developing' || p.status === 'reviewing';
              const isSelected = currentProjectId === p.id;
              const stats = projectStats[p.id];
              const featureStats = stats?.features || {};
              const agentStats = stats?.agents || {};
              const total = featureStats.total ?? 0;
              const passed = featureStats.passed ?? 0;
              const progress = total > 0 ? (passed / total) * 100 : 0;
              const cost = agentStats.total_cost ?? 0;

              return (
                <div
                  key={p.id}
                  onClick={() => handleSelect(p.id)}
                  className={`bg-slate-900 border rounded-lg p-4 cursor-pointer transition-all hover:border-slate-600 ${isSelected ? 'border-forge-500/50' : 'border-slate-800'}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-200 leading-snug">{p.wish}</p>
                      <div className="flex items-center gap-3 mt-2">
                        <span className={`text-xs font-medium ${st.color}`}>
                          {isActive && <span className="inline-block w-1.5 h-1.5 rounded-full bg-current mr-1 animate-pulse" />}
                          {st.text}
                        </span>
                        {total > 0 && (
                          <span className="text-xs text-slate-500">
                            {passed}/{total} features
                          </span>
                        )}
                        {cost > 0 && (
                          <span className="text-xs text-amber-500/70">${cost.toFixed(3)}</span>
                        )}
                        <span className="text-xs text-slate-600">{new Date(p.created_at).toLocaleDateString()}</span>
                      </div>
                      {/* 进度条 */}
                      {total > 0 && (
                        <div className="mt-2 w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-700 ${progress >= 100 ? 'bg-green-500' : 'bg-forge-500'}`}
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      )}
                    </div>
                    <div className="flex gap-1 flex-shrink-0 flex-wrap justify-end" style={{ maxWidth: '120px' }}>
                      {isActive && (
                        <button onClick={e => handleStop(e, p.id)} className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-red-900/50 text-slate-400 hover:text-red-400 transition-colors" title="停止">⏹</button>
                      )}
                      {(p.status === 'paused' || p.status === 'error') && (
                        <button onClick={e => handleResume(e, p.id)} className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-emerald-900/50 text-slate-400 hover:text-emerald-400 transition-colors" title="继续">▶</button>
                      )}
                      {p.status === 'delivered' && (
                        <button onClick={e => handleExport(e, p.id)} className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-forge-900/50 text-slate-400 hover:text-forge-400 transition-colors" title="导出 zip">📦</button>
                      )}
                      {!isActive && (
                        <button onClick={e => handleDelete(e, p.id)} className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-red-900/50 text-slate-400 hover:text-red-400 transition-colors" title="删除">🗑</button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

