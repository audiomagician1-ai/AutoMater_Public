/**
 * SessionPanel — Agent 会话历史面板
 *
 * 左侧: session 列表（含关联 feature 标签 + 状态徽章）
 * 右侧: 选中 session 的完整对话消息 / 实时消息流
 *
 * v19.0: 初始创建
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppStore, type AgentWorkMessage } from '../stores/app-store';
import { createLogger } from '../utils/logger';

const log = createLogger('SessionPanel');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

interface SessionListItem {
  id: string;
  projectId: string | null;
  agentId: string;
  agentRole: string;
  agentSeq: number;
  status: 'active' | 'completed' | 'archived';
  backupPath: string | null;
  createdAt: string;
  completedAt: string | null;
  messageCount: number;
  totalTokens: number;
  totalCost: number;
}

interface FeatureLink {
  id: string;
  featureId: string;
  sessionId: string;
  workType: string;
  expectedOutput: string;
  actualOutput: string | null;
  status: 'pending' | 'active' | 'completed' | 'failed';
}

interface BackupMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ function?: { name: string; arguments: string } }>;
}

// ═══════════════════════════════════════
// Constants
// ═══════════════════════════════════════

const WORK_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  'pm-analysis':      { label: 'PM 分析',   color: 'bg-blue-500/20 text-blue-400' },
  'pm-design':        { label: 'PM 设计',   color: 'bg-blue-500/20 text-blue-400' },
  'pm-incremental':   { label: '增量分析',   color: 'bg-cyan-500/20 text-cyan-400' },
  'pm-acceptance':    { label: '验收审查',   color: 'bg-indigo-500/20 text-indigo-400' },
  'architect-design': { label: '架构设计',   color: 'bg-purple-500/20 text-purple-400' },
  'dev-implement':    { label: '开发实现',   color: 'bg-emerald-500/20 text-emerald-400' },
  'dev-rework':       { label: '返工重做',   color: 'bg-amber-500/20 text-amber-400' },
  'qa-review':        { label: 'QA 审查',   color: 'bg-orange-500/20 text-orange-400' },
  'qa-tdd':           { label: 'TDD 测试',  color: 'bg-yellow-500/20 text-yellow-400' },
  'devops-build':     { label: '构建验证',   color: 'bg-rose-500/20 text-rose-400' },
  'doc-generation':   { label: '文档生成',   color: 'bg-teal-500/20 text-teal-400' },
  'meta-agent':       { label: '元Agent',   color: 'bg-violet-500/20 text-violet-400' },
};

const STATUS_BADGE: Record<string, { dot: string; text: string }> = {
  active:    { dot: 'bg-emerald-400 animate-pulse', text: 'text-emerald-400' },
  completed: { dot: 'bg-slate-500',                 text: 'text-slate-400' },
  archived:  { dot: 'bg-slate-700',                 text: 'text-slate-600' },
  pending:   { dot: 'bg-amber-400 animate-pulse',   text: 'text-amber-400' },
  failed:    { dot: 'bg-red-500',                    text: 'text-red-400' },
};

const ROLE_MSG_STYLES: Record<string, { icon: string; border: string; bg: string; label: string }> = {
  system:    { icon: '⚙️', border: 'border-l-slate-600',   bg: 'bg-slate-800/50', label: '系统' },
  user:      { icon: '👤', border: 'border-l-blue-500',    bg: 'bg-blue-500/5',   label: '用户' },
  assistant: { icon: '🤖', border: 'border-l-forge-500',   bg: 'bg-forge-500/5',  label: 'Agent' },
  tool:      { icon: '🔧', border: 'border-l-amber-500',   bg: 'bg-amber-500/5',  label: '工具' },
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ═══════════════════════════════════════
// SessionPanel Component
// ═══════════════════════════════════════

export interface SessionPanelProps {
  agentId: string;
  projectId: string;
}

export function SessionPanel({ agentId, projectId }: SessionPanelProps) {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [featureLinks, setFeatureLinks] = useState<Map<string, FeatureLink[]>>(new Map());
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [backupMessages, setBackupMessages] = useState<BackupMessage[]>([]);
  const [loadingBackup, setLoadingBackup] = useState(false);
  const [showLive, setShowLive] = useState(true); // 默认展示实时流
  const msgEndRef = useRef<HTMLDivElement>(null);

  // 实时消息 from zustand
  const liveMessages = useAppStore(s => s.agentWorkMessages.get(agentId)) ?? [];
  const activeStream = useAppStore(s => s.activeStreams.get(agentId));
  const reactState = useAppStore(s => s.agentReactStates.get(agentId));

  // ── 加载 session 列表 ──
  const loadSessions = useCallback(async () => {
    try {
      const list = await window.automater.session.list(projectId, agentId);
      setSessions(list || []);

      // 加载每个 session 的 feature 关联
      const linkMap = new Map<string, FeatureLink[]>();
      for (const sess of (list || [])) {
        try {
          const links = await window.automater.session.sessionFeatures(sess.id);
          if (links?.length) linkMap.set(sess.id, links);
        } catch { /* silent */ }
      }
      setFeatureLinks(linkMap);
    } catch (err) {
      log.error('Failed to load sessions:', err);
    }
  }, [projectId, agentId]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  // 每10秒刷新 session 列表
  useEffect(() => {
    const t = setInterval(loadSessions, 10_000);
    return () => clearInterval(t);
  }, [loadSessions]);

  // ── 选择 session → 加载备份消息 ──
  const selectSession = useCallback(async (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setShowLive(false);
    setLoadingBackup(true);
    try {
      const backup = await window.automater.session.readBackup(sessionId);
      setBackupMessages(backup?.messages || []);
    } catch (err) {
      log.error('Failed to read backup:', err);
      setBackupMessages([]);
    } finally {
      setLoadingBackup(false);
    }
  }, []);

  // ── 切换到实时流 ──
  const switchToLive = useCallback(() => {
    setSelectedSessionId(null);
    setShowLive(true);
    setBackupMessages([]);
  }, []);

  // 自动滚动
  useEffect(() => {
    if (showLive && msgEndRef.current) {
      msgEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [liveMessages.length, activeStream?.content, showLive]);

  // active session (第一个 status=active 的)
  const activeSession = sessions.find(s => s.status === 'active');

  return (
    <div className="flex h-full">
      {/* ── 左列: Session 列表 ── */}
      <div className="w-60 shrink-0 border-r border-slate-800 bg-slate-950 flex flex-col">
        <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
          <span className="text-xs font-medium text-slate-400">会话记录</span>
          <span className="text-[10px] text-slate-600">{sessions.length} 条</span>
        </div>

        {/* 实时流入口 */}
        <button
          onClick={switchToLive}
          className={`mx-2 mt-2 px-3 py-2 rounded-lg text-left text-xs transition-colors
            ${showLive
              ? 'bg-forge-600/20 border border-forge-500/40 text-forge-300'
              : 'bg-slate-900 border border-slate-800 text-slate-400 hover:border-slate-700'}`}
        >
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-medium">实时工作流</span>
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">
            {liveMessages.length} 条消息 {activeStream ? '· 输出中...' : ''}
          </div>
        </button>

        {/* Session 列表 */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sessions.map(sess => {
            const links = featureLinks.get(sess.id) || [];
            const isSelected = !showLive && selectedSessionId === sess.id;
            const badge = STATUS_BADGE[sess.status] || STATUS_BADGE.completed;
            const isActive = sess.status === 'active';

            return (
              <button
                key={sess.id}
                onClick={() => selectSession(sess.id)}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors
                  ${isSelected
                    ? 'bg-forge-600/20 border border-forge-500/40'
                    : 'bg-slate-900/50 border border-transparent hover:border-slate-700'}`}
              >
                {/* 标题行 */}
                <div className="flex items-center gap-1.5 mb-1">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${badge.dot}`} />
                  <span className={`font-medium truncate ${isActive ? 'text-slate-200' : 'text-slate-400'}`}>
                    #{sess.agentSeq}
                  </span>
                  <span className="text-[10px] text-slate-600 ml-auto shrink-0">
                    {formatTime(sess.createdAt)}
                  </span>
                </div>

                {/* Feature 关联标签 */}
                {links.length > 0 ? (
                  <div className="flex flex-wrap gap-1 mb-1">
                    {links.slice(0, 2).map(link => {
                      const wt = WORK_TYPE_LABELS[link.workType] || { label: link.workType, color: 'bg-slate-700 text-slate-300' };
                      return (
                        <span key={link.id} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${wt.color}`}>
                          {wt.label}
                          <span className="text-slate-500 truncate max-w-[60px]">{link.featureId}</span>
                        </span>
                      );
                    })}
                    {links.length > 2 && (
                      <span className="text-[10px] text-slate-600">+{links.length - 2}</span>
                    )}
                  </div>
                ) : (
                  <div className="text-[10px] text-slate-600 mb-1">无关联任务</div>
                )}

                {/* 统计 */}
                <div className="flex items-center gap-2 text-[10px] text-slate-600">
                  <span>{sess.messageCount} 消息</span>
                  {sess.totalTokens > 0 && <span>{formatTokens(sess.totalTokens)} tok</span>}
                  {sess.totalCost > 0 && <span className="text-emerald-600">${sess.totalCost.toFixed(3)}</span>}
                </div>
              </button>
            );
          })}

          {sessions.length === 0 && (
            <div className="text-center py-8 text-slate-600 text-[11px]">
              <div className="text-xl mb-2">📭</div>
              暂无历史会话
            </div>
          )}
        </div>
      </div>

      {/* ── 右列: 消息内容区 ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {showLive ? (
          <LiveMessageView
            liveMessages={liveMessages}
            activeStream={activeStream}
            reactState={reactState}
            agentId={agentId}
            msgEndRef={msgEndRef}
          />
        ) : loadingBackup ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-slate-500 text-sm animate-pulse">加载对话记录...</div>
          </div>
        ) : (
          <BackupMessageView
            messages={backupMessages}
            session={sessions.find(s => s.id === selectedSessionId) ?? null}
            featureLinks={featureLinks.get(selectedSessionId ?? '') || []}
          />
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// LiveMessageView — 实时消息流 (复用 AgentWorkFeed 逻辑)
// ═══════════════════════════════════════

const LIVE_MSG_STYLES: Record<AgentWorkMessage['type'], { icon: string; border: string; bg: string; label: string }> = {
  think:        { icon: '💭', border: 'border-l-blue-500',    bg: 'bg-blue-500/5',    label: '思考' },
  'tool-call':  { icon: '🔧', border: 'border-l-amber-500',  bg: 'bg-amber-500/5',   label: '工具' },
  'tool-result': { icon: '📦', border: 'border-l-emerald-500', bg: 'bg-emerald-500/5', label: '结果' },
  output:       { icon: '✅', border: 'border-l-green-500',   bg: 'bg-green-500/5',   label: '输出' },
  status:       { icon: '📌', border: 'border-l-slate-500',   bg: 'bg-slate-500/5',   label: '状态' },
  'sub-agent':  { icon: '🔬', border: 'border-l-violet-500',  bg: 'bg-violet-500/5',  label: '子Agent' },
  error:        { icon: '⚠️', border: 'border-l-red-500',     bg: 'bg-red-500/5',     label: '错误' },
  plan:         { icon: '📋', border: 'border-l-orange-500',  bg: 'bg-orange-500/5',  label: '计划' },
};

function LiveMessageView({
  liveMessages, activeStream, reactState, agentId, msgEndRef,
}: {
  liveMessages: readonly AgentWorkMessage[];
  activeStream: { content: string } | undefined;
  reactState: ReturnType<typeof useAppStore.getState>['agentReactStates'] extends Map<string, infer V> ? V | undefined : never;
  agentId: string;
  msgEndRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const latestIter = reactState?.iterations?.length
    ? reactState.iterations[reactState.iterations.length - 1]
    : undefined;

  return (
    <>
      {/* Header */}
      <div className="shrink-0 px-4 py-2 border-b border-slate-800 flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-sm font-medium text-slate-200">实时工作流</span>
        <span className="text-xs text-slate-500 font-mono">{agentId}</span>
        {latestIter && (
          <div className="ml-auto flex gap-3 text-[11px] text-slate-500">
            <span>迭代 <span className="text-slate-300 font-mono">{latestIter.iteration}</span></span>
            <span>Token <span className="text-slate-300 font-mono">{formatTokens(latestIter.totalContextTokens)}</span></span>
            <span>成本 <span className="text-emerald-400 font-mono">${latestIter.cumulativeCost.toFixed(4)}</span></span>
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {liveMessages.length === 0 && !activeStream && (
          <div className="text-center py-12 text-slate-600">
            <div className="text-3xl mb-2">🤖</div>
            <div className="text-xs">Agent 开始执行后，思考和操作将实时展示在这里</div>
          </div>
        )}

        {liveMessages.map(msg => {
          const style = LIVE_MSG_STYLES[msg.type] || LIVE_MSG_STYLES.status;
          const isExpanded = expandedId === msg.id;
          const isLong = msg.content.length > 200;

          return (
            <div key={msg.id}
              className={`border-l-2 ${style.border} ${style.bg} rounded-r-lg px-3 py-2 transition-colors hover:brightness-110`}
              onClick={() => isLong ? setExpandedId(isExpanded ? null : msg.id) : undefined}
            >
              <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                <span>{style.icon}</span>
                <span className="font-medium text-slate-400">{style.label}</span>
                {msg.iteration && <span className="text-slate-600">#{msg.iteration}</span>}
                <span className="ml-auto text-slate-600">{new Date(msg.timestamp).toLocaleTimeString()}</span>
              </div>
              {msg.type === 'tool-result' && msg.tool ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${msg.tool.success ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                      {msg.tool.name}
                    </span>
                    <span className="text-xs text-slate-500 truncate">{msg.tool.args}</span>
                  </div>
                  {msg.tool.outputPreview && (
                    <pre className="text-[11px] text-slate-400 font-mono whitespace-pre-wrap break-all leading-relaxed">{msg.tool.outputPreview}</pre>
                  )}
                </div>
              ) : (
                <div className={`text-sm text-slate-300 leading-relaxed ${isLong && !isExpanded ? 'line-clamp-3 cursor-pointer' : 'whitespace-pre-wrap break-all'}`}>
                  {msg.content}
                </div>
              )}
              {isLong && !isExpanded && (
                <div className="text-[10px] text-slate-600 mt-1 cursor-pointer hover:text-slate-400">点击展开 ▸</div>
              )}
            </div>
          );
        })}

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

        <div ref={msgEndRef} />
      </div>
    </>
  );
}

// ═══════════════════════════════════════
// BackupMessageView — 历史对话消息查看器
// ═══════════════════════════════════════

function BackupMessageView({
  messages, session, featureLinks,
}: {
  messages: BackupMessage[];
  session: SessionListItem | null;
  featureLinks: FeatureLink[];
}) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [showSystem, setShowSystem] = useState(false);

  const filteredMessages = showSystem ? messages : messages.filter(m => m.role !== 'system');

  return (
    <>
      {/* Header */}
      <div className="shrink-0 px-4 py-2 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-slate-200">
            会话 #{session?.agentSeq ?? '?'}
          </span>
          {session && (
            <>
              <span className={`text-[10px] px-2 py-0.5 rounded ${STATUS_BADGE[session.status]?.text || ''} bg-slate-800`}>
                {session.status === 'active' ? '进行中' : session.status === 'completed' ? '已完成' : '已归档'}
              </span>
              <span className="text-xs text-slate-500">{formatTime(session.createdAt)}</span>
              {session.completedAt && (
                <span className="text-xs text-slate-600">→ {formatTime(session.completedAt)}</span>
              )}
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1 text-[10px] text-slate-500 cursor-pointer">
              <input type="checkbox" checked={showSystem} onChange={e => setShowSystem(e.target.checked)}
                className="w-3 h-3 rounded border-slate-700 bg-slate-900 text-forge-500 focus:ring-0" />
              显示系统提示
            </label>
          </div>
        </div>

        {/* Feature 关联 */}
        {featureLinks.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {featureLinks.map(link => {
              const wt = WORK_TYPE_LABELS[link.workType] || { label: link.workType, color: 'bg-slate-700 text-slate-300' };
              const st = STATUS_BADGE[link.status] || STATUS_BADGE.completed;
              return (
                <span key={link.id} className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] ${wt.color}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                  {wt.label}
                  <span className="text-slate-400 font-mono">{link.featureId}</span>
                  {link.actualOutput && (
                    <span className="text-slate-500 max-w-[120px] truncate" title={link.actualOutput}>
                      · {link.actualOutput}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Stats bar */}
      {session && (
        <div className="shrink-0 px-4 py-1.5 border-b border-slate-800/50 flex items-center gap-4 text-[11px] text-slate-500">
          <span>📨 {session.messageCount} 消息</span>
          {session.totalTokens > 0 && <span>🔤 {formatTokens(session.totalTokens)} tokens</span>}
          {session.totalCost > 0 && <span className="text-emerald-500">💰 ${session.totalCost.toFixed(4)}</span>}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {messages.length === 0 ? (
          <div className="text-center py-12 text-slate-600">
            <div className="text-3xl mb-2">📭</div>
            <div className="text-xs">该会话尚无备份消息</div>
            <div className="text-[10px] text-slate-700 mt-1">对话完成后才会写入备份</div>
          </div>
        ) : (
          filteredMessages.map((msg, idx) => {
            const style = ROLE_MSG_STYLES[msg.role] || ROLE_MSG_STYLES.user;
            const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            const isExpanded = expandedIdx === idx;
            const isLong = contentStr.length > 400;

            return (
              <div key={idx}
                className={`border-l-2 ${style.border} ${style.bg} rounded-r-lg px-3 py-2`}
              >
                <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                  <span>{style.icon}</span>
                  <span className="font-medium text-slate-400">{style.label}</span>
                  {msg.role === 'tool' && msg.tool_call_id && (
                    <span className="text-slate-600 font-mono text-[10px]">{msg.tool_call_id}</span>
                  )}
                </div>

                {/* tool_calls 展示 */}
                {msg.tool_calls && msg.tool_calls.length > 0 && (
                  <div className="mb-2 space-y-1">
                    {msg.tool_calls.map((tc, ti) => (
                      <div key={ti} className="flex items-center gap-2 text-xs">
                        <span className="font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
                          {tc.function?.name || 'unknown'}
                        </span>
                        <span className="text-slate-500 truncate text-[10px]">
                          {truncate(tc.function?.arguments || '', 80)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Content */}
                {contentStr && (
                  <div
                    className={`text-sm text-slate-300 leading-relaxed ${isLong && !isExpanded ? 'line-clamp-4 cursor-pointer' : 'whitespace-pre-wrap break-all'}`}
                    onClick={() => isLong ? setExpandedIdx(isExpanded ? null : idx) : undefined}
                  >
                    {contentStr}
                  </div>
                )}
                {isLong && !isExpanded && (
                  <div className="text-[10px] text-slate-600 mt-1 cursor-pointer hover:text-slate-400"
                    onClick={() => setExpandedIdx(idx)}>
                    点击展开 ({contentStr.length} 字符) ▸
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}