/**
 * ModuleArchGraph — 基于 module-graph.json 的 dagre DAG 可视化
 *
 * 导入项目完成后，features 尚未产生时，用此组件展示真实模块架构关系图谱。
 * 节点 = 模块（按 type 着色），边 = 模块间依赖（按 type 着色）
 * 支持: 滚轮缩放、拖拽平移、hover 高亮关联边、点击查看模块详情
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import dagre from 'dagre';

// ── Types (mirror backend probe-types.ts) ──

interface ModuleGraphNode {
  id: string;
  type: 'module' | 'entry-point' | 'api-layer' | 'data-layer' | 'config' | 'utility';
  path: string;
  responsibility: string;
  publicAPI: string[];
  keyTypes: string[];
  patterns: string[];
  issues: string[];
  fileCount: number;
  loc: number;
}

interface ModuleGraphEdge {
  source: string;
  target: string;
  type: 'import' | 'dataflow' | 'event' | 'config' | 'ipc';
  weight: number;
}

interface ModuleGraph {
  nodes: ModuleGraphNode[];
  edges: ModuleGraphEdge[];
}

interface LayoutNode extends ModuleGraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Color maps ──

const NODE_COLORS: Record<string, { fill: string; stroke: string; text: string }> = {
  'entry-point': { fill: '#052e16', stroke: '#22c55e', text: '#4ade80' },
  'api-layer':   { fill: '#172554', stroke: '#3b82f6', text: '#60a5fa' },
  'data-layer':  { fill: '#2e1065', stroke: '#8b5cf6', text: '#a78bfa' },
  'config':      { fill: '#451a03', stroke: '#f59e0b', text: '#fbbf24' },
  'utility':     { fill: '#1e293b', stroke: '#64748b', text: '#94a3b8' },
  'module':      { fill: '#083344', stroke: '#06b6d4', text: '#22d3ee' },
};

const EDGE_COLORS: Record<string, string> = {
  import:   '#334155',
  dataflow: '#3b82f6',
  event:    '#f59e0b',
  config:   '#8b5cf6',
  ipc:      '#06b6d4',
};

const NODE_TYPE_LABEL: Record<string, { icon: string; label: string }> = {
  'entry-point': { icon: '🚪', label: '入口' },
  'api-layer':   { icon: '🌐', label: 'API' },
  'data-layer':  { icon: '🗃️', label: '数据层' },
  'config':      { icon: '⚙️', label: '配置' },
  'utility':     { icon: '🔧', label: '工具' },
  'module':      { icon: '📦', label: '模块' },
};

// ── Dagre layout ──

function layoutGraph(graph: ModuleGraph): { nodes: LayoutNode[]; width: number; height: number } {
  const NODE_W = 210;
  const NODE_H = 70;

  if (graph.nodes.length === 0) return { nodes: [], width: 0, height: 0 };

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 100, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));

  const nodeIds = new Set(graph.nodes.map(n => n.id));
  for (const node of graph.nodes) {
    g.setNode(node.id, { width: NODE_W, height: NODE_H });
  }
  for (const edge of graph.edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(g);

  const layoutNodes: LayoutNode[] = graph.nodes.map(n => {
    const pos = g.node(n.id);
    return { ...n, x: (pos?.x ?? 0) - NODE_W / 2, y: (pos?.y ?? 0) - NODE_H / 2, width: NODE_W, height: NODE_H };
  });

  const gGraph = g.graph();
  return { nodes: layoutNodes, width: (gGraph.width ?? 800) + 60, height: (gGraph.height ?? 400) + 60 };
}

// ── Component ──

export function ModuleArchGraph({ projectId }: { projectId: string }) {
  const [graph, setGraph] = useState<ModuleGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<ModuleGraphNode | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const loadGraph = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.automater.project.getModuleGraph(projectId);
      if (res.success && res.graph) setGraph(res.graph as ModuleGraph);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { loadGraph(); }, [loadGraph]);

  const layout = useMemo(() => graph ? layoutGraph(graph) : null, [graph]);

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

  const zoomIn = () => setTransform(t => ({ ...t, scale: Math.min(4, t.scale * 1.2) }));
  const zoomOut = () => setTransform(t => ({ ...t, scale: Math.max(0.15, t.scale * 0.8) }));
  const resetView = () => setTransform({ x: 0, y: 0, scale: 1 });

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 justify-center text-sm text-slate-500">
        <div className="animate-spin w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full" />
        加载模块图...
      </div>
    );
  }

  if (!graph || !layout || layout.nodes.length === 0) return null;

  // Precompute edge connections for hover highlight
  const nodeEdges = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!nodeEdges.has(edge.source)) nodeEdges.set(edge.source, new Set());
    if (!nodeEdges.has(edge.target)) nodeEdges.set(edge.target, new Set());
    nodeEdges.get(edge.source)!.add(edge.target);
    nodeEdges.get(edge.target)!.add(edge.source);
  }

  const nodeMap = new Map(layout.nodes.map(n => [n.id, n]));

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-slate-400">🗺️ 系统架构图</h3>
        <div className="flex items-center gap-3 text-[10px] text-slate-500">
          {Object.entries(NODE_TYPE_LABEL).map(([type, { icon, label }]) => {
            const c = NODE_COLORS[type] || NODE_COLORS.module;
            return (
              <span key={type} className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: c.stroke }} />
                {icon} {label}
              </span>
            );
          })}
          <span className="text-slate-600 ml-2">{graph.nodes.length} 模块 · {graph.edges.length} 依赖</span>
        </div>
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
            缩放: {(transform.scale * 100).toFixed(0)}% · 滚轮缩放 · 拖拽平移 · 点击查看详情
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
                <marker id="mg-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569" />
                </marker>
                <marker id="mg-arrow-hl" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#22d3ee" />
                </marker>
              </defs>

              <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
                {/* Edges */}
                {graph.edges.map((edge, i) => {
                  const from = nodeMap.get(edge.source);
                  const to = nodeMap.get(edge.target);
                  if (!from || !to) return null;
                  const fromX = from.x + from.width;
                  const fromY = from.y + from.height / 2;
                  const toX = to.x;
                  const toY = to.y + to.height / 2;
                  const midX = (fromX + toX) / 2;
                  const isHl = hoveredNode === edge.source || hoveredNode === edge.target;
                  const color = isHl ? '#22d3ee' : (EDGE_COLORS[edge.type] || '#334155');
                  return (
                    <path key={i}
                      d={`M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`}
                      fill="none" stroke={color} strokeWidth={isHl ? 2.5 : 1.5} opacity={isHl ? 1 : 0.5}
                      markerEnd={isHl ? 'url(#mg-arrow-hl)' : 'url(#mg-arrow)'}
                      className="transition-all duration-200"
                    />
                  );
                })}

                {/* Nodes */}
                {layout.nodes.map(node => {
                  const c = NODE_COLORS[node.type] || NODE_COLORS.module;
                  const tl = NODE_TYPE_LABEL[node.type] || NODE_TYPE_LABEL.module;
                  const isHl = hoveredNode === node.id;
                  const isSel = selectedNode?.id === node.id;
                  const hasIssues = node.issues.length > 0;

                  return (
                    <g key={node.id} transform={`translate(${node.x}, ${node.y})`}
                      onMouseEnter={() => setHoveredNode(node.id)}
                      onMouseLeave={() => setHoveredNode(null)}
                      onClick={() => setSelectedNode(isSel ? null : node)}
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
                        stroke={isSel ? '#22d3ee' : isHl ? '#5c7cfa' : c.stroke}
                        strokeWidth={isSel ? 2.5 : isHl ? 2 : 1}
                        className="transition-all duration-200"
                      />

                      {/* Type indicator */}
                      <circle cx={14} cy={18} r={4} fill={c.stroke} />

                      {/* Module name */}
                      <text x={26} y={22} fontSize={11} fill={c.text} fontWeight={600} fontFamily="sans-serif">
                        {tl.icon} {node.id.length > 20 ? node.id.slice(0, 19) + '…' : node.id}
                      </text>

                      {/* Responsibility (truncated) */}
                      <text x={14} y={40} fontSize={9} fill="#64748b" fontFamily="sans-serif">
                        {node.responsibility.length > 28 ? node.responsibility.slice(0, 27) + '…' : node.responsibility}
                      </text>

                      {/* Stats line */}
                      <text x={14} y={58} fontSize={8} fill="#475569" fontFamily="sans-serif">
                        {node.fileCount} 文件 · {node.loc} LOC
                        {hasIssues && ` · ⚠ ${node.issues.length}`}
                      </text>
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
              <span className="w-3 h-3 rounded-full" style={{ backgroundColor: (NODE_COLORS[selectedNode.type] || NODE_COLORS.module).stroke }} />
              <h4 className="text-sm font-semibold text-slate-200">{selectedNode.id}</h4>
            </div>
            <p className="text-xs text-slate-400 mb-3">{selectedNode.responsibility}</p>
            <div className="text-[10px] text-slate-500 mb-3">📂 {selectedNode.path}</div>
            <div className="flex gap-3 text-[10px] text-slate-500 mb-3">
              <span>{selectedNode.fileCount} 文件</span>
              <span>{selectedNode.loc} LOC</span>
              <span className="capitalize">{(NODE_TYPE_LABEL[selectedNode.type] || NODE_TYPE_LABEL.module).label}</span>
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

            {/* Dependencies */}
            <div className="pt-3 border-t border-slate-700/50">
              <div className="text-[10px] font-medium text-slate-400 uppercase mb-1">依赖关系</div>
              {graph.edges
                .filter(e => e.source === selectedNode.id || e.target === selectedNode.id)
                .slice(0, 12)
                .map((edge, i) => (
                  <div key={i} className="text-[10px] text-slate-500 flex items-center gap-1 mb-0.5">
                    {edge.source === selectedNode.id
                      ? <><span className="text-cyan-500">→</span> {edge.target}</>
                      : <><span className="text-emerald-500">←</span> {edge.source}</>}
                    <span className="text-slate-600">({edge.type})</span>
                  </div>
                ))}
            </div>
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
