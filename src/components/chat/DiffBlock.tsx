/**
 * DiffBlock — Echo 风格文件 diff 展示
 *
 * DiffBlock 设计:
 *   - Header: tool name + file path + 行数统计 (+N -N) + ✓/✗
 *   - 展开: 红删绿增 diff 内容
 *
 * @since v31.0
 */

import type { AgentWorkMessage } from '../../stores/app-store';

export function DiffBlock({
  msg,
  isExpanded,
  onToggle,
}: {
  msg: AgentWorkMessage;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const diff = msg.diff!;
  const tool = msg.tool!;

  return (
    <div className="rounded-lg border border-slate-700/50 overflow-hidden bg-slate-900/60">
      {/* Header: tool name + path + stats */}
      <div
        className="flex items-center gap-2 px-3 py-2 bg-slate-800/40 cursor-pointer hover:bg-slate-800/60 transition-colors"
        onClick={onToggle}
      >
        <span className="text-amber-400 font-semibold text-xs">{tool.name === 'write_file' ? 'write' : 'edit'}</span>
        <span className="text-slate-300 text-xs font-mono truncate flex-1">{diff.path}</span>
        <span className="text-emerald-400 text-xs font-mono">+{diff.added}</span>
        <span className="text-red-400 text-xs font-mono">-{diff.removed}</span>
        {tool.success && <span className="text-emerald-400 text-xs">✓</span>}
        {tool.success === false && <span className="text-red-400 text-xs">✗</span>}
        <span className="text-slate-600 text-xs">{isExpanded ? '▴' : '▾'}</span>
      </div>

      {/* Expanded: diff content */}
      {isExpanded && (
        <div className="font-mono text-xs leading-relaxed max-h-80 overflow-y-auto">
          {diff.oldString &&
            diff.oldString.split('\n').map((line, i) => (
              <div key={`old-${i}`} className="px-3 py-0.5 bg-red-500/10 text-red-300">
                <span className="text-red-500/60 select-none mr-2">-</span>
                {line}
              </div>
            ))}
          {diff.newString &&
            diff.newString.split('\n').map((line, i) => (
              <div key={`new-${i}`} className="px-3 py-0.5 bg-emerald-500/10 text-emerald-300">
                <span className="text-emerald-500/60 select-none mr-2">+</span>
                {line}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
