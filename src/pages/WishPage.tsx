import { useState, useEffect } from 'react';
import { useAppStore } from '../stores/app-store';

const STATUS_LABELS: Record<string, { text: string; color: string }> = {
  initializing: { text: '分析中', color: 'text-blue-400' },
  developing:   { text: '开发中', color: 'text-emerald-400' },
  reviewing:    { text: '审查中', color: 'text-amber-400' },
  delivered:    { text: '已交付', color: 'text-green-400' },
  paused:       { text: '已暂停', color: 'text-slate-400' },
  error:        { text: '出错',   color: 'text-red-400' },
};

export function WishPage() {
  const { currentProjectId, addLog, clearLogs, settingsConfigured, setGlobalPage, setProjectPage } = useAppStore();
  const [project, setProject] = useState<any>(null);
  const [wish, setWish] = useState('');
  const [loading, setLoading] = useState(false);

  const loadProject = async () => {
    if (!currentProjectId) return;
    const p = await window.agentforge.project.get(currentProjectId);
    setProject(p);
  };

  useEffect(() => { loadProject(); }, [currentProjectId]);
  useEffect(() => {
    const t = setInterval(loadProject, 5000);
    return () => clearInterval(t);
  }, [currentProjectId]);

  const handleNewWish = async () => {
    if (!wish.trim() || loading || !currentProjectId) return;
    // TODO: 未来支持在已有项目中追加需求
    // 目前功能: 重新许愿 = 停止旧的 + 重新开始
    setLoading(true);
    clearLogs();
    try {
      await window.agentforge.project.stop(currentProjectId);
      // 在此项目中重新开始
      await window.agentforge.project.start(currentProjectId);
      setWish('');
      setProjectPage('logs');
    } catch (err: any) {
      addLog({ projectId: currentProjectId, agentId: 'system', content: `❌ ${err.message}` });
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    if (!currentProjectId) return;
    await window.agentforge.project.stop(currentProjectId);
    loadProject();
  };

  const handleResume = async () => {
    if (!currentProjectId) return;
    await window.agentforge.project.start(currentProjectId);
    setProjectPage('logs');
  };

  if (!currentProjectId || !project) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500">
        <p>加载中...</p>
      </div>
    );
  }

  const st = STATUS_LABELS[project.status] || { text: project.status, color: 'text-slate-500' };
  const isActive = project.status === 'initializing' || project.status === 'developing' || project.status === 'reviewing';

  return (
    <div className="h-full flex flex-col p-8 gap-6 overflow-y-auto">
      <div className="max-w-2xl mx-auto w-full space-y-6">
        {/* 当前项目信息 */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-200">当前许愿</h2>
              <span className={`text-xs font-medium mt-1 inline-block ${st.color}`}>
                {isActive && <span className="inline-block w-1.5 h-1.5 rounded-full bg-current mr-1 animate-pulse" />}
                {st.text}
              </span>
            </div>
            <div className="flex gap-2">
              {isActive && (
                <button onClick={handleStop} className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-red-900/50 text-slate-400 hover:text-red-400 transition-colors">
                  ⏹ 停止
                </button>
              )}
              {(project.status === 'paused' || project.status === 'error') && (
                <button onClick={handleResume} className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-emerald-900/50 text-slate-400 hover:text-emerald-400 transition-colors">
                  ▶ 继续
                </button>
              )}
            </div>
          </div>
          <p className="text-sm text-slate-300 leading-relaxed bg-slate-800/40 rounded-lg p-4">{project.wish}</p>
          <div className="text-xs text-slate-600">创建于 {new Date(project.created_at).toLocaleString()}</div>
        </div>

        {/* 追加需求 (预留) */}
        <div className="bg-slate-900/50 border border-dashed border-slate-700 rounded-xl p-6 space-y-3">
          <h3 className="text-sm font-medium text-slate-400">继续许愿（续跑当前项目）</h3>
          <div className="flex gap-2">
            <textarea
              value={wish}
              onChange={e => setWish(e.target.value)}
              placeholder="追加需求或修改方向..."
              rows={2}
              className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-100 placeholder-slate-600 resize-none focus:outline-none focus:border-forge-500 transition-colors text-sm"
              onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) handleNewWish(); }}
            />
            <button
              onClick={handleResume}
              disabled={isActive}
              className="px-4 py-2 rounded-lg font-medium text-sm transition-all self-end bg-forge-600 hover:bg-forge-500 text-white shadow-lg shadow-forge-600/20 disabled:bg-slate-800 disabled:text-slate-600 disabled:cursor-not-allowed disabled:shadow-none whitespace-nowrap"
            >
              {loading ? '⏳' : '▶ 续跑'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

