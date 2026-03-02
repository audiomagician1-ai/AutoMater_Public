export function StatCard({ icon, label, value, sub }: { icon: string; label: string; value: string; sub?: string }) {
  return (
    <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-800/80 rounded-xl p-4 space-y-1 hover:border-slate-700/80 hover:bg-slate-900/90 transition-all duration-300 hover:shadow-lg hover:shadow-black/20 group">
      <div className="flex items-center gap-2 text-xs text-slate-500"><span className="group-hover:scale-110 transition-transform">{icon}</span><span>{label}</span></div>
      <div className="text-lg font-bold text-slate-200 animate-count">{value}</div>
      {sub && <div className="text-[10px] text-slate-600">{sub}</div>}
    </div>
  );
}
