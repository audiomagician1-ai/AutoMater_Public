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
  const [saving, setSaving] = useState(false);

  const loadProject = async () => {
    if (!currentProjectId) return;
    const p = await window.agentforge.project.get(currentProjectId);
    setProject(p);
    // 如果用户还没编辑过，则用已保存的 wish 填充
    if (p?.wish && !wish) setWish(p.wish);
  };

  useEffect(() => { loadProject(); }, [currentProjectId]);
  useEffect(() => {
    const t = setInterval(loadProject, 5000);
    return () => clearInterval(t);
  }, [currentProjectId]);

  /** 保存需求 (不启动) */
  const handleSaveWish = async () => {
    if (!wish.trim() || !currentProjectId) return;
    setSaving(true);
    try {
      await window.agentforge.project.setWish(currentProjectId, wish.trim());
      addLog({ projectId: currentProjectId, agentId: 'system', content: '✨ 需求已保存' });
    } catch (err: any) {
      addLog({ projectId: currentProjectId, agentId: 'system', content: `❌ ${err.message}` });
    } finally {
      setSaving(false);
      loadProject();
    }
  };

  /** 保存需求并启动 Agent */
  const handleStartWish = async () => {
    if (!wish.trim() || loading || !currentProjectId) return;
    if (!settingsConfigured) { setGlobalPage('settings'); return; }

    setLoading(true);
    clearLogs();
    try {
      // 先保存需求
      await window.agentforge.project.setWish(currentProjectId, wish.trim());
      // 启动 Agent 编排
      await window.agentforge.project.start(currentProjectId);
      addLog({ projectId: currentProjectId, agentId: 'system', content: `🚀 Agent 团队开始工作: ${wish.trim().slice(0, 60)}...` });
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
  const hasExistingWish = !!project.wish?.trim();

  return (
    <div className="h-full flex flex-col p-8 gap-6 overflow-y-auto">
      <div className="max-w-2xl mx-auto w-full space-y-6">
        {/* 项目信息头 */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-200">{project.name}</h2>
            <div className="flex items-center gap-3 mt-1">
              <span className={`text-xs font-medium ${st.color}`}>
                {isActive && <span className="inline-block w-1.5 h-1.5 rounded-full bg-current mr-1 animate-pulse" />}
                {st.text}
              </span>
              <span className="text-[10px] text-slate-600 font-mono">{project.workspace_path}</span>
            </div>
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

        {/* 需求输入区 */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-300">
              {hasExistingWish ? '编辑需求' : '描述你的需求'}
            </h3>
            {hasExistingWish && (
              <span className="text-[10px] text-slate-600">上次更新: {new Date(project.updated_at).toLocaleString()}</span>
            )}
          </div>

          <textarea
            value={wish}
            onChange={e => setWish(e.target.value)}
            placeholder="详细描述你想要实现的软件需求...&#10;&#10;例: 一个 Todo App，带用户认证、暗黑模式、实时同步，使用 React + Express + PostgreSQL 技术栈"
            rows={8}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-slate-100 placeholder-slate-600 resize-y focus:outline-none focus:border-forge-500 transition-colors text-sm leading-relaxed"
            onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) handleStartWish(); }}
          />

          <div className="flex items-center justify-between">
            <p className="text-[10px] text-slate-600">
              Ctrl+Enter 保存并启动 · 描述越详细，Agent 输出质量越高
            </p>
            <span className="text-[10px] text-slate-600">{wish.length} 字符</span>
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleStartWish}
              disabled={!wish.trim() || loading}
              className="flex-1 py-2.5 rounded-lg font-medium text-sm transition-all bg-forge-600 hover:bg-forge-500 text-white shadow-lg shadow-forge-600/20 disabled:bg-slate-800 disabled:text-slate-600 disabled:cursor-not-allowed disabled:shadow-none"
            >
              {loading ? '⏳ 启动中...' : '🚀 保存并启动 Agent'}
            </button>
            <button
              onClick={handleSaveWish}
              disabled={!wish.trim() || saving}
              className="px-4 py-2.5 rounded-lg text-sm text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 transition-all disabled:opacity-40"
            >
              {saving ? '保存中...' : '💾 仅保存'}
            </button>
          </div>
        </div>

        {/* 已有需求预览 */}
        {hasExistingWish && project.wish !== wish && (
          <div className="bg-slate-900/50 border border-dashed border-slate-700 rounded-xl p-4">
            <h4 className="text-[10px] font-medium text-slate-500 mb-2">已保存的需求 (未修改)</h4>
            <p className="text-xs text-slate-400 leading-relaxed whitespace-pre-wrap">{project.wish}</p>
          </div>
        )}
      </div>
    </div>
  );
}

