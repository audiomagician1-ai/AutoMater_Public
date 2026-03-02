/**
 * ImportAnalysisPanel — v7.0 导入分析结果展示
 *
 * 展示:
 * 1. Module Graph 可视化 (节点 = 模块, 边 = 依赖)
 * 2. Probe 报告摘要 (每个探针的发现和置信度)
 * 3. 已知问题列表
 * 4. 增量变更检测状态
 */

import { useState, useEffect, useCallback } from 'react';

/* ─── Types mirroring backend probe-types.ts ─── */
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

interface ProbeReport {
  probeId: string;
  type: string;
  findings: Array<{ type: string; id: string; name: string; description: string; files: string[] }>;
  filesExamined: string[];
  issues: Array<{ location: string; severity: string; description: string }>;
  confidence: number;
  tokensUsed: number;
  durationMs: number;
  rounds: number;
}

interface IncrementalResult {
  changedFiles: string[];
  affectedProbeTypes: string[];
  needsFullReprobe: boolean;
  reason: string;
}

/* ─── Color maps ─── */
const NODE_TYPE_COLOR: Record<string, string> = {
  'entry-point': 'bg-emerald-500',
  'api-layer': 'bg-blue-500',
  'data-layer': 'bg-purple-500',
  'config': 'bg-amber-500',
  'utility': 'bg-slate-400',
  'module': 'bg-cyan-500',
};

const NODE_TYPE_LABEL: Record<string, string> = {
  'entry-point': '入口',
  'api-layer': 'API层',
  'data-layer': '数据层',
  'config': '配置',
  'utility': '工具',
  'module': '模块',
};

const PROBE_TYPE_ICON: Record<string, string> = {
  entry: '🚪',
  module: '📦',
  'api-boundary': '🌐',
  'data-model': '🗃️',
  'config-infra': '⚙️',
  smell: '🔍',
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: 'text-red-400 bg-red-900/30',
  warning: 'text-amber-400 bg-amber-900/30',
  info: 'text-blue-400 bg-blue-900/30',
};

/* ─── Main Component ─── */
export function ImportAnalysisPanel({ projectId }: { projectId: string }) {
  const [graph, setGraph] = useState<ModuleGraph | null>(null);
  const [reports, setReports] = useState<ProbeReport[]>([]);
  const [issues, setIssues] = useState<string>('');
  const [incremental, setIncremental] = useState<IncrementalResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedNode, setSelectedNode] = useState<ModuleGraphNode | null>(null);
  const [activeTab, setActiveTab] = useState<'graph' | 'probes' | 'issues'>('graph');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [graphRes, reportsRes, issuesRes, incrRes] = await Promise.all([
        window.automater.project.getModuleGraph(projectId),
        window.automater.project.getProbeReports(projectId),
        window.automater.project.getKnownIssues(projectId),
        window.automater.project.detectIncrementalChanges(projectId),
      ]);
      if (graphRes.success && graphRes.graph) setGraph(graphRes.graph as ModuleGraph);
      if (reportsRes.success && reportsRes.reports) setReports(reportsRes.reports as ProbeReport[]);
      if (issuesRes.success) setIssues(issuesRes.issues || '');
      if (incrRes.success) setIncremental({
        changedFiles: incrRes.changedFiles || [],
        affectedProbeTypes: incrRes.affectedProbeTypes || [],
        needsFullReprobe: incrRes.needsFullReprobe || false,
        reason: incrRes.reason || '',
      });
    } catch (err) {
      console.error('Failed to load analysis data', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { loadData(); }, [loadData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin w-5 h-5 border-2 border-cyan-400 border-t-transparent rounded-full" />
        <span className="ml-2 text-slate-400 text-sm">加载分析结果...</span>
      </div>
    );
  }

  if (!graph || graph.nodes.length === 0) {
    return null; // No analysis results yet
  }

  const totalFindings = reports.reduce((s, r) => s + r.findings.length, 0);
  const totalIssues = reports.reduce((s, r) => s + r.issues.length, 0);
  const avgConfidence = reports.length > 0
    ? (reports.reduce((s, r) => s + r.confidence, 0) / reports.length * 100).toFixed(0)
    : '0';

  return (
    <div className="mt-6 bg-slate-800/50 rounded-xl border border-slate-700/50 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-slate-800/80 border-b border-slate-700/50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-base font-medium text-slate-200">📊 导入分析报告</span>
          <span className="text-xs text-slate-500">
            {graph.nodes.length} 模块 · {graph.edges.length} 依赖 · {totalFindings} 发现 · {totalIssues} 问题
          </span>
        </div>
        <div className="flex items-center gap-2">
          {incremental && !incremental.needsFullReprobe && incremental.changedFiles.length === 0 && (
            <span className="text-xs text-emerald-400 bg-emerald-900/20 px-2 py-0.5 rounded">✅ 分析最新</span>
          )}
          {incremental && incremental.changedFiles.length > 0 && (
            <span className="text-xs text-amber-400 bg-amber-900/20 px-2 py-0.5 rounded">
              ⚠️ {incremental.changedFiles.length} 文件已变更
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-700/50">
        {(['graph', 'probes', 'issues'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm transition-colors ${
              activeTab === tab
                ? 'text-cyan-400 border-b-2 border-cyan-400 bg-slate-800/30'
                : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            {tab === 'graph' ? `模块图 (${graph.nodes.length})` :
             tab === 'probes' ? `探针报告 (${reports.length})` :
             `已知问题 (${totalIssues})`}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="p-4">
        {activeTab === 'graph' && (
          <ModuleGraphView
            graph={graph}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
          />
        )}
        {activeTab === 'probes' && (
          <ProbeReportsView reports={reports} avgConfidence={avgConfidence} />
        )}
        {activeTab === 'issues' && (
          <KnownIssuesView issues={issues} reports={reports} />
        )}
      </div>
    </div>
  );
}

/* ─── Module Graph View ─── */
function ModuleGraphView({
  graph,
  selectedNode,
  onSelectNode,
}: {
  graph: ModuleGraph;
  selectedNode: ModuleGraphNode | null;
  onSelectNode: (n: ModuleGraphNode | null) => void;
}) {
  // Group nodes by type
  const grouped = new Map<string, ModuleGraphNode[]>();
  for (const node of graph.nodes) {
    const g = grouped.get(node.type) || [];
    g.push(node);
    grouped.set(node.type, g);
  }

  return (
    <div className="flex gap-4">
      {/* Module list */}
      <div className="flex-1 space-y-2 max-h-[500px] overflow-y-auto pr-2">
        {[...grouped.entries()].map(([type, nodes]) => (
          <div key={type}>
            <div className="flex items-center gap-2 mb-1">
              <div className={`w-2.5 h-2.5 rounded-full ${NODE_TYPE_COLOR[type] || 'bg-slate-500'}`} />
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                {NODE_TYPE_LABEL[type] || type} ({nodes.length})
              </span>
            </div>
            {nodes.map(node => (
              <button
                key={node.id}
                onClick={() => onSelectNode(selectedNode?.id === node.id ? null : node)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all mb-1 ${
                  selectedNode?.id === node.id
                    ? 'bg-cyan-900/30 border border-cyan-500/50 text-cyan-300'
                    : 'bg-slate-800/50 hover:bg-slate-700/50 text-slate-300 border border-transparent'
                }`}
              >
                <div className="font-medium text-xs">{node.id}</div>
                <div className="text-xs text-slate-500 mt-0.5 line-clamp-1">{node.responsibility}</div>
                <div className="flex gap-2 mt-1 text-[10px] text-slate-500">
                  <span>{node.fileCount} 文件</span>
                  <span>{node.loc} LOC</span>
                  {node.issues.length > 0 && (
                    <span className="text-amber-400">⚠ {node.issues.length}</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Detail panel */}
      <div className="w-80 shrink-0">
        {selectedNode ? (
          <div className="bg-slate-800/80 rounded-lg border border-slate-700/50 p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className={`w-3 h-3 rounded-full ${NODE_TYPE_COLOR[selectedNode.type] || 'bg-slate-500'}`} />
              <h3 className="text-sm font-semibold text-slate-200">{selectedNode.id}</h3>
            </div>
            <p className="text-xs text-slate-400 mb-3">{selectedNode.responsibility}</p>
            <div className="text-xs text-slate-500 mb-2">📂 {selectedNode.path}</div>

            {selectedNode.publicAPI.length > 0 && (
              <div className="mb-3">
                <div className="text-[10px] font-medium text-slate-400 uppercase mb-1">Public API</div>
                <div className="flex flex-wrap gap-1">
                  {selectedNode.publicAPI.slice(0, 10).map(api => (
                    <span key={api} className="text-[10px] bg-cyan-900/30 text-cyan-400 px-1.5 py-0.5 rounded">{api}</span>
                  ))}
                  {selectedNode.publicAPI.length > 10 && (
                    <span className="text-[10px] text-slate-500">+{selectedNode.publicAPI.length - 10}</span>
                  )}
                </div>
              </div>
            )}

            {selectedNode.keyTypes.length > 0 && (
              <div className="mb-3">
                <div className="text-[10px] font-medium text-slate-400 uppercase mb-1">Key Types</div>
                <div className="flex flex-wrap gap-1">
                  {selectedNode.keyTypes.slice(0, 8).map(t => (
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
              <div>
                <div className="text-[10px] font-medium text-amber-400 uppercase mb-1">Issues</div>
                {selectedNode.issues.map((issue, i) => (
                  <div key={i} className="text-[10px] text-amber-300 bg-amber-900/20 px-2 py-1 rounded mb-1">{issue}</div>
                ))}
              </div>
            )}

            {/* Dependency connections */}
            <div className="mt-3 pt-3 border-t border-slate-700/50">
              <div className="text-[10px] font-medium text-slate-400 uppercase mb-1">依赖关系</div>
              {graph.edges
                .filter(e => e.source === selectedNode.id || e.target === selectedNode.id)
                .slice(0, 10)
                .map((edge, i) => (
                  <div key={i} className="text-[10px] text-slate-500 flex items-center gap-1 mb-0.5">
                    {edge.source === selectedNode.id ? (
                      <><span className="text-cyan-500">→</span> {edge.target}</>
                    ) : (
                      <><span className="text-emerald-500">←</span> {edge.source}</>
                    )}
                    <span className="text-slate-600">({edge.type})</span>
                  </div>
                ))}
            </div>
          </div>
        ) : (
          <div className="bg-slate-800/50 rounded-lg border border-slate-700/30 p-4 text-center">
            <div className="text-slate-500 text-sm">👈 选择一个模块查看详情</div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
              {[...grouped.entries()].map(([type, nodes]) => (
                <div key={type} className="flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full ${NODE_TYPE_COLOR[type] || 'bg-slate-500'}`} />
                  <span className="text-slate-400">{NODE_TYPE_LABEL[type] || type}: {nodes.length}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Probe Reports View ─── */
function ProbeReportsView({ reports, avgConfidence }: { reports: ProbeReport[]; avgConfidence: string }) {
  const [expandedProbe, setExpandedProbe] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-4 mb-3 text-xs text-slate-400">
        <span>平均置信度: <strong className="text-cyan-400">{avgConfidence}%</strong></span>
        <span>总耗时: <strong className="text-slate-300">{(reports.reduce((s, r) => s + r.durationMs, 0) / 1000).toFixed(1)}s</strong></span>
        <span>总 Token: <strong className="text-slate-300">{reports.reduce((s, r) => s + r.tokensUsed, 0).toLocaleString()}</strong></span>
      </div>

      {reports.map(report => (
        <div key={report.probeId} className="bg-slate-800/50 rounded-lg border border-slate-700/30">
          <button
            onClick={() => setExpandedProbe(expandedProbe === report.probeId ? null : report.probeId)}
            className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-slate-700/30 transition-colors rounded-lg"
          >
            <div className="flex items-center gap-2">
              <span>{PROBE_TYPE_ICON[report.type] || '🔎'}</span>
              <span className="text-sm font-medium text-slate-200">{report.probeId}</span>
              <span className="text-xs text-slate-500">
                {report.findings.length} 发现 · {report.filesExamined.length} 文件 · {report.rounds} 轮
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className={`${report.confidence >= 0.7 ? 'text-emerald-400' : report.confidence >= 0.4 ? 'text-amber-400' : 'text-red-400'}`}>
                {(report.confidence * 100).toFixed(0)}%
              </span>
              <span className="text-slate-500">{(report.durationMs / 1000).toFixed(1)}s</span>
              <span className="text-slate-600">{expandedProbe === report.probeId ? '▼' : '▶'}</span>
            </div>
          </button>

          {expandedProbe === report.probeId && (
            <div className="px-4 pb-3 border-t border-slate-700/30 pt-2">
              {/* Findings */}
              {report.findings.length > 0 && (
                <div className="mb-3">
                  <div className="text-[10px] font-medium text-slate-400 uppercase mb-1">发现</div>
                  {report.findings.map((f, i) => (
                    <div key={i} className="text-xs text-slate-300 bg-slate-700/30 px-2 py-1.5 rounded mb-1">
                      <span className="text-cyan-400 font-medium">{f.name}</span>
                      <span className="text-slate-500 ml-2">({f.type})</span>
                      <div className="text-slate-400 mt-0.5 line-clamp-2">{f.description}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Issues */}
              {report.issues.length > 0 && (
                <div className="mb-3">
                  <div className="text-[10px] font-medium text-amber-400 uppercase mb-1">问题</div>
                  {report.issues.map((issue, i) => (
                    <div key={i} className={`text-xs px-2 py-1 rounded mb-1 ${SEVERITY_COLOR[issue.severity] || 'text-slate-400'}`}>
                      <span className="font-medium">{issue.location}</span>: {issue.description}
                    </div>
                  ))}
                </div>
              )}

              {/* Files examined */}
              <div>
                <div className="text-[10px] font-medium text-slate-400 uppercase mb-1">检查的文件 ({report.filesExamined.length})</div>
                <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
                  {report.filesExamined.map(f => (
                    <span key={f} className="text-[10px] text-slate-500 bg-slate-700/50 px-1.5 py-0.5 rounded">{f}</span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ─── Known Issues View ─── */
function KnownIssuesView({ issues, reports }: { issues: string; reports: ProbeReport[] }) {
  // Collect all issues from probe reports
  const allIssues = reports.flatMap(r =>
    r.issues.map(i => ({ ...i, probe: r.probeId }))
  );

  // Group by severity
  const critical = allIssues.filter(i => i.severity === 'critical');
  const warnings = allIssues.filter(i => i.severity === 'warning');
  const infos = allIssues.filter(i => i.severity === 'info');

  return (
    <div className="space-y-4">
      {/* Summary counters */}
      <div className="flex gap-4 text-xs">
        {critical.length > 0 && (
          <span className="text-red-400 bg-red-900/20 px-2 py-1 rounded">
            🔴 {critical.length} 严重
          </span>
        )}
        {warnings.length > 0 && (
          <span className="text-amber-400 bg-amber-900/20 px-2 py-1 rounded">
            🟡 {warnings.length} 警告
          </span>
        )}
        {infos.length > 0 && (
          <span className="text-blue-400 bg-blue-900/20 px-2 py-1 rounded">
            🔵 {infos.length} 信息
          </span>
        )}
      </div>

      {/* Issue list grouped by severity */}
      {[
        { label: '严重问题', items: critical, color: 'border-red-500/30' },
        { label: '警告', items: warnings, color: 'border-amber-500/30' },
        { label: '信息', items: infos, color: 'border-blue-500/30' },
      ].filter(g => g.items.length > 0).map(group => (
        <div key={group.label}>
          <div className="text-xs font-medium text-slate-400 mb-2">{group.label}</div>
          {group.items.map((issue, i) => (
            <div key={i} className={`text-xs bg-slate-800/50 border-l-2 ${group.color} px-3 py-2 rounded-r-lg mb-1`}>
              <div className="flex items-center justify-between">
                <span className="text-slate-300 font-medium">{issue.location}</span>
                <span className="text-slate-600 text-[10px]">{issue.probe}</span>
              </div>
              <div className="text-slate-400 mt-0.5">{issue.description}</div>
            </div>
          ))}
        </div>
      ))}

      {/* Raw KNOWN-ISSUES.md content */}
      {issues && (
        <details className="text-xs">
          <summary className="text-slate-500 cursor-pointer hover:text-slate-400 py-1">
            📄 KNOWN-ISSUES.md 原文
          </summary>
          <pre className="mt-2 bg-slate-900/50 text-slate-400 p-3 rounded-lg whitespace-pre-wrap text-[11px] max-h-80 overflow-y-auto">
            {issues}
          </pre>
        </details>
      )}
    </div>
  );
}
