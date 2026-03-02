/**
 * ArchTreeGraph — 三级钻探架构可视化 (v10.0)
 *
 * 基于 architecture-tree.json 的层级 DAG 可视化:
 *   L1: Domain (架构域)  — 点击/双击下钻
 *   L2: Module (模块)     — 点击/双击下钻
 *   L3: Component (组件) — 叶子节点, 展示文件列表
 *
 * 交互: 滚轮缩放、拖拽平移、hover 高亮关联边、双击下钻、面包屑导航
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import dagre from 'dagre';

// ── Types (mirror backend probe-types.ts) ──

type ArchNodeLevel = 'domain' | 'module' | 'component';

interface ArchNode {
  id: string;
  parentId: string | null;
  level: ArchNodeLevel;
  name: string;
  responsibility: string;
  type: string;
  files: string[];
  publicAPI: string[];
  keyTypes: string[];
  patterns: string[];
  issues: string[];
  loc: number;
  fileCount: number;
}

interface ArchEdge {
  source: string;
  target: string;
  type: string;
  weight: number;
  label?: string;
}

interface ArchTree {
  nodes: ArchNode[];
  edges: ArchEdge[];
}

interface LayoutNode extends ArchNode {
  x: number;
  y: number;
  width: number;
  height: number;
  childCount: number;
}

// ── Color maps ──

const LEVEL_COLORS: Record<ArchNodeLevel, { fill: string; stroke: string; text: string }> = {
  domain:    { fill: '#1a1a2e', stroke: '#8b5cf6', text: '#c4b5fd' },
  module:    { fill: '#083344', stroke: '#06b6d4', text: '#22d3ee' },
  component: { fill: '#052e16', stroke: '#22c55e', text: '#4ade80' },
};

const TYPE_ICONS: Record<string, string> = {
  'entry-point': '🚪',
  'api-layer': '🌐',
  'data-layer': '🗃️',
  'business-logic': '⚙️',
  'config': '⚙️',
  'utility': '🔧',
  'ui': '🎨',
  'infrastructure': '🏗️',
};

const EDGE_COLORS: Record<string, string> = {
  import: '#334155',
  dataflow: '#3b82f6',
  event: '#f59e0b',
  config: '#8b5cf6',
  ipc: '#06b6d4',
};

// ── Dagre layout ──

function layoutNodes(
  nodes: Array<ArchNode & { childCount: number }>,
  edges: ArchEdge[],
): { nodes: LayoutNode[]; width: number; height: number } {
  const NODE_W = 220;
  const NODE_H = 80;

  if (nodes.length === 0) return { nodes: [], width: 0, height: 0 };

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 100, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));

  const nodeIds = new Set(nodes.map(n => n.id));
  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_W, height: NODE_H });
  }
  for (const edge of edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(g);

  const layoutNodes: LayoutNode[] = nodes.map(n => {
    const pos = g.node(n.id);
    return { ...n, x: (pos?.x ?? 0) - NODE_W / 2, y: (pos?.y ?? 0) - NODE_H / 2, width: NODE_W, height: NODE_H };
  });

  const gGraph = g.graph();
  return { nodes: layoutNodes, width: (gGraph.width ?? 800) + 60, height: (gGraph.height ?? 400) + 60 };
}

// ── Component ──

export function ArchTreeGraph({ projectId }: { projectId: string }) {
  const [tree, setTree] = useState<ArchTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<ArchNode | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  // Drill-down state
  const [viewLevel, setViewLevel] = useState<ArchNodeLevel>('domain');
  const [filterParentId, setFilterParentId] = useState<string | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<Array<{ level: ArchNodeLevel; label: string; parentId: string | null }>>([
    { level: 'domain', label: '架构域', parentId: null },
  ]);

  const loadTree = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.automater.project.getArchTree(projectId);
      if (res.success && res.tree) setTree(res.tree as ArchTree);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { loadTree(); }, [loadTree]);

  // Compute visible nodes and edges based on drill-down level
  const { visibleNodes, visibleEdges } = useMemo(() => {
    if (!tree) return { visibleNodes: [], visibleEdges: [] };

    let filteredNodes: ArchNode[];
    if (viewLevel === 'domain') {
      filteredNodes = tree.nodes.filter(n => n.level === 'domain');
    } else if (viewLevel === 'module') {
      filteredNodes = tree.nodes.filter(n => n.level === 'module' && n.parentId === filterParentId);
    } else {
      filteredNodes = tree.nodes.filter(n => n.level === 'component' && n.parentId === filterParentId);
    }

    // Count children for each node
    const nodesWithChildren = filteredNodes.map(n => ({
      ...n,
      childCount: tree.nodes.filter(c => c.parentId === n.id).length,
    }));

    // Filter edges to only visible nodes
    const nodeIds = new Set(filteredNodes.map(n => n.id));
    // Also include edges between parent module IDs if we're at domain level
    const filteredEdges = tree.edges.filter(e => {
      if (nodeIds.has(e.source) && nodeIds.has(e.target)) return true;
      // At domain level: map module edges up to their domain parents
      if (viewLevel === 'domain') {
        const sourceNode = tree.nodes.find(n => n.id === e.source);
        const targetNode = tree.nodes.find(n => n.id === e.target);
        const sourceDomain = sourceNode?.level === 'module' ? sourceNode.parentId : sourceNode?.level === 'component' ? tree.nodes.find(n => n.id === sourceNode.parentId)?.parentId : e.source;
        const targetDomain = targetNode?.level === 'module' ? targetNode.parentId : targetNode?.level === 'component' ? tree.nodes.find(n => n.id === targetNode.parentId)?.parentId : e.target;
        return sourceDomain && targetDomain && nodeIds.has(sourceDomain) && nodeIds.has(targetDomain) && sourceDomain !== targetDomain;
      }
      return false;
    });

    // Remap cross-level edges at domain level
    const remappedEdges: ArchEdge[] = viewLevel === 'domain'
      ? (() => {
          const domainEdgeSet = new Set<string>();
          const result: ArchEdge[] = [];
          for (const e of filteredEdges) {
            if (nodeIds.has(e.source) && nodeIds.has(e.target)) {
              const key = `${e.source}-${e.target}`;
              if (!domainEdgeSet.has(key)) { domainEdgeSet.add(key); result.push(e); }
            } else {
              const sourceNode = tree.nodes.find(n => n.id === e.source);
              const targetNode = tree.nodes.find(n => n.id === e.target);
              const sd = sourceNode?.level === 'module' ? sourceNode.parentId! : tree.nodes.find(n => n.id === sourceNode?.parentId)?.parentId!;
              const td = targetNode?.level === 'module' ? targetNode.parentId! : tree.nodes.find(n => n.id === targetNode?.parentId)?.parentId!;
              if (sd && td && sd !== td) {
                const key = `${sd}-${td}`;
                if (!domainEdgeSet.has(key)) { domainEdgeSet.add(key); result.push({ ...e, source: sd, target: td }); }
              }
            }
          }
          return result;
        })()
      : filteredEdges;

    return { visibleNodes: nodesWithChildren, visibleEdges: remappedEdges };
  }, [tree, viewLevel, filterParentId]);

  const layout = useMemo(
    () => visibleNodes.length > 0 ? layoutNodes(visibleNodes, visibleEdges) : null,
    [visibleNodes, visibleEdges],
  );

  // ── Wheel zoom ──
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
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

  const handleMouseDown = (e: React.MouseEvent) => { if (e.button !== 0) return; setDragging(true); setDragStart({ x: e.clientX - transform.x, y: e.clientY - transform.y }); };
  const handleMouseMove = (e: React.MouseEvent) => { if (!dragging) return; setTransform(t => ({ ...t, x: e.clientX - dragStart.x, y: e.clientY - dragStart.y })); };
  const handleMouseUp = () => setDragging(false);

  const handleDoubleClick = (node: LayoutNode) => {
    if (node.childCount === 0) return;
    if (viewLevel === 'domain') {
      setViewLevel('module');
      setFilterParentId(node.id);
      setBreadcrumb([
        { level: 'domain', label: '架构域', parentId: null },
        { level: 'module', label: node.name, parentId: node.id },
      ]);
      setTransform({ x: 0, y: 0, scale: 1 });
      setSelectedNode(null);
    } else if (viewLevel === 'module') {
      setViewLevel('component');
      setFilterParentId(node.id);
      setBreadcrumb(prev => [
        ...prev,
        { level: 'component', label: node.name, parentId: node.id },
      ]);
      setTransform({ x: 0, y: 0, scale: 1 });
      setSelectedNode(null);
    }
  };

  const navigateToBreadcrumb = (item: typeof breadcrumb[0]) => {
    setViewLevel(item.level);
    setFilterParentId(item.parentId);
    if (item.level === 'domain') {
      setBreadcrumb([{ level: 'domain', label: '架构域', parentId: null }]);
    } else if (item.level === 'module') {
      setBreadcrumb(prev => prev.slice(0, 2));
    }
    setTransform({ x: 0, y: 0, scale: 1 });
    setSelectedNode(null);
  };

  const zoomIn = () => setTransform(t => ({ ...t, scale: Math.min(4, t.scale * 1.2) }));
  const zoomOut = () => setTransform(t => ({ ...t, scale: Math.max(0.15, t.scale * 0.8) }));
  const resetView = () => setTransform({ x: 0, y: 0, scale: 1 });

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 justify-center text-sm text-slate-500">
        <div className="animate-spin w-4 h-4 border-2 border-violet-400 border-t-transparent rounded-full" />
        加载架构树...
      </div>
    );
  }

  if (!tree || !layout || layout.nodes.length === 0) return null;

  const nodeMap = new Map(layout.nodes.map(n => [n.id, n]));

  // Tree-level stats
  const treeDomains = tree.nodes.filter(n => n.level === 'domain').length;
  const treeModules = tree.nodes.filter(n => n.level === 'module').length;
  const treeComponents = tree.nodes.filter(n => n.level === 'component').length;

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-slate-400">🏛️ 系统架构图谱</h3>
        <div className="flex items-center gap-3 text-[10px] text-slate-500">
          {Object.entries(LEVEL_COLORS).map(([level, c]) => (
            <span key={level} className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: c.stroke }} />
              {level === 'domain' ? '域' : level === 'module' ? '模块' : '组件'}
            </span>
          ))}
          <span className="text-slate-600 ml-2">{treeDomains} 域 · {treeModules} 模块 · {treeComponents} 组件</span>
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-xs mb-2">
        {breadcrumb.map((item, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-slate-600">›</span>}
            <button
              onClick={() => navigateToBreadcrumb(item)}
              className={`px-2 py-0.5 rounded transition-colors ${
                i === breadcrumb.length - 1
                  ? 'bg-violet-600/20 text-violet-400'
                  : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
              }`}
            >
              {item.label}
            </button>
          </span>
        ))}
      </div>

      <div className="flex gap-3">
        {/* ── Graph ── */}
        <div
          className="relative flex-1 overflow-hidden border border-slate-800 rounded-xl bg-slate-950/50"
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
                <marker id="at-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569" />
                </marker>
                <marker id="at-arrow-hl" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#c4b5fd" />
                </marker>
              </defs>

              <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
                {/* Edges */}
                {visibleEdges.map((edge, i) => {
                  const from = nodeMap.get(edge.source);
                  const to = nodeMap.get(edge.target);
                  if (!from || !to) return null;
                  const fromX = from.x + from.width;
                  const fromY = from.y + from.height / 2;
                  const toX = to.x;
                  const toY = to.y + to.height / 2;
                  const midX = (fromX + toX) / 2;
                  const isHl = hoveredNode === edge.source || hoveredNode === edge.target;
                  const color = isHl ? '#c4b5fd' : (EDGE_COLORS[edge.type] || '#334155');
                  return (
                    <path key={i}
                      d={`M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`}
                      fill="none" stroke={color} strokeWidth={isHl ? 2.5 : 1.5} opacity={isHl ? 1 : 0.5}
                      markerEnd={isHl ? 'url(#at-arrow-hl)' : 'url(#at-arrow)'}
                      className="transition-all duration-200"
                    />
                  );
                })}

                {/* Nodes */}
                {layout.nodes.map(node => {
                  const c = LEVEL_COLORS[node.level] || LEVEL_COLORS.module;
                  const icon = TYPE_ICONS[node.type] || '📦';
                  const isHl = hoveredNode === node.id;
                  const isSel = selectedNode?.id === node.id;
                  const hasIssues = node.issues.length > 0;
                  const hasChildren = node.childCount > 0;

                  return (
                    <g key={node.id} transform={`translate(${node.x}, ${node.y})`}
                      onMouseEnter={() => setHoveredNode(node.id)}
                      onMouseLeave={() => setHoveredNode(null)}
                      onClick={() => setSelectedNode(isSel ? null : node)}
                      onDoubleClick={() => handleDoubleClick(node)}
                      className="cursor-pointer"
                    >
                      {/* Outer glow on hover */}
                      {isHl && (
                        <rect width={node.width} height={node.height} rx={10} fill="none"
                          stroke={c.stroke} strokeWidth={2} opacity={0.3}>
                          <animate attributeName="opacity" values="0.3;0.1;0.3" dur="2s" repeatCount="indefinite" />
                        </rect>
                      )}

                      <rect width={node.width} height={node.height} rx={10} fill={c.fill}
                        stroke={isSel ? '#e879f9' : isHl ? '#a78bfa' : c.stroke}
                        strokeWidth={isSel ? 2.5 : isHl ? 2 : 1}
                        className="transition-all duration-200"
                      />

                      {/* Level indicator */}
                      <circle cx={14} cy={20} r={4} fill={c.stroke} />

                      {/* Node name */}
                      <text x={26} y={24} fontSize={11} fill={c.text} fontWeight={600} fontFamily="sans-serif">
                        {icon} {node.name.length > 18 ? node.name.slice(0, 17) + '…' : node.name}
                      </text>

                      {/* Responsibility (truncated) */}
                      <text x={14} y={44} fontSize={9} fill="#64748b" fontFamily="sans-serif">
                        {node.responsibility.length > 30 ? node.responsibility.slice(0, 29) + '…' : node.responsibility}
                      </text>

                      {/* Stats line */}
                      <text x={14} y={62} fontSize={8} fill="#475569" fontFamily="sans-serif">
                        {node.fileCount} 文件 · {node.loc} LOC
                        {hasIssues && ` · ⚠ ${node.issues.length}`}
                        {hasChildren && ` · 📂 ${node.childCount}`}
                      </text>

                      {/* Drill-down hint */}
                      {hasChildren && (
                        <text x={node.width - 8} y={16} fontSize={8} fill="#475569" textAnchor="end">双击展开</text>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>
        </div>

        {/* ── Detail panel ── */}
        {selectedNode && (
          <div className="w-72 shrink-0 bg-slate-900/80 border border-slate-800 rounded-xl p-4 overflow-y-auto max-h-[460px]">
            <div className="flex items-center gap-2 mb-3">
              <span className="w-3 h-3 rounded-full" style={{ backgroundColor: (LEVEL_COLORS[selectedNode.level] || LEVEL_COLORS.module).stroke }} />
              <h4 className="text-sm font-semibold text-slate-200">{selectedNode.name}</h4>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500 capitalize">{selectedNode.level}</span>
            </div>
            <p className="text-xs text-slate-400 mb-3">{selectedNode.responsibility}</p>
            <div className="text-[10px] text-slate-500 mb-3">{TYPE_ICONS[selectedNode.type] || '📦'} {selectedNode.type}</div>
            <div className="flex gap-3 text-[10px] text-slate-500 mb-3">
              <span>{selectedNode.fileCount} 文件</span>
              <span>{selectedNode.loc} LOC</span>
            </div>

            {selectedNode.publicAPI.length > 0 && (
              <div className="mb-3">
                <div className="text-[10px] font-medium text-slate-400 uppercase mb-1">Public API</div>
                <div className="flex flex-wrap gap-1">
                  {selectedNode.publicAPI.slice(0, 12).map(api => (
                    <span key={api} className="text-[10px] bg-cyan-900/30 text-cyan-400 px-1.5 py-0.5 rounded">{api}</span>
                  ))}
                  {selectedNode.publicAPI.length > 12 && <span className="text-[10px] text-slate-500">+{selectedNode.publicAPI.length - 12}</span>}
                </div>
              </div>
            )}

            {selectedNode.keyTypes.length > 0 && (
              <div className="mb-3">
                <div className="text-[10px] font-medium text-slate-400 uppercase mb-1">Key Types</div>
                <div className="flex flex-wrap gap-1">
                  {selectedNode.keyTypes.slice(0, 10).map(t => (
                    <span key={t} className="text-[10px] bg-purple-900/30 text-purple-400 px-1.5 py-0.5 rounded">{t}</span>
                  ))}
                </div>
              </div>
            )}

            {selectedNode.patterns.length > 0 && (
              <div className="mb-3">
                <div className="text-[10px] font-medium text-slate-400 uppercase mb-1">Patterns</div>
                <div className="flex flex-wrap gap-1">
                  {selectedNode.patterns.map(p => (
                    <span key={p} className="text-[10px] bg-emerald-900/30 text-emerald-400 px-1.5 py-0.5 rounded">{p}</span>
                  ))}
                </div>
              </div>
            )}

            {selectedNode.issues.length > 0 && (
              <div className="mb-3">
                <div className="text-[10px] font-medium text-amber-400 uppercase mb-1">Issues ({selectedNode.issues.length})</div>
                {selectedNode.issues.map((issue, i) => (
                  <div key={i} className="text-[10px] text-amber-300 bg-amber-900/20 px-2 py-1 rounded mb-1">{issue}</div>
                ))}
              </div>
            )}

            {/* Files list (for components) */}
            {selectedNode.files.length > 0 && (
              <div className="pt-3 border-t border-slate-700/50">
                <div className="text-[10px] font-medium text-slate-400 uppercase mb-1">
                  文件 ({selectedNode.files.length})
                </div>
                <div className="max-h-32 overflow-y-auto">
                  {selectedNode.files.slice(0, 20).map((f, i) => (
                    <div key={i} className="text-[10px] text-slate-500 font-mono truncate mb-0.5" title={f}>
                      📄 {f}
                    </div>
                  ))}
                  {selectedNode.files.length > 20 && (
                    <div className="text-[10px] text-slate-600">+{selectedNode.files.length - 20} 更多</div>
                  )}
                </div>
              </div>
            )}

            {/* Dependencies */}
            {tree && (
              <div className="pt-3 border-t border-slate-700/50">
                <div className="text-[10px] font-medium text-slate-400 uppercase mb-1">依赖关系</div>
                {tree.edges
                  .filter(e => e.source === selectedNode.id || e.target === selectedNode.id)
                  .slice(0, 12)
                  .map((edge, i) => {
                    const otherId = edge.source === selectedNode.id ? edge.target : edge.source;
                    const otherNode = tree.nodes.find(n => n.id === otherId);
                    return (
                      <div key={i} className="text-[10px] text-slate-500 flex items-center gap-1 mb-0.5">
                        {edge.source === selectedNode.id
                          ? <><span className="text-cyan-500">→</span> {otherNode?.name || otherId}</>
                          : <><span className="text-emerald-500">←</span> {otherNode?.name || otherId}</>}
                        <span className="text-slate-600">({edge.type})</span>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Edge type legend */}
      <div className="flex gap-4 mt-2 text-[10px] text-slate-500">
        {Object.entries(EDGE_COLORS).map(([type, color]) => (
          <span key={type} className="flex items-center gap-1">
            <span className="w-4 h-0.5 rounded" style={{ backgroundColor: color }} />
            {type}
          </span>
        ))}
      </div>
    </section>
  );
}
