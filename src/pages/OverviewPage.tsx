/**
 * OverviewPage — 项目全景 (v4.1)
 *
 * 三层级 DAG 可视化:
 *   L1: 系统模块 (group_name 聚合)
 *   L2: 子模块   (sub_group 聚合)
 *   L3: Feature  (具体功能节点)
 *
 * dagre 自动布局 → 无节点重叠
 * 独立 wheel/touch 事件 → 无页面滚动冲突
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useAppStore } from '../stores/app-store';
import dagre from 'dagre';
import { TechBackground } from '../components/TechBackground';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

interface Feature {
  id: string; title: string; description: string; priority: number;
  category: string; status: string; depends_on: string; locked_by: string | null;
  group_name?: string; sub_group?: string;
  pm_verdict?: string;
  requirement_doc_ver?: number;
  test_spec_doc_ver?: number;
}

type ViewLevel = 'module' | 'submodule' | 'feature';

interface BreadcrumbItem {
  level: ViewLevel;
  label: string;
  filterValue?: string; // group_name or sub_group value
}

// ═══════════════════════════════════════
// Constants
// ═══════════════════════════════════════

const STATUS_COLOR: Record<string, { fill: string; stroke: string; text: string; bg: string }> = {
  todo:        { fill: '#334155', stroke: '#475569', text: '#94a3b8', bg: 'bg-slate-600' },
  in_progress: { fill: '#1e3a5f', stroke: '#3b82f6', text: '#60a5fa', bg: 'bg-blue-500' },
  reviewing:   { fill: '#422006', stroke: '#f59e0b', text: '#fbbf24', bg: 'bg-amber-500' },
  passed:      { fill: '#052e16', stroke: '#22c55e', text: '#4ade80', bg: 'bg-emerald-500' },
  failed:      { fill: '#450a0a', stroke: '#ef4444', text: '#f87171', bg: 'bg-red-500' },
};

const CATEGORY_BADGE: Record<string, string> = {
  infrastructure: '🔧', core: '⚙️', ui: '🎨', api: '🔌', testing: '🧪', docs: '📝',
};

// ═══════════════════════════════════════
// Dagre Layout Engine
// ═══════════════════════════════════════

interface GraphNode {
  id: string;
  label: string;
  status: string;
  category: string;
  x: number;
  y: number;
  width: number;
  height: number;
  deps: string[];
  /** 聚合节点: 子节点数量 */
  childCount?: number;
  /** 聚合节点: 各状态数量 */
  statusCounts?: Record<string, number>;
  /** 原始 feature (仅 L3 有) */
  feature?: Feature;
}

function buildDagreGraph(
  nodes: Array<{ id: string; label: string; status: string; category: string; deps: string[]; childCount?: number; statusCounts?: Record<string, number>; feature?: Feature }>,
  nodeWidth: number = 180,
  nodeHeight: number = 56,
): GraphNode[] {
  if (nodes.length === 0) return [];

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 80, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  const nodeIds = new Set(nodes.map(n => n.id));
  for (const node of nodes) {
    g.setNode(node.id, { width: nodeWidth, height: nodeHeight });
    for (const dep of node.deps) {
      if (nodeIds.has(dep)) {
        g.setEdge(dep, node.id);
      }
    }
  }

  dagre.layout(g);

  return nodes.map(n => {
    const pos = g.node(n.id);
    return {
      ...n,
      x: (pos?.x ?? 0) - nodeWidth / 2,
      y: (pos?.y ?? 0) - nodeHeight / 2,
      width: nodeWidth,
      height: nodeHeight,
    };
  });
}

// ═══════════════════════════════════════
// Aggregate helpers
// ═══════════════════════════════════════

function aggregateModules(features: Feature[]) {
  const groups = new Map<string, Feature[]>();
  for (const f of features) {
    const key = f.group_name || f.category || 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  return groups;
}

function aggregateSubModules(features: Feature[]) {
  const groups = new Map<string, Feature[]>();
  for (const f of features) {
    const key = f.sub_group || f.title || f.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  return groups;
}

function statusCountsFromFeatures(features: Feature[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of features) {
    counts[f.status] = (counts[f.status] || 0) + 1;
  }
  return counts;
}

function dominantStatus(counts: Record<string, number>): string {
  if (counts.failed) return 'failed';
  if (counts.in_progress || counts.reviewing) return 'in_progress';
  if (counts.passed && !counts.todo) return 'passed';
  return 'todo';
}

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

function InteractiveGraph({
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
      // L1: One node per group_name
      const groups = aggregateModules(enriched);
      const moduleNodes = [...groups.entries()].map(([name, feats]) => {
        const counts = statusCountsFromFeatures(feats);
        // Dependencies: if any feature in this group depends on a feature in another group
        const groupFeatureIds = new Set(feats.map(f => f.id));
        const depGroups = new Set<string>();
        for (const f of feats) {
          let deps: string[] = [];
          try { deps = JSON.parse(f.depends_on || '[]'); } catch {}
          for (const d of deps) {
            if (!groupFeatureIds.has(d)) {
              // Find which group this dep belongs to
              for (const [gn, gfeats] of groups) {
                if (gn !== name && gfeats.some(gf => gf.id === d)) {
                  depGroups.add(gn);
                }
              }
            }
          }
        }
        return {
          id: name,
          label: name,
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
      // L2: Features within selected group, aggregated by sub_group
      const groupFeatures = enriched.filter(f => (f.group_name || f.category || 'other') === filterGroup);
      const subGroups = aggregateSubModules(groupFeatures);

      if (subGroups.size <= 1) {
        // No meaningful sub-grouping → show features directly (fall through to L3 behavior)
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
          id: name,
          label: name,
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

  // Attach wheel as non-passive (React synthetic onWheel can't preventDefault)
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

  // Double-click to drill down
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
      if (status.currentTask?.includes(featureId)) return { agentId, ...status };
    }
    return null;
  };

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

                return (
                  <g key={node.id} transform={`translate(${node.x}, ${node.y})`}
                    onMouseEnter={() => setHoveredNode(node.id)}
                    onMouseLeave={() => setHoveredNode(null)}
                    onDoubleClick={() => handleDoubleClick(node)}
                    className="cursor-pointer"
                  >
                    {/* Glow for active */}
                    {(node.status === 'in_progress' || agent) && (
                      <rect width={node.width} height={node.height} rx={10} fill="none" stroke={sc.stroke} strokeWidth={2} opacity={0.3}>
                        <animate attributeName="opacity" values="0.3;0.1;0.3" dur="2s" repeatCount="indefinite" />
                      </rect>
                    )}

                    <rect width={node.width} height={node.height} rx={10} fill={sc.fill}
                      stroke={isHl ? '#5c7cfa' : sc.stroke} strokeWidth={isHl ? 2 : 1}
                      className="transition-all duration-200"
                    />

                    {/* Status dot */}
                    <circle cx={14} cy={isAggregate ? 20 : node.height / 2} r={4} fill={sc.stroke}>
                      {(node.status === 'in_progress' || node.status === 'reviewing') && (
                        <animate attributeName="opacity" values="1;0.3;1" dur="1.5s" repeatCount="indefinite" />
                      )}
                    </circle>

                    {/* Label */}
                    <text x={26} y={isAggregate ? 24 : node.height * 0.42} fontSize={11} fill={sc.text} fontFamily="sans-serif">
                      {CATEGORY_BADGE[node.category] || ''} {node.label.length > 16 ? node.label.slice(0, 15) + '…' : node.label}
                    </text>

                    {/* Aggregate extras */}
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

                    {/* Feature extras */}
                    {!isAggregate && agent && (
                      <text x={26} y={node.height * 0.75} fontSize={9} fill="#5c7cfa" fontFamily="sans-serif">
                        🤖 {agent.agentId}
                      </text>
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
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// Progress Ring
// ═══════════════════════════════════════

function ProgressRing({ value, size = 100, label, color = '#5c7cfa' }: { value: number; size?: number; label: string; color?: string }) {
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

// ═══════════════════════════════════════
// Stat Card
// ═══════════════════════════════════════

function StatCard({ icon, label, value, sub }: { icon: string; label: string; value: string; sub?: string }) {
  return (
    <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-800/80 rounded-xl p-4 space-y-1 hover:border-slate-700/80 hover:bg-slate-900/90 transition-all duration-300 hover:shadow-lg hover:shadow-black/20 group">
      <div className="flex items-center gap-2 text-xs text-slate-500"><span className="group-hover:scale-110 transition-transform">{icon}</span><span>{label}</span></div>
      <div className="text-lg font-bold text-slate-200 animate-count">{value}</div>
      {sub && <div className="text-[10px] text-slate-600">{sub}</div>}
    </div>
  );
}

// ═══════════════════════════════════════
// 7-Stage Pipeline Bar (v4.4)
// ═══════════════════════════════════════

/** 7-stage pipeline definition aligned with orchestrator phases */
const PIPELINE_STAGES = [
  { key: 'pm_analysis',    label: 'PM 分析',      icon: '🧠', color: 'bg-blue-500' },
  { key: 'design_doc',     label: '设计文档',     icon: '📐', color: 'bg-violet-500' },
  { key: 'architecture',   label: '架构设计',     icon: '🏗️', color: 'bg-indigo-500' },
  { key: 'sub_reqs',       label: '需求拆分+测试', icon: '📋', color: 'bg-cyan-500' },
  { key: 'development',    label: '开发实现',     icon: '🔨', color: 'bg-amber-500' },
  { key: 'qa_review',      label: 'QA 审查',      icon: '🧪', color: 'bg-emerald-500' },
  { key: 'acceptance',     label: '验收',         icon: '🎯', color: 'bg-orange-500' },
] as const;

/**
 * Infer which pipeline stage is active based on project status and feature states.
 * Returns an index (0-based) into PIPELINE_STAGES.
 */
function inferPipelineStage(projectStatus: string, features: Feature[]): number {
  if (!projectStatus || projectStatus === 'idle') return -1;

  const total = features.length;
  if (total === 0) {
    // No features yet → still in PM analysis or design phase
    if (projectStatus === 'initializing') return 0;
    return 0;
  }

  const allPassed = features.every(f => f.status === 'passed');
  const anyDeveloping = features.some(f => f.status === 'in_progress');
  const anyReviewing = features.some(f => f.status === 'reviewing');
  const anyFailed = features.some(f => f.status === 'failed');
  const hasReqDocs = features.some(f => (f.requirement_doc_ver ?? 0) > 0);
  const hasTestSpecs = features.some(f => (f.test_spec_doc_ver ?? 0) > 0);

  if (projectStatus === 'awaiting_user_acceptance' || allPassed) return 6;
  if (anyReviewing) return 5;
  if (anyDeveloping || anyFailed) return 4;
  if (hasReqDocs || hasTestSpecs) return 3;
  if (total > 0 && projectStatus === 'developing') return 4;
  if (projectStatus === 'initializing') return 1;
  return 2;
}

function PipelineBar({ projectStatus, features }: { projectStatus: string; features: Feature[] }) {
  const activeStage = inferPipelineStage(projectStatus, features);

  return (
    <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-800/80 rounded-xl p-4 hover:border-slate-700/60 transition-all duration-300">
      <h4 className="text-[10px] uppercase tracking-wider text-slate-500 mb-3">流水线进度</h4>
      <div className="flex items-center gap-1">
        {PIPELINE_STAGES.map((stage, i) => {
          const isCompleted = i < activeStage;
          const isActive = i === activeStage;
          const isFuture = i > activeStage;

          return (
            <div key={stage.key} className="flex items-center flex-1">
              {/* Node */}
              <div className="flex flex-col items-center gap-1 flex-1 min-w-0">
                <div className={`
                  w-8 h-8 rounded-lg flex items-center justify-center text-sm transition-all
                  ${isCompleted ? `${stage.color} text-white shadow-lg` : ''}
                  ${isActive ? `${stage.color} text-white shadow-lg ring-2 ring-white/20 animate-pulse` : ''}
                  ${isFuture ? 'bg-slate-800 text-slate-600' : ''}
                `}>
                  {isCompleted ? '✓' : stage.icon}
                </div>
                <span className={`text-[9px] leading-none text-center truncate w-full ${
                  isActive ? 'text-slate-200 font-medium' : isCompleted ? 'text-slate-400' : 'text-slate-600'
                }`}>
                  {stage.label}
                </span>
              </div>

              {/* Connector (except after last) */}
              {i < PIPELINE_STAGES.length - 1 && (
                <div className={`h-0.5 w-4 flex-shrink-0 ${
                  i < activeStage ? 'bg-slate-600' : 'bg-slate-800'
                }`} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// Document Completion Indicator (v4.4)
// ═══════════════════════════════════════

function DocCompletionBar({ features, projectId }: { features: Feature[]; projectId: string }) {
  const [docStats, setDocStats] = useState<{ design: boolean; reqCount: number; testCount: number }>({
    design: false, reqCount: 0, testCount: 0,
  });

  useEffect(() => {
    if (!projectId) return;
    window.agentforge.project.listAllDocs(projectId).then(docs => {
      setDocStats({
        design: (docs?.design?.length ?? 0) > 0,
        reqCount: docs?.requirements?.length ?? 0,
        testCount: docs?.testSpecs?.length ?? 0,
      });
    }).catch(() => {});
  }, [projectId]);

  const total = features.length;
  const reqCoverage = total > 0 ? Math.round((docStats.reqCount / total) * 100) : 0;
  const testCoverage = total > 0 ? Math.round((docStats.testCount / total) * 100) : 0;

  return (
    <div className="bg-slate-900/80 backdrop-blur-sm border border-slate-800/80 rounded-xl p-4 hover:border-slate-700/60 transition-all duration-300">
      <h4 className="text-[10px] uppercase tracking-wider text-slate-500 mb-3">文档完成度</h4>
      <div className="grid grid-cols-3 gap-4">
        {/* Design doc */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">📐 设计文档</span>
            <span className={docStats.design ? 'text-emerald-400' : 'text-slate-600'}>
              {docStats.design ? '✓ 已生成' : '— 待生成'}
            </span>
          </div>
          <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-500 ${docStats.design ? 'w-full bg-violet-500' : 'w-0'}`} />
          </div>
        </div>

        {/* Requirement docs */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">📋 需求文档</span>
            <span className="text-slate-500">{docStats.reqCount}/{total}</span>
          </div>
          <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-500"
              style={{ width: `${reqCoverage}%` }}
            />
          </div>
        </div>

        {/* Test specs */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">🧪 测试规格</span>
            <span className="text-slate-500">{docStats.testCount}/{total}</span>
          </div>
          <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-500"
              style={{ width: `${testCoverage}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// Main OverviewPage
// ═══════════════════════════════════════

const PROJECT_STATUS: Record<string, { text: string; color: string }> = {
  initializing: { text: '初始化', color: 'text-blue-400' },
  analyzing:    { text: '导入分析中', color: 'text-cyan-400' },
  developing:   { text: '开发中', color: 'text-emerald-400' },
  reviewing:    { text: '审查中', color: 'text-amber-400' },
  delivered:    { text: '已交付', color: 'text-green-400' },
  paused:       { text: '已暂停', color: 'text-slate-400' },
  error:        { text: '出错',   color: 'text-red-400' },
  idle:         { text: '空闲',   color: 'text-slate-500' },
};

export function OverviewPage() {
  const { currentProjectId, featureStatuses, addLog, settingsConfigured, setGlobalPage, setProjectPage, showAcceptancePanel, setShowAcceptancePanel } = useAppStore();
  const [features, setFeatures] = useState<Feature[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [project, setProject] = useState<any>(null);

  // v5.1: 导入分析实时进度
  const [importProgress, setImportProgress] = useState<{
    phase: number; step: string; progress: number; done?: boolean; error?: boolean;
  } | null>(null);

  // 切换项目时清空残留的分析进度
  useEffect(() => {
    setImportProgress(null);
  }, [currentProjectId]);

  const load = useCallback(async () => {
    if (!currentProjectId) return;
    const [feats, st, proj] = await Promise.all([
      window.agentforge.project.getFeatures(currentProjectId),
      window.agentforge.project.getStats(currentProjectId),
      window.agentforge.project.get(currentProjectId),
    ]);
    setFeatures(feats || []);
    setStats(st);
    setProject(proj);
    // 如果项目进入 analyzing 状态但没有进度信息，设初始值
    if (proj?.status === 'analyzing' && !importProgress) {
      setImportProgress({ phase: 0, step: '分析中...', progress: 0 });
    }
    // 分析完成后清除进度
    if (proj?.status !== 'analyzing' && importProgress?.done) {
      // 保留完成消息 5 秒后清除
      setTimeout(() => setImportProgress(null), 8000);
    }
  }, [currentProjectId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  // 订阅后端 import-progress 事件
  useEffect(() => {
    const unsub = window.agentforge.on('project:import-progress', (data: any) => {
      if (data.projectId === currentProjectId) {
        setImportProgress({
          phase: data.phase,
          step: data.step,
          progress: data.progress,
          done: data.done,
          error: data.error,
        });
        if (data.done) load(); // 刷新项目数据
      }
    });
    return unsub;
  }, [currentProjectId, load]);

  const handleStart = async () => {
    if (!currentProjectId) return;
    if (!settingsConfigured) { setGlobalPage('settings'); return; }
    await window.agentforge.project.start(currentProjectId);
    addLog({ projectId: currentProjectId, agentId: 'system', content: '🚀 Agent 团队开始工作' });
    load();
  };
  const handleStop = async () => {
    if (!currentProjectId) return;
    await window.agentforge.project.stop(currentProjectId);
    addLog({ projectId: currentProjectId, agentId: 'system', content: '⏸ 已暂停' });
    load();
  };

  if (!currentProjectId) {
    return <div className="h-full flex items-center justify-center text-slate-500"><p>加载中...</p></div>;
  }

  const enriched = features.map(f => ({ ...f, status: featureStatuses.get(f.id) || f.status }));

  const f = stats?.features || {};
  const a = stats?.agents || {};
  const total = f.total ?? 0;
  const passed = f.passed ?? 0;
  const inProgress = f.in_progress ?? 0;
  const reviewing = f.reviewing ?? 0;
  const failed = f.failed ?? 0;
  const todo = f.todo ?? 0;
  const progress = total > 0 ? (passed / total) * 100 : 0;

  const categoryCount = new Map<string, number>();
  enriched.forEach(feat => {
    const cat = feat.category || 'other';
    categoryCount.set(cat, (categoryCount.get(cat) ?? 0) + 1);
  });

  // 项目状态判断
  const isActive = project && (project.status === 'initializing' || project.status === 'analyzing' || project.status === 'developing' || project.status === 'reviewing');
  const canStart = project && !isActive && project.wish?.trim();
  const canResume = project && (project.status === 'paused' || project.status === 'error');
  const noWish = project && !isActive && !canResume && !project.wish?.trim();

  return (
    <div className="h-full flex flex-col overflow-y-auto relative">
      {/* 科技感动态背景 */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <TechBackground intensity={isActive ? 1.5 : 0.6} />
        {/* 渐变遮罩保证内容可读性 */}
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950/40 via-slate-950/80 to-slate-950/95" />
      </div>
      {/* ═══════ Command Center Header ═══════ */}
      <div className="flex-shrink-0 px-6 pt-6 pb-2 relative z-10">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xl font-bold">指挥中心</h2>
          <button onClick={load} className="text-sm text-slate-500 hover:text-slate-300 transition-colors" title="刷新">🔄</button>
        </div>
      </div>

      {/* ═══════ Compact Control Bar ═══════ */}
      <div className="flex-shrink-0 mx-6 mb-4 relative z-10">
        <div className={`relative overflow-hidden rounded-2xl border transition-all duration-500 ${
          isActive
            ? 'border-emerald-500/30 bg-gradient-to-br from-emerald-950/50 via-slate-900 to-cyan-950/50'
            : canResume
              ? 'border-amber-500/30 bg-gradient-to-br from-amber-950/30 via-slate-900 to-orange-950/30'
              : 'border-slate-700/50 bg-gradient-to-br from-slate-900 via-slate-900/80 to-forge-950/50'
        }`}>
          {isActive && (
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute top-0 left-1/4 w-20 h-20 bg-emerald-500/5 rounded-full blur-3xl animate-pulse" />
              <div className="absolute bottom-0 right-1/4 w-24 h-24 bg-cyan-500/5 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
            </div>
          )}

          <div className="relative flex items-center gap-4 py-3 px-6">
            {/* Status indicator + Action button (inline compact) */}
            {project && (() => {
              const st = PROJECT_STATUS[project.status] || { text: project.status, color: 'text-slate-500' };
              return (
                <div className="flex items-center gap-2 shrink-0">
                  {isActive && <span className="relative flex h-2.5 w-2.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span><span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span></span>}
                  {canResume && <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />}
                  {!isActive && !canResume && <span className="w-2.5 h-2.5 rounded-full bg-slate-600" />}
                  <span className={`text-sm font-semibold ${st.color}`}>{st.text}</span>
                </div>
              );
            })()}

            {/* Action button — compact inline */}
            <div className="flex-1 flex items-center justify-center">
              {isActive ? (
                <button onClick={handleStop}
                  className="group flex items-center gap-2 px-5 py-2 rounded-xl bg-emerald-900/40 hover:bg-red-900/40 border border-emerald-500/20 hover:border-red-500/30 transition-all">
                  <span className="text-lg group-hover:hidden">⚡</span>
                  <span className="text-lg hidden group-hover:inline">⏸</span>
                  <span className="text-sm font-bold text-emerald-300 group-hover:text-red-300 transition-colors">运行中</span>
                  <span className="text-[10px] text-emerald-400/60 group-hover:text-red-400/80 transition-colors">点击暂停</span>
                </button>
              ) : canResume ? (
                <button onClick={handleStart}
                  className="group flex items-center gap-2 px-5 py-2 rounded-xl bg-amber-900/30 hover:bg-emerald-900/40 border border-amber-500/20 hover:border-emerald-500/30 transition-all hover:shadow-lg hover:shadow-emerald-500/10">
                  <span className="text-lg">▶️</span>
                  <span className="text-sm font-bold text-amber-300 group-hover:text-emerald-300 transition-colors">已暂停</span>
                  <span className="text-[10px] text-amber-400/60 group-hover:text-emerald-400/80 transition-colors">点击继续</span>
                </button>
              ) : canStart ? (
                <button onClick={handleStart}
                  className="group flex items-center gap-2 px-5 py-2 rounded-xl bg-forge-800/50 hover:bg-forge-700/60 border border-forge-500/20 hover:border-forge-400/40 transition-all hover:shadow-lg hover:shadow-forge-500/20">
                  <span className="text-lg group-hover:scale-110 group-hover:rotate-12 transition-all">🚀</span>
                  <span className="text-sm font-bold text-forge-300 group-hover:text-white transition-colors">启动开发</span>
                </button>
              ) : noWish ? (
                <button onClick={() => setProjectPage('wish')}
                  className="group flex items-center gap-2 px-5 py-2 rounded-xl border border-dashed border-slate-700 hover:border-forge-500/40 transition-all">
                  <span className="text-lg">✨</span>
                  <span className="text-sm font-bold text-slate-400 group-hover:text-forge-300 transition-colors">去许愿</span>
                </button>
              ) : null}
            </div>

            {/* Live stats (right side) */}
            {isActive && (
              <div className="flex items-center gap-4 text-xs text-slate-500 shrink-0">
                <span>🤖 {a.total ?? 0}</span>
                <span>📊 {a.total_tokens ? `${(a.total_tokens / 1000).toFixed(1)}k` : '0'}</span>
                <span>💰 {a.total_cost ? `$${a.total_cost.toFixed(3)}` : '$0'}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 px-6 pb-6 space-y-6 relative z-10">
        {/* Project Import Analysis — Real-time Progress (v5.1) */}
        {project?.status === 'analyzing' && (
          <section className="bg-gradient-to-r from-cyan-900/15 to-slate-900/30 border border-cyan-800/30 rounded-xl p-5 animate-in fade-in">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                {importProgress?.done && !importProgress?.error ? (
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                ) : importProgress?.error ? (
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
                ) : (
                  <div className="w-2.5 h-2.5 rounded-full bg-cyan-500 animate-pulse" />
                )}
                <span className="text-sm font-medium text-cyan-300">
                  📥 项目导入分析
                  {importProgress?.done && !importProgress?.error && ' — 完成 ✅'}
                  {importProgress?.error && ' — 失败 ❌'}
                </span>
              </div>
              <span className="text-[10px] text-slate-500 font-mono">
                Phase {importProgress?.phase ?? 0}/3
              </span>
            </div>

            {/* Phase 指示器 */}
            <div className="grid grid-cols-4 gap-2 mb-4">
              {[
                { phase: 0, label: '静态扫描', icon: '🔍', desc: '目录 / LOC / 依赖图' },
                { phase: 1, label: '模块摘要', icon: '📝', desc: 'Worker 模型分层摘要' },
                { phase: 2, label: '架构合成', icon: '🏗️', desc: 'Strong 模型架构文档' },
                { phase: 3, label: '文档填充', icon: '📋', desc: '设计 / 需求 / 测试规格' },
              ].map((p) => {
                const current = importProgress?.phase ?? -1;
                const isDone = current > p.phase || (current === p.phase && importProgress?.done && !importProgress?.error);
                const isActive = current === p.phase && !importProgress?.done;
                const isPending = current < p.phase;
                return (
                  <div
                    key={p.phase}
                    className={`rounded-lg p-3 text-center transition-all duration-500 ${
                      isDone ? 'bg-emerald-900/30 border border-emerald-700/30' :
                      isActive ? 'bg-cyan-900/40 border border-cyan-600/40 shadow-lg shadow-cyan-900/20' :
                      'bg-slate-800/30 border border-slate-700/20'
                    }`}
                  >
                    <div className={`text-xl mb-1 ${isActive ? 'animate-bounce' : ''}`}>{p.icon}</div>
                    <div className={`text-[11px] font-medium ${
                      isDone ? 'text-emerald-400' : isActive ? 'text-cyan-300' : 'text-slate-600'
                    }`}>
                      {isDone ? '✓ ' : ''}{p.label}
                    </div>
                    <div className={`text-[9px] mt-0.5 ${
                      isDone ? 'text-emerald-500/70' : isActive ? 'text-cyan-400/70' : 'text-slate-700'
                    }`}>
                      {p.desc}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 当前步骤详情 + 进度条 */}
            {importProgress && (
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className={`text-xs ${importProgress.error ? 'text-red-400' : importProgress.done ? 'text-emerald-400' : 'text-cyan-400'}`}>
                    {importProgress.step}
                  </span>
                  <span className="text-[10px] text-slate-500 font-mono">
                    {Math.round(importProgress.progress * 100)}%
                  </span>
                </div>
                <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ease-out ${
                      importProgress.error ? 'bg-red-500' : importProgress.done ? 'bg-emerald-500' : 'bg-cyan-500'
                    }`}
                    style={{ width: `${Math.max(2, importProgress.progress * 100)}%` }}
                  />
                </div>
              </div>
            )}

            {/* 完成后提示 */}
            {importProgress?.done && !importProgress?.error && (
              <p className="text-[11px] text-emerald-500/80 mt-3">
                🎉 分析完成！查看「文档」页浏览自动生成的架构文档和需求文档，或在「许愿」页输入新需求开始开发。
              </p>
            )}
          </section>
        )}

        {/* Static analysis info for projects without import */}
        {enriched.length === 0 && !importProgress && project?.status !== 'analyzing' && (
          <section className="bg-gradient-to-r from-cyan-900/10 to-slate-900/30 border border-cyan-800/20 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-slate-600" />
                <span className="text-xs text-slate-500 uppercase tracking-wider font-medium">📥 项目导入分析</span>
              </div>
              <span className="text-[10px] text-slate-600">Phase 0~3 自动化</span>
            </div>
            <p className="text-[10px] text-slate-600">
              💡 在「项目」页选择「导入已有项目」可自动分析大型代码库并生成文档框架。Hot/Warm/Cold 三层记忆确保 Token 高效利用。
            </p>
          </section>
        )}

        {/* Skeleton placeholder modules when no features yet */}
        {enriched.length === 0 && !isActive && (
          <div className="space-y-6">
            {/* Skeleton: Real-time status bar */}
            <section className="bg-slate-900/30 border border-slate-800/50 border-dashed rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full bg-slate-700" />
                <span className="text-xs text-slate-600 uppercase tracking-wider">📡 实时状态</span>
              </div>
              <div className="grid grid-cols-5 gap-3">
                {['待做', '开发中', '审查中', '已完成', '失败'].map(l => (
                  <div key={l} className="bg-slate-800/30 rounded-lg p-3 text-center">
                    <div className="text-lg font-bold text-slate-700">—</div>
                    <div className="text-[10px] text-slate-700">{l}</div>
                  </div>
                ))}
              </div>
            </section>

            {/* Skeleton: Pipeline */}
            <section className="bg-slate-900/30 border border-slate-800/50 border-dashed rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full bg-slate-700" />
                <span className="text-xs text-slate-600 uppercase tracking-wider">🔄 流水线进度</span>
              </div>
              <div className="flex items-center gap-1">
                {PIPELINE_STAGES.map((stage, i) => (
                  <div key={stage.key} className="flex items-center flex-1">
                    <div className="flex flex-col items-center gap-1 flex-1">
                      <div className="w-8 h-8 rounded-lg bg-slate-800/50 flex items-center justify-center text-sm text-slate-700">{stage.icon}</div>
                      <span className="text-[9px] text-slate-700 text-center truncate w-full">{stage.label}</span>
                    </div>
                    {i < PIPELINE_STAGES.length - 1 && <div className="h-0.5 w-4 flex-shrink-0 bg-slate-800/50" />}
                  </div>
                ))}
              </div>
            </section>

            {/* Skeleton: Architecture graph */}
            <section className="bg-slate-900/30 border border-slate-800/50 border-dashed rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full bg-slate-700" />
                <span className="text-xs text-slate-600 uppercase tracking-wider">🗺️ 系统架构图</span>
              </div>
              <div className="h-48 flex items-center justify-center">
                <div className="text-center text-slate-700 space-y-2">
                  <div className="flex items-center justify-center gap-4">
                    {['模块A', '模块B', '模块C'].map(m => (
                      <div key={m} className="w-24 h-12 rounded-lg border border-slate-800/50 bg-slate-800/20 flex items-center justify-center text-[10px] text-slate-700">{m}</div>
                    ))}
                  </div>
                  <div className="text-[10px]">PM 分析后自动生成</div>
                </div>
              </div>
            </section>

            {/* Skeleton: Progress dashboard */}
            <section className="bg-slate-900/30 border border-slate-800/50 border-dashed rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full bg-slate-700" />
                <span className="text-xs text-slate-600 uppercase tracking-wider">📊 进度看板</span>
              </div>
              <div className="grid grid-cols-4 gap-3">
                {['Agents', 'Tokens', '成本', '分类'].map(l => (
                  <div key={l} className="bg-slate-800/30 rounded-lg p-3 text-center">
                    <div className="text-lg font-bold text-slate-700">—</div>
                    <div className="text-[10px] text-slate-700">{l}</div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* Progress dashboard */}
        {enriched.length > 0 && (
          <section>
            <h3 className="text-sm font-medium text-slate-400 mb-3">📊 进度概览</h3>
            <div className="flex flex-wrap gap-6 items-start">
              <div className="flex gap-4">
                <ProgressRing value={progress} label="总进度" color="#22c55e" />
                {failed > 0 && <ProgressRing value={total > 0 ? (failed / total) * 100 : 0} size={80} label="失败率" color="#ef4444" />}
              </div>
              <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 min-w-[300px]">
                <StatCard icon="⬜" label="待做" value={String(todo)} />
                <StatCard icon="🔨" label="开发中" value={String(inProgress)} />
                <StatCard icon="🔍" label="审查中" value={String(reviewing)} />
                <StatCard icon="✅" label="已完成" value={String(passed)} />
                <StatCard icon="❌" label="失败" value={String(failed)} />
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard icon="🤖" label="Agents" value={String(a.total ?? 0)} />
              <StatCard icon="📊" label="Tokens" value={a.total_tokens ? `${(a.total_tokens / 1000).toFixed(1)}k` : '0'} />
              <StatCard icon="💰" label="成本" value={a.total_cost ? `$${a.total_cost.toFixed(3)}` : '$0'} />
              <StatCard icon="📁" label="分类" value={String(categoryCount.size)}
                sub={[...categoryCount.entries()].map(([k, v]) => `${CATEGORY_BADGE[k] || '📦'}${k}: ${v}`).join('  ')} />
            </div>
          </section>
        )}

        {/* Pipeline + Doc completion (v4.4) */}
        {enriched.length > 0 && project && (
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <PipelineBar projectStatus={project.status} features={enriched} />
            <DocCompletionBar features={enriched} projectId={currentProjectId!} />
          </section>
        )}

        {/* User acceptance prompt */}
        {project?.status === 'awaiting_user_acceptance' && !showAcceptancePanel && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-5 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🎯</span>
              <div>
                <div className="text-sm font-medium text-amber-300">项目等待您的验收</div>
                <div className="text-xs text-amber-400/60">所有 Feature 已通过开发和 QA 审查, 请做出最终决定</div>
              </div>
            </div>
            <button
              onClick={() => setShowAcceptancePanel(true)}
              className="px-5 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium transition-all"
            >
              开始验收
            </button>
          </div>
        )}

        {/* DAG graph */}
        {enriched.length > 0 && (
          <section>
            <h3 className="text-sm font-medium text-slate-400 mb-3">🗺️ 系统架构图</h3>
            <InteractiveGraph features={enriched} onDrillDown={() => {}} />
            <div className="flex gap-4 mt-2 text-[10px] text-slate-500">
              {Object.entries(STATUS_COLOR).map(([key, sc]) => (
                <span key={key} className="flex items-center gap-1">
                  <span className={`w-2 h-2 rounded-full ${sc.bg}`} />
                  {key === 'todo' ? '待做' : key === 'in_progress' ? '开发中' : key === 'reviewing' ? '审查中' : key === 'passed' ? '已完成' : '失败'}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Feature roadmap */}
        {enriched.length > 0 && (
          <section>
            <h3 className="text-sm font-medium text-slate-400 mb-3">📋 Feature 路线图</h3>
            <div className="space-y-1">
              {enriched
                .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
                .map(feat => {
                  const sc = STATUS_COLOR[feat.status] || STATUS_COLOR.todo;
                  return (
                    <div key={feat.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-900/70 transition-colors">
                      <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: sc.stroke }} />
                      <span className="text-[10px] text-slate-600 font-mono w-12 flex-shrink-0">{feat.id}</span>
                      <span className="text-[10px] w-5">{CATEGORY_BADGE[feat.category] || '📦'}</span>
                      <span className="text-xs text-slate-300 flex-1 truncate">{feat.title || feat.description}</span>
                      {feat.group_name && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">{feat.group_name}</span>
                      )}
                      <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: sc.text, backgroundColor: sc.fill }}>
                        {feat.status === 'todo' ? '待做' : feat.status === 'in_progress' ? '开发中' : feat.status === 'reviewing' ? '审查中' : feat.status === 'passed' ? '✓' : '✗'}
                      </span>
                      <span className="text-[10px] text-slate-600">P{feat.priority}</span>
                    </div>
                  );
                })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}