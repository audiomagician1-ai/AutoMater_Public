import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useAppStore } from '../stores/app-store';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════
interface Feature {
  id: string; title: string; description: string; priority: number;
  category: string; status: string; depends_on: string; locked_by: string | null;
}

interface LayoutNode {
  id: string; title: string; status: string; category: string;
  x: number; y: number; deps: string[]; priority: number;
  /** 子任务数 (模拟复杂度) */
  complexity: number;
  /** 是否展开子任务 */
  expanded?: boolean;
}

// ═══════════════════════════════════════
// Status colors
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
// DAG Layout — topological sort into layers + complexity sizing
// ═══════════════════════════════════════
function layoutDAG(features: Feature[]): LayoutNode[] {
  const nodeMap = new Map<string, Feature>();
  features.forEach(f => nodeMap.set(f.id, f));

  const depsMap = new Map<string, string[]>();
  features.forEach(f => {
    let deps: string[] = [];
    try { deps = JSON.parse(f.depends_on || '[]'); } catch {}
    depsMap.set(f.id, deps.filter(d => nodeMap.has(d)));
  });

  // Assign layers
  const layerOf = new Map<string, number>();
  const visited = new Set<string>();
  function getLayer(id: string): number {
    if (layerOf.has(id)) return layerOf.get(id)!;
    if (visited.has(id)) return 0;
    visited.add(id);
    const deps = depsMap.get(id) || [];
    const maxDep = deps.length > 0 ? Math.max(...deps.map(getLayer)) + 1 : 0;
    layerOf.set(id, maxDep);
    return maxDep;
  }
  features.forEach(f => getLayer(f.id));

  // Complexity = dependents count + priority-based
  const dependentsOf = new Map<string, number>();
  features.forEach(f => {
    const deps = depsMap.get(f.id) || [];
    deps.forEach(d => dependentsOf.set(d, (dependentsOf.get(d) || 0) + 1));
  });

  const layers = new Map<number, string[]>();
  features.forEach(f => {
    const layer = layerOf.get(f.id) ?? 0;
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer)!.push(f.id);
  });

  const BASE_W = 160;
  const BASE_H = 48;
  const GAP_X = 80;
  const GAP_Y = 32;

  const nodes: LayoutNode[] = [];
  const sortedLayers = [...layers.entries()].sort((a, b) => a[0] - b[0]);

  for (const [layerIdx, ids] of sortedLayers) {
    ids.sort((a, b) => (nodeMap.get(a)!.priority) - (nodeMap.get(b)!.priority));
    let yOffset = 20;
    for (const id of ids) {
      const f = nodeMap.get(id)!;
      const complexity = (dependentsOf.get(id) || 0) + (f.priority <= 2 ? 2 : 1);
      const scale = Math.min(1 + complexity * 0.15, 1.6);
      const w = BASE_W * scale;
      const h = BASE_H * scale;
      nodes.push({
        id: f.id,
        title: f.title || f.description,
        status: f.status,
        category: f.category,
        priority: f.priority,
        deps: depsMap.get(f.id) || [],
        x: layerIdx * (BASE_W + GAP_X) + 40,
        y: yOffset,
        complexity,
      });
      yOffset += h + GAP_Y;
    }
  }

  return nodes;
}

// ═══════════════════════════════════════
// Interactive Graph — zoom / pan / click
// ═══════════════════════════════════════
function InteractiveGraph({ features }: { features: Feature[] }) {
  const { featureStatuses, agentStatuses } = useAppStore();
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Transform state
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [expandedNode, setExpandedNode] = useState<string | null>(null);

  const enriched = features.map(f => ({ ...f, status: featureStatuses.get(f.id) || f.status }));
  const nodes = useMemo(() => layoutDAG(enriched), [enriched]);
  const nodeMap = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);

  const BASE_W = 160;
  const BASE_H = 48;

  // Edges
  const edges: Array<{ from: LayoutNode; to: LayoutNode }> = [];
  for (const node of nodes) {
    for (const depId of node.deps) {
      const depNode = nodeMap.get(depId);
      if (depNode) edges.push({ from: depNode, to: node });
    }
  }

  // Canvas size
  const maxX = Math.max(...nodes.map(n => n.x + BASE_W * Math.min(1 + n.complexity * 0.15, 1.6)), 600);
  const maxY = Math.max(...nodes.map(n => n.y + BASE_H * Math.min(1 + n.complexity * 0.15, 1.6)), 400);

  // Wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setTransform(t => {
      const newScale = Math.max(0.2, Math.min(3, t.scale * delta));
      // Zoom toward cursor
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        return {
          scale: newScale,
          x: cx - (cx - t.x) * (newScale / t.scale),
          y: cy - (cy - t.y) * (newScale / t.scale),
        };
      }
      return { ...t, scale: newScale };
    });
  }, []);

  // Pan
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

  // Double click to expand
  const handleDoubleClick = (nodeId: string) => {
    setExpandedNode(expandedNode === nodeId ? null : nodeId);
  };

  // Find agent working on feature
  const getAgentForFeature = (featureId: string) => {
    for (const [agentId, status] of agentStatuses.entries()) {
      if (status.currentTask?.includes(featureId)) return { agentId, ...status };
    }
    return null;
  };

  // Zoom controls
  const zoomIn = () => setTransform(t => ({ ...t, scale: Math.min(3, t.scale * 1.2) }));
  const zoomOut = () => setTransform(t => ({ ...t, scale: Math.max(0.2, t.scale * 0.8) }));
  const resetView = () => setTransform({ x: 0, y: 0, scale: 1 });

  return (
    <div className="relative overflow-hidden border border-slate-800 rounded-xl bg-slate-950/50" style={{ height: '500px' }}>
      {/* Zoom controls */}
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
        <button onClick={zoomIn} className="w-8 h-8 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300 text-sm flex items-center justify-center" title="放大">+</button>
        <button onClick={zoomOut} className="w-8 h-8 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300 text-sm flex items-center justify-center" title="缩小">−</button>
        <button onClick={resetView} className="w-8 h-8 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300 text-xs flex items-center justify-center" title="重置">⟲</button>
      </div>
      <div className="absolute bottom-3 left-3 z-10 text-[10px] text-slate-600">
        缩放: {(transform.scale * 100).toFixed(0)}% · 滚轮缩放 · 拖拽平移 · 双击展开
      </div>

      <div
        ref={containerRef}
        className="w-full h-full cursor-grab active:cursor-grabbing"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <svg ref={svgRef} width="100%" height="100%">
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
              const fs = Math.min(1 + e.from.complexity * 0.15, 1.6);
              const ts = Math.min(1 + e.to.complexity * 0.15, 1.6);
              const fromX = e.from.x + BASE_W * fs;
              const fromY = e.from.y + BASE_H * fs / 2;
              const toX = e.to.x;
              const toY = e.to.y + BASE_H * ts / 2;
              const midX = (fromX + toX) / 2;
              const isHl = hoveredNode === e.from.id || hoveredNode === e.to.id;

              return (
                <path key={i}
                  d={`M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`}
                  fill="none" stroke={isHl ? '#5c7cfa' : '#334155'} strokeWidth={isHl ? 2 : 1.5}
                  markerEnd={isHl ? 'url(#arrow-hl)' : 'url(#arrow)'} className="transition-all duration-200"
                />
              );
            })}

            {/* Nodes */}
            {nodes.map(node => {
              const sc = STATUS_COLOR[node.status] || STATUS_COLOR.todo;
              const isHl = hoveredNode === node.id;
              const isExpanded = expandedNode === node.id;
              const scale = Math.min(1 + node.complexity * 0.15, 1.6);
              const w = BASE_W * scale;
              const h = BASE_H * scale;
              const agent = getAgentForFeature(node.id);

              return (
                <g key={node.id} transform={`translate(${node.x}, ${node.y})`}
                  onMouseEnter={() => setHoveredNode(node.id)}
                  onMouseLeave={() => setHoveredNode(null)}
                  onDoubleClick={() => handleDoubleClick(node.id)}
                  className="cursor-pointer"
                >
                  {/* Glow for active */}
                  {(node.status === 'in_progress' || agent) && (
                    <rect width={w} height={h} rx={10} fill="none" stroke={sc.stroke} strokeWidth={2} opacity={0.3}>
                      <animate attributeName="opacity" values="0.3;0.1;0.3" dur="2s" repeatCount="indefinite" />
                    </rect>
                  )}
                  <rect width={w} height={h} rx={10} fill={sc.fill}
                    stroke={isHl ? '#5c7cfa' : sc.stroke} strokeWidth={isHl ? 2 : 1}
                    className="transition-all duration-200"
                  />
                  {/* Status dot */}
                  <circle cx={14} cy={h / 2} r={4 * scale * 0.7} fill={sc.stroke}>
                    {(node.status === 'in_progress' || node.status === 'reviewing') && (
                      <animate attributeName="opacity" values="1;0.3;1" dur="1.5s" repeatCount="indefinite" />
                    )}
                  </circle>
                  {/* Title */}
                  <text x={26} y={h * 0.45} fontSize={11 * scale * 0.75} fill={sc.text} fontFamily="sans-serif">
                    {CATEGORY_BADGE[node.category] || ''} {node.title.length > 18 / scale ? node.title.slice(0, Math.floor(17 / scale)) + '…' : node.title}
                  </text>
                  {/* Agent working indicator */}
                  {agent && (
                    <text x={26} y={h * 0.75} fontSize={9 * scale * 0.7} fill="#5c7cfa" fontFamily="sans-serif">
                      🤖 {agent.agentId.split('-')[0]}
                    </text>
                  )}
                  {/* Priority badge */}
                  <text x={w - 10} y={16} fontSize={9} fill="#475569" textAnchor="end">P{node.priority}</text>
                  {/* Complexity indicator */}
                  {node.complexity > 2 && (
                    <text x={w - 10} y={h - 6} fontSize={8} fill="#64748b" textAnchor="end">⊞ {node.complexity}</text>
                  )}

                  {/* Expanded detail panel */}
                  {isExpanded && (
                    <g transform={`translate(0, ${h + 6})`}>
                      <rect width={w} height={60} rx={6} fill="#1e293b" stroke="#334155" strokeWidth={1} />
                      <text x={8} y={16} fontSize={9} fill="#94a3b8" fontFamily="monospace">{node.id}</text>
                      <text x={8} y={30} fontSize={8} fill="#64748b">依赖: {node.deps.length > 0 ? node.deps.join(', ') : '无'}</text>
                      <text x={8} y={44} fontSize={8} fill="#64748b">状态: {node.status} · 复杂度: {node.complexity}</text>
                      {agent && <text x={8} y={56} fontSize={8} fill="#5c7cfa">Agent: {agent.agentId} · {agent.currentTask?.slice(0, 30)}</text>}
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
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
        <circle
          cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={6}
          strokeDasharray={c} strokeDashoffset={offset}
          strokeLinecap="round" transform={`rotate(-90 ${size/2} ${size/2})`}
          className="transition-all duration-700"
        />
        <text x={size/2} y={size/2} textAnchor="middle" dominantBaseline="central" fill="#e2e8f0" fontSize={size * 0.22} fontWeight="bold">
          {Math.round(value)}%
        </text>
      </svg>
      <span className="text-[10px] text-slate-500">{label}</span>
    </div>
  );
}

// ═══════════════════════════════════════
// Stats Card
// ═══════════════════════════════════════
function StatCard({ icon, label, value, sub }: { icon: string; label: string; value: string; sub?: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-1">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span>{icon}</span>
        <span>{label}</span>
      </div>
      <div className="text-lg font-bold text-slate-200">{value}</div>
      {sub && <div className="text-[10px] text-slate-600">{sub}</div>}
    </div>
  );
}

// ═══════════════════════════════════════
// Main OverviewPage
// ═══════════════════════════════════════
export function OverviewPage() {
  const { currentProjectId, featureStatuses } = useAppStore();
  const [features, setFeatures] = useState<Feature[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [archContent, setArchContent] = useState<string | null>(null);
  const [project, setProject] = useState<any>(null);

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

    // Read ARCHITECTURE.md
    try {
      const result = await window.agentforge.workspace.readFile(currentProjectId, 'ARCHITECTURE.md');
      setArchContent(result.success ? result.content : null);
    } catch { setArchContent(null); }
  }, [currentProjectId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  if (!currentProjectId) {
    return <div className="h-full flex items-center justify-center text-slate-500"><p>加载中...</p></div>;
  }

  // Enrich statuses
  const enriched = features.map(f => ({
    ...f,
    status: featureStatuses.get(f.id) || f.status,
  }));

  const f = stats?.features || {};
  const a = stats?.agents || {};
  const total = f.total ?? 0;
  const passed = f.passed ?? 0;
  const inProgress = f.in_progress ?? 0;
  const reviewing = f.reviewing ?? 0;
  const failed = f.failed ?? 0;
  const todo = f.todo ?? 0;
  const progress = total > 0 ? (passed / total) * 100 : 0;

  // Category distribution
  const categoryCount = new Map<string, number>();
  enriched.forEach(feat => {
    const cat = feat.category || 'other';
    categoryCount.set(cat, (categoryCount.get(cat) ?? 0) + 1);
  });

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-slate-800/50 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold">项目全景</h2>
            {project && <p className="text-xs text-slate-500 mt-0.5 max-w-xl truncate">{project.wish}</p>}
          </div>
          <button onClick={load} className="text-sm text-slate-500 hover:text-slate-300 transition-colors">🔄</button>
        </div>
      </div>

      <div className="flex-1 p-6 space-y-6">
        {/* Empty state for new projects */}
        {enriched.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-slate-500 gap-4">
            <div className="text-5xl">🗺️</div>
            <div className="text-lg font-medium text-slate-400">项目全景</div>
            <div className="text-sm text-center max-w-md">
              当 PM Agent 完成需求分析并拆分为功能模块后，这里会展示：
              <br />
              <span className="text-slate-600">• 可缩放、平移的逻辑连接图</span>
              <br />
              <span className="text-slate-600">• 按复杂度分大小的任务节点</span>
              <br />
              <span className="text-slate-600">• 双击节点查看子任务和 Agent 工作状态</span>
            </div>
          </div>
        )}

        {/* ── 进度仪表盘 ── */}
        {enriched.length > 0 && (
        <section>
          <h3 className="text-sm font-medium text-slate-400 mb-3">📊 进度概览</h3>
          <div className="flex flex-wrap gap-6 items-start">
            {/* 进度环 */}
            <div className="flex gap-4">
              <ProgressRing value={progress} label="总进度" color="#22c55e" />
              {failed > 0 && <ProgressRing value={total > 0 ? (failed / total) * 100 : 0} size={80} label="失败率" color="#ef4444" />}
            </div>

            {/* 状态分布 */}
            <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 min-w-[300px]">
              <StatCard icon="⬜" label="待做" value={String(todo)} />
              <StatCard icon="🔨" label="开发中" value={String(inProgress)} />
              <StatCard icon="🔍" label="审查中" value={String(reviewing)} />
              <StatCard icon="✅" label="已完成" value={String(passed)} />
              <StatCard icon="❌" label="失败" value={String(failed)} />
            </div>
          </div>

          {/* 额外统计 */}
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard icon="🤖" label="Agents" value={String(a.total ?? 0)} />
            <StatCard icon="📊" label="Tokens" value={a.total_tokens ? `${(a.total_tokens / 1000).toFixed(1)}k` : '0'} />
            <StatCard icon="💰" label="成本" value={a.total_cost ? `$${a.total_cost.toFixed(3)}` : '$0'} />
            <StatCard icon="📁" label="分类" value={String(categoryCount.size)}
              sub={[...categoryCount.entries()].map(([k, v]) => `${CATEGORY_BADGE[k] || '📦'}${k}: ${v}`).join('  ')} />
          </div>
        </section>
        )}

        {/* ── Feature 依赖图 (交互式) ── */}
        {enriched.length > 0 && (
          <section>
            <h3 className="text-sm font-medium text-slate-400 mb-3">🗺️ 逻辑连接图</h3>
            <InteractiveGraph features={enriched} />
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

        {/* ── 架构概览 ── */}
        {archContent && (
          <section>
            <h3 className="text-sm font-medium text-slate-400 mb-3">🏗️ 架构文档</h3>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 overflow-auto max-h-96">
              <pre className="text-xs text-slate-400 font-mono whitespace-pre-wrap leading-relaxed">{archContent}</pre>
            </div>
          </section>
        )}

        {/* ── Feature 路线图 (时序) ── */}
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
                      <div className={`w-2 h-2 rounded-full flex-shrink-0`} style={{ backgroundColor: sc.stroke }} />
                      <span className="text-[10px] text-slate-600 font-mono w-12 flex-shrink-0">{feat.id}</span>
                      <span className="text-[10px] w-5">{CATEGORY_BADGE[feat.category] || '📦'}</span>
                      <span className="text-xs text-slate-300 flex-1 truncate">{feat.title || feat.description}</span>
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