/**
 * StatusBlock — 状态消息 (小字号灰色)
 * @since v31.0
 */

import type { AgentWorkMessage } from '../../stores/app-store';

export function StatusBlock({ msg }: { msg: AgentWorkMessage }) {
  return <div className="py-1 text-xs text-slate-500 leading-relaxed">{msg.content}</div>;
}
