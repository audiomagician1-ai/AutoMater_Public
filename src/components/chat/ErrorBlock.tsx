/**
 * ErrorBlock — 错误消息
 * @since v31.0
 */

import type { AgentWorkMessage } from '../../stores/app-store';

export function ErrorBlock({ msg }: { msg: AgentWorkMessage }) {
  return (
    <div className="flex items-start gap-2 py-1.5 text-red-400 text-sm">
      <span className="shrink-0">⚠️</span>
      <span className="leading-relaxed">{msg.content}</span>
    </div>
  );
}
