/**
 * BashBlock — Echo 风格终端命令展示
 *
 * TerminalBlock 设计:
 *   - 深色终端背景
 *   - $ command 高亮
 *   - 展开时显示完整输出
 *
 * @since v31.0
 */

import type { AgentWorkMessage } from '../../stores/app-store';

export function BashBlock({
  msg,
  isExpanded,
  onToggle,
}: {
  msg: AgentWorkMessage;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const tool = msg.tool!;
  const command = tool.command || tool.args;
  const output = isExpanded ? tool.fullOutput || tool.outputPreview || '' : tool.outputPreview || '';
  const cwd = tool.cwd || '';

  return (
    <div className="rounded-lg overflow-hidden bg-[#1a1b26] border border-slate-700/30">
      {/* Header: bash label */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 bg-[#24253a] cursor-pointer hover:bg-[#2a2b42] transition-colors"
        onClick={onToggle}
      >
        <span className="text-slate-500 text-xs font-medium">bash</span>
        {tool.success === true && <span className="text-emerald-400 text-xs">✓</span>}
        {tool.success === false && <span className="text-red-400 text-xs">✗</span>}
        <span className="ml-auto text-slate-600 text-xs">{isExpanded ? '▴' : '▾'}</span>
      </div>
      {/* Terminal content */}
      <div className="px-3 py-2 font-mono text-xs">
        {cwd && <div className="text-slate-600 mb-1">{cwd}</div>}
        <div className="text-slate-400">
          <span className="text-amber-400">$ </span>
          <span className="text-amber-300">{command}</span>
        </div>
        {(isExpanded || output.length < 300) && output && (
          <pre className="mt-1.5 text-slate-500 whitespace-pre-wrap break-all leading-relaxed max-h-60 overflow-y-auto">
            {output || 'Command completed with no output'}
          </pre>
        )}
        {!isExpanded && output.length >= 300 && (
          <div className="mt-1 text-slate-600 text-[10px] cursor-pointer hover:text-slate-400">
            点击展开输出 ({output.length} chars) ▾
          </div>
        )}
      </div>
    </div>
  );
}
