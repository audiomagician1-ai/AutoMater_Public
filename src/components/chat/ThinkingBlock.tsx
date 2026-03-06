/**
 * ThinkingBlock — Echo 风格思维链: 💡 首行缩略 ▾
 *
 * 借鉴 Echo Agent CompactMessage.vue 的 reasoning 折叠设计:
 *   - 收起时: 💡 + 首行预览 + ▾
 *   - 展开时: reasoning (蓝色左边框) + 正文 (Markdown)
 *
 * @since v31.0
 */

import type { AgentWorkMessage } from '../../stores/app-store';
import { MarkdownContent } from './MarkdownContent';

export function ThinkingBlock({
  msg,
  isExpanded,
  onToggle,
}: {
  msg: AgentWorkMessage;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const content = msg.content || '';
  const reasoning = msg.reasoning || '';
  const displayText = reasoning || content;
  const firstLine = displayText.split('\n')[0].slice(0, 120);
  const isLong = displayText.length > 150 || displayText.includes('\n');

  return (
    <div className="py-1.5">
      {/* Collapsible header */}
      <div className="flex items-start gap-2 cursor-pointer group" onClick={onToggle}>
        <span className="text-base leading-6 shrink-0">💡</span>
        <span className={`text-[13px] leading-6 text-slate-400 ${!isExpanded && isLong ? 'truncate' : ''}`}>
          {isExpanded ? '' : firstLine}
          {!isExpanded && isLong && '...'}
        </span>
        {isLong && (
          <span className="shrink-0 text-slate-600 text-xs leading-6 group-hover:text-slate-400 transition-colors ml-1">
            {isExpanded ? '▴' : '▾'}
          </span>
        )}
      </div>
      {/* Expanded content */}
      {isExpanded && (
        <div className="mt-2 ml-7 text-sm text-slate-300 leading-relaxed whitespace-pre-wrap break-words">
          {reasoning && (
            <div className="mb-2 pl-3 border-l-2 border-blue-500/30 text-slate-400 text-xs leading-relaxed">
              {reasoning}
            </div>
          )}
          {content && <MarkdownContent text={content} />}
        </div>
      )}
    </div>
  );
}
