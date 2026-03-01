import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/app-store';

export function LogsPage() {
  const { logs } = useAppStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  // 自动滚到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  return (
    <div className="h-full flex flex-col p-6 gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">实时日志</h2>
        <span className="text-sm text-slate-500">{logs.length} 条</span>
      </div>

      <div className="flex-1 bg-slate-900 border border-slate-800 rounded-xl overflow-y-auto p-4 font-mono text-sm space-y-1">
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
