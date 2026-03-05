/**
 * wish-constants.ts — WishPage 共享常量和格式化工具
 *
 * 从 WishPage.tsx 拆分 (v30.2)
 */

import type { ChatMode } from '../../stores/slices/meta-agent-slice';

export const WISH_STATUS: Record<string, { text: string; color: string; icon: string }> = {
  pending: { text: '待分析', color: 'text-slate-400', icon: '⏳' },
  analyzing: { text: 'PM 分析中', color: 'text-blue-400', icon: '🧠' },
  analyzed: { text: '已分析', color: 'text-emerald-400', icon: '✅' },
  developing: { text: '开发中', color: 'text-amber-400', icon: '🔨' },
  done: { text: '已完成', color: 'text-green-400', icon: '🎉' },
  rejected: { text: '已拒绝', color: 'text-red-400', icon: '❌' },
};

export const CHAT_MODE_INFO: Record<ChatMode, { icon: string; label: string; desc: string; color: string }> = {
  work: { icon: '🔧', label: '工作', desc: '指挥调度 · 派发任务给团队', color: 'text-amber-400' },
  chat: { icon: '💬', label: '闲聊', desc: '自由对话 · 不触发工作流', color: 'text-blue-400' },
  deep: { icon: '🔬', label: '深度', desc: '深入分析 · 可输出文件/派发任务', color: 'text-purple-400' },
  admin: { icon: '🛠️', label: '管理', desc: '修改团队/工作流/项目配置', color: 'text-rose-400' },
};

export function formatSessionTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
