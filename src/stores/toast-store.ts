/**
 * Toast & Confirm 全局状态管理 (Zustand)
 * v15.0: 替换所有 alert() / confirm() 为产品内组件
 */
import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  /** 自动消失时间 ms, 0 = 手动关闭 */
  duration: number;
  createdAt: number;
}

export interface ConfirmCheckbox {
  label: string;
  defaultChecked?: boolean;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  /** 可选复选框，用于附加选项（如 "同时删除文件"） */
  checkbox?: ConfirmCheckbox;
}

export interface ConfirmResult {
  confirmed: boolean;
  checkboxValue?: boolean;
}

interface ToastState {
  toasts: ToastItem[];
  addToast: (type: ToastType, message: string, duration?: number) => void;
  removeToast: (id: string) => void;

  // Confirm dialog
  confirmDialog: (ConfirmOptions & { resolve: (result: ConfirmResult) => void; checkboxValue: boolean }) | null;
  showConfirm: (options: ConfirmOptions) => Promise<ConfirmResult>;
  setConfirmCheckbox: (value: boolean) => void;
  resolveConfirm: (ok: boolean) => void;
}

let toastIdCounter = 0;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  addToast: (type, message, duration = 3000) => {
    const id = `toast-${++toastIdCounter}`;
    const toast: ToastItem = { id, type, message, duration, createdAt: Date.now() };
    set(s => ({ toasts: [...s.toasts.slice(-8), toast] }));
    if (duration > 0) {
      setTimeout(() => get().removeToast(id), duration);
    }
  },

  removeToast: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),

  confirmDialog: null,

  showConfirm: (options) => {
    return new Promise<ConfirmResult>((resolve) => {
      set({ confirmDialog: { ...options, resolve, checkboxValue: options.checkbox?.defaultChecked ?? false } });
    });
  },

  setConfirmCheckbox: (value) => {
    const dialog = get().confirmDialog;
    if (dialog) {
      set({ confirmDialog: { ...dialog, checkboxValue: value } });
    }
  },

  resolveConfirm: (ok) => {
    const dialog = get().confirmDialog;
    if (dialog) {
      dialog.resolve({ confirmed: ok, checkboxValue: dialog.checkboxValue });
      set({ confirmDialog: null });
    }
  },
}));

/** 便捷函数 — 可在组件外使用 */
export const toast = {
  success: (msg: string, duration?: number) => useToastStore.getState().addToast('success', msg, duration),
  error: (msg: string, duration?: number) => useToastStore.getState().addToast('error', msg, duration ?? 5000),
  warning: (msg: string, duration?: number) => useToastStore.getState().addToast('warning', msg, duration ?? 4000),
  info: (msg: string, duration?: number) => useToastStore.getState().addToast('info', msg, duration),
};

export const confirm = (options: ConfirmOptions) => useToastStore.getState().showConfirm(options);

/** 向后兼容: 简单确认（不使用 checkbox 时直接返回 boolean） */
export const confirmSimple = async (options: ConfirmOptions): Promise<boolean> => {
  const result = await confirm(options);
  return result.confirmed;
};
