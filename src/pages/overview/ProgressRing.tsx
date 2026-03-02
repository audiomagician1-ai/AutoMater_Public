export function ProgressRing({ value, size = 100, label, color = '#5c7cfa' }: { value: number; size?: number; label: string; color?: string }) {
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - value / 100);
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#1e293b" strokeWidth={6} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={6}
          strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
          transform={`rotate(-90 ${size/2} ${size/2})`} className="transition-all duration-700" />
        <text x={size/2} y={size/2} textAnchor="middle" dominantBaseline="central" fill="#e2e8f0" fontSize={size * 0.22} fontWeight="bold">
          {Math.round(value)}%
        </text>
      </svg>
      <span className="text-[10px] text-slate-500">{label}</span>
    </div>
  );
}
