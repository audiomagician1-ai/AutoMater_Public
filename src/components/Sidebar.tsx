import { useAppStore, type ProjectPageId } from '../stores/app-store';

const projectNavItems: { id: ProjectPageId; icon: string; label: string }[] = [
  { id: 'overview', icon: '🗺️', label: '全景' },
  { id: 'wish',    icon: '✨', label: '许愿' },
  { id: 'board',   icon: '📋', label: '看板' },
  { id: 'team',    icon: '👥', label: '团队' },
  { id: 'context', icon: '🧠', label: '上下文' },
  { id: 'timeline', icon: '⏳', label: '时间线' },
  { id: 'output',  icon: '📦', label: '产出' },
  { id: 'logs',    icon: '📜', label: '日志' },
];

export function Sidebar() {
  const { insideProject, projectPage, setProjectPage, exitProject, settingsConfigured, setGlobalPage } = useAppStore();

  // 不在项目内时不渲染侧边栏（ProjectsPage 自带顶栏导航）
  if (!insideProject) return null;

  return (
    <aside className="w-16 bg-slate-900 border-r border-slate-800 flex flex-col items-center py-3 gap-1 flex-shrink-0">
      {/* 返回按钮 */}
      <button
        onClick={exitProject}
        className="w-10 h-10 rounded-xl bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-sm mb-4 transition-all text-slate-400 hover:text-slate-200"
        title="返回项目列表"
      >
        ←
      </button>

      {/* 项目内导航 */}
      {projectNavItems.map(item => (
        <button
          key={item.id}
          onClick={() => setProjectPage(item.id)}
          className={`
            w-12 h-12 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-all text-xs
            ${projectPage === item.id
              ? 'bg-forge-600/20 text-forge-400 shadow-inner'
              : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'}
          `}
          title={item.label}
        >
          <span className="text-base">{item.icon}</span>
          <span className="text-[10px] leading-none">{item.label}</span>
        </button>
      ))}

      {/* 底部 */}
      <div className="mt-auto flex flex-col items-center gap-2 mb-2">
        <button
          onClick={() => setGlobalPage('settings')}
          className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-all"
          title="设置"
        >
          ⚙️
        </button>
        <div
          className={`w-2.5 h-2.5 rounded-full ${settingsConfigured ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`}
          title={settingsConfigured ? 'LLM 已连接' : '请先配置 LLM'}
        />
      </div>
    </aside>
  );
}
