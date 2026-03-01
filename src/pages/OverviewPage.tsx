import { useState, useEffect, useMemo, useCallback } from 'react';
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
// DAG Layout — simple topological sort into layers
// ═══════════════════════════════════════
function layoutDAG(features: Feature[]): LayoutNode[] {
  const nodeMap = new Map<string, Feature>();
  features.forEach(f => nodeMap.set(f.id, f));

  // Parse deps
  const depsMap = new Map<string, string[]>();
  features.forEach(f => {
    let deps: string[] = [];
    try { deps = JSON.parse(f.depends_on || '[]'); } catch {}
    depsMap.set(f.id, deps.filter(d => nodeMap.has(d)));
  });

  // Assign layers via topological sort (longest path)
  const layerOf = new Map<string, number>();
  const visited = new Set<string>();

  function getLayer(id: string): number {
    if (layerOf.has(id)) return layerOf.get(id)!;
    if (visited.has(id)) return 0; // cycle guard
    visited.add(id);
    const deps = depsMap.get(id) || [];
    const maxDep = deps.length > 0 ? Math.max(...deps.map(getLayer)) + 1 : 0;
    layerOf.set(id, maxDep);
    return maxDep;
  }
  features.forEach(f => getLayer(f.id));

  // Group by layer
  const layers = new Map<number, string[]>();
  features.forEach(f => {
    const layer = layerOf.get(f.id) ?? 0;
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer)!.push(f.id);
  });

  const NODE_W = 180;
  const NODE_H = 56;
  const GAP_X = 60;
  const GAP_Y = 40;

  const nodes: LayoutNode[] = [];
  const sortedLayers = [...layers.entries()].sort((a, b) => a[0] - b[0]);

  for (const [layerIdx, ids] of sortedLayers) {
    // Sort by priority within layer
    ids.sort((a, b) => (nodeMap.get(a)!.priority) - (nodeMap.get(b)!.priority));
    for (let i = 0; i < ids.length; i++) {
      const f = nodeMap.get(ids[i])!;
      nodes.push({
        id: f.id,
        title: f.title || f.description,
        status: f.status,
        category: f.category,
        priority: f.priority,
        deps: depsMap.get(f.id) || [],
        x: layerIdx * (NODE_W + GAP_X) + 20,
        y: i * (NODE_H + GAP_Y) + 20,
      });
    }
  }

  return nodes;
}

// ═══════════════════════════════════════
// SVG DAG Component
// ═══════════════════════════════════════
function FeatureDAG({ features }: { features: Feature[] }) {
  const { featureStatuses } = useAppStore();

  const enriched = features.map(f => ({
    ...f,
    status: featureStatuses.get(f.id) || f.status,
  }));

  const nodes = useMemo(() => layoutDAG(enriched), [enriched]);
  const nodeMap = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);

  const NODE_W = 180;
  const NODE_H = 56;
  const maxX = Math.max(...nodes.map(n => n.x), 0) + NODE_W + 40;
  const maxY = Math.max(...nodes.map(n => n.y), 0) + NODE_H + 40;

  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  // Build edges
  const edges: Array<{ from: LayoutNode; to: LayoutNode }> = [];
  for (const node of nodes) {
    for (const depId of node.deps) {
      const depNode = nodeMap.get(depId);
      if (depNode) edges.push({ from: depNode, to: node });
    }
  }

  return (
    <div className="overflow-auto border border-slate-800 rounded-xl bg-slate-950/50">
      <svg width={maxX} height={maxY} className="min-w-full">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569" />
          </marker>
          <marker id="arrow-active" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#5c7cfa" />
          </marker>
        </defs>

        {/* Edges */}
        {edges.map((e, i) => {
          const fromX = e.from.x + NODE_W;
          const fromY = e.from.y + NODE_H / 2;
          const toX = e.to.x;
          const toY = e.to.y + NODE_H / 2;
          const midX = (fromX + toX) / 2;
          const isHovered = hoveredNode === e.from.id || hoveredNode === e.to.id;

          return (
            <path
              key={i}
              d={`M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`}
              fill="none"
              stroke={isHovered ? '#5c7cfa' : '#334155'}
              strokeWidth={isHovered ? 2 : 1.5}
              markerEnd={isHovered ? 'url(#arrow-active)' : 'url(#arrow)'}
              className="transition-all duration-200"
            />
          );
        })}

        {/* Nodes */}
        {nodes.map(node => {
          const sc = STATUS_COLOR[node.status] || STATUS_COLOR.todo;
          const isHovered = hoveredNode === node.id;

          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              onMouseEnter={() => setHoveredNode(node.id)}
              onMouseLeave={() => setHoveredNode(null)}
              className="cursor-pointer"
            >
              <rect
                width={NODE_W} height={NODE_H} rx={8}
                fill={sc.fill}
                stroke={isHovered ? '#5c7cfa' : sc.stroke}
                strokeWidth={isHovered ? 2 : 1}
                className="transition-all duration-200"
              />
              {/* Status dot */}
              <circle cx={14} cy={NODE_H / 2} r={4} fill={sc.stroke}>
                {(node.status === 'in_progress' || node.status === 'reviewing') && (
                  <animate attributeName="opacity" values="1;0.3;1" dur="1.5s" repeatCount="indefinite" />
                )}
              </circle>
              {/* ID */}
              <text x={26} y={20} fontSize={10} fill="#64748b" fontFamily="monospace">{node.id}</text>
              {/* Title (truncated) */}
              <text x={26} y={38} fontSize={11} fill={sc.text} fontFamily="sans-serif">
                {CATEGORY_BADGE[node.category] || ''} {node.title.length > 16 ? node.title.slice(0, 15) + '…' : node.title}
              </text>
              {/* Priority badge */}
              <text x={NODE_W - 14} y={18} fontSize={9} fill="#475569" textAnchor="end">P{node.priority}</text>
            </g>
          );
        })}
      </svg>
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
        {/* ── 进度仪表盘 ── */}
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

        {/* ── Feature 依赖图 ── */}
        {enriched.length > 0 && (
          <section>
            <h3 className="text-sm font-medium text-slate-400 mb-3">🗺️ Feature 依赖拓扑</h3>
            <FeatureDAG features={enriched} />
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