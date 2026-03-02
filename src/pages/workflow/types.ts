/**
 * workflow/ — Shared types & constants
 */

export const MISSION_TYPES = [
  { type: 'regression_test', icon: '🧪', label: '回归测试', desc: '全量 Feature 回归' },
  { type: 'code_review',    icon: '🔍', label: '代码审查', desc: '质量/安全/性能审查' },
  { type: 'retrospective',  icon: '📊', label: '架构复盘', desc: '多维度架构分析' },
  { type: 'security_audit', icon: '🔒', label: '安全审计', desc: 'OWASP + CWE 扫描' },
  { type: 'perf_benchmark', icon: '⚡', label: '性能基准', desc: '关键路径性能分析' },
] as const;

const COLOR_MAP: Record<string, { bg: string; border: string; text: string }> = {
  'bg-violet-500':  { bg: '#7c3aed', border: '#8b5cf6', text: '#c4b5fd' },
  'bg-blue-500':    { bg: '#3b82f6', border: '#60a5fa', text: '#93c5fd' },
  'bg-cyan-500':    { bg: '#06b6d4', border: '#22d3ee', text: '#67e8f9' },
  'bg-amber-500':   { bg: '#f59e0b', border: '#fbbf24', text: '#fcd34d' },
  'bg-emerald-500': { bg: '#10b981', border: '#34d399', text: '#6ee7b7' },
  'bg-indigo-500':  { bg: '#6366f1', border: '#818cf8', text: '#a5b4fc' },
  'bg-rose-500':    { bg: '#f43f5e', border: '#fb7185', text: '#fda4af' },
  'bg-teal-500':    { bg: '#14b8a6', border: '#2dd4bf', text: '#5eead4' },
  'bg-orange-500':  { bg: '#f97316', border: '#fb923c', text: '#fdba74' },
  'bg-red-500':     { bg: '#ef4444', border: '#f87171', text: '#fca5a5' },
  'bg-forge-500':   { bg: '#5c7cfa', border: '#748ffc', text: '#91a7ff' },
};

export function getStageColor(colorClass: string) {
  return COLOR_MAP[colorClass] || { bg: '#475569', border: '#64748b', text: '#94a3b8' };
}

export const MISSION_STATUS: Record<string, { text: string; color: string; icon: string }> = {
  pending:   { text: '等待中', color: 'text-slate-400', icon: '⏳' },
  planning:  { text: '规划中', color: 'text-blue-400', icon: '📋' },
  executing: { text: '执行中', color: 'text-amber-400', icon: '⚡' },
  judging:   { text: '评估中', color: 'text-violet-400', icon: '⚖️' },
  completed: { text: '已完成', color: 'text-emerald-400', icon: '✅' },
  failed:    { text: '失败', color: 'text-red-400', icon: '❌' },
  cancelled: { text: '已取消', color: 'text-slate-500', icon: '⏹' },
};

export const TASK_STATUS_STYLE: Record<string, { icon: string; color: string }> = {
  pending:  { icon: '○', color: 'text-slate-500' },
  running:  { icon: '◉', color: 'text-amber-400' },
  passed:   { icon: '✓', color: 'text-emerald-400' },
  failed:   { icon: '✗', color: 'text-red-400' },
  skipped:  { icon: '–', color: 'text-slate-600' },
};
