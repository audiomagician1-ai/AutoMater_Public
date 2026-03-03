/**
 * AgentWorkFeed — Echo 风格 Agent 工作过程面板 (v26.0 完全重写)
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

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAppStore, type AgentWorkMessage } from '../stores/app-store';

const EMPTY_MSGS: readonly AgentWorkMessage[] = [];

// ═══════════════════════════════════════
// Constants + Styles
// ═══════════════════════════════════════

export const MSG_STYLES: Record<AgentWorkMessage['type'], { icon: string; border: string; bg: string; label: string }> =
  {
    think: { icon: '💡', border: 'border-l-blue-400', bg: '', label: '思考' },
    'tool-call': { icon: '🔧', border: 'border-l-amber-500', bg: 'bg-amber-500/5', label: '工具' },
    'tool-result': { icon: '🔧', border: '', bg: '', label: '工具' },
    output: { icon: '✅', border: 'border-l-green-500', bg: '', label: '输出' },
    status: { icon: '📌', border: '', bg: '', label: '状态' },
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

/** 判断工具是否为命令类 (bash / terminal 样式展示) */
function isBashTool(name: string): boolean {
  return ['run_command', 'run_test', 'run_lint'].includes(name);
}

/** 判断工具是否为文件编辑类 (diff 展示) */
function isEditTool(name: string): boolean {
  return ['edit_file', 'write_file', 'batch_edit'].includes(name);
}

/** 判断工具是否为读取类 (折叠展示) */
function isReadTool(name: string): boolean {
  return ['read_file', 'read_many_files', 'search_files', 'list_files', 'glob_files', 'code_graph_query'].includes(
    name,
  );
}

// ═══════════════════════════════════════
// Sub-components
// ═══════════════════════════════════════

/** 思维链消息 — Echo 风格: 💡 首行缩略 ▾ */
function ThinkingBlock({
  msg,
  isExpanded,
  onToggle,
}: {
  msg: AgentWorkMessage;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const content = msg.content || '';
  const reasoning = msg.reasoning || '';
  const displayText = reasoning || content;
  const firstLine = displayText.split('\n')[0].slice(0, 120);
  const isLong = displayText.length > 150 || displayText.includes('\n');

  return (
    <div className="py-1.5">
      {/* Collapsible header */}
      <div className="flex items-start gap-2 cursor-pointer group" onClick={onToggle}>
        <span className="text-base leading-6 shrink-0">💡</span>
        <span className={`text-[13px] leading-6 text-slate-400 ${!isExpanded && isLong ? 'truncate' : ''}`}>
          {isExpanded ? '' : firstLine}
          {!isExpanded && isLong && '...'}
        </span>
        {isLong && (
          <span className="shrink-0 text-slate-600 text-xs leading-6 group-hover:text-slate-400 transition-colors ml-1">
            {isExpanded ? '▴' : '▾'}
          </span>
        )}
      </div>
      {/* Expanded content */}
      {isExpanded && (
        <div className="mt-2 ml-7 text-sm text-slate-300 leading-relaxed whitespace-pre-wrap break-words">
          {reasoning && (
            <div className="mb-2 pl-3 border-l-2 border-blue-500/30 text-slate-400 text-xs leading-relaxed">
              {reasoning}
            </div>
          )}
          {content && <MarkdownContent text={content} />}
        </div>
      )}
    </div>
  );
}

/** 工具调用卡片 — Echo 风格: 圆角卡片 + 工具名 + 参数 + ▾展开 */
function ToolCallCard({
  msg,
  isExpanded,
  onToggle,
}: {
  msg: AgentWorkMessage;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const tool = msg.tool;
  if (!tool) return null;

  const name = tool.name;

  // edit_file / write_file → diff 展示
  if (isEditTool(name) && msg.diff) {
    return <DiffBlock msg={msg} isExpanded={isExpanded} onToggle={onToggle} />;
  }

  // run_command / bash → 终端样式
  if (isBashTool(name)) {
    return <BashBlock msg={msg} isExpanded={isExpanded} onToggle={onToggle} />;
  }

  // 其他工具 → 通用折叠卡片
  return <GenericToolCard msg={msg} isExpanded={isExpanded} onToggle={onToggle} />;
}

/** Diff 展示块 — Echo 风格: 文件路径 + 行数统计 + 绿增红删 */
function DiffBlock({
  msg,
  isExpanded,
  onToggle,
}: {
  msg: AgentWorkMessage;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const diff = msg.diff!;
  const tool = msg.tool!;

  return (
    <div className="rounded-lg border border-slate-700/50 overflow-hidden bg-slate-900/60">
      {/* Header: tool name + path + stats */}
      <div
        className="flex items-center gap-2 px-3 py-2 bg-slate-800/40 cursor-pointer hover:bg-slate-800/60 transition-colors"
        onClick={onToggle}
      >
        <span className="text-amber-400 font-semibold text-xs">{tool.name === 'write_file' ? 'write' : 'edit'}</span>
        <span className="text-slate-300 text-xs font-mono truncate flex-1">{diff.path}</span>
        <span className="text-emerald-400 text-xs font-mono">+{diff.added}</span>
        <span className="text-red-400 text-xs font-mono">-{diff.removed}</span>
        {tool.success && <span className="text-emerald-400 text-xs">✓</span>}
        {tool.success === false && <span className="text-red-400 text-xs">✗</span>}
        <span className="text-slate-600 text-xs">{isExpanded ? '▴' : '▾'}</span>
      </div>

      {/* Expanded: diff content */}
      {isExpanded && (
        <div className="font-mono text-xs leading-relaxed max-h-80 overflow-y-auto">
          {diff.oldString &&
            diff.oldString.split('\n').map((line, i) => (
              <div key={`old-${i}`} className="px-3 py-0.5 bg-red-500/10 text-red-300">
                <span className="text-red-500/60 select-none mr-2">-</span>
                {line}
              </div>
            ))}
          {diff.newString &&
            diff.newString.split('\n').map((line, i) => (
              <div key={`new-${i}`} className="px-3 py-0.5 bg-emerald-500/10 text-emerald-300">
                <span className="text-emerald-500/60 select-none mr-2">+</span>
                {line}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/** Bash / 命令行终端块 — Echo 风格 */
function BashBlock({
  msg,
  isExpanded,
  onToggle,
}: {
  msg: AgentWorkMessage;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const tool = msg.tool!;
  const command = tool.command || tool.args;
  const output = isExpanded ? tool.fullOutput || tool.outputPreview || '' : tool.outputPreview || '';
  const cwd = tool.cwd || '';

  return (
    <div className="rounded-lg overflow-hidden bg-[#1a1b26] border border-slate-700/30">
      {/* Header: bash label */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 bg-[#24253a] cursor-pointer hover:bg-[#2a2b42] transition-colors"
        onClick={onToggle}
      >
        <span className="text-slate-500 text-xs font-medium">bash</span>
        <span className="ml-auto text-slate-600 text-xs">{isExpanded ? '▴' : '▾'}</span>
      </div>
      {/* Terminal content */}
      <div className="px-3 py-2 font-mono text-xs">
        {cwd && <div className="text-slate-600 mb-1">{cwd}</div>}
        <div className="text-slate-400">
          <span className="text-amber-400">$ </span>
          <span className="text-amber-300">{command}</span>
        </div>
        {(isExpanded || output.length < 300) && output && (
          <pre className="mt-1.5 text-slate-500 whitespace-pre-wrap break-all leading-relaxed max-h-60 overflow-y-auto">
            {output || 'Command completed with no output'}
          </pre>
        )}
        {!isExpanded && output.length >= 300 && (
          <div className="mt-1 text-slate-600 text-[10px] cursor-pointer hover:text-slate-400">
            点击展开输出 ({output.length} chars) ▾
          </div>
        )}
      </div>
    </div>
  );
}

/** 通用工具调用卡片 — read_file / search_files 等 */
function GenericToolCard({
  msg,
  isExpanded,
  onToggle,
}: {
  msg: AgentWorkMessage;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const tool = msg.tool!;
  const argsDisplay = tool.args || '';

  return (
    <div className="rounded-lg border border-slate-700/40 overflow-hidden bg-slate-800/30">
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-slate-800/50 transition-colors"
        onClick={onToggle}
      >
        <span className="text-base">🔧</span>
        <span className="text-slate-200 text-sm font-medium">{tool.name}</span>
        {tool.success === true && <span className="text-emerald-400 text-xs">✓</span>}
        {tool.success === false && <span className="text-red-400 text-xs">✗</span>}
        <span className="ml-auto text-slate-600 text-xs">{isExpanded ? '▴' : '▾'}</span>
      </div>
      {/* Collapsed: args preview */}
      {!isExpanded && argsDisplay && (
        <div className="px-3 pb-2 text-xs text-slate-500 font-mono truncate">{argsDisplay}</div>
      )}
      {/* Expanded: full args + output */}
      {isExpanded && (
        <div className="border-t border-slate-700/30">
          {tool.fullArgs && (
            <div className="px-3 py-2 text-xs">
              <div className="text-slate-500 text-[10px] mb-1">调用参数</div>
              <pre className="text-slate-400 font-mono whitespace-pre-wrap break-all leading-relaxed max-h-40 overflow-y-auto">
                {formatJsonSafe(tool.fullArgs)}
              </pre>
            </div>
          )}
          {(tool.fullOutput || tool.outputPreview) && (
            <div className="px-3 py-2 border-t border-slate-700/20 text-xs">
              <div className="text-slate-500 text-[10px] mb-1">输出</div>
              <pre className="text-slate-400 font-mono whitespace-pre-wrap break-all leading-relaxed max-h-60 overflow-y-auto">
                {tool.fullOutput || tool.outputPreview || ''}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 输出 / 总结块 — Markdown 渲染 + 代码块可复制 */
function OutputBlock({ msg }: { msg: AgentWorkMessage }) {
  return (
    <div className="py-2">
      <MarkdownContent text={msg.content} />
    </div>
  );
}

/** 错误块 */
function ErrorBlock({ msg }: { msg: AgentWorkMessage }) {
  return (
    <div className="flex items-start gap-2 py-1.5 text-red-400 text-sm">
      <span className="shrink-0">⚠️</span>
      <span className="leading-relaxed">{msg.content}</span>
    </div>
  );
}

/** 状态消息 — 小字号灰色 */
function StatusBlock({ msg }: { msg: AgentWorkMessage }) {
  return <div className="py-1 text-xs text-slate-500 leading-relaxed">{msg.content}</div>;
}

// ═══════════════════════════════════════
// Markdown rendering (lightweight)
// ═══════════════════════════════════════

function MarkdownContent({ text }: { text: string }) {
  const parts = useMemo(() => splitMarkdown(text), [text]);

  return (
    <div className="text-sm text-slate-300 leading-relaxed space-y-2">
      {parts.map((part, i) => {
        if (part.type === 'code') {
          return (
            <div key={i} className="relative group">
              <div className="flex items-center justify-between px-3 py-1 bg-slate-800/80 rounded-t-lg border border-b-0 border-slate-700/40">
                <span className="text-[10px] text-slate-500 font-mono">{part.lang || 'code'}</span>
                <button
                  onClick={() => navigator.clipboard?.writeText(part.content)}
                  className="text-[10px] text-slate-600 hover:text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  复制
                </button>
              </div>
              <pre className="px-3 py-2 bg-slate-900/80 rounded-b-lg border border-t-0 border-slate-700/40 text-xs text-slate-400 font-mono whitespace-pre-wrap break-all overflow-x-auto leading-relaxed max-h-80 overflow-y-auto">
                {part.content}
              </pre>
            </div>
          );
        }
        if (part.type === 'heading') {
          return (
            <div key={i} className="font-bold text-slate-100 text-base mt-2">
              {part.content}
            </div>
          );
        }
        // plain text
        return (
          <div key={i} className="whitespace-pre-wrap break-words">
            {part.content}
          </div>
        );
      })}
    </div>
  );
}

interface MarkdownPart {
  type: 'text' | 'code' | 'heading';
  content: string;
  lang?: string;
}

function splitMarkdown(text: string): MarkdownPart[] {
  const parts: MarkdownPart[] = [];
  const codeBlockRe = /```(\w*)\n([\s\S]*?)```/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      pushTextParts(parts, text.slice(lastIdx, match.index));
    }
    parts.push({ type: 'code', content: match[2], lang: match[1] || '' });
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    pushTextParts(parts, text.slice(lastIdx));
  }
  if (parts.length === 0) parts.push({ type: 'text', content: text });
  return parts;
}

function pushTextParts(parts: MarkdownPart[], text: string) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (/^#{1,3}\s/.test(trimmed)) {
      parts.push({ type: 'heading', content: trimmed.replace(/^#{1,3}\s*/, '') });
    } else if (trimmed) {
      // merge with previous text part if exists
      const last = parts[parts.length - 1];
      if (last && last.type === 'text') {
        last.content += '\n' + trimmed;
      } else {
        parts.push({ type: 'text', content: trimmed });
      }
    }
  }
}

function formatJsonSafe(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

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
