/**
 * SystemMonitor — 系统性能实时监控 (类 Windows 任务管理器)
 *
 * CPU / GPU / 内存 / 进程内存 实时迷你面积图
 * 每 2 秒采样一次, 保留最近 60 个数据点 (2 分钟)
 *
 * v6.0
 */

import { useState, useEffect, useRef, useCallback } from 'react';

interface MetricHistory {
  /** 最近 N 次采样的值 (0~100) */
  values: number[];
}

const MAX_POINTS = 60; // 2 分钟 @ 2s interval
const POLL_INTERVAL = 2000;

/** 迷你面积图 — SVG 实现, 无外部依赖 */
function MiniAreaChart({
  data,
  color,
  height = 48,
  width = 160,
  maxValue = 100,
}: {
  data: number[];
  color: string;
  height?: number;
  width?: number;
  maxValue?: number;
}) {
  if (data.length < 2) {
    return (
      <svg width={width} height={height} className="opacity-30">
        <rect width={width} height={height} rx={4} fill="#0f172a" />
        <text x={width / 2} y={height / 2 + 4} textAnchor="middle" fill="#334155" fontSize={10}>待采样...</text>
      </svg>
    );
  }

  const padded = data.length < MAX_POINTS
    ? [...new Array(MAX_POINTS - data.length).fill(0), ...data]
    : data.slice(-MAX_POINTS);

  const step = width / (padded.length - 1);
  const points = padded.map((v, i) => ({
    x: i * step,
    y: height - (Math.min(v, maxValue) / maxValue) * (height - 4) - 2,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${height} L ${points[0].x} ${height} Z`;

  return (
    <svg width={width} height={height} className="rounded">
      <defs>
        <linearGradient id={`grad-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.4} />
          <stop offset="100%" stopColor={color} stopOpacity={0.05} />
        </linearGradient>
      </defs>
      <rect width={width} height={height} rx={4} fill="#0f172a" />
      {/* Grid lines */}
      {[25, 50, 75].map(pct => (
        <line key={pct} x1={0} y1={height - (pct / 100) * (height - 4) - 2}
          x2={width} y2={height - (pct / 100) * (height - 4) - 2}
          stroke="#1e293b" strokeWidth={0.5} />
      ))}
      <path d={areaPath} fill={`url(#grad-${color.replace('#', '')})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} />
      {/* Current value dot */}
      <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r={2.5} fill={color} />
    </svg>
  );
}

/** 格式化字节为人类可读 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} GB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} TB`;
}

export function SystemMonitor({ inline }: { inline?: boolean }) {
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [memHistory, setMemHistory] = useState<number[]>([]);
  const [gpuHistory, setGpuHistory] = useState<number[]>([]);
  const [procMemHistory, setProcMemHistory] = useState<number[]>([]);
  const [latestMetrics, setLatestMetrics] = useState<SystemMetrics | null>(null);

  const poll = useCallback(async () => {
    try {
      const m = await window.automater.monitor.getSystemMetrics();
      setLatestMetrics(m);
      setCpuHistory(prev => [...prev.slice(-(MAX_POINTS - 1)), m.cpu.usage]);
      setMemHistory(prev => [...prev.slice(-(MAX_POINTS - 1)), m.memory.percent]);
      setGpuHistory(prev => [...prev.slice(-(MAX_POINTS - 1)), m.gpu.usage >= 0 ? m.gpu.usage : 0]);
      setProcMemHistory(prev => [...prev.slice(-(MAX_POINTS - 1)), m.process.memoryMB]);
    } catch { /* 忽略采集失败 */ }
  }, []);

  useEffect(() => {
    poll(); // 首次立即采集
    const timer = setInterval(poll, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [poll]);

  const m = latestMetrics;

  const cards = (
    <>
      {/* CPU */}
      <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-800/80 rounded-xl p-3 space-y-2 hover:border-slate-700/80 transition-all">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">CPU</span>
          <span className="text-sm font-bold text-cyan-400">{m?.cpu.usage ?? 0}%</span>
        </div>
        <MiniAreaChart data={cpuHistory} color="#22d3ee" />
        <div className="text-[9px] text-slate-600">
          {m?.cpu.cores ?? 0} 核心
        </div>
      </div>

      {/* Memory */}
      <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-800/80 rounded-xl p-3 space-y-2 hover:border-slate-700/80 transition-all">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">内存</span>
          <span className="text-sm font-bold text-violet-400">{m?.memory.percent ?? 0}%</span>
        </div>
        <MiniAreaChart data={memHistory} color="#8b5cf6" />
        <div className="text-[9px] text-slate-600">
          {m ? `${formatBytes(m.memory.used)} / ${formatBytes(m.memory.total)}` : '—'}
        </div>
      </div>

      {/* GPU */}
      <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-800/80 rounded-xl p-3 space-y-2 hover:border-slate-700/80 transition-all">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">GPU</span>
          <span className="text-sm font-bold text-emerald-400">
            {m?.gpu.usage != null && m.gpu.usage >= 0 ? `${m.gpu.usage}%` : 'N/A'}
          </span>
        </div>
        <MiniAreaChart
          data={gpuHistory}
          color="#10b981"
        />
        <div className="text-[9px] text-slate-600 truncate">
          {m?.gpu.name !== 'N/A' ? m?.gpu.name : '未检测到 GPU'}
          {m?.gpu.memoryPercent != null && m.gpu.memoryPercent >= 0 && ` · 显存 ${m.gpu.memoryPercent}%`}
        </div>
      </div>

      {/* Process Memory */}
      <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-800/80 rounded-xl p-3 space-y-2 hover:border-slate-700/80 transition-all">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">进程内存</span>
          <span className="text-sm font-bold text-amber-400">{m?.process.memoryMB ?? 0} MB</span>
        </div>
        <MiniAreaChart
          data={procMemHistory}
          color="#f59e0b"
          maxValue={Math.max(512, ...procMemHistory, m?.process.memoryMB ?? 0) * 1.2}
        />
        <div className="text-[9px] text-slate-600">
          运行 {m?.process.uptimeS ? `${Math.floor(m.process.uptimeS / 60)}m ${m.process.uptimeS % 60}s` : '—'}
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
