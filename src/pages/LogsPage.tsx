import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/app-store';

/** 流式输出面板 — 实时显示当前 Agent 正在输出的 token */
function StreamPanel({ agentId, label, content }: { agentId: string; label: string; content: string }) {
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [content]);

  // 只显示最后 2000 字符以保持性能
  const visible = content.length > 2000 ? '...' + content.slice(-2000) : content;
  const charCount = content.length;

  return (
    <div className="bg-slate-900/80 border border-slate-700/50 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800/60 border-b border-slate-700/30">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-xs font-medium text-forge-400">{agentId}</span>
        {label && <span className="text-xs text-slate-500">— {label}</span>}
        <span className="ml-auto text-[10px] text-slate-600">{charCount} chars</span>
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
  const { logs, activeStreams } = useAppStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  // 自动滚到底部
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs.length, autoScroll]);

  // 检测手动滚动
  const handleScroll = () => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAutoScroll(atBottom);
  };

  const streams = Array.from(activeStreams.values());

  return (
    <div className="h-full flex flex-col p-6 gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">实时日志</h2>
        <div className="flex items-center gap-3">
          {streams.length > 0 && (
            <span className="text-xs text-emerald-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              {streams.length} 路流式输出中
            </span>
          )}
          <span className="text-sm text-slate-500">{logs.length} 条</span>
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

      {/* 流式输出面板 */}
      {streams.length > 0 && (
        <div className="space-y-2 flex-shrink-0">
          {streams.map(s => (
            <StreamPanel key={s.agentId} agentId={s.agentId} label={s.label} content={s.content} />
          ))}
        </div>
      )}

      {/* 历史日志 */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 bg-slate-900 border border-slate-800 rounded-xl overflow-y-auto p-4 font-mono text-sm space-y-1"
      >
        {logs.length === 0 && (
          <div className="text-slate-600 text-center py-8">
            等待项目启动...
          </div>
        )}
        {logs.map(log => (
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
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
