import { useAppStore, type ProjectPageId, type GlobalPageId } from '../stores/app-store';

const globalNavItems: { id: GlobalPageId; icon: string; label: string }[] = [
  { id: 'projects', icon: '📁', label: '项目' },
  { id: 'guide', icon: '📖', label: '教程' },
  { id: 'evolution', icon: '🧬', label: '进化' },
  { id: 'settings', icon: '⚙️', label: '设置' },
];

const projectNavItems: { id: ProjectPageId; icon: string; label: string }[] = [
  { id: 'overview', icon: '🗺️', label: '全景' },
  { id: 'wish', icon: '✨', label: '许愿' },
  { id: 'board', icon: '📋', label: '看板' },
  { id: 'docs', icon: '📄', label: '文档' },
  { id: 'workflow', icon: '🔄', label: '工作流' },
  { id: 'team', icon: '👥', label: '团队' },
  { id: 'context', icon: '🧠', label: '上下文' },
  { id: 'timeline', icon: '⏳', label: '时间线' },
  { id: 'sessions', icon: '📼', label: '会话' },
  { id: 'output', icon: '📦', label: '产出' },
  { id: 'git', icon: '🔀', label: '版本' },
  { id: 'logs', icon: '📜', label: '日志' },
  { id: 'guide', icon: '📖', label: '教程' },
];

export function Sidebar() {
  const insideProject = useAppStore(s => s.insideProject);
  const globalPage = useAppStore(s => s.globalPage);
  const projectPage = useAppStore(s => s.projectPage);
  const setGlobalPage = useAppStore(s => s.setGlobalPage);
  const setProjectPage = useAppStore(s => s.setProjectPage);
  const exitProject = useAppStore(s => s.exitProject);
  const settingsConfigured = useAppStore(s => s.settingsConfigured);
  const pendingNotifications = useAppStore(s => s.pendingNotifications);
  const clearNotifications = useAppStore(s => s.clearNotifications);

  return (
    <aside className="w-16 bg-slate-900/95 backdrop-blur-sm border-r border-slate-800/80 flex flex-col items-center py-3 gap-1 flex-shrink-0 relative">
      {/* Subtle gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-b from-forge-500/[0.02] via-transparent to-slate-900/50 pointer-events-none" />

      {/* 品牌 Logo */}
      <div
        className="relative w-10 h-10 rounded-xl bg-gradient-to-br from-forge-500 to-forge-700 flex items-center justify-center text-sm font-bold shadow-lg shadow-forge-500/20 mb-3 cursor-pointer select-none hover:shadow-forge-500/40 hover:scale-105 transition-all duration-300 z-10"
        title="智械母机 AutoMater"
        onClick={() => {
          if (insideProject) exitProject();
          else setGlobalPage('projects');
        }}
      >
        F
        <div className="absolute inset-0 rounded-xl bg-gradient-to-t from-white/0 to-white/10 pointer-events-none" />
      </div>

      {insideProject ? (
        <>
          {/* 返回按钮 */}
          <button
            onClick={exitProject}
            className="w-10 h-10 rounded-xl bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-sm mb-3 transition-all text-slate-400 hover:text-slate-200"
            title="返回项目列表"
          >
            ←
          </button>

          {/* 项目内导航 */}
          {projectNavItems.map(item => {
            const hasBadge = item.id === 'overview' && pendingNotifications > 0;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setProjectPage(item.id);
                  if (hasBadge) clearNotifications();
                }}
                className={`
                  relative w-12 h-12 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-all duration-200 text-xs group
                  ${
                    projectPage === item.id
                      ? 'bg-forge-600/20 text-forge-400 shadow-inner shadow-forge-500/10 ring-1 ring-forge-500/20'
                      : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/80 hover:shadow-lg hover:shadow-black/20'
                  }
                `}
                title={item.label}
              >
                <span className="text-base">{item.icon}</span>
                <span className="text-[10px] leading-none">{item.label}</span>
                {hasBadge && (
                  <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-red-500 text-[9px] text-white flex items-center justify-center font-bold animate-pulse">
                    {pendingNotifications > 9 ? '9+' : pendingNotifications}
                  </span>
                )}
              </button>
            );
          })}
        </>
      ) : (
        <>
          {/* 全局导航 */}
          {globalNavItems.map(item => (
            <button
              key={item.id}
              onClick={() => setGlobalPage(item.id)}
              className={`
                w-12 h-12 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-all duration-200 text-xs group
                ${
                  globalPage === item.id
                    ? 'bg-forge-600/20 text-forge-400 shadow-inner shadow-forge-500/10 ring-1 ring-forge-500/20'
                    : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/80 hover:shadow-lg hover:shadow-black/20'
                }
              `}
              title={item.label}
            >
              <span className="text-base">{item.icon}</span>
              <span className="text-[10px] leading-none">{item.label}</span>
            </button>
          ))}
        </>
      )}

      {/* 底部状态指示 */}
      <div className="mt-auto flex flex-col items-center gap-2 mb-2 z-10">
        {insideProject && (
          <button
            onClick={() => setGlobalPage('settings')}
            className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-slate-800/80 transition-all duration-200"
            title="设置"
          >
            ⚙️
          </button>
        )}
        <div className="relative">
          <div
            className={`w-2.5 h-2.5 rounded-full transition-all duration-500 ${settingsConfigured ? 'bg-emerald-400 shadow-lg shadow-emerald-400/50' : 'bg-amber-400 animate-pulse shadow-lg shadow-amber-400/50'}`}
            title={settingsConfigured ? 'LLM 已连接' : '请先配置 LLM'}
          />
          {settingsConfigured && (
            <div className="absolute inset-0 w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping opacity-20" />
          )}
        </div>
      </div>
    </aside>
  );
}
