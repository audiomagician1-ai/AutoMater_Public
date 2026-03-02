import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useAppStore } from '../../stores/app-store';
import {
  type Feature, type ViewLevel, type BreadcrumbItem, type GraphNode,
  STATUS_COLOR, CATEGORY_BADGE,
  buildDagreGraph, aggregateModules, aggregateSubModules,
  statusCountsFromFeatures, dominantStatus,
  getAgentRoleIcon,
} from './types';

// ═══════════════════════════════════════
// Mini progress bar for aggregate nodes
// ═══════════════════════════════════════

function MiniProgressBar({ counts, width }: { counts: Record<string, number>; width: number }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const barW = width - 20;
  let offset = 0;

  return (
    <g transform={`translate(10, 0)`}>
      <rect width={barW} height={4} rx={2} fill="#1e293b" />
      {['passed', 'in_progress', 'reviewing', 'failed', 'todo'].map(status => {
        const count = counts[status] || 0;
        if (count === 0) return null;
        const w = (count / total) * barW;
        const x = offset;
        offset += w;
        const color = STATUS_COLOR[status]?.stroke || '#475569';
        return <rect key={status} x={x} width={w} height={4} rx={0} fill={color} />;
      })}
    </g>
  );
}

// ═══════════════════════════════════════
// Interactive Graph Component
// ═══════════════════════════════════════

export function InteractiveGraph({
  features,
  onDrillDown,
}: {
  features: Feature[];
  onDrillDown: (level: ViewLevel, value: string) => void;
}) {
  const { featureStatuses, agentStatuses } = useAppStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [tooltipAgent, setTooltipAgent] = useState<{ agentId: string; x: number; y: number } | null>(null);
  const [viewLevel, setViewLevel] = useState<ViewLevel>('module');
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>([
    { level: 'module', label: '系统模块' },
  ]);
  const [filterGroup, setFilterGroup] = useState<string | null>(null);
  const [filterSubGroup, setFilterSubGroup] = useState<string | null>(null);

  // Enrich with realtime statuses
  const enriched = useMemo(
    () => features.map(f => ({ ...f, status: featureStatuses.get(f.id) || f.status })),
    [features, featureStatuses],
  );

  // Build graph nodes based on current view level
  const graphNodes = useMemo(() => {
    if (viewLevel === 'module') {
      const groups = aggregateModules(enriched);
      const moduleNodes = [...groups.entries()].map(([name, feats]) => {
        const counts = statusCountsFromFeatures(feats);
        const groupFeatureIds = new Set(feats.map(f => f.id));
        const depGroups = new Set<string>();
        for (const f of feats) {
          let deps: string[] = [];
          try { deps = JSON.parse(f.depends_on || '[]'); } catch {}
          for (const d of deps) {
            if (!groupFeatureIds.has(d)) {
              for (const [gn, gfeats] of groups) {
                if (gn !== name && gfeats.some(gf => gf.id === d)) {
                  depGroups.add(gn);
                }
              }
            }
          }
        }
        return {
          id: name, label: name,
          status: dominantStatus(counts),
          category: feats[0]?.category || 'core',
          deps: [...depGroups],
          childCount: feats.length,
          statusCounts: counts,
        };
      });
      return buildDagreGraph(moduleNodes, 200, 70);
    }

    if (viewLevel === 'submodule' && filterGroup) {
      const groupFeatures = enriched.filter(f => (f.group_name || f.category || 'other') === filterGroup);
      const subGroups = aggregateSubModules(groupFeatures);

      if (subGroups.size <= 1) {
        const featureNodes = groupFeatures.map(f => {
          let deps: string[] = [];
          try { deps = JSON.parse(f.depends_on || '[]'); } catch {}
          return { id: f.id, label: f.title || f.description, status: f.status, category: f.category, deps, feature: f };
        });
        return buildDagreGraph(featureNodes, 180, 56);
      }

      const subNodes = [...subGroups.entries()].map(([name, feats]) => {
        const counts = statusCountsFromFeatures(feats);
        const subFeatureIds = new Set(feats.map(f => f.id));
        const depSubs = new Set<string>();
        for (const f of feats) {
          let deps: string[] = [];
          try { deps = JSON.parse(f.depends_on || '[]'); } catch {}
          for (const d of deps) {
            if (!subFeatureIds.has(d)) {
              for (const [sn, sfeats] of subGroups) {
                if (sn !== name && sfeats.some(sf => sf.id === d)) depSubs.add(sn);
              }
            }
          }
        }
        return {
          id: name, label: name,
          status: dominantStatus(counts),
          category: feats[0]?.category || 'core',
          deps: [...depSubs],
          childCount: feats.length,
          statusCounts: counts,
        };
      });
      return buildDagreGraph(subNodes, 200, 70);
    }

    // L3: Individual features
    const filtered = filterSubGroup
      ? enriched.filter(f => (f.sub_group || f.title || f.id) === filterSubGroup)
      : filterGroup
        ? enriched.filter(f => (f.group_name || f.category || 'other') === filterGroup)
        : enriched;

    const featureNodes = filtered.map(f => {
      let deps: string[] = [];
      try { deps = JSON.parse(f.depends_on || '[]'); } catch {}
      return { id: f.id, label: f.title || f.description, status: f.status, category: f.category, deps, feature: f };
    });
    return buildDagreGraph(featureNodes, 180, 56);
  }, [viewLevel, enriched, filterGroup, filterSubGroup]);

  // Canvas bounds
  const maxX = graphNodes.length > 0 ? Math.max(...graphNodes.map(n => n.x + n.width)) + 40 : 600;
  const maxY = graphNodes.length > 0 ? Math.max(...graphNodes.map(n => n.y + n.height)) + 40 : 400;

  // Edges
  const edges = useMemo(() => {
    const nodeMap = new Map(graphNodes.map(n => [n.id, n]));
    const result: Array<{ from: GraphNode; to: GraphNode }> = [];
    for (const node of graphNodes) {
      for (const depId of node.deps) {
        const depNode = nodeMap.get(depId);
        if (depNode) result.push({ from: depNode, to: node });
      }
    }
    return result;
  }, [graphNodes]);

  // ── Event handlers ──

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const delta = e.deltaY > 0 ? 0.92 : 1.08;
    setTransform(t => {
      const newScale = Math.max(0.15, Math.min(4, t.scale * delta));
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        return { scale: newScale, x: cx - (cx - t.x) * (newScale / t.scale), y: cy - (cy - t.y) * (newScale / t.scale) };
      }
      return { ...t, scale: newScale };
    });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setDragging(true);
    setDragStart({ x: e.clientX - transform.x, y: e.clientY - transform.y });
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    setTransform(t => ({ ...t, x: e.clientX - dragStart.x, y: e.clientY - dragStart.y }));
  };
  const handleMouseUp = () => setDragging(false);

  const handleDoubleClick = (node: GraphNode) => {
    if (viewLevel === 'module') {
      setViewLevel('submodule');
      setFilterGroup(node.id);
      setFilterSubGroup(null);
      setBreadcrumb([
        { level: 'module', label: '系统模块' },
        { level: 'submodule', label: node.label, filterValue: node.id },
      ]);
      setTransform({ x: 0, y: 0, scale: 1 });
    } else if (viewLevel === 'submodule' && node.childCount) {
      setViewLevel('feature');
      setFilterSubGroup(node.id);
      setBreadcrumb(prev => [
        ...prev,
        { level: 'feature', label: node.label, filterValue: node.id },
      ]);
      setTransform({ x: 0, y: 0, scale: 1 });
    }
  };

  const navigateToBreadcrumb = (item: BreadcrumbItem) => {
    setViewLevel(item.level);
    if (item.level === 'module') {
      setFilterGroup(null);
      setFilterSubGroup(null);
      setBreadcrumb([{ level: 'module', label: '系统模块' }]);
    } else if (item.level === 'submodule') {
      setFilterGroup(item.filterValue ?? null);
      setFilterSubGroup(null);
      setBreadcrumb(prev => prev.slice(0, 2));
    }
    setTransform({ x: 0, y: 0, scale: 1 });
  };

  const zoomIn = () => setTransform(t => ({ ...t, scale: Math.min(4, t.scale * 1.2) }));
  const zoomOut = () => setTransform(t => ({ ...t, scale: Math.max(0.15, t.scale * 0.8) }));
  const resetView = () => setTransform({ x: 0, y: 0, scale: 1 });

  const getAgentForFeature = (featureId: string) => {
    for (const [agentId, status] of agentStatuses.entries()) {
      if (status.status === 'working' && status.currentTask === featureId) return { agentId, ...status };
    }
    return null;
  };

  const getAgentsForFeatureSet = (featureIds: Set<string>) => {
    const agents: Array<{ agentId: string; status: string; currentTask: string | null; featureTitle?: string }> = [];
    for (const [agentId, status] of agentStatuses.entries()) {
      if (status.status === 'working' && status.currentTask && featureIds.has(status.currentTask)) {
        agents.push({ agentId, ...status });
      }
    }
    return agents;
  };

  const moduleFeatureIds = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const f of enriched) {
      const key = f.group_name || f.category || 'other';
      if (!m.has(key)) m.set(key, new Set());
      m.get(key)!.add(f.id);
    }
    return m;
  }, [enriched]);

  return (
    <div className="space-y-2">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-xs">
        {breadcrumb.map((item, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-slate-600">›</span>}
            <button
              onClick={() => navigateToBreadcrumb(item)}
              className={`px-2 py-0.5 rounded transition-colors ${
                i === breadcrumb.length - 1
                  ? 'bg-forge-600/20 text-forge-400'
                  : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
              }`}
            >
              {item.label}
            </button>
          </span>
        ))}
      </div>

      {/* Graph container */}
      <div
        className="relative overflow-hidden border border-slate-800 rounded-xl bg-slate-950/50"
        style={{ height: '460px', touchAction: 'none' }}
      >
        {/* Controls */}
        <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
          <button onClick={zoomIn} className="w-8 h-8 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300 text-sm flex items-center justify-center" title="放大">+</button>
          <button onClick={zoomOut} className="w-8 h-8 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300 text-sm flex items-center justify-center" title="缩小">−</button>
          <button onClick={resetView} className="w-8 h-8 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300 text-xs flex items-center justify-center" title="重置">⟲</button>
        </div>
        <div className="absolute bottom-3 left-3 z-10 text-[10px] text-slate-600">
          缩放: {(transform.scale * 100).toFixed(0)}% · 滚轮缩放 · 拖拽平移 · 双击下钻
        </div>

        <div
          ref={containerRef}
          className="w-full h-full cursor-grab active:cursor-grabbing"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <svg width="100%" height="100%">
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569" />
              </marker>
              <marker id="arrow-hl" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#5c7cfa" />
              </marker>
            </defs>

            <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
              {/* Edges */}
              {edges.map((e, i) => {
                const fromX = e.from.x + e.from.width;
                const fromY = e.from.y + e.from.height / 2;
                const toX = e.to.x;
                const toY = e.to.y + e.to.height / 2;
                const midX = (fromX + toX) / 2;
                const isHl = hoveredNode === e.from.id || hoveredNode === e.to.id;
                return (
                  <path key={i}
                    d={`M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`}
                    fill="none" stroke={isHl ? '#5c7cfa' : '#334155'} strokeWidth={isHl ? 2 : 1.5}
                    markerEnd={isHl ? 'url(#arrow-hl)' : 'url(#arrow)'}
                    className="transition-all duration-200"
                  />
                );
              })}

              {/* Nodes */}
              {graphNodes.map(node => {
                const sc = STATUS_COLOR[node.status] || STATUS_COLOR.todo;
                const isHl = hoveredNode === node.id;
                const isAggregate = !!node.childCount;
                const agent = !isAggregate && node.feature ? getAgentForFeature(node.id) : null;
                const moduleAgents = isAggregate ? getAgentsForFeatureSet(moduleFeatureIds.get(node.id) || new Set()) : [];

                return (
                  <g key={node.id} transform={`translate(${node.x}, ${node.y})`}
                    onMouseEnter={() => setHoveredNode(node.id)}
                    onMouseLeave={() => { setHoveredNode(null); setTooltipAgent(null); }}
                    onDoubleClick={() => handleDoubleClick(node)}
                    className="cursor-pointer"
                  >
                    {(node.status === 'in_progress' || agent || moduleAgents.length > 0) && (
                      <rect width={node.width} height={node.height} rx={10} fill="none" stroke={sc.stroke} strokeWidth={2} opacity={0.3}>
                        <animate attributeName="opacity" values="0.3;0.1;0.3" dur="2s" repeatCount="indefinite" />
                      </rect>
                    )}

                    <rect width={node.width} height={node.height} rx={10} fill={sc.fill}
                      stroke={isHl ? '#5c7cfa' : sc.stroke} strokeWidth={isHl ? 2 : 1}
                      className="transition-all duration-200"
                    />

                    <circle cx={14} cy={isAggregate ? 20 : node.height / 2} r={4} fill={sc.stroke}>
                      {(node.status === 'in_progress' || node.status === 'reviewing') && (
                        <animate attributeName="opacity" values="1;0.3;1" dur="1.5s" repeatCount="indefinite" />
                      )}
                    </circle>

                    <text x={26} y={isAggregate ? 24 : node.height * 0.42} fontSize={11} fill={sc.text} fontFamily="sans-serif">
                      {CATEGORY_BADGE[node.category] || ''} {node.label.length > 16 ? node.label.slice(0, 15) + '…' : node.label}
                    </text>

                    {isAggregate && (
                      <>
                        <text x={26} y={40} fontSize={9} fill="#64748b" fontFamily="sans-serif">
                          {node.childCount} 个功能
                        </text>
                        <g transform={`translate(0, ${node.height - 10})`}>
                          <MiniProgressBar counts={node.statusCounts || {}} width={node.width} />
                        </g>
                        <text x={node.width - 8} y={16} fontSize={8} fill="#475569" textAnchor="end">双击展开</text>
                      </>
                    )}

                    {isAggregate && moduleAgents.length > 0 && (
                      <g transform={`translate(${node.width - 8}, ${node.height - 28})`}>
                        {moduleAgents.slice(0, 3).map((ma, idx) => {
                          const ri = getAgentRoleIcon(ma.agentId);
                          return (
                            <g key={ma.agentId} transform={`translate(${-idx * 20}, 0)`}
                              onMouseEnter={(e) => {
                                const svgRect = containerRef.current?.getBoundingClientRect();
                                if (svgRect) {
                                  setTooltipAgent({ agentId: ma.agentId, x: e.clientX - svgRect.left, y: e.clientY - svgRect.top });
                                }
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                const svgRect = containerRef.current?.getBoundingClientRect();
                                if (svgRect) {
                                  setTooltipAgent(prev => prev?.agentId === ma.agentId ? null : { agentId: ma.agentId, x: e.clientX - svgRect.left, y: e.clientY - svgRect.top });
                                }
                              }}
                              className="cursor-pointer"
                            >
                              <circle cx={0} cy={0} r={10} fill="#0f172a" stroke={ri.color} strokeWidth={1.5}>
                                <animate attributeName="stroke-opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite" />
                              </circle>
                              <text x={0} y={4} textAnchor="middle" fontSize={10}>{ri.icon}</text>
                            </g>
                          );
                        })}
                        {moduleAgents.length > 3 && (
                          <text x={-60} y={4} fontSize={8} fill="#94a3b8" textAnchor="end">+{moduleAgents.length - 3}</text>
                        )}
                      </g>
                    )}

                    {!isAggregate && agent && (
                      <g transform={`translate(${node.width - 16}, ${node.height / 2})`}
                        onMouseEnter={(e) => {
                          const svgRect = containerRef.current?.getBoundingClientRect();
                          if (svgRect) {
                            setTooltipAgent({ agentId: agent.agentId, x: e.clientX - svgRect.left, y: e.clientY - svgRect.top });
                          }
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          const svgRect = containerRef.current?.getBoundingClientRect();
                          if (svgRect) {
                            setTooltipAgent(prev => prev?.agentId === agent.agentId ? null : { agentId: agent.agentId, x: e.clientX - svgRect.left, y: e.clientY - svgRect.top });
                          }
                        }}
                        className="cursor-pointer"
                      >
                        {(() => {
                          const ri = getAgentRoleIcon(agent.agentId);
                          return (
                            <>
                              <circle cx={0} cy={0} r={12} fill="#0f172a" stroke={ri.color} strokeWidth={2}>
                                <animate attributeName="stroke-opacity" values="1;0.3;1" dur="1.5s" repeatCount="indefinite" />
                              </circle>
                              <text x={0} y={4} textAnchor="middle" fontSize={12}>{ri.icon}</text>
                            </>
                          );
                        })()}
                      </g>
                    )}

                    {!isAggregate && (
                      <text x={node.width - 8} y={14} fontSize={9} fill="#475569" textAnchor="end">P{node.feature?.priority ?? ''}</text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        </div>

        {/* Agent tooltip overlay */}
        {tooltipAgent && (() => {
          const agentData = agentStatuses.get(tooltipAgent.agentId);
          if (!agentData) return null;
          const ri = getAgentRoleIcon(tooltipAgent.agentId);
          const roleName = tooltipAgent.agentId.startsWith('pm') ? '产品经理'
            : tooltipAgent.agentId.startsWith('arch') ? '架构师'
            : tooltipAgent.agentId.startsWith('dev') ? '开发者'
            : tooltipAgent.agentId.startsWith('qa') ? 'QA'
            : 'Agent';
          return (
            <div
              className="absolute z-30 pointer-events-none"
              style={{ left: tooltipAgent.x + 16, top: tooltipAgent.y - 10 }}
            >
              <div className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 shadow-2xl min-w-[180px]">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-base">{ri.icon}</span>
                  <div>
                    <div className="text-xs font-bold text-slate-200">{roleName}</div>
                    <div className="text-[9px] text-slate-500 font-mono">{tooltipAgent.agentId}</div>
                  </div>
                  <span className="ml-auto w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: ri.color }} />
                </div>
                <div className="border-t border-slate-800 pt-1.5 space-y-0.5">
                  <div className="text-[10px]">
                    <span className="text-slate-500">状态: </span>
                    <span style={{ color: ri.color }} className="font-medium">
                      {agentData.status === 'working' ? '工作中' : agentData.status === 'idle' ? '待机' : agentData.status}
                    </span>
                  </div>
                  {agentData.currentTask && (
                    <div className="text-[10px]">
                      <span className="text-slate-500">任务: </span>
                      <span className="text-slate-300 font-mono">{agentData.currentTask}</span>
                    </div>
                  )}
                  {agentData.featureTitle && (
                    <div className="text-[10px]">
                      <span className="text-slate-500">内容: </span>
                      <span className="text-slate-300">{agentData.featureTitle.slice(0, 50)}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
