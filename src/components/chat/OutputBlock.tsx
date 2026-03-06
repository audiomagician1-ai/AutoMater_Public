/**
 * OutputBlock / ErrorBlock / StatusBlock — 简单消息类型渲染
 * @since v31.0
 */

import type { AgentWorkMessage } from '../../stores/app-store';
import { MarkdownContent } from './MarkdownContent';

/** 输出 / 总结块 — Markdown 渲染 */
export function OutputBlock({ msg }: { msg: AgentWorkMessage }) {
  return (
    <div className="py-2">
      <MarkdownContent text={msg.content} />
    </div>
  );
}
