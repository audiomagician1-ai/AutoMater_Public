/**
 * ContextMenu — 通用右键菜单组件
 * 用于文档/产出页的"查看历史版本""回退版本"操作
 */

import { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  label: string;
  icon?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [onClose]);

  // Clamp position to viewport
  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 36 - 16),
    zIndex: 9999,
  };

  return (
    <div ref={ref} style={style} className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl py-1 min-w-[180px] animate-in fade-in duration-100">
      {items.map((item, i) => (
        <button
          key={i}
          disabled={item.disabled}
          onClick={() => { item.onClick(); onClose(); }}
          className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors ${
            item.disabled
              ? 'text-slate-600 cursor-not-allowed'
              : item.danger
                ? 'text-red-400 hover:bg-red-900/30'
                : 'text-slate-300 hover:bg-slate-800'
          }`}
        >
          {item.icon && <span className="w-4 text-center">{item.icon}</span>}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}
