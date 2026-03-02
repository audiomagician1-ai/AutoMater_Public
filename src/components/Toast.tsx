/**
 * Toast 全局通知 + ConfirmDialog 二次确认
 * v15.0: 替换 alert()/confirm()
 */
import { useEffect } from 'react';
import { useToastStore, type ToastItem, type ToastType } from '../stores/toast-store';

const ICONS: Record<ToastType, string> = {
  success: '✅',
  error: '❌',
  warning: '⚠️',
  info: 'ℹ️',
};

const BG: Record<ToastType, string> = {
  success: 'bg-emerald-900/90 border-emerald-700/50',
  error: 'bg-red-900/90 border-red-700/50',
  warning: 'bg-amber-900/90 border-amber-700/50',
  info: 'bg-slate-800/95 border-slate-700/50',
};

function ToastItem({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  return (
    <div
      className={`flex items-start gap-2.5 px-4 py-3 rounded-xl border shadow-xl backdrop-blur-sm text-sm text-slate-100 animate-slide-in-right min-w-[280px] max-w-[420px] ${BG[item.type]}`}
    >
      <span className="text-base shrink-0 mt-0.5">{ICONS[item.type]}</span>
      <span className="flex-1 leading-relaxed break-words">{item.message}</span>
      <button
        onClick={onDismiss}
        className="shrink-0 text-slate-500 hover:text-slate-300 transition-colors ml-1"
      >
        ✕
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore(s => s.toasts);
  const removeToast = useToastStore(s => s.removeToast);

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem item={t} onDismiss={() => removeToast(t.id)} />
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog() {
  const dialog = useToastStore(s => s.confirmDialog);
  const resolveConfirm = useToastStore(s => s.resolveConfirm);
  const setConfirmCheckbox = useToastStore(s => s.setConfirmCheckbox);

  // Escape 关闭
  useEffect(() => {
    if (!dialog) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resolveConfirm(false);
      if (e.key === 'Enter') resolveConfirm(true);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dialog, resolveConfirm]);

  if (!dialog) return null;

  return (
    <div className="fixed inset-0 bg-black/60 z-[9998] flex items-center justify-center animate-fade-in" onClick={() => resolveConfirm(false)}>
      <div
        className="bg-slate-900 border border-slate-700 rounded-2xl w-[400px] shadow-2xl animate-scale-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-2">
          <h3 className="text-base font-bold text-slate-100">{dialog.title}</h3>
          <p className="mt-2 text-sm text-slate-400 leading-relaxed">{dialog.message}</p>
          {dialog.checkbox && (
            <label className="flex items-center gap-2 mt-3 cursor-pointer select-none group">
              <input
                type="checkbox"
                checked={dialog.checkboxValue}
                onChange={e => setConfirmCheckbox(e.target.checked)}
                className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-red-500 focus:ring-red-500/30 focus:ring-offset-0 cursor-pointer"
              />
              <span className="text-sm text-slate-400 group-hover:text-slate-300 transition-colors">
                {dialog.checkbox.label}
              </span>
            </label>
          )}
        </div>
        <div className="flex justify-end gap-2 px-6 py-4">
          <button
            onClick={() => resolveConfirm(false)}
            className="px-4 py-2 text-sm rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
          >
            {dialog.cancelText || '取消'}
          </button>
          <button
            onClick={() => resolveConfirm(true)}
            className={`px-4 py-2 text-sm rounded-lg font-medium transition-colors ${
              dialog.danger
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : 'bg-forge-600 hover:bg-forge-500 text-white'
            }`}
            autoFocus
          >
            {dialog.confirmText || '确认'}
          </button>
        </div>
      </div>
    </div>
  );
}
