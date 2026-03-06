/**
 * AgentWorkFeed — Echo 风格 Agent 工作过程面板
 *
 * v26.0: 完全重写
 * v31.0: 重构 — 渲染组件提取到 components/chat/ 共享库
 *
 * 对标 Echo 的会话展示:
 * - 思维链: 💡图标 + 首行缩略 + ▾展开全文
 * - 工具调用: 🔧图标 + 工具名卡片 + 参数摘要 + ▾展开 (fullArgs + fullOutput)
 * - edit_file: 绿增红删 diff 面板 (path + +N -N ✓)
 * - run_command/bash: 深色终端样式 ($ command + output)
 * - 输出/总结: Markdown 渲染，代码块可复制
 * - 不同内容间淡色分隔线区分
 * - 过程消息默认折叠，点击展开
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppStore, type AgentWorkMessage } from '../stores/app-store';
import { MSG_STYLES, ThinkingBlock, ToolCallCard, OutputBlock, ErrorBlock, StatusBlock } from './chat';

// v31.0: re-export MSG_STYLES for backward compatibility (MetaAgentPanel, WishPage import it)
export { MSG_STYLES } from './chat';

const EMPTY_MSGS: readonly AgentWorkMessage[] = [];

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

// v31.0: isBashTool, isEditTool, isReadTool moved to components/chat/constants.ts

// v31.0: Sub-components (ThinkingBlock, DiffBlock, BashBlock, GenericToolCard,
// ToolCallCard, OutputBlock, ErrorBlock, StatusBlock, MarkdownContent)
// moved to components/chat/ shared library.

// v31.0: OutputBlock, ErrorBlock, StatusBlock, MarkdownContent, splitMarkdown,
// pushTextParts, formatJsonSafe all moved to components/chat/

// ═══════════════════════════════════════
// AgentWorkFeed Component
// ═══════════════════════════════════════

export interface AgentWorkFeedProps {
  agentId: string;
  /** 紧凑模式 — 隐藏header/底栏 */
  compact?: boolean;
  /** 最大高度 (仅 compact 模式) */
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
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 自动滚动
  useEffect(() => {
    if (autoScroll && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [messages.length, autoScroll, activeStream?.content]);

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
    <div className="flex flex-col h-full bg-slate-950/50">
      {/* Header */}
      {!compact && (
        <div className="shrink-0 px-4 py-3 border-b border-slate-800/60 flex items-center gap-3">
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
        className="flex-1 overflow-y-auto px-5 py-4"
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

        {messages.map((msg, idx) => {
          const isExpanded = expandedIds.has(msg.id);
          const showSeparator = idx > 0 && shouldShowSeparator(messages[idx - 1], msg);

          return (
            <div key={msg.id}>
              {/* 淡色分隔线 */}
              {showSeparator && <div className="my-3 border-t border-slate-800/40" />}

              {/* 消息渲染 */}
              <div className="my-1">
                {msg.type === 'think' && (
                  <ThinkingBlock msg={msg} isExpanded={isExpanded} onToggle={() => toggleExpand(msg.id)} />
                )}
                {(msg.type === 'tool-result' || msg.type === 'tool-call') && msg.tool && (
                  <ToolCallCard msg={msg} isExpanded={isExpanded} onToggle={() => toggleExpand(msg.id)} />
                )}
                {msg.type === 'output' && <OutputBlock msg={msg} />}
                {msg.type === 'error' && <ErrorBlock msg={msg} />}
                {msg.type === 'status' && <StatusBlock msg={msg} />}
                {msg.type === 'sub-agent' && <StatusBlock msg={msg} />}
                {msg.type === 'plan' && <StatusBlock msg={msg} />}
              </div>
            </div>
          );
        })}

        {/* Streaming indicator — 实时思维链 */}
        {activeStream && (
          <div className="my-2 py-2">
            <div className="flex items-start gap-2">
              <span className="text-base leading-6 shrink-0 animate-pulse">💡</span>
              <pre className="text-[13px] text-slate-400 leading-relaxed whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                {activeStream.content.length > 2000 ? '...' + activeStream.content.slice(-2000) : activeStream.content}
                <span className="inline-block w-1.5 h-4 bg-blue-400/60 animate-pulse ml-0.5 align-text-bottom" />
              </pre>
            </div>
          </div>
        )}
      </div>

      {/* Bottom status bar */}
      {!compact && latestIter && (
        <div className="shrink-0 px-4 py-2 border-t border-slate-800/60 flex items-center gap-4 text-[11px] text-slate-500">
          <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                latestIter.totalContextTokens / (reactState?.maxContextWindow || 128000) > 0.8
                  ? 'bg-amber-500'
                  : 'bg-emerald-500/70'
              }`}
              style={{
                width: `${Math.min((latestIter.totalContextTokens / (reactState?.maxContextWindow || 128000)) * 100, 100)}%`,
              }}
            />
          </div>
          <span>
            ctx {formatTokens(latestIter.totalContextTokens)}/{formatTokens(reactState?.maxContextWindow || 128000)}
          </span>
          <span>{messages.length} 条</span>
          {!autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true);
                if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
              }}
              className="text-forge-400 hover:text-forge-300 transition-colors"
            >
              ↓ 最新
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 决定两条消息间是否需要分隔线 */
function shouldShowSeparator(prev: AgentWorkMessage, curr: AgentWorkMessage): boolean {
  // 不同类型间加分隔线
  if (prev.type !== curr.type) return true;
  // 不同迭代间加分隔线
  if (prev.iteration && curr.iteration && prev.iteration !== curr.iteration) return true;
  // 同类型但时间差 > 5s
  if (curr.timestamp - prev.timestamp > 5000) return true;
  return false;
}
