/**
 * LogsPage — 实时日志 + 持久化历史 (v4.0)
 *
 * - 进入页面时从 DB 加载历史日志
 * - IPC 推送的实时日志追加到底部
 * - 支持按 Agent 过滤、按关键词搜索
 * - 分页加载更早日志 (Load More)
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

  // ── 滚动 ──
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  /** 从 DB 加载日志 */
  const loadLogs = useCallback(async (opts?: { offset?: number; append?: boolean }) => {
    if (!currentProjectId) return;
    setLoading(true);
    try {
      const result = await window.agentforge.project.getLogs(currentProjectId, {
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

  // 自动滚到底部
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [realtimeLogs.length, autoScroll]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAutoScroll(atBottom);
  };

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

    // 合并并按时间排序，实时日志在同一时间戳时排后面
    const all = [...dbEntries, ...rtEntries];
    all.sort((a, b) => a.timestamp - b.timestamp || (a.source === 'db' ? -1 : 1));
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
          {!autoScroll && (
            <button
              onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
              className="text-xs px-2 py-1 rounded bg-forge-600/20 text-forge-400 hover:bg-forge-600/30 transition-colors"
            >
              ↓ 回到底部
            </button>
          )}
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
          {agentIds.map(id => <option key={id} value={id}>{id}</option>)}
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

      {/* 日志列表 */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 bg-slate-900 border border-slate-800 rounded-xl overflow-y-auto p-4 font-mono text-sm"
      >
        {/* Load more */}
        {hasMore && (
          <div className="text-center mb-3">
            <button
              onClick={handleLoadMore}
              disabled={loading}
              className="text-xs px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-50"
            >
              {loading ? '加载中...' : `加载更早日志 (还有 ${totalCount - dbLogs.length} 条)`}
            </button>
          </div>
        )}

        {!initialLoaded && (
          <div className="text-slate-600 text-center py-8">加载中...</div>
        )}

        {initialLoaded && mergedLogs.length === 0 && (
          <div className="text-slate-600 text-center py-8">
            {searchText || filterAgent ? '没有匹配的日志' : '暂无日志记录'}
          </div>
        )}

        <div className="space-y-0.5">
          {mergedLogs.map(log => (
            <div key={log.id} className="flex gap-3 hover:bg-slate-800/50 rounded px-2 py-0.5 transition-colors">
              <span className="text-slate-600 text-xs whitespace-nowrap flex-shrink-0">
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              <span className="text-forge-400 text-xs whitespace-nowrap flex-shrink-0 w-16 truncate">
                {log.agentId}
              </span>
              <span className="text-slate-300 break-all">{log.content}</span>
            </div>
          ))}
        </div>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
