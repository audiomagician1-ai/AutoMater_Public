/**
 * MissionCard — Single mission card with expandable task list
 */

import { MISSION_TYPES, MISSION_STATUS, TASK_STATUS_STYLE } from './types';

export function MissionCard({ mission: m, onCancel, onDelete, expanded, onToggle, tasks }: {
  mission: MissionRecord;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  expanded: boolean;
  onToggle: (id: string) => void;
  tasks: MissionTaskRecord[];
}) {
  const st = MISSION_STATUS[m.status] || MISSION_STATUS.pending;
  const typeInfo = MISSION_TYPES.find(t => t.type === m.type);
  const isRunning = ['pending', 'planning', 'executing', 'judging'].includes(m.status);

  const doneTasks = tasks.filter(t => ['passed', 'failed', 'skipped'].includes(t.status)).length;
  const totalTasks = tasks.length;
  const progressPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  return (
    <div className={`rounded-lg border transition-all ${
      isRunning ? 'border-cyan-600/30 bg-cyan-900/10' : 'border-slate-800 bg-slate-900/30'
    }`}>
      <div className="flex items-center gap-3 p-3 cursor-pointer hover:bg-slate-800/30 transition-colors rounded-lg"
        onClick={() => onToggle(m.id)}>
        <span className="text-lg">{typeInfo?.icon || '🎯'}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-200">{typeInfo?.label || m.type}</span>
            <span className={`text-[10px] ${st.color}`}>{st.icon} {st.text}</span>
            {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />}
            {totalTasks > 0 && (
              <span className="text-[9px] text-slate-500">{doneTasks}/{totalTasks}</span>
            )}
          </div>
          {isRunning && totalTasks > 0 && (
            <div className="mt-1 h-1 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-cyan-500 rounded-full transition-all duration-500" style={{ width: `${progressPct}%` }} />
            </div>
          )}
          {!expanded && m.conclusion && (
            <p className="text-[10px] text-slate-500 mt-0.5 truncate">{m.conclusion.slice(0, 100)}...</p>
          )}
          <div className="text-[9px] text-slate-600 mt-0.5">
            {m.token_usage > 0 && <span>{(m.token_usage / 1000).toFixed(1)}k tokens</span>}
            {m.cost_usd > 0 && <span className="ml-2">${m.cost_usd.toFixed(4)}</span>}
            <span className="ml-2">{new Date(m.created_at + 'Z').toLocaleString()}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className={`text-[10px] transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
          {isRunning ? (
            <button onClick={(e) => { e.stopPropagation(); onCancel(m.id); }} className="text-[10px] px-2 py-1 rounded bg-red-900/20 text-red-400 hover:bg-red-800/30 transition-colors">取消</button>
          ) : (
            <button onClick={(e) => { e.stopPropagation(); onDelete(m.id); }} className="text-[10px] px-2 py-1 rounded bg-slate-800 text-slate-500 hover:text-red-400 transition-colors">删除</button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-0 border-t border-slate-800/50">
          {tasks.length > 0 && (
            <div className="mt-2 space-y-1">
              <div className="text-[10px] font-bold text-slate-400 mb-1">📋 任务清单 ({tasks.length})</div>
              {tasks.map(task => {
                const ts = TASK_STATUS_STYLE[task.status] || TASK_STATUS_STYLE.pending;
                return (
                  <details key={task.id} className="group">
                    <summary className="flex items-center gap-2 cursor-pointer list-none text-[11px] py-1 hover:bg-slate-800/30 rounded px-1">
                      <span className={`${ts.color} font-mono`}>{ts.icon}</span>
                      <span className="text-slate-300 truncate flex-1">{task.title}</span>
                      <span className={`text-[9px] ${ts.color}`}>{task.status}</span>
                    </summary>
                    {task.output && (
                      <pre className="mt-1 ml-5 text-[10px] text-slate-500 bg-slate-900/60 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
                        {task.output.length > 2000 ? task.output.slice(0, 2000) + '\n\n... (截断)' : task.output}
                      </pre>
                    )}
                  </details>
                );
              })}
            </div>
          )}
          {tasks.length === 0 && isRunning && (
            <div className="text-[10px] text-slate-600 py-2">⏳ 正在规划任务...</div>
          )}
          {tasks.length === 0 && !isRunning && !m.conclusion && (
            <div className="text-[10px] text-slate-600 py-2">暂无任务数据</div>
          )}
          {m.conclusion && (
            <div className="mt-3">
              <div className="text-[10px] font-bold text-slate-400 mb-1">📝 结论</div>
              <div className="text-[11px] text-slate-300 bg-slate-900/60 rounded p-3 max-h-60 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">
                {m.conclusion}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
