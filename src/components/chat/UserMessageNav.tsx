/**
 * UserMessageNav — 用户消息快速跳转导航条
 *
 * UserMessageNavigator 设计:
 *   - 固定在消息列表左侧
 *   - 每个用户消息对应一个小圆点
 *   - 点击跳转到对应消息位置
 *   - 当前可见消息高亮
 *
 * @since v31.0
 */

import { useCallback } from 'react';

interface NavItem {
  id: string;
  index: number;
  preview: string;
}

interface UserMessageNavProps {
  items: NavItem[];
  activeIndex: number;
  onNavigate: (index: number) => void;
}

export function UserMessageNav({ items, activeIndex, onNavigate }: UserMessageNavProps) {
  if (items.length <= 1) return null;

  return (
    <div className="fixed left-1 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-1 py-2">
      {items.map((item, i) => (
        <button
          key={item.id}
          onClick={() => onNavigate(item.index)}
          className={`w-2 h-2 rounded-full transition-all hover:scale-150 ${
            i === activeIndex ? 'bg-forge-400 shadow-sm shadow-forge-400/50' : 'bg-slate-700 hover:bg-slate-500'
          }`}
          title={item.preview.slice(0, 60)}
        />
      ))}
    </div>
  );
}

/** 从消息列表中提取 user 消息导航项 */
export function extractUserNavItems(messages: Array<{ id: string; role: string; content: string }>): NavItem[] {
  return messages
    .map((msg, index) => ({ id: msg.id, index, role: msg.role, content: msg.content }))
    .filter(m => m.role === 'user')
    .map(m => ({
      id: m.id,
      index: m.index,
      preview: m.content.slice(0, 60),
    }));
}

/** Hook: 计算当前可见的 user 消息 index (使用 IntersectionObserver) */
export function useActiveUserMessage(
  containerRef: React.RefObject<HTMLElement | null>,
  messageCount: number,
): { activeIndex: number; scrollToMessage: (index: number) => void } {
  const scrollToMessage = useCallback(
    (index: number) => {
      const container = containerRef.current;
      if (!container) return;
      const msgEl = container.querySelector(`[data-msg-index="${index}"]`);
      if (msgEl) {
        msgEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    },
    [containerRef],
  );

  // 简化实现: 暂时返回最后一个 user message 的 index
  return { activeIndex: Math.max(0, messageCount - 1), scrollToMessage };
}
