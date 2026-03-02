/**
 * team/ — Shared types & constants for TeamPage components
 */

export const ROLE_INFO: Record<string, { icon: string; title: string }> = {
  pm: { icon: '🧠', title: '产品经理' },
  architect: { icon: '🏗️', title: '架构师' },
  developer: { icon: '💻', title: '开发者' },
  qa: { icon: '🧪', title: 'QA 工程师' },
  reviewer: { icon: '👁️', title: 'Reviewer' },
  devops: { icon: '🚀', title: 'DevOps' },
};

export const STATUS_STYLES: Record<string, string> = {
  idle: 'bg-slate-600',
  working: 'bg-emerald-500 animate-pulse',
  waiting: 'bg-amber-500',
  error: 'bg-red-500',
  stopped: 'bg-slate-700',
};

export const INPUT_CLS = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500';
export const LABEL_CLS = 'text-xs text-slate-500 mb-1 block';

export type EditTab = 'basic' | 'model' | 'mcp' | 'skill';

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
