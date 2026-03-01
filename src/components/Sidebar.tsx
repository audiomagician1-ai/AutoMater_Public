import { useAppStore, type PageId } from '../stores/app-store';

const navItems: { id: PageId; icon: string; label: string }[] = [
  { id: 'wish', icon: '✨', label: '许愿台' },
  { id: 'board', icon: '📋', label: '看板' },
  { id: 'team', icon: '👥', label: '团队' },
  { id: 'logs', icon: '📜', label: '日志' },
  { id: 'settings', icon: '⚙️', label: '设置' },
];

export function Sidebar() {
  const { currentPage, setPage, settingsConfigured } = useAppStore();

  return (
    <aside className="w-16 bg-slate-900 border-r border-slate-800 flex flex-col items-center py-4 gap-1">
      {/* Logo */}
      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-forge-500 to-forge-700 flex items-center justify-center text-lg font-bold mb-6 shadow-lg shadow-forge-500/20">
        F
      </div>

      {/* Nav */}
      {navItems.map(item => (
        <button
          key={item.id}
          onClick={() => setPage(item.id)}
          className={`
            w-12 h-12 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-all text-xs
            ${currentPage === item.id
              ? 'bg-forge-600/20 text-forge-400 shadow-inner'
              : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'}
          `}
          title={item.label}
        >
          <span className="text-base">{item.icon}</span>
          <span className="text-[10px] leading-none">{item.label}</span>
        </button>
      ))}

      {/* Status dot */}
      <div className="mt-auto mb-2">
        <div
          className={`w-2.5 h-2.5 rounded-full ${settingsConfigured ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`}
          title={settingsConfigured ? 'LLM 已连接' : '请先配置 LLM'}
        />
      </div>
    </aside>
  );
}
