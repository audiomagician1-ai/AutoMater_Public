/**
 * CollapsibleWorkBlock — 工作过程折叠区
 *
 * Compact/Full 双模式设计:
 *   - 折叠状态: "工作过程 · N 步 💭M 🔧K" 单行摘要
 *   - 展开状态: 渲染所有 InlineWorkMessage
 *
 * 替代之前在 MetaAgentPanel / WishPage 中的重复实现。
 *
 * @since v31.0
 */

import { useState } from 'react';
import type { AgentWorkMessage } from '../../stores/app-store';
import { InlineWorkMessage } from './InlineWorkMessage';

interface CollapsibleWorkBlockProps {
  workMessages: AgentWorkMessage[];
  /** 默认展开状态 (默认 false) */
  defaultExpanded?: boolean;
  /** 紧凑模式 — MetaAgentPanel 侧边栏用 */
  compact?: boolean;
}

export function CollapsibleWorkBlock({
  workMessages,
  defaultExpanded = false,
  compact = false,
}: CollapsibleWorkBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const thinkCount = workMessages.filter(m => m.type === 'think').length;
  const toolCount = workMessages.filter(m => m.type === 'tool-result' || m.type === 'tool-call').length;
  const editCount = workMessages.filter(m => m.diff).length;
  const errorCount = workMessages.filter(m => m.type === 'error').length;

  if (workMessages.length === 0) return null;

  return (
    <div className={compact ? 'mt-1' : 'mt-1.5 max-w-[85%]'}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[10px] text-slate-500 hover:text-slate-300 transition-colors py-0.5 group"
      >
        <span className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>▸</span>
        <span className="w-1 h-1 rounded-full bg-slate-600 group-hover:bg-slate-400 shrink-0" />
        <span>工作过程 · {workMessages.length} 步</span>
        {thinkCount > 0 && <span className="text-blue-500/60">💭{thinkCount}</span>}
        {toolCount > 0 && <span className="text-emerald-500/60">🔧{toolCount}</span>}
        {editCount > 0 && <span className="text-amber-500/60">📝{editCount}</span>}
        {errorCount > 0 && <span className="text-red-500/60">⚠️{errorCount}</span>}
      </button>
      {expanded && (
        <div className={`mt-1 space-y-1 ${compact ? 'pl-1' : 'pl-1.5'} border-l border-slate-800/50`}>
          {workMessages.map(wm => (
            <InlineWorkMessage key={wm.id} msg={wm} />
          ))}
        </div>
      )}
    </div>
  );
}
