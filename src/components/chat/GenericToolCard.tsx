/**
 * GenericToolCard — 通用工具调用卡片 (read_file / search_files 等)
 *
 * generic 折叠面板设计:
 *   - 折叠: 工具名 + ✓/✗ + 参数预览
 *   - 展开: 完整参数 JSON + 执行输出
 *
 * @since v31.0
 */

import type { AgentWorkMessage } from '../../stores/app-store';
import { formatJsonSafe } from './MarkdownContent';

export function GenericToolCard({
  msg,
  isExpanded,
  onToggle,
}: {
  msg: AgentWorkMessage;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const tool = msg.tool!;
  const argsDisplay = tool.args || '';

  return (
    <div className="rounded-lg border border-slate-700/40 overflow-hidden bg-slate-800/30">
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-slate-800/50 transition-colors"
        onClick={onToggle}
      >
        <span className="text-base">🔧</span>
        <span className="text-slate-200 text-sm font-medium">{tool.name}</span>
        {tool.success === true && <span className="text-emerald-400 text-xs">✓</span>}
        {tool.success === false && <span className="text-red-400 text-xs">✗</span>}
        <span className="ml-auto text-slate-600 text-xs">{isExpanded ? '▴' : '▾'}</span>
      </div>
      {/* Collapsed: args preview */}
      {!isExpanded && argsDisplay && (
        <div className="px-3 pb-2 text-xs text-slate-500 font-mono truncate">{argsDisplay}</div>
      )}
      {/* Expanded: full args + output */}
      {isExpanded && (
        <div className="border-t border-slate-700/30">
          {tool.fullArgs && (
            <div className="px-3 py-2 text-xs">
              <div className="text-slate-500 text-[10px] mb-1">调用参数</div>
              <pre className="text-slate-400 font-mono whitespace-pre-wrap break-all leading-relaxed max-h-40 overflow-y-auto">
                {formatJsonSafe(tool.fullArgs)}
              </pre>
            </div>
          )}
          {(tool.fullOutput || tool.outputPreview) && (
            <div className="px-3 py-2 border-t border-slate-700/20 text-xs">
              <div className="text-slate-500 text-[10px] mb-1">输出</div>
              <pre className="text-slate-400 font-mono whitespace-pre-wrap break-all leading-relaxed max-h-60 overflow-y-auto">
                {tool.fullOutput || tool.outputPreview || ''}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
