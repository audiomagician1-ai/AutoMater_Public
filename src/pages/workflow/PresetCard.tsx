/**
 * PresetCard — Workflow preset selector card
 */

export function PresetCard({ preset, isActive, onActivate, onEdit, onDuplicate, onDelete }: {
  preset: WorkflowPresetInfo;
  isActive: boolean;
  onActivate: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`group relative rounded-xl border p-3 transition-all cursor-pointer ${
      isActive
        ? 'border-forge-500/50 bg-forge-600/10 ring-1 ring-forge-500/20 shadow-lg shadow-forge-500/10'
        : 'border-slate-700/40 bg-slate-800/20 hover:border-slate-600/60 hover:bg-slate-800/40'
    }`}
      onClick={onActivate}
    >
      <div className="flex items-start gap-2.5">
        <div className="text-2xl flex-shrink-0">{preset.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-bold ${isActive ? 'text-forge-300' : 'text-slate-200'}`}>
              {preset.name}
            </span>
            {isActive && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-forge-500/20 text-forge-400 font-medium">当前</span>
            )}
            {preset.isBuiltin && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-slate-700/50 text-slate-500">内置</span>
            )}
          </div>
          <p className="text-[10px] text-slate-500 mt-0.5 line-clamp-2 leading-relaxed">{preset.description}</p>
          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
            {preset.stages.slice(0, 6).map((s, i) => (
              <span key={i} className="text-xs" title={s.label}>{s.icon}</span>
            ))}
            {preset.stages.length > 6 && (
              <span className="text-[9px] text-slate-600">+{preset.stages.length - 6}</span>
            )}
            <span className="text-[9px] text-slate-600 ml-1">{preset.stages.length} 阶段</span>
          </div>
        </div>
      </div>

      {/* Actions — visible on hover */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={(e) => { e.stopPropagation(); onEdit(); }}
          className="w-6 h-6 rounded bg-slate-700/80 hover:bg-slate-600 text-[10px] flex items-center justify-center text-slate-300" title="编辑">✏️</button>
        <button onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
          className="w-6 h-6 rounded bg-slate-700/80 hover:bg-slate-600 text-[10px] flex items-center justify-center text-slate-300" title="复制">📋</button>
        {!preset.isBuiltin && (
          <button onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="w-6 h-6 rounded bg-slate-700/80 hover:bg-red-800/60 text-[10px] flex items-center justify-center text-slate-300 hover:text-red-300" title="删除">🗑️</button>
        )}
      </div>
    </div>
  );
}
