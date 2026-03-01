/**
 * ActivityCharts — 活动时序折线图
 *
 * 展示过去 30 分钟内每分钟的:
 *  - Token 消耗 (input + output)
 *  - 金额预估 (USD)
 *  - 代码行写入
 *  - LLM/工具 调用次数
 *
 * 纯 SVG 实现, 无外部图表库依赖
 *
 * v6.0
 */

import { useState, useEffect, useCallback } from 'react';

const POLL_INTERVAL = 10000; // 10 秒刷新
const CHART_MINUTES = 30;

/** SVG 折线+面积图 — 通用 */
function TimeseriesChart({
  data,
  color,
  label,
  formatter,
  height = 80,
}: {
  data: Array<{ minute: string; value: number }>;
  color: string;
  label: string;
  formatter: (v: number) => string;
  height?: number;
}) {
  const width = 320;
  const maxVal = Math.max(1, ...data.map(d => d.value));
  const padTop = 4;
  const padBottom = 16;
  const chartH = height - padTop - padBottom;

  if (data.length < 2) {
    return (
      <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-800/80 rounded-xl p-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</span>
          <span className="text-xs font-bold text-slate-400">—</span>
        </div>
        <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
          <rect width={width} height={height} rx={4} fill="#0f172a" />
          <text x={width / 2} y={height / 2 + 4} textAnchor="middle" fill="#334155" fontSize={10}>无数据</text>
        </svg>
      </div>
    );
  }

  const step = width / (data.length - 1);
  const points = data.map((d, i) => ({
    x: i * step,
    y: padTop + chartH - (d.value / maxVal) * chartH,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${height - padBottom} L 0 ${height - padBottom} Z`;

  const currentVal = data[data.length - 1]?.value ?? 0;
  const totalVal = data.reduce((sum, d) => sum + d.value, 0);

  return (
    <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-800/80 rounded-xl p-3 hover:border-slate-700/80 transition-all">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-slate-600">本分钟</span>
          <span className="text-xs font-bold" style={{ color }}>{formatter(currentVal)}</span>
        </div>
      </div>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="rounded">
        <defs>
          <linearGradient id={`act-grad-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <rect width={width} height={height} fill="#0f172a" />
        {/* Grid */}
        {[0.25, 0.5, 0.75].map(pct => (
          <line key={pct}
            x1={0} y1={padTop + chartH * (1 - pct)}
            x2={width} y2={padTop + chartH * (1 - pct)}
            stroke="#1e293b" strokeWidth={0.5}
          />
        ))}
        <path d={areaPath} fill={`url(#act-grad-${color.replace('#', '')})`} />
        <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} />
        <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r={2.5} fill={color} />
        {/* Time labels */}
        <text x={4} y={height - 3} fill="#475569" fontSize={8}>-{CHART_MINUTES}m</text>
        <text x={width - 4} y={height - 3} fill="#475569" fontSize={8} textAnchor="end">现在</text>
      </svg>
      <div className="text-[9px] text-slate-600 mt-1">
        30分钟合计: {formatter(totalVal)}
      </div>
    </div>
  );
}

export function ActivityCharts({ projectId }: { projectId: string }) {
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

  const tokenData = data.map(d => ({ minute: d.minute, value: d.inputTokens + d.outputTokens }));
  const costData = data.map(d => ({ minute: d.minute, value: d.costUsd }));
  const linesData = data.map(d => ({ minute: d.minute, value: d.linesWritten }));
  const callsData = data.map(d => ({ minute: d.minute, value: d.llmCalls + d.toolCalls }));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <TimeseriesChart
        data={tokenData}
        color="#3b82f6"
        label="Token 消耗 / 分钟"
        formatter={v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v))}
      />
      <TimeseriesChart
        data={costData}
        color="#f59e0b"
        label="预估金额 / 分钟"
        formatter={v => `$${v < 0.001 ? v.toFixed(6) : v < 0.01 ? v.toFixed(4) : v.toFixed(3)}`}
      />
      <TimeseriesChart
        data={linesData}
        color="#10b981"
        label="代码行写入 / 分钟"
        formatter={v => String(Math.round(v))}
      />
      <TimeseriesChart
        data={callsData}
        color="#8b5cf6"
        label="API 调用 / 分钟"
        formatter={v => String(Math.round(v))}
      />
    </div>
  );
}
