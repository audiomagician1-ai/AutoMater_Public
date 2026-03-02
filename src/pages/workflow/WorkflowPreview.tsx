/**
 * WorkflowPreview — 大尺寸 SVG 流水线图
 */

import { getStageColor } from './types';

export function WorkflowPreview({ stages, activeStageIndex }: {
  stages: WorkflowStageInfo[];
  activeStageIndex: number;
}) {
  if (stages.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-slate-600">
        <div className="text-center">
          <div className="text-4xl mb-2">🔄</div>
          <div className="text-sm">选择或创建工作流</div>
        </div>
      </div>
    );
  }

  const nodeW = 110;
  const nodeH = 64;
  const gap = 40;
  const totalW = stages.length * (nodeW + gap) - gap + 80;
  const totalH = nodeH + 80;

  return (
    <div className="h-full w-full overflow-x-auto overflow-y-hidden flex items-center">
      <svg
        width={Math.max(totalW, 600)}
        height={totalH}
        viewBox={`0 0 ${Math.max(totalW, 600)} ${totalH}`}
        className="mx-auto"
      >
        <defs>
          <marker id="wf-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569" />
          </marker>
          <marker id="wf-arrow-active" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#5c7cfa" />
          </marker>
          <filter id="glow">
            <feGaussianBlur in="SourceAlpha" stdDeviation="4" result="blur" />
            <feFlood floodColor="#5c7cfa" floodOpacity="0.4" result="color" />
            <feComposite in2="blur" operator="in" result="shadow" />
            <feMerge>
              <feMergeNode in="shadow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {stages.map((stage, i) => {
          const x = 40 + i * (nodeW + gap);
          const y = (totalH - nodeH) / 2;
          const sc = getStageColor(stage.color);
          const isActive = i === activeStageIndex;
          const isPast = i < activeStageIndex;
          const isFuture = i > activeStageIndex;

          return (
            <g key={stage.id + '-' + i}>
              {i > 0 && (
                <line
                  x1={x - gap + 4} y1={y + nodeH / 2}
                  x2={x - 4} y2={y + nodeH / 2}
                  stroke={isPast || isActive ? '#5c7cfa' : '#334155'}
                  strokeWidth={isPast || isActive ? 2 : 1.5}
                  markerEnd={isPast || isActive ? 'url(#wf-arrow-active)' : 'url(#wf-arrow)'}
                />
              )}

              <g filter={isActive ? 'url(#glow)' : undefined}>
                <rect
                  x={x} y={y} width={nodeW} height={nodeH} rx={12}
                  fill={isActive ? sc.bg + '30' : isPast ? sc.bg + '18' : '#1e293b'}
                  stroke={isActive ? sc.border : isPast ? sc.bg + '60' : '#334155'}
                  strokeWidth={isActive ? 2.5 : 1.5}
                  opacity={isFuture ? 0.5 : 1}
                />
                {isActive && (
                  <rect
                    x={x} y={y} width={nodeW} height={nodeH} rx={12}
                    fill="none" stroke={sc.border} strokeWidth={2} opacity={0.4}
                  >
                    <animate attributeName="opacity" values="0.4;0.1;0.4" dur="2s" repeatCount="indefinite" />
                  </rect>
                )}
              </g>

              <text x={x + nodeW / 2} y={y + 24} textAnchor="middle" fontSize={18} opacity={isFuture ? 0.4 : 1}>
                {isPast ? '✓' : stage.icon}
              </text>

              <text
                x={x + nodeW / 2} y={y + 44} textAnchor="middle" fontSize={10}
                fill={isActive ? sc.text : isPast ? '#94a3b8' : '#64748b'}
                fontFamily="sans-serif" fontWeight={isActive ? 'bold' : 'normal'}
              >
                {stage.label.length > 10 ? stage.label.slice(0, 9) + '…' : stage.label}
              </text>

              {stage.skippable && (
                <text x={x + nodeW - 6} y={y + 12} textAnchor="end" fontSize={8} fill="#64748b">可跳</text>
              )}
              <text x={x + 8} y={y + 12} fontSize={8} fill="#475569" fontFamily="monospace">{i + 1}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
