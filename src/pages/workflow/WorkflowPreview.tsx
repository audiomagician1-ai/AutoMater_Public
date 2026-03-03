/**
 * WorkflowPreview — SVG 流水线图 (v25.0 DAG transitions 支持)
 *
 * 支持: 线性箭头 (默认), 显式 transition 箭头, 自循环重试弧线, 条件标签
 */

import { getStageColor } from './types';

/** Transition 条件的显示样式 */
const CONDITION_STYLE: Record<string, { label: string; color: string }> = {
  success: { label: '✓', color: '#34d399' },
  failure: { label: '✗', color: '#f87171' },
  always:  { label: '→', color: '#94a3b8' },
};

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
  // 留出上方空间给自循环弧线
  const topPad = 40;
  const totalH = nodeH + 80 + topPad;
  const baseY = topPad;

  // 预计算节点位置
  const nodePositions = stages.map((_, i) => ({
    x: 40 + i * (nodeW + gap),
    y: baseY + (totalH - nodeH - topPad) / 2,
    cx: 40 + i * (nodeW + gap) + nodeW / 2,
    cy: baseY + (totalH - nodeH - topPad) / 2 + nodeH / 2,
  }));

  // 构建 stageId → index 映射
  const stageIdxMap = new Map<string, number>();
  stages.forEach((s, i) => stageIdxMap.set(s.id, i));

  // 收集需要渲染的 DAG 箭头
  type Arrow = { fromIdx: number; toIdx: number; condition: string; maxRetries?: number; isSelfLoop: boolean };
  const dagArrows: Arrow[] = [];
  const hasExplicitTransitions = new Set<number>(); // 有显式 transitions 的阶段

  stages.forEach((stage, i) => {
    const trans = (stage as { transitions?: Array<{ target: string; condition: string; maxRetries?: number }> }).transitions;
    if (!trans || trans.length === 0) return;
    hasExplicitTransitions.add(i);
    for (const t of trans) {
      const toIdx = stageIdxMap.get(t.target);
      if (toIdx === undefined) continue;
      dagArrows.push({
        fromIdx: i,
        toIdx,
        condition: t.condition,
        maxRetries: t.maxRetries,
        isSelfLoop: i === toIdx,
      });
    }
  });

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
          <marker id="wf-arrow-success" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#34d399" />
          </marker>
          <marker id="wf-arrow-failure" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#f87171" />
          </marker>
          <marker id="wf-arrow-always" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
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

        {/* Default linear arrows (only between stages without explicit transitions) */}
        {stages.map((_, i) => {
          if (i === 0) return null;
          // 如果前一阶段有显式 transitions, 跳过默认箭头
          if (hasExplicitTransitions.has(i - 1)) return null;
          const pos = nodePositions[i];
          const isActive = i === activeStageIndex;
          const isPast = i < activeStageIndex;
          return (
            <line
              key={`default-arrow-${i}`}
              x1={pos.x - gap + 4} y1={pos.cy}
              x2={pos.x - 4} y2={pos.cy}
              stroke={isPast || isActive ? '#5c7cfa' : '#334155'}
              strokeWidth={isPast || isActive ? 2 : 1.5}
              markerEnd={isPast || isActive ? 'url(#wf-arrow-active)' : 'url(#wf-arrow)'}
            />
          );
        })}

        {/* DAG transition arrows */}
        {dagArrows.map((arrow, ai) => {
          const { fromIdx, toIdx, condition, maxRetries, isSelfLoop } = arrow;
          const from = nodePositions[fromIdx];
          const to = nodePositions[toIdx];
          const style = CONDITION_STYLE[condition] || CONDITION_STYLE.always;
          const markerId = `wf-arrow-${condition}`;

          if (isSelfLoop) {
            // 自循环: 画一个上方弧线
            const cx = from.cx;
            const topY = from.y - 20;
            const halfW = 25;
            return (
              <g key={`dag-${ai}`}>
                <path
                  d={`M ${cx - halfW} ${from.y} C ${cx - halfW} ${topY}, ${cx + halfW} ${topY}, ${cx + halfW} ${from.y}`}
                  fill="none" stroke={style.color} strokeWidth={1.5} strokeDasharray="4,3"
                  markerEnd={`url(#${markerId})`} opacity={0.7}
                />
                <text x={cx} y={topY - 2} textAnchor="middle" fontSize={8} fill={style.color} opacity={0.9}>
                  {style.label} 重试{maxRetries ? `(≤${maxRetries})` : ''}
                </text>
              </g>
            );
          }

          // 非自循环: 从 from 的右边到 to 的左边
          const isForward = toIdx > fromIdx;
          const fromX = isForward ? from.x + nodeW : from.x;
          const toX = isForward ? to.x : to.x + nodeW;
          const offsetY = condition === 'failure' ? 10 : condition === 'always' ? -8 : 0;

          if (Math.abs(toIdx - fromIdx) === 1 && isForward) {
            // 相邻前向: 直线
            return (
              <g key={`dag-${ai}`}>
                <line
                  x1={fromX + 4} y1={from.cy + offsetY}
                  x2={toX - 6} y2={to.cy + offsetY}
                  stroke={style.color} strokeWidth={1.5} opacity={0.7}
                  markerEnd={`url(#${markerId})`}
                />
                {condition !== 'success' && (
                  <text
                    x={(fromX + toX) / 2} y={from.cy + offsetY - 6}
                    textAnchor="middle" fontSize={7} fill={style.color} opacity={0.8}
                  >
                    {style.label}
                  </text>
                )}
              </g>
            );
          }

          // 非相邻或后退: 曲线
          const midX = (fromX + toX) / 2;
          const curveY = isForward ? from.cy - 30 + offsetY : from.cy + nodeH / 2 + 20;
          return (
            <g key={`dag-${ai}`}>
              <path
                d={`M ${fromX + 4} ${from.cy + offsetY} Q ${midX} ${curveY}, ${toX - 6} ${to.cy + offsetY}`}
                fill="none" stroke={style.color} strokeWidth={1.5} strokeDasharray="4,3"
                markerEnd={`url(#${markerId})`} opacity={0.6}
              />
              <text
                x={midX} y={curveY + (isForward ? -4 : 12)}
                textAnchor="middle" fontSize={7} fill={style.color} opacity={0.8}
              >
                {style.label}{maxRetries ? ` (≤${maxRetries})` : ''}
              </text>
            </g>
          );
        })}

        {/* Stage nodes */}
        {stages.map((stage, i) => {
          const pos = nodePositions[i];
          const sc = getStageColor(stage.color);
          const isActive = i === activeStageIndex;
          const isPast = i < activeStageIndex;
          const isFuture = i > activeStageIndex;

          return (
            <g key={stage.id + '-' + i}>
              <g filter={isActive ? 'url(#glow)' : undefined}>
                <rect
                  x={pos.x} y={pos.y} width={nodeW} height={nodeH} rx={12}
                  fill={isActive ? sc.bg + '30' : isPast ? sc.bg + '18' : '#1e293b'}
                  stroke={isActive ? sc.border : isPast ? sc.bg + '60' : '#334155'}
                  strokeWidth={isActive ? 2.5 : 1.5}
                  opacity={isFuture ? 0.5 : 1}
                />
                {isActive && (
                  <rect
                    x={pos.x} y={pos.y} width={nodeW} height={nodeH} rx={12}
                    fill="none" stroke={sc.border} strokeWidth={2} opacity={0.4}
                  >
                    <animate attributeName="opacity" values="0.4;0.1;0.4" dur="2s" repeatCount="indefinite" />
                  </rect>
                )}
              </g>

              <text x={pos.cx} y={pos.y + 24} textAnchor="middle" fontSize={18} opacity={isFuture ? 0.4 : 1}>
                {isPast ? '✓' : stage.icon}
              </text>

              <text
                x={pos.cx} y={pos.y + 44} textAnchor="middle" fontSize={10}
                fill={isActive ? sc.text : isPast ? '#94a3b8' : '#64748b'}
                fontFamily="sans-serif" fontWeight={isActive ? 'bold' : 'normal'}
              >
                {stage.label.length > 10 ? stage.label.slice(0, 9) + '…' : stage.label}
              </text>

              {stage.skippable && (
                <text x={pos.x + nodeW - 6} y={pos.y + 12} textAnchor="end" fontSize={8} fill="#64748b">可跳</text>
              )}
              <text x={pos.x + 8} y={pos.y + 12} fontSize={8} fill="#475569" fontFamily="monospace">{i + 1}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
