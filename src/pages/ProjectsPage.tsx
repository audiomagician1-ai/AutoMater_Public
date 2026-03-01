import { useState, useEffect } from 'react';
import { useAppStore } from '../stores/app-store';

const STATUS_LABELS: Record<string, { text: string; color: string; icon: string }> = {
  initializing: { text: '分析中', color: 'text-blue-400',    icon: '🔵' },
  developing:   { text: '开发中', color: 'text-emerald-400', icon: '🟢' },
  reviewing:    { text: '审查中', color: 'text-amber-400',   icon: '🟡' },
  delivered:    { text: '已交付', color: 'text-green-400',   icon: '✅' },
  paused:       { text: '已暂停', color: 'text-slate-400',   icon: '⏸️' },
  error:        { text: '出错',   color: 'text-red-400',     icon: '❌' },
};

export function ProjectsPage() {
  const [wish, setWish] = useState('');
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState<any[]>([]);
  const [projectStats, setProjectStats] = useState<Record<string, any>>({});
  const { settingsConfigured, setGlobalPage, enterProject, addLog, clearLogs } = useAppStore();

  const loadProjects = async () => {
    const list = await window.agentforge.project.list();
    setProjects(list || []);
    const stats: Record<string, any> = {};
    for (const p of (list || [])) {
      try { stats[p.id] = await window.agentforge.project.getStats(p.id); } catch {}
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
    if (!settingsConfigured) { setGlobalPage('settings'); return; }

    setLoading(true);
    clearLogs();
    try {
      const result = await window.agentforge.project.create(wish.trim());
      if (result.success) {
        addLog({ projectId: result.projectId, agentId: 'system', content: `🎯 新项目: ${result.name}` });
        await window.agentforge.project.start(result.projectId);
        setWish('');
        enterProject(result.projectId, 'logs');
      }
    } catch (err: any) {
      addLog({ projectId: '', agentId: 'system', content: `❌ ${err.message}` });
    } finally {
      setLoading(false);
      loadProjects();
    }
  };

  const handleStop = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await window.agentforge.project.stop(id);
    loadProjects();
  };

  const handleResume = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await window.agentforge.project.start(id);
    enterProject(id, 'logs');
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await window.agentforge.project.delete(id);
    loadProjects();
  };

  const handleExport = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const result = await window.agentforge.project.export(id);
    if (result.success) addLog({ projectId: id, agentId: 'system', content: `📦 已导出: ${result.path}` });
  };

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      {/* 顶部 Hero */}
      <div className="px-8 pt-8 pb-6 border-b border-slate-800/50">
        <div className="max-w-3xl mx-auto space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-forge-500 to-forge-700 flex items-center justify-center text-lg font-bold shadow-lg shadow-forge-500/20">F</div>
            <div>
              <h1 className="text-2xl font-bold">AgentForge</h1>
              <p className="text-slate-500 text-xs">AI Agent 团队帮你实现软件需求</p>
            </div>
            <button onClick={() => setGlobalPage('settings')} className="ml-auto text-slate-500 hover:text-slate-300 transition-colors p-2 rounded-lg hover:bg-slate-800" title="设置">
              ⚙️
            </button>
          </div>

          {/* 新项目输入区 */}
          <div className="flex gap-2">
            <textarea
              value={wish}
              onChange={e => setWish(e.target.value)}
              placeholder="描述你的需求... (例: 一个 Todo App, 带用户认证和暗黑模式)"
              rows={2}
              className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-100 placeholder-slate-600 resize-none focus:outline-none focus:border-forge-500 transition-colors text-sm"
              onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) handleCreate(); }}
            />
            <button
              onClick={handleCreate}
              disabled={!wish.trim() || loading}
              className="px-5 py-2.5 rounded-lg font-medium text-sm transition-all self-end bg-forge-600 hover:bg-forge-500 text-white shadow-lg shadow-forge-600/20 disabled:bg-slate-800 disabled:text-slate-600 disabled:cursor-not-allowed disabled:shadow-none whitespace-nowrap"
            >
              {loading ? '⏳' : '🚀 新建项目'}
            </button>
          </div>

          {!settingsConfigured && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-amber-400 text-sm text-center">
              💡 首次使用请先 <button onClick={() => setGlobalPage('settings')} className="underline font-medium">配置 LLM</button>
            </div>
          )}
        </div>
      </div>

      {/* 项目网格 */}
      <div className="flex-1 px-8 py-6">
        <div className="max-w-5xl mx-auto">
          {projects.length === 0 ? (
            <div className="text-center py-20 text-slate-600">
              <p className="text-4xl mb-3">🏗️</p>
              <p className="text-lg">还没有项目</p>
              <p className="text-sm mt-1">在上方输入你的需求，AI 团队立即开始工作</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {projects.map(p => {
                const st = STATUS_LABELS[p.status] || { text: p.status, color: 'text-slate-500', icon: '⬜' };
                const isActive = p.status === 'initializing' || p.status === 'developing' || p.status === 'reviewing';
                const stats = projectStats[p.id];
                const f = stats?.features || {};
                const a = stats?.agents || {};
                const total = f.total ?? 0;
                const passed = f.passed ?? 0;
                const progress = total > 0 ? (passed / total) * 100 : 0;
                const cost = a.total_cost ?? 0;

                return (
                  <div
                    key={p.id}
                    onClick={() => enterProject(p.id)}
                    className="bg-slate-900 border border-slate-800 rounded-xl p-5 cursor-pointer transition-all hover:border-slate-600 hover:shadow-lg hover:shadow-slate-900/50 group"
                  >
                    {/* 状态徽章 */}
                    <div className="flex items-center justify-between mb-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full bg-slate-800 ${st.color}`}>
                        {isActive && <span className="inline-block w-1.5 h-1.5 rounded-full bg-current mr-1 animate-pulse" />}
                        {st.text}
                      </span>
                      <span className="text-[10px] text-slate-600">{new Date(p.created_at).toLocaleDateString()}</span>
                    </div>

                    {/* 需求描述 */}
                    <p className="text-sm text-slate-200 leading-snug line-clamp-3 mb-3 min-h-[3em]">{p.wish}</p>

                    {/* 进度条 */}
                    {total > 0 && (
                      <div className="mb-3">
                        <div className="flex justify-between text-[10px] text-slate-500 mb-1">
                          <span>{passed}/{total} features</span>
                          <span>{Math.round(progress)}%</span>
                        </div>
                        <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-700 ${progress >= 100 ? 'bg-green-500' : 'bg-forge-500'}`}
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* 底部操作 */}
                    <div className="flex items-center justify-between pt-2 border-t border-slate-800/50">
                      {cost > 0 && <span className="text-[10px] text-amber-500/70">${cost.toFixed(3)}</span>}
                      <div className="flex gap-1 ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
                        {isActive && (
                          <button onClick={e => handleStop(e, p.id)} className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-red-900/50 text-slate-400 hover:text-red-400 transition-colors" title="停止">⏹</button>
                        )}
                        {(p.status === 'paused' || p.status === 'error') && (
                          <button onClick={e => handleResume(e, p.id)} className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-emerald-900/50 text-slate-400 hover:text-emerald-400 transition-colors" title="继续">▶</button>
                        )}
                        {p.status === 'delivered' && (
                          <button onClick={e => handleExport(e, p.id)} className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-forge-900/50 text-slate-400 hover:text-forge-400 transition-colors" title="导出">📦</button>
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
          )}
        </div>
      </div>
    </div>
  );
}