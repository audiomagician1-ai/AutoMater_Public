/**
 * ActivityCharts — 活动时序折线图 (紧凑版)
 *
 * 展示过去 30 分钟内每分钟的:
 *  - Token 消耗 (input + output)
 *  - 金额预估 (USD)
 *  - 代码行写入
 *  - LLM/工具 调用次数
 *
 * 紧凑 4 列布局, 与 SystemMonitor 保持一致
 * 纯 SVG 实现, 无外部图表库依赖
 *
 * v6.2 — compact layout matching SystemMonitor
 */

import { useState, useEffect, useCallback } from 'react';

const POLL_INTERVAL = 10000; // 10 秒刷新
const CHART_MINUTES = 30;
const MAX_POINTS = 30; // 30 分钟内每分钟一个点

/** 紧凑迷你面积图 — 与 SystemMonitor 的 MiniAreaChart 视觉对齐 */
const VB_W = 160;
const VB_H = 48;

function MiniTimeseriesChart({
  data,
  color,
}: {
  data: number[];
  color: string;
}) {
  if (data.length < 2) {
    return (
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" className="w-full h-auto opacity-30 rounded">
        <rect width={VB_W} height={VB_H} rx={4} fill="#0f172a" />
        <text x={VB_W / 2} y={VB_H / 2 + 4} textAnchor="middle" fill="#334155" fontSize={10}>待采集...</text>
      </svg>
    );
  }

  const padded = data.length < MAX_POINTS
    ? [...new Array(MAX_POINTS - data.length).fill(0), ...data]
    : data.slice(-MAX_POINTS);

  const maxVal = Math.max(1, ...padded);
  const step = VB_W / (padded.length - 1);
  const points = padded.map((v, i) => ({
    x: i * step,
    y: VB_H - (Math.min(v, maxVal) / maxVal) * (VB_H - 4) - 2,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${VB_H} L ${points[0].x.toFixed(1)} ${VB_H} Z`;

  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" className="w-full h-auto rounded">
      <defs>
        <linearGradient id={`act-grad-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.4} />
          <stop offset="100%" stopColor={color} stopOpacity={0.05} />
        </linearGradient>
      </defs>
      <rect width={VB_W} height={VB_H} rx={4} fill="#0f172a" />
      {/* Grid lines */}
      {[25, 50, 75].map(pct => (
        <line key={pct}
          x1={0} y1={VB_H - (pct / 100) * (VB_H - 4) - 2}
          x2={VB_W} y2={VB_H - (pct / 100) * (VB_H - 4) - 2}
          stroke="#1e293b" strokeWidth={0.5}
        />
      ))}
      <path d={areaPath} fill={`url(#act-grad-${color.replace('#', '')})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} />
      <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r={2.5} fill={color} />
    </svg>
  );
}

export function ActivityCharts({ projectId, inline }: { projectId: string; inline?: boolean }) {
  const [data, setData] = useState<ActivityDataPoint[]>([]);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const result = await window.automater.monitor.getActivityTimeseries(projectId, CHART_MINUTES);
      setData(result);
    } catch { /* ignore */ }
  }, [projectId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [load]);

  const tokenValues = data.map(d => d.inputTokens + d.outputTokens);
  const costValues = data.map(d => d.costUsd);
  const linesValues = data.map(d => d.linesWritten);
  const callsValues = data.map(d => d.llmCalls + d.toolCalls);

  const currentToken = tokenValues[tokenValues.length - 1] ?? 0;
  const currentCost = costValues[costValues.length - 1] ?? 0;
  const currentLines = linesValues[linesValues.length - 1] ?? 0;
  const currentCalls = callsValues[callsValues.length - 1] ?? 0;

  const totalToken = tokenValues.reduce((a, b) => a + b, 0);
  const totalCost = costValues.reduce((a, b) => a + b, 0);
  const totalLines = linesValues.reduce((a, b) => a + b, 0);
  const totalCalls = callsValues.reduce((a, b) => a + b, 0);

  const fmtToken = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
  const fmtCost = (v: number) => `$${v < 0.001 ? v.toFixed(4) : v < 0.01 ? v.toFixed(3) : v.toFixed(2)}`;

  const cards = (
    <>
      {/* Token 消耗 */}
      <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-800/80 rounded-xl p-3 space-y-2 hover:border-slate-700/80 transition-all min-w-0 overflow-hidden">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">Tokens</span>
          <span className="text-sm font-bold text-blue-400">{fmtToken(currentToken)}</span>
        </div>
        <MiniTimeseriesChart data={tokenValues} color="#3b82f6" />
        <div className="text-[9px] text-slate-600">
          30m 合计: {fmtToken(totalToken)}
        </div>
      </div>

      {/* 金额 */}
      <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-800/80 rounded-xl p-3 space-y-2 hover:border-slate-700/80 transition-all min-w-0 overflow-hidden">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">费用</span>
          <span className="text-sm font-bold text-amber-400">{fmtCost(currentCost)}</span>
        </div>
        <MiniTimeseriesChart data={costValues} color="#f59e0b" />
        <div className="text-[9px] text-slate-600">
          30m 合计: {fmtCost(totalCost)}
        </div>
      </div>

      {/* 代码行 */}
      <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-800/80 rounded-xl p-3 space-y-2 hover:border-slate-700/80 transition-all min-w-0 overflow-hidden">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">代码行</span>
          <span className="text-sm font-bold text-emerald-400">{Math.round(currentLines)}</span>
        </div>
        <MiniTimeseriesChart data={linesValues} color="#10b981" />
        <div className="text-[9px] text-slate-600">
          30m 合计: {Math.round(totalLines)}
        </div>
      </div>

      {/* API 调用 */}
      <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-800/80 rounded-xl p-3 space-y-2 hover:border-slate-700/80 transition-all min-w-0 overflow-hidden">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">API 调用</span>
          <span className="text-sm font-bold text-violet-400">{Math.round(currentCalls)}</span>
        </div>
        <MiniTimeseriesChart data={callsValues} color="#8b5cf6" />
        <div className="text-[9px] text-slate-600">
          30m 合计: {Math.round(totalCalls)}
        </div>
      </div>
    </>
  );

  if (inline) return cards;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards}
    </div>
  );
}
