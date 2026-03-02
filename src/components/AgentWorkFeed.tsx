/**
 * AgentWorkFeed — 对话式Agent工作细节面板 (共享组件)
 *
 * 从 TeamPage.tsx 提取为独立组件，供 TeamPage / OverviewPage 复用。
 * 展示Agent的思维链、工具调用、输出、错误等消息流。
 *
 * v6.1: 提取为独立文件
 */

import { useState, useEffect, useRef } from 'react';
import { useAppStore, type AgentWorkMessage } from '../stores/app-store';

const EMPTY_MSGS: readonly AgentWorkMessage[] = [];

// ═══════════════════════════════════════
// Constants
// ═══════════════════════════════════════

export const MSG_STYLES: Record<AgentWorkMessage['type'], { icon: string; border: string; bg: string; label: string }> =
  {
    think: { icon: '💭', border: 'border-l-blue-500', bg: 'bg-blue-500/5', label: '思考' },
    'tool-call': { icon: '🔧', border: 'border-l-amber-500', bg: 'bg-amber-500/5', label: '工具' },
    'tool-result': { icon: '📦', border: 'border-l-emerald-500', bg: 'bg-emerald-500/5', label: '结果' },
    output: { icon: '✅', border: 'border-l-green-500', bg: 'bg-green-500/5', label: '输出' },
    status: { icon: '📌', border: 'border-l-slate-500', bg: 'bg-slate-500/5', label: '状态' },
    'sub-agent': { icon: '🔬', border: 'border-l-violet-500', bg: 'bg-violet-500/5', label: '子Agent' },
    error: { icon: '⚠️', border: 'border-l-red-500', bg: 'bg-red-500/5', label: '错误' },
    plan: { icon: '📋', border: 'border-l-orange-500', bg: 'bg-orange-500/5', label: '计划' },
  };

const ROLE_INFO: Record<string, { icon: string; title: string }> = {
  pm: { icon: '🧠', title: '产品经理' },
  architect: { icon: '🏗️', title: '架构师' },
  developer: { icon: '💻', title: '开发者' },
  qa: { icon: '🧪', title: 'QA 工程师' },
  reviewer: { icon: '👁️', title: 'Reviewer' },
  devops: { icon: '🚀', title: 'DevOps' },
  meta: { icon: '🤖', title: '元Agent管家' },
};

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ═══════════════════════════════════════
// AgentWorkFeed Component
// ═══════════════════════════════════════

export interface AgentWorkFeedProps {
  agentId: string;
  /** 紧凑模式 — 隐藏header/底栏，适合嵌入到其他面板中 */
  compact?: boolean;
  /** 最大高度 (仅 compact 模式有效) */
  maxHeight?: string;
}

export function AgentWorkFeed({ agentId, compact = false, maxHeight }: AgentWorkFeedProps) {
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const compKey = currentProjectId ? `${currentProjectId}:${agentId}` : agentId;
  const messagesRaw = useAppStore(s => s.agentWorkMessages.get(compKey));
  const messages = messagesRaw ?? EMPTY_MSGS;
  const reactState = useAppStore(s => s.agentReactStates.get(compKey));
  const activeStream = useAppStore(s => s.activeStreams.get(agentId));
  const feedRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedMsgId, setExpandedMsgId] = useState<string | null>(null);

  // 自动滚动到底部
  useEffect(() => {
    if (autoScroll && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [messages.length, autoScroll, activeStream?.content]);

  // 检测手动滚动
  const handleScroll = () => {
    if (!feedRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = feedRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 60);
  };

  const latestIter = reactState?.iterations?.length
    ? reactState.iterations[reactState.iterations.length - 1]
    : undefined;

  const roleKey = agentId === 'meta-agent' ? 'meta' : agentId.split('-')[0];
  const info = ROLE_INFO[roleKey] || { icon: '🤖', title: agentId };

  return (
    <div className="flex flex-col h-full">
      {/* Header bar (full mode only) */}
      {!compact && (
        <div className="shrink-0 px-4 py-3 border-b border-slate-800 flex items-center gap-3">
          <span className="text-2xl">{info.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-slate-100 truncate">{info.title}</div>
            <div className="text-xs text-slate-500 font-mono">{agentId}</div>
          </div>
          {latestIter && (
            <div className="flex gap-3 text-xs text-slate-400">
              <span>
                迭代 <span className="text-slate-200 font-mono">{latestIter.iteration}</span>
              </span>
              <span>
                Token <span className="text-slate-200 font-mono">{formatTokens(latestIter.totalContextTokens)}</span>
              </span>
              <span>
                成本 <span className="text-emerald-400 font-mono">${latestIter.cumulativeCost.toFixed(4)}</span>
              </span>
            </div>
          )}
        </div>
      )}

      {/* Message feed */}
      <div
        ref={feedRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-2"
        style={compact && maxHeight ? { maxHeight } : undefined}
      >
        {messages.length === 0 && !activeStream && (
          <div className={`text-center text-slate-600 ${compact ? 'py-4' : 'py-12'}`}>
            <div className={compact ? 'text-lg mb-1' : 'text-3xl mb-2'}>{info.icon}</div>
            <div className="text-xs">尚无工作记录</div>
            {!compact && (
              <div className="text-xs mt-1 text-slate-700">Agent 开始执行后，思考和操作将实时展示在这里</div>
            )}
          </div>
        )}

        {messages.map(msg => {
          const style = MSG_STYLES[msg.type] || MSG_STYLES.status;
          const isExpanded = expandedMsgId === msg.id;
          const isLong = msg.content.length > 200;

          return (
            <div
              key={msg.id}
              className={`border-l-2 ${style.border} ${style.bg} rounded-r-lg px-3 py-2 transition-colors hover:brightness-110`}
              onClick={() => (isLong ? setExpandedMsgId(isExpanded ? null : msg.id) : undefined)}
            >
              <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                <span>{style.icon}</span>
                <span className="font-medium text-slate-400">{style.label}</span>
                {msg.iteration && <span className="text-slate-600">#{msg.iteration}</span>}
                <span className="ml-auto text-slate-600">{new Date(msg.timestamp).toLocaleTimeString()}</span>
              </div>

              {/* Tool call 特殊样式 */}
              {msg.type === 'tool-result' && msg.tool ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs font-mono px-1.5 py-0.5 rounded ${msg.tool.success ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}
                    >
                      {msg.tool.name}
                    </span>
                    <span className="text-xs text-slate-500 truncate">{msg.tool.args}</span>
                  </div>
                  {msg.tool.outputPreview && (
                    <pre className="text-[11px] text-slate-400 font-mono whitespace-pre-wrap break-all leading-relaxed">
                      {msg.tool.outputPreview}
                    </pre>
                  )}
                </div>
              ) : (
                <div
                  className={`text-sm text-slate-300 leading-relaxed ${isLong && !isExpanded ? 'line-clamp-3 cursor-pointer' : 'whitespace-pre-wrap break-all'}`}
                >
                  {msg.content}
                </div>
              )}
              {isLong && !isExpanded && (
                <div className="text-[10px] text-slate-600 mt-1 cursor-pointer hover:text-slate-400">点击展开 ▸</div>
              )}
            </div>
          );
        })}

        {/* Streaming indicator */}
        {activeStream && (
          <div className="border-l-2 border-l-forge-500 bg-forge-500/5 rounded-r-lg px-3 py-2">
            <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-forge-400 animate-pulse" />
              <span className="text-forge-400 font-medium">输出中...</span>
              <span className="ml-auto text-slate-600">{activeStream.content.length} chars</span>
            </div>
            <pre className="text-sm text-slate-300 font-mono whitespace-pre-wrap break-all leading-relaxed max-h-40 overflow-y-auto">
              {activeStream.content.length > 1000 ? '...' + activeStream.content.slice(-1000) : activeStream.content}
              <span className="inline-block w-1.5 h-3.5 bg-forge-400/80 animate-pulse ml-0.5 align-text-bottom" />
            </pre>
          </div>
        )}
      </div>

      {/* Bottom status bar (full mode only) */}
      {!compact && latestIter && (
        <div className="shrink-0 px-4 py-2 border-t border-slate-800 flex items-center gap-4 text-[11px] text-slate-500">
          <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                latestIter.totalContextTokens / (reactState?.maxContextWindow || 128000) > 0.8
                  ? 'bg-amber-500'
                  : 'bg-emerald-500'
              }`}
              style={{
                width: `${Math.min((latestIter.totalContextTokens / (reactState?.maxContextWindow || 128000)) * 100, 100)}%`,
              }}
            />
          </div>
          <span>
            ctx {formatTokens(latestIter.totalContextTokens)} / {formatTokens(reactState?.maxContextWindow || 128000)}
          </span>
          <span>{messages.length} 条消息</span>
          {!autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true);
                if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
              }}
              className="text-forge-400 hover:text-forge-300 transition-colors"
            >
              ↓ 回到最新
            </button>
          )}
        </div>
      )}
    </div>
  );
}
