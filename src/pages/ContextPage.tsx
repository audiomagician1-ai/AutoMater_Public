/**
 * ContextPage — 上下文资产管理器 (v1.1)
 *
 * 类似游戏性能 Profiler：可视化展示每个 Agent 当前 ReAct 循环
 * 使用的上下文组成、各模块 token 占比、内容预览。
 */

import { useState, useEffect, useMemo } from 'react';
import { useAppStore } from '../stores/app-store';

// ═══════════════════════════════════════
// 颜色映射 — 每种 source 类型对应一个颜色
// ═══════════════════════════════════════
const SOURCE_COLORS: Record<string, { bg: string; bar: string; text: string; border: string }> = {
  'project-config': { bg: 'bg-violet-500/10', bar: 'bg-violet-500', text: 'text-violet-400', border: 'border-violet-500/30' },
  'architecture':   { bg: 'bg-blue-500/10',   bar: 'bg-blue-500',   text: 'text-blue-400',   border: 'border-blue-500/30' },
  'file-tree':      { bg: 'bg-emerald-500/10', bar: 'bg-emerald-500', text: 'text-emerald-400', border: 'border-emerald-500/30' },
  'repo-map':       { bg: 'bg-amber-500/10',   bar: 'bg-amber-500',   text: 'text-amber-400',   border: 'border-amber-500/30' },
  'dependency':     { bg: 'bg-cyan-500/10',    bar: 'bg-cyan-500',    text: 'text-cyan-400',    border: 'border-cyan-500/30' },
  'keyword-match':  { bg: 'bg-pink-500/10',    bar: 'bg-pink-500',    text: 'text-pink-400',    border: 'border-pink-500/30' },
  'plan':           { bg: 'bg-orange-500/10',   bar: 'bg-orange-500',  text: 'text-orange-400',  border: 'border-orange-500/30' },
  'qa-feedback':    { bg: 'bg-red-500/10',     bar: 'bg-red-500',     text: 'text-red-400',     border: 'border-red-500/30' },
};

const DEFAULT_COLOR = { bg: 'bg-slate-500/10', bar: 'bg-slate-500', text: 'text-slate-400', border: 'border-slate-500/30' };

function getColor(source: string) {
  return SOURCE_COLORS[source] ?? DEFAULT_COLOR;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatBytes(chars: number): string {
  const bytes = chars; // ~1 byte per char for ASCII, rough
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

// ═══════════════════════════════════════
// TokenBudgetBar — 堆叠条形图
// ═══════════════════════════════════════
function TokenBudgetBar({ snapshot }: { snapshot: ContextSnapshot }) {
  const usedRatio = Math.min(snapshot.totalTokens / snapshot.tokenBudget, 1);
  const isOverBudget = snapshot.totalTokens > snapshot.tokenBudget;

  return (
    <div className="space-y-2">
      {/* 标题栏 */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-400">
          Token 预算: <span className={isOverBudget ? 'text-red-400 font-bold' : 'text-slate-200'}>
            {formatTokens(snapshot.totalTokens)}
          </span>
          {' / '}
          {formatTokens(snapshot.tokenBudget)}
        </span>
        <span className={`font-mono ${isOverBudget ? 'text-red-400' : usedRatio > 0.8 ? 'text-amber-400' : 'text-emerald-400'}`}>
          {(usedRatio * 100).toFixed(0)}%
        </span>
      </div>

      {/* 堆叠条 */}
      <div className="relative h-6 bg-slate-800 rounded-full overflow-hidden border border-slate-700">
        <div className="absolute inset-0 flex">
          {snapshot.sections.map((sec, i) => {
            const width = (sec.tokens / snapshot.tokenBudget) * 100;
            if (width < 0.5) return null;
            const color = getColor(sec.source);
            return (
              <div
                key={sec.id}
                className={`${color.bar} h-full transition-all duration-500 relative group`}
                style={{ width: `${Math.min(width, 100)}%` }}
                title={`${sec.name}: ${formatTokens(sec.tokens)} tokens (${width.toFixed(1)}%)`}
              >
                {/* Hover tooltip */}
                <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 hidden group-hover:block z-50">
                  <div className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[10px] whitespace-nowrap shadow-xl">
                    <span className="font-medium">{sec.name}</span>
                    <br />
                    {formatTokens(sec.tokens)} tokens · {width.toFixed(1)}%
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {/* 预算线 */}
        {isOverBudget && (
          <div className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10" style={{ left: `${(1 / usedRatio) * 100}%` }} />
        )}
      </div>

      {/* 图例 */}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {snapshot.sections.map(sec => {
          const color = getColor(sec.source);
          return (
            <div key={sec.id} className="flex items-center gap-1 text-[10px]">
              <div className={`w-2 h-2 rounded-sm ${color.bar}`} />
              <span className="text-slate-400">{sec.name}</span>
              <span className={`${color.text} font-mono`}>{formatTokens(sec.tokens)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// ContextSectionCard — 可展开/折叠的模块卡片
// ═══════════════════════════════════════
function ContextSectionCard({ section, tokenBudget }: { section: ContextSection; tokenBudget: number }) {
  const [expanded, setExpanded] = useState(false);
  const color = getColor(section.source);
  const ratio = (section.tokens / tokenBudget * 100).toFixed(1);

  return (
    <div className={`rounded-lg border ${color.border} ${color.bg} overflow-hidden transition-all`}>
      {/* Header */}
      <button
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-white/5 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-lg">{expanded ? '▼' : '▶'}</span>
        <div className="flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${color.text}`}>{section.name}</span>
            {section.truncated && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-medium">截断</span>
            )}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {section.source} · {section.files?.length ? `${section.files.length} 文件` : '内联'}
          </div>
        </div>
        {/* 右侧统计 */}
        <div className="text-right shrink-0">
          <div className="text-xs font-mono text-slate-300">{formatTokens(section.tokens)} <span className="text-slate-500">tokens</span></div>
          <div className="text-[10px] text-slate-500">{formatBytes(section.chars)} · {ratio}%</div>
        </div>
        {/* mini bar */}
        <div className="w-16 h-2 bg-slate-800 rounded-full overflow-hidden shrink-0">
          <div className={`h-full ${color.bar} transition-all duration-300`} style={{ width: `${Math.min(parseFloat(ratio), 100)}%` }} />
        </div>
      </button>

      {/* Content */}
      {expanded && (
        <div className="border-t border-slate-800">
          {/* 文件列表 */}
          {section.files && section.files.length > 0 && (
            <div className="px-4 py-2 border-b border-slate-800/50">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">包含文件</div>
              <div className="flex flex-wrap gap-1">
                {section.files.map(f => (
                  <span key={f} className="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">{f}</span>
                ))}
              </div>
            </div>
          )}
          {/* 内容预览 */}
          <div className="px-4 py-3">
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">内容预览</div>
            <pre className="text-[11px] text-slate-400 font-mono whitespace-pre-wrap break-all max-h-96 overflow-y-auto bg-slate-900/50 rounded p-3 border border-slate-800 leading-relaxed">
              {section.content.length > 5000 ? section.content.slice(0, 5000) + '\n\n... [显示截断至 5000 字符]' : section.content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════
// ContextPage — 主页面
// ═══════════════════════════════════════
export function ContextPage() {
  const { currentProjectId, contextSnapshots } = useAppStore();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 选择第一个 agent 如果没有选中
  const agentIds = useMemo(() => [...contextSnapshots.keys()], [contextSnapshots]);
  const effectiveAgent = selectedAgent && contextSnapshots.has(selectedAgent) ? selectedAgent : agentIds[0] ?? null;
  const snapshot = effectiveAgent ? contextSnapshots.get(effectiveAgent) ?? null : null;

  // 从后端拉取缓存的快照 (补充 IPC 推送可能漏掉的)
  useEffect(() => {
    if (!currentProjectId) return;
    setLoading(true);
    window.agentforge.project.getContextSnapshots(currentProjectId).then(data => {
      const store = useAppStore.getState();
      for (const [, snap] of Object.entries(data)) {
        store.updateContextSnapshot(snap as ContextSnapshot);
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, [currentProjectId]);

  // 空状态
  if (!currentProjectId) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500">
        请先选择一个项目
      </div>
    );
  }

  if (agentIds.length === 0 && !loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-slate-500">
        <div className="text-5xl">🧠</div>
        <div className="text-lg font-medium text-slate-400">上下文资产管理器</div>
        <div className="text-sm text-center max-w-md">
          当 Agent 开始工作后，这里会实时展示每个 Agent 的上下文组成。
          <br />
          <span className="text-slate-600">就像游戏性能 Profiler 一样，帮你理解和优化 LLM 的"内存"使用。</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-800 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-slate-100">🧠 上下文资产管理器</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              实时查看每个 Agent 的上下文模块组成 · Token 占比 · 内容详情
            </p>
          </div>
          {/* 汇总统计 */}
          {snapshot && (
            <div className="flex gap-4 text-xs">
              <div className="text-center">
                <div className="text-slate-400">模块数</div>
                <div className="text-lg font-bold text-slate-200">{snapshot.sections.length}</div>
              </div>
              <div className="text-center">
                <div className="text-slate-400">总 Tokens</div>
                <div className="text-lg font-bold text-slate-200">{formatTokens(snapshot.totalTokens)}</div>
              </div>
              <div className="text-center">
                <div className="text-slate-400">文件数</div>
                <div className="text-lg font-bold text-slate-200">{snapshot.filesIncluded}</div>
              </div>
              <div className="text-center">
                <div className="text-slate-400">快照</div>
                <div className="text-sm font-mono text-slate-400">{timeAgo(snapshot.timestamp)}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Agent 选择器 */}
      {agentIds.length > 1 && (
        <div className="px-6 py-2 border-b border-slate-800 flex gap-2 shrink-0 overflow-x-auto">
          {agentIds.map(id => {
            const snap = contextSnapshots.get(id)!;
            const isActive = id === effectiveAgent;
            return (
              <button
                key={id}
                onClick={() => setSelectedAgent(id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
                  isActive
                    ? 'bg-forge-600/20 text-forge-400 border border-forge-500/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800 border border-transparent'
                }`}
              >
                <span className="mr-1.5">🤖</span>
                {id}
                <span className="ml-2 text-slate-500">
                  F:{snap.featureId} · {formatTokens(snap.totalTokens)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* 主内容区 */}
      {snapshot && (
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* Token 预算条 */}
          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-4">
            <TokenBudgetBar snapshot={snapshot} />
          </div>

          {/* Feature 信息 */}
          <div className="bg-slate-900/30 rounded-lg border border-slate-800 px-4 py-3">
            <div className="text-[10px] text-slate-500 uppercase tracking-wider">当前任务</div>
            <div className="text-sm text-slate-300 mt-1">
              <span className="font-mono text-forge-400">{snapshot.featureId}</span>
              <span className="mx-2 text-slate-600">·</span>
              Agent: <span className="font-mono text-emerald-400">{snapshot.agentId}</span>
            </div>
          </div>

          {/* 模块卡片列表 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-slate-300">上下文模块 ({snapshot.sections.length})</h2>
              <span className="text-[10px] text-slate-500">按注入顺序排列 · 点击展开查看内容</span>
            </div>
            {snapshot.sections.map(sec => (
              <ContextSectionCard key={sec.id} section={sec} tokenBudget={snapshot.tokenBudget} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}