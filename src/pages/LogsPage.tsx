/**
 * LogsPage — 实时日志 + 持久化历史 (v5.0)
 *
 * - 进入页面时从 DB 加载历史日志
 * - IPC 推送的实时日志插入到顶部 (新日志在上)
 * - 支持按 Agent 过滤、按关键词搜索
 * - 分页加载更早 (更旧) 日志 (Load More 在底部)
 * - Agent ID 自动映射为用户设置的名字
 * - 大段日志内容自动分段显示
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useAppStore } from '../stores/app-store';

const PAGE_SIZE = 200;

interface DBLogEntry {
  id: number;
  project_id: string;
  agent_id: string;
  type: string;
  content: string;
  created_at: string;
}

/** 流式输出面板 — 实时显示当前 Agent 正在输出的 token */
function StreamPanel({ agentId, label, content }: { agentId: string; label: string; content: string }) {
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [content]);

  const visible = content.length > 2000 ? '...' + content.slice(-2000) : content;

  return (
    <div className="bg-slate-900/80 border border-slate-700/50 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800/60 border-b border-slate-700/30">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-xs font-medium text-forge-400">{agentId}</span>
        {label && <span className="text-xs text-slate-500">— {label}</span>}
        <span className="ml-auto text-[10px] text-slate-600">{content.length} chars</span>
      </div>
      <pre
        ref={ref}
        className="px-3 py-2 text-xs text-slate-400 font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto leading-relaxed"
      >
        {visible}
        <span className="inline-block w-1.5 h-3.5 bg-forge-400/80 animate-pulse ml-0.5 align-text-bottom" />
      </pre>
    </div>
  );
}

// ═══════════════════════════════════════
// Agent 名称解析 + 日志格式化
// ═══════════════════════════════════════

/** 角色前缀 → role 映射 */
const ROLE_PREFIXES: Record<string, string> = {
  'pm': 'pm',
  'arch': 'architect',
  'dev': 'developer',
  'qa': 'qa',
  'reviewer': 'reviewer',
  'devops': 'devops',
};

/** 角色 → 默认中文名称 + Emoji */
const ROLE_DEFAULTS: Record<string, string> = {
  'pm': '📋 产品经理',
  'architect': '🏗️ 架构师',
  'developer': '💻 开发者',
  'qa': '🧪 测试工程师',
  'reviewer': '🔍 代码审查',
  'devops': '🚀 DevOps',
};

/**
 * 将 agentId (如 "pm-mm7w48p4") 解析为用户友好的显示名称。
 * 优先级: 用户自定义名 > 角色默认中文名 > 内置名 > 原始ID
 */
function resolveAgentName(agentId: string, nameMap: Record<string, string>): string {
  // 1. 内置名称 (system, meta-agent)
  if (nameMap[agentId]) return nameMap[agentId];

  // 2. 从 agentId 前缀推断角色
  const prefix = agentId.split('-')[0];
  const role = ROLE_PREFIXES[prefix];
  if (role) {
    // 用户自定义名称
    if (nameMap[`role:${role}`]) return nameMap[`role:${role}`];
    // 默认角色名称
    if (ROLE_DEFAULTS[role]) return ROLE_DEFAULTS[role];
  }

  // 3. 特殊 ID 模式
  if (agentId.startsWith('pm-req-batch')) return '📋 PM子需求';
  if (agentId.startsWith('qa-spec-batch')) return '🧪 测试规格';

  return agentId;
}

/** 角色 → 标签颜色 */
function getAgentColor(agentId: string): string {
  const prefix = agentId.split('-')[0];
  switch (prefix) {
    case 'pm': return 'text-blue-400 bg-blue-500/10';
    case 'arch': return 'text-purple-400 bg-purple-500/10';
    case 'dev': return 'text-green-400 bg-green-500/10';
    case 'qa': return 'text-yellow-400 bg-yellow-500/10';
    case 'system': return 'text-slate-400 bg-slate-500/10';
    default:
      if (agentId === 'meta-agent') return 'text-cyan-400 bg-cyan-500/10';
      if (agentId === 'system') return 'text-slate-400 bg-slate-500/10';
      return 'text-forge-400 bg-forge-500/10';
  }
}

/**
 * 格式化大段日志内容 — 将连续长文本分段显示，提高可读性。
 * - JSON 块用代码样式
 * - 长文本按双换行分段
 * - Markdown 标题加粗
 */
function FormatLogContent({ content }: { content: string }) {
  // 短内容直接显示
  if (content.length < 200 && !content.includes('\n')) {
    return <span className="text-slate-300">{content}</span>;
  }

  // 检测是否是大段 JSON
  const jsonMatch = content.match(/^\s*[\[{]/);
  if (jsonMatch && content.length > 300) {
    // 截取前 500 字符做预览
    const preview = content.slice(0, 500);
    return (
      <details className="inline group">
        <summary className="cursor-pointer text-slate-400 hover:text-slate-200 transition-colors">
          <span className="text-slate-500">[JSON 数据 · {content.length} 字符]</span>
          {' '}<span className="text-xs text-slate-600 group-open:hidden">点击展开 ▸</span>
        </summary>
        <pre className="mt-1 p-2 bg-slate-800/60 rounded text-xs text-slate-400 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-all leading-relaxed">
          {content}
        </pre>
      </details>
    );
  }

  // 多段内容分段展示
  const paragraphs = content.split(/\n{2,}|\n(?=#{1,3}\s)|(?<=\n)(?=---)/);
  if (paragraphs.length <= 1) {
    // 单段但很长 — 用换行分割
    const lines = content.split('\n');
    if (lines.length <= 2) {
      return <span className="text-slate-300 break-all">{content}</span>;
    }
    return (
      <div className="text-slate-300 space-y-0.5">
        {lines.map((line, i) => {
          if (!line.trim()) return null;
          // Markdown 标题
          if (/^#{1,3}\s/.test(line)) {
            return <div key={i} className="font-semibold text-slate-200 mt-1">{line.replace(/^#+\s*/, '')}</div>;
          }
          // 列表项
          if (/^\s*[-*]\s/.test(line)) {
            return <div key={i} className="pl-3 text-slate-400">{line}</div>;
          }
          return <div key={i} className="break-all">{line}</div>;
        })}
      </div>
    );
  }

  // 多段内容
  return (
    <div className="text-slate-300 space-y-2">
      {paragraphs.map((para, i) => {
        const trimmed = para.trim();
        if (!trimmed) return null;
        if (/^#{1,3}\s/.test(trimmed)) {
          return <div key={i} className="font-semibold text-slate-200">{trimmed.replace(/^#+\s*/, '')}</div>;
        }
        if (/^```/.test(trimmed)) {
          return <pre key={i} className="p-2 bg-slate-800/60 rounded text-xs text-slate-400 overflow-x-auto whitespace-pre-wrap">{trimmed}</pre>;
        }
        return <div key={i} className="break-all leading-relaxed">{trimmed}</div>;
      })}
    </div>
  );
}

/** 单条日志行 — 格式优化版 */
function LogRow({ log, agentNameMap }: {
  log: { id: string; agentId: string; content: string; timestamp: number };
  agentNameMap: Record<string, string>;
}) {
  const displayName = resolveAgentName(log.agentId, agentNameMap);
  const colorClass = getAgentColor(log.agentId);
  const isLong = log.content.length > 300 || log.content.includes('\n');

  return (
    <div className={`flex gap-3 rounded px-2 py-1 transition-colors ${isLong ? 'flex-col bg-slate-800/30 border-l-2 border-slate-700/50 mb-1' : 'hover:bg-slate-800/50 items-start'}`}>
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-slate-600 text-xs whitespace-nowrap">
          {new Date(log.timestamp).toLocaleTimeString()}
        </span>
        <span className={`text-xs whitespace-nowrap px-1.5 py-0.5 rounded ${colorClass}`}>
          {displayName}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <FormatLogContent content={log.content} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// LogsPage Main Component
// ═══════════════════════════════════════

export function LogsPage() {
  const { logs: realtimeLogs, activeStreams, currentProjectId } = useAppStore();

  // ── 持久化日志 ──
  const [dbLogs, setDbLogs] = useState<DBLogEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);

  // ── 过滤 ──
  const [filterAgent, setFilterAgent] = useState('');
  const [keyword, setKeyword] = useState('');
  const [searchText, setSearchText] = useState('');

  // ── 滚动 (新日志在顶部，不再需要 autoScroll 到底部) ──
  const topRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── 团队成员名称映射 (agentId → display name) ──
  const [agentNameMap, setAgentNameMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!currentProjectId) return;
    window.automater.team.list(currentProjectId).then((members: any[]) => {
      const map: Record<string, string> = {};
      // 内置名称
      map['system'] = '🖥️ 系统';
      map['meta-agent'] = '🤵 管家';
      for (const m of members) {
        // team_members 的 role 会对应 orchestrator 生成的 agentId 前缀
        // 例如 role='pm' → agentId='pm-xxx', role='developer' → agentId='dev-1'
        map[`role:${m.role}`] = m.name;
      }
      setAgentNameMap(map);
    }).catch(() => {});
  }, [currentProjectId]);

  /** 从 DB 加载日志 */
  const loadLogs = useCallback(async (opts?: { offset?: number; append?: boolean }) => {
    if (!currentProjectId) return;
    setLoading(true);
    try {
      const result = await window.automater.project.getLogs(currentProjectId, {
        limit: PAGE_SIZE,
        offset: opts?.offset ?? 0,
        agentId: filterAgent || undefined,
        keyword: searchText || undefined,
      });
      if (opts?.append) {
        // 加载更早日志: 插入到头部
        setDbLogs(prev => {
          const existingIds = new Set(prev.map(l => l.id));
          const newRows = (result.rows as DBLogEntry[]).filter(r => !existingIds.has(r.id));
          return [...newRows, ...prev];
        });
      } else {
        setDbLogs(result.rows as DBLogEntry[]);
      }
      setTotalCount(result.total);
    } catch (err) {
      console.error('[LogsPage] Failed to load logs:', err);
    } finally {
      setLoading(false);
      setInitialLoaded(true);
    }
  }, [currentProjectId, filterAgent, searchText]);

  // 首次加载 + 过滤/搜索变更时重新加载
  useEffect(() => {
    setDbLogs([]);
    setInitialLoaded(false);
    loadLogs();
  }, [loadLogs]);

  // 加载更早日志
  const handleLoadMore = useCallback(() => {
    if (loading || dbLogs.length >= totalCount) return;
    loadLogs({ offset: dbLogs.length, append: true });
  }, [loading, dbLogs.length, totalCount, loadLogs]);

  // 防抖搜索
  useEffect(() => {
    const timer = setTimeout(() => setSearchText(keyword), 400);
    return () => clearTimeout(timer);
  }, [keyword]);

  // 新日志到达时确保滚动到顶部可见
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [realtimeLogs.length]);

  // 合并: DB 历史 + 实时推送 (去重 by content+agent 近似匹配)
  const mergedLogs = useMemo(() => {
    const dbEntries = dbLogs.map(l => ({
      id: `db-${l.id}`,
      agentId: l.agent_id,
      content: l.content,
      timestamp: new Date(l.created_at + 'Z').getTime(),
      source: 'db' as const,
    }));

    const rtEntries = realtimeLogs
      .filter(l => l.projectId === currentProjectId)
      .map(l => ({
        id: `rt-${l.id}`,
        agentId: l.agentId,
        content: l.content,
        timestamp: l.timestamp,
        source: 'realtime' as const,
      }));

    // 合并并按时间降序排序 (新日志在前)
    const all = [...dbEntries, ...rtEntries];
    all.sort((a, b) => b.timestamp - a.timestamp || (a.source === 'realtime' ? -1 : 1));
    return all;
  }, [dbLogs, realtimeLogs, currentProjectId]);

  // 提取 Agent 列表用于过滤
  const agentIds = useMemo(() => {
    const set = new Set<string>();
    mergedLogs.forEach(l => set.add(l.agentId));
    return [...set].sort();
  }, [mergedLogs]);

  const streams = Array.from(activeStreams.values());
  const hasMore = dbLogs.length < totalCount;

  return (
    <div className="h-full flex flex-col p-6 gap-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <h2 className="text-xl font-bold">日志</h2>
        <div className="flex items-center gap-3">
          {streams.length > 0 && (
            <span className="text-xs text-emerald-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              {streams.length} 路流式输出中
            </span>
          )}
          <span className="text-sm text-slate-500">
            {mergedLogs.length} 条{totalCount > 0 ? ` / ${totalCount} 总计` : ''}
          </span>
          <button
            onClick={() => { if (containerRef.current) containerRef.current.scrollTop = 0; }}
            className="text-xs px-2 py-1 rounded bg-forge-600/20 text-forge-400 hover:bg-forge-600/30 transition-colors"
          >
            ↑ 回到最新
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex gap-2 flex-shrink-0">
        <div className="relative flex-1 max-w-xs">
          <input
            type="text"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder="搜索日志内容..."
            className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500"
          />
          {keyword && (
            <button onClick={() => setKeyword('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs">✕</button>
          )}
        </div>
        <select
          value={filterAgent}
          onChange={e => setFilterAgent(e.target.value)}
          className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-forge-500"
        >
          <option value="">全部 Agent</option>
          {agentIds.map(id => <option key={id} value={id}>{resolveAgentName(id, agentNameMap)}</option>)}
        </select>
      </div>

      {/* 流式输出面板 */}
      {streams.length > 0 && (
        <div className="space-y-2 flex-shrink-0">
          {streams.map(s => (
            <StreamPanel key={s.agentId} agentId={s.agentId} label={s.label} content={s.content} />
          ))}
        </div>
      )}

      {/* 日志列表 (新日志在上) */}
      <div
        ref={containerRef}
        className="flex-1 bg-slate-900 border border-slate-800 rounded-xl overflow-y-auto p-4 font-mono text-sm"
      >
        <div ref={topRef} />

        {!initialLoaded && (
          <div className="text-slate-600 text-center py-8">加载中...</div>
        )}

        {initialLoaded && mergedLogs.length === 0 && (
          <div className="text-slate-600 text-center py-8">
            {searchText || filterAgent ? '没有匹配的日志' : '暂无日志记录'}
          </div>
        )}

        <div className="space-y-1">
          {mergedLogs.map(log => (
            <LogRow key={log.id} log={log} agentNameMap={agentNameMap} />
          ))}
        </div>

        {/* Load more (旧日志) — 现在在底部 */}
        {hasMore && (
          <div className="text-center mt-4">
            <button
              onClick={handleLoadMore}
              disabled={loading}
              className="text-xs px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-50"
            >
              {loading ? '加载中...' : `加载更早日志 (还有 ${totalCount - dbLogs.length} 条)`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
