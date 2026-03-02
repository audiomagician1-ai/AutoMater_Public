/**
 * OverviewPage shared types, constants, and helpers
 */

import dagre from 'dagre';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface Feature {
  id: string; title: string; description: string; priority: number;
  category: string; status: string; depends_on: string; locked_by: string | null;
  group_name?: string; sub_group?: string;
  pm_verdict?: string;
  requirement_doc_ver?: number;
  test_spec_doc_ver?: number;
}

export type ViewLevel = 'module' | 'submodule' | 'feature';

export interface BreadcrumbItem {
  level: ViewLevel;
  label: string;
  filterValue?: string;
}

export interface GraphNode {
  id: string;
  label: string;
  status: string;
  category: string;
  x: number;
  y: number;
  width: number;
  height: number;
  deps: string[];
  childCount?: number;
  statusCounts?: Record<string, number>;
  feature?: Feature;
}

// ═══════════════════════════════════════
// Constants
// ═══════════════════════════════════════

export const STATUS_COLOR: Record<string, { fill: string; stroke: string; text: string; bg: string }> = {
  todo:        { fill: '#334155', stroke: '#475569', text: '#94a3b8', bg: 'bg-slate-600' },
  in_progress: { fill: '#1e3a5f', stroke: '#3b82f6', text: '#60a5fa', bg: 'bg-blue-500' },
  reviewing:   { fill: '#422006', stroke: '#f59e0b', text: '#fbbf24', bg: 'bg-amber-500' },
  passed:      { fill: '#052e16', stroke: '#22c55e', text: '#4ade80', bg: 'bg-emerald-500' },
  failed:      { fill: '#450a0a', stroke: '#ef4444', text: '#f87171', bg: 'bg-red-500' },
};

export const CATEGORY_BADGE: Record<string, string> = {
  infrastructure: '🔧', core: '⚙️', ui: '🎨', api: '🔌', testing: '🧪', docs: '📝',
};

// ═══════════════════════════════════════
// Dagre Layout Engine
// ═══════════════════════════════════════

export function buildDagreGraph(
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

export function aggregateModules(features: Feature[]) {
  const groups = new Map<string, Feature[]>();
  for (const f of features) {
    const key = f.group_name || f.category || 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  return groups;
}

export function aggregateSubModules(features: Feature[]) {
  const groups = new Map<string, Feature[]>();
  for (const f of features) {
    const key = f.sub_group || f.title || f.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  return groups;
}

export function statusCountsFromFeatures(features: Feature[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of features) {
    counts[f.status] = (counts[f.status] || 0) + 1;
  }
  return counts;
}

export function dominantStatus(counts: Record<string, number>): string {
  if (counts.failed) return 'failed';
  if (counts.in_progress || counts.reviewing) return 'in_progress';
  if (counts.passed && !counts.todo) return 'passed';
  return 'todo';
}

// Agent role icon mapping
export const AGENT_ROLE_ICONS: Record<string, { icon: string; color: string }> = {
  pm: { icon: '🧠', color: '#8b5cf6' },
  architect: { icon: '🏗️', color: '#3b82f6' },
  developer: { icon: '💻', color: '#10b981' },
  qa: { icon: '🧪', color: '#f59e0b' },
  devops: { icon: '🚀', color: '#06b6d4' },
  reviewer: { icon: '👁️', color: '#a855f7' },
};

export function getAgentRoleIcon(agentId: string): { icon: string; color: string } {
  if (agentId.startsWith('pm')) return AGENT_ROLE_ICONS.pm;
  if (agentId.startsWith('arch')) return AGENT_ROLE_ICONS.architect;
  if (agentId.startsWith('dev')) return AGENT_ROLE_ICONS.developer;
  if (agentId.startsWith('qa')) return AGENT_ROLE_ICONS.qa;
  if (agentId.startsWith('devops')) return AGENT_ROLE_ICONS.devops;
  return { icon: '🤖', color: '#64748b' };
}

export const PROJECT_STATUS: Record<string, { text: string; color: string }> = {
  initializing: { text: '初始化', color: 'text-blue-400' },
  analyzing:    { text: '导入分析中', color: 'text-cyan-400' },
  developing:   { text: '开发中', color: 'text-emerald-400' },
  reviewing:    { text: '审查中', color: 'text-amber-400' },
  delivered:    { text: '已交付', color: 'text-green-400' },
  paused:       { text: '已暂停', color: 'text-slate-400' },
  error:        { text: '出错',   color: 'text-red-400' },
  idle:         { text: '空闲',   color: 'text-slate-500' },
};
