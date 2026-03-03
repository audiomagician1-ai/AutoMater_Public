/**
 * WishPage v5.0 — 需求管理 + 元Agent对话
 *
 * 左侧: 需求列表 (agent自主识别迭代需求)
 * 右侧: 元Agent对话页面 — 跨项目通用管家, 默认轻量上下文
 *        用户可通过管家按需查询任何项目的设计细节和技术架构
 *        分诊新需求/迭代需求的职责由 PM 承担 (需要项目上下文)
 *
 * v20.0: 右侧对话区加入常驻会话历史列表 + session 持久化
 *
 * @module WishPage
 */

import { useState, useEffect, useCallback, useRef, useMemo, type MouseEvent as ReactMouseEvent } from 'react';
import { useAppStore, type MetaAgentMessage, type AgentWorkMessage } from '../stores/app-store';
import type { MetaSessionItem, ChatMode } from '../stores/slices/meta-agent-slice';
import { friendlyErrorMessage } from '../utils/errors';
import { MetaAgentSettings } from '../components/MetaAgentSettings';
import { toast, confirm } from '../stores/toast-store';
import { renderMarkdown } from '../utils/markdown';
import { EmptyState } from '../components/EmptyState';
import { MSG_STYLES } from '../components/AgentWorkFeed';
import { ChatInput, type ChatAttachment } from '../components/ChatInput';
import { MessageAttachments } from '../components/MessageAttachments';

// ═══════════════════════════════════════
// Constants
// ═══════════════════════════════════════

const WISH_STATUS: Record<string, { text: string; color: string; icon: string }> = {
  pending: { text: '待分析', color: 'text-slate-400', icon: '⏳' },
  analyzing: { text: 'PM 分析中', color: 'text-blue-400', icon: '🧠' },
  analyzed: { text: '已分析', color: 'text-emerald-400', icon: '✅' },
  developing: { text: '开发中', color: 'text-amber-400', icon: '🔨' },
  done: { text: '已完成', color: 'text-green-400', icon: '🎉' },
  rejected: { text: '已拒绝', color: 'text-red-400', icon: '❌' },
};

// ═══════════════════════════════════════
// Meta Agent Chat Panel — 元Agent对话区
// ═══════════════════════════════════════

const GREETING: MetaAgentMessage = {
  id: 'greeting',
  role: 'assistant',
  content:
    '你好！我是元Agent管家，你的一站式项目助手。你可以：\n• 直接告诉我你的需求想法，我会自动创建并启动开发\n• 查询任何项目的设计文档、技术架构、进度状态\n• 调整工作流程、查看团队配置\n有什么需要？',
  timestamp: Date.now(),
};

const META_AGENT_ID = 'meta-agent';

const CHAT_MODE_INFO: Record<ChatMode, { icon: string; label: string; desc: string; color: string }> = {
  work: { icon: '🔧', label: '工作', desc: '指挥调度 · 派发任务给团队', color: 'text-amber-400' },
  chat: { icon: '💬', label: '闲聊', desc: '自由对话 · 不触发工作流', color: 'text-blue-400' },
  deep: { icon: '🔬', label: '深度', desc: '深入分析 · 可输出文件/派发任务', color: 'text-purple-400' },
  admin: { icon: '🛠️', label: '管理', desc: '修改团队/工作流/项目配置', color: 'text-rose-400' },
};

function formatSessionTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ═══════════════════════════════════════
// ModeSwitchBadge — 会话模式切换徽章
// ═══════════════════════════════════════

function ModeSwitchBadge({
  sessionId,
  currentMode,
  onRefresh,
}: {
  sessionId: string;
  currentMode: ChatMode;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [hoveredMode, setHoveredMode] = useState<ChatMode | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const info = CHAT_MODE_INFO[currentMode];

  // 关闭 popover 当点击外部
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSwitch = async (mode: ChatMode) => {
    if (mode === currentMode) {
      setOpen(false);
      return;
    }
    try {
      // 更新 DB 中的 session chat_mode
      await window.automater.session.updateChatMode(sessionId, mode);
      onRefresh();
    } catch {
      /* silent */
    }
    setOpen(false);
  };

  const handleToggle = (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setPopoverPos({ top: rect.bottom + 4, left: rect.right });
    }
    setOpen(!open);
  };

  return (
    <div className="relative shrink-0" ref={ref}>
      {/* 模式图标按钮 — 更大、可点击 */}
      <button
        onClick={handleToggle}
        className={`w-6 h-6 rounded-md flex items-center justify-center text-sm hover:bg-slate-700/60 transition-all ${info.color}`}
        title={`${info.label}模式 · 点击切换`}
      >
        {info.icon}
      </button>

      {/* 使用 fixed 定位避免被 overflow 容器裁剪 */}
      {open && popoverPos && (
        <div
          className="fixed z-[60] flex items-stretch bg-slate-900 border border-slate-700 rounded-xl shadow-2xl shadow-black/50 overflow-hidden"
          style={{ top: popoverPos.top, left: popoverPos.left, transform: 'translateX(-100%)' }}
          onClick={e => e.stopPropagation()}
        >
          {(['work', 'chat', 'deep', 'admin'] as ChatMode[]).map(m => {
            const mi = CHAT_MODE_INFO[m];
            const isActive = m === currentMode;
            return (
              <button
                key={m}
                onClick={() => handleSwitch(m)}
                onMouseEnter={() => setHoveredMode(m)}
                onMouseLeave={() => setHoveredMode(null)}
                className={`relative flex flex-col items-center gap-1 px-3.5 py-2.5 transition-all min-w-[56px]
                  ${
                    isActive
                      ? 'bg-forge-600/20 border-b-2 border-forge-500'
                      : 'hover:bg-slate-800/80 border-b-2 border-transparent'
                  }`}
              >
                <span className="text-base">{mi.icon}</span>
                <span
                  className={`text-[10px] font-medium whitespace-nowrap ${isActive ? 'text-forge-400' : 'text-slate-400'}`}
                >
                  {mi.label}
                </span>
              </button>
            );
          })}
          {/* 悬停说明浮层 */}
          {hoveredMode && (
            <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 px-3 py-1 bg-slate-800 border border-slate-700 rounded-lg text-[10px] text-slate-300 whitespace-nowrap shadow-xl pointer-events-none z-[61]">
              {CHAT_MODE_INFO[hoveredMode].desc}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════
// SessionListPanel — 会话历史列表 (常驻在许愿页)
// ═══════════════════════════════════════

function SessionListPanel() {
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const sessionList = useAppStore(s => s.metaSessionList);
  const setSessionList = useAppStore(s => s.setMetaSessionList);
  const currentSessionId = useAppStore(s => s.currentMetaSessionId);
  const setCurrentSessionId = useAppStore(s => s.setCurrentMetaSessionId);
  const setMessages = useAppStore(s => s.setMetaAgentMessages);
  const messagesMap = useAppStore(s => s.metaAgentMessages);
  const [loading, setLoading] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      // v27.0: 始终加载全部会话(含隐藏)，前端按 showHidden 过滤
      const list = await window.automater.metaAgent.listChatSessions(currentProjectId, undefined, true);
      setSessionList((list || []).map(s => ({ ...s, title: s.title ?? undefined })) as MetaSessionItem[]);
    } catch {
      /* silent */
    }
    setLoading(false);
  }, [currentProjectId, setSessionList]);

  useEffect(() => {
    loadSessions();
  }, [currentProjectId]);
  useEffect(() => {
    const t = setInterval(loadSessions, 15_000);
    return () => clearInterval(t);
  }, [loadSessions]);

  const handleSelect = useCallback(
    async (sessId: string) => {
      setCurrentSessionId(sessId);
      if (messagesMap.has(sessId) && (messagesMap.get(sessId)?.length ?? 0) > 0) return;
      try {
        const rows = await window.automater.metaAgent.loadMessages(sessId);
        if (rows?.length) {
          setMessages(
            sessId,
            rows.map(r => ({
              id: r.id,
              role: r.role as 'user' | 'assistant',
              content: r.content,
              timestamp: new Date(r.createdAt).getTime(),
              triggeredWish: r.triggeredWish || undefined,
              attachments: r.attachments?.map(a => ({ ...a, type: a.type as 'image' | 'file' })) || undefined,
            })),
          );
        }
      } catch {
        /* silent */
      }
    },
    [messagesMap, setCurrentSessionId, setMessages],
  );

  // ── 右键菜单 ──
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; sessId: string } | null>(null);
  const handleCtx = (e: ReactMouseEvent, sessId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, sessId });
  };
  const closeCtx = () => setCtxMenu(null);

  // ── v27.0: 置顶 / 重命名 / 隐藏 ──
  const [showHidden, setShowHidden] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ sessId: string; current: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const handleTogglePin = async () => {
    if (!ctxMenu) return;
    try {
      await window.automater.session.togglePin(ctxMenu.sessId);
      await loadSessions();
    } catch {
      /* silent */
    }
    closeCtx();
  };

  const handleStartRename = () => {
    if (!ctxMenu) return;
    const sess = sessionList.find(s => s.id === ctxMenu.sessId);
    if (!sess) return;
    const current = sess.customTitle || sess.title || `会话 #${sess.agentSeq}`;
    setRenameTarget({ sessId: ctxMenu.sessId, current });
    setRenameValue(current);
    closeCtx();
  };

  const handleConfirmRename = async () => {
    if (!renameTarget) return;
    try {
      await window.automater.session.rename(renameTarget.sessId, renameValue.trim() || null);
      await loadSessions();
    } catch {
      /* silent */
    }
    setRenameTarget(null);
  };

  const handleToggleHidden = async () => {
    if (!ctxMenu) return;
    try {
      await window.automater.session.toggleHidden(ctxMenu.sessId);
      await loadSessions();
    } catch {
      /* silent */
    }
    closeCtx();
  };

  const handleCopyAll = async () => {
    if (!ctxMenu) return;
    try {
      const rows = await window.automater.metaAgent.loadMessages(ctxMenu.sessId);
      const text = (rows || []).map(r => `[${r.role}] ${r.content}`).join('\n\n');
      await navigator.clipboard.writeText(text);
    } catch {
      /* silent */
    }
    closeCtx();
  };
  const handleCopyConclusions = async () => {
    if (!ctxMenu) return;
    try {
      const rows = await window.automater.metaAgent.loadMessages(ctxMenu.sessId);
      const conclusions = (rows || [])
        .filter(r => r.role === 'assistant')
        .map(r => r.content)
        .filter(c => c.length > 20);
      const last3 = conclusions.slice(-3);
      await navigator.clipboard.writeText(last3.join('\n\n---\n\n'));
    } catch {
      /* silent */
    }
    closeCtx();
  };
  const handleOpenFolder = async () => {
    if (!ctxMenu) return;
    try {
      await window.automater.session.openBackupFolder(ctxMenu.sessId);
    } catch {
      /* silent */
    }
    closeCtx();
  };

  return (
    <div className="w-56 shrink-0 border-r border-slate-800 flex flex-col bg-slate-950/60" onClick={closeCtx}>
      {/* 右键菜单 */}
      {ctxMenu && (
        <div
          className="fixed z-[60] w-44 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl py-1 text-[11px]"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          {/* 置顶/取消置顶 */}
          <button
            onClick={handleTogglePin}
            className="w-full text-left px-3 py-1.5 text-slate-300 hover:bg-slate-800 transition-colors flex items-center gap-2"
          >
            <span>{sessionList.find(s => s.id === ctxMenu.sessId)?.pinned ? '📌' : '📌'}</span>
            {sessionList.find(s => s.id === ctxMenu.sessId)?.pinned ? '取消置顶' : '置顶'}
          </button>
          {/* 重命名 */}
          <button
            onClick={handleStartRename}
            className="w-full text-left px-3 py-1.5 text-slate-300 hover:bg-slate-800 transition-colors flex items-center gap-2"
          >
            <span>✏️</span>重命名
          </button>
          {/* 隐藏/取消隐藏 */}
          <button
            onClick={handleToggleHidden}
            className="w-full text-left px-3 py-1.5 text-slate-300 hover:bg-slate-800 transition-colors flex items-center gap-2"
          >
            <span>{sessionList.find(s => s.id === ctxMenu.sessId)?.hidden ? '👁️' : '🙈'}</span>
            {sessionList.find(s => s.id === ctxMenu.sessId)?.hidden ? '取消隐藏' : '隐藏'}
          </button>
          <div className="border-t border-slate-800 my-0.5" />
          <button
            onClick={handleCopyAll}
            className="w-full text-left px-3 py-1.5 text-slate-300 hover:bg-slate-800 transition-colors flex items-center gap-2"
          >
            <span>📋</span>复制全部
          </button>
          <button
            onClick={handleCopyConclusions}
            className="w-full text-left px-3 py-1.5 text-slate-300 hover:bg-slate-800 transition-colors flex items-center gap-2"
          >
            <span>💡</span>复制关键结论
          </button>
          <div className="border-t border-slate-800 my-0.5" />
          <button
            onClick={handleOpenFolder}
            className="w-full text-left px-3 py-1.5 text-slate-300 hover:bg-slate-800 transition-colors flex items-center gap-2"
          >
            <span>📁</span>跳转至所在文件夹
          </button>
        </div>
      )}

      {/* 重命名弹窗 */}
      {renameTarget && (
        <>
          <div className="fixed inset-0 z-[70]" onClick={() => setRenameTarget(null)} />
          <div className="fixed z-[71] top-1/3 left-1/2 -translate-x-1/2 w-72 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-4">
            <div className="text-xs font-medium text-slate-300 mb-2">重命名会话</div>
            <input
              autoFocus
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleConfirmRename();
                if (e.key === 'Escape') setRenameTarget(null);
              }}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-forge-500 transition-colors"
              placeholder="输入新名称，留空恢复默认"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setRenameTarget(null)}
                className="text-[10px] px-3 py-1 rounded-md text-slate-400 hover:bg-slate-800 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleConfirmRename}
                className="text-[10px] px-3 py-1 rounded-md bg-forge-600/30 text-forge-400 hover:bg-forge-600/50 transition-colors"
              >
                确认
              </button>
            </div>
          </div>
        </>
      )}

      {/* Header */}
      <div className="px-3 py-2.5 border-b border-slate-800 flex items-center gap-2">
        <span className="text-xs font-medium text-slate-400 flex-1">会话历史</span>
        <div className="relative">
          <button
            onClick={() => setNewChatOpen(!newChatOpen)}
            className="text-[10px] px-2 py-0.5 rounded-md bg-forge-600/20 text-forge-400 hover:bg-forge-600/30 transition-colors"
          >
            + 新对话
          </button>
          {newChatOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setNewChatOpen(false)} />
              <div className="absolute right-0 top-7 z-50 w-48 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl py-1">
                {(['work', 'chat', 'deep', 'admin'] as ChatMode[]).map(m => {
                  const info = CHAT_MODE_INFO[m];
                  return (
                    <button
                      key={m}
                      onClick={() => {
                        setCurrentSessionId(null);
                        // Store the desired mode for next session creation
                        (window as unknown as Record<string, unknown>).__nextChatMode = m;
                        // Notify MetaAgentChat to update pendingMode
                        window.dispatchEvent(new CustomEvent('meta-agent:mode-change', { detail: m }));
                        setNewChatOpen(false);
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-slate-800 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span>{info.icon}</span>
                        <span className={`text-xs font-medium ${info.color}`}>{info.label}模式</span>
                      </div>
                      <div className="text-[9px] text-slate-500 ml-6">{info.desc}</div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Session 列表 */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
        {loading && sessionList.length === 0 && (
          <div className="text-center py-8 text-slate-600 text-[10px] animate-pulse">加载中...</div>
        )}

        {sessionList
          .filter(sess => showHidden || !sess.hidden)
          .map(sess => {
            const isSelected = currentSessionId === sess.id;
            const title = sess.customTitle || sess.title || `会话 #${sess.agentSeq}`;
            const isActive = sess.status === 'active';

            return (
              <div
                key={sess.id}
                onClick={() => handleSelect(sess.id)}
                onContextMenu={e => handleCtx(e, sess.id)}
                className={`w-full text-left px-2.5 py-2 rounded-lg text-[11px] transition-colors group cursor-pointer
                ${
                  isSelected
                    ? 'bg-forge-600/15 border border-forge-500/30 text-slate-200'
                    : 'border border-transparent hover:bg-slate-900/80 hover:border-slate-800 text-slate-400'
                }
                ${sess.hidden ? 'opacity-50' : ''}`}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  {sess.pinned && (
                    <span className="text-[9px] shrink-0" title="已置顶">
                      📌
                    </span>
                  )}
                  {isActive && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />}
                  <span className="truncate font-medium flex-1">{title}</span>
                  {sess.hidden && (
                    <span className="text-[8px] shrink-0 opacity-60" title="已隐藏">
                      🙈
                    </span>
                  )}
                  <ModeSwitchBadge sessionId={sess.id} currentMode={sess.chatMode || 'work'} onRefresh={loadSessions} />
                </div>
                <div className="flex items-center gap-1.5 text-[9px] text-slate-600">
                  <span>{formatSessionTime(sess.createdAt)}</span>
                  {sess.totalTokens > 0 && <span>{formatTokens(sess.totalTokens)}</span>}
                  {sess.totalCost > 0 && <span className="text-emerald-700">${sess.totalCost.toFixed(3)}</span>}
                </div>
              </div>
            );
          })}

        {!loading && sessionList.length === 0 && (
          <div className="text-center py-8 text-slate-600 text-[10px]">
            <div className="text-lg mb-1.5">💬</div>
            暂无历史会话
            <br />
            <span className="text-slate-700">在右侧对话即可自动创建</span>
          </div>
        )}
      </div>

      {/* 底部: 统计 + 显示隐藏开关 */}
      {sessionList.length > 0 && (
        <div className="px-2.5 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 flex items-center justify-between">
          <span>
            共 {sessionList.filter(s => !s.hidden).length} 个会话
            {sessionList.some(s => s.hidden) ? ` (${sessionList.filter(s => s.hidden).length} 隐藏)` : ''}
          </span>
          {sessionList.some(s => s.hidden) && (
            <button
              onClick={() => setShowHidden(prev => !prev)}
              className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${
                showHidden ? 'text-forge-400 bg-forge-600/15' : 'text-slate-600 hover:text-slate-400'
              }`}
            >
              {showHidden ? '隐藏已隐藏' : '显示已隐藏'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════
// InlineWorkMessage — 思维过程/工具调用内联卡片 (复用 AgentWorkFeed 样式)
// ═══════════════════════════════════════

const EMPTY_WORK_MSGS: readonly AgentWorkMessage[] = [];

function InlineWorkMessage({ msg }: { msg: AgentWorkMessage }) {
  const style = MSG_STYLES[msg.type] || MSG_STYLES.status;
  const [expanded, setExpanded] = useState(false);
  const isLong = msg.content.length > 300;
  return (
    <div className={`border-l-2 ${style.border} ${style.bg} rounded-r-lg px-2.5 py-1.5 transition-colors`}>
      <div className="flex items-center gap-1.5 text-[10px] text-slate-500 mb-0.5">
        <span>{style.icon}</span>
        <span className="font-medium text-slate-400">{style.label}</span>
        {msg.iteration && <span className="text-slate-600">#{msg.iteration}</span>}
        <span className="ml-auto text-slate-700">
          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </div>
      {msg.type === 'tool-result' && msg.tool ? (
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className={`text-[10px] font-mono px-1 py-0.5 rounded ${msg.tool.success ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}
            >
              {msg.tool.name}
            </span>
            <span className="text-[10px] text-slate-500 truncate max-w-[300px]">{msg.tool.args}</span>
          </div>
          {msg.tool.outputPreview && (
            <pre className="text-[10px] text-slate-400 font-mono whitespace-pre-wrap break-all leading-relaxed max-h-32 overflow-y-auto">
              {msg.tool.outputPreview}
            </pre>
          )}
        </div>
      ) : (
        <div
          className={`text-[11px] text-slate-300 leading-relaxed ${isLong && !expanded ? 'line-clamp-4 cursor-pointer' : 'whitespace-pre-wrap break-all'}`}
          onClick={() => isLong && setExpanded(!expanded)}
        >
          {msg.content}
        </div>
      )}
      {isLong && !expanded && (
        <div
          className="text-[9px] text-slate-600 mt-0.5 cursor-pointer hover:text-slate-400"
          onClick={() => setExpanded(true)}
        >
          点击展开 ▸
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════
// MetaAgentChat — 对话区 (含会话持久化)
// ═══════════════════════════════════════

function MetaAgentChat({ compact = false }: { compact?: boolean }) {
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const messagesMap = useAppStore(s => s.metaAgentMessages);
  const addMessage = useAppStore(s => s.addMetaAgentMessage);
  const updateLastAssistant = useAppStore(s => s.updateLastAssistantMessage);
  const attachWorkMsgs = useAppStore(s => s.attachWorkMessagesToLast);
  const currentSessionId = useAppStore(s => s.currentMetaSessionId);
  const setCurrentSessionId = useAppStore(s => s.setCurrentMetaSessionId);
  const sessionList = useAppStore(s => s.metaSessionList);

  const chatKey = currentSessionId || currentProjectId || '_global';
  const messages = messagesMap.get(chatKey) || [];

  // v26.0: 全局开关 — 显示工作过程细节
  const [showWorkDetails, setShowWorkDetails] = useState(false);

  // ── 模式管理 ──
  // pendingMode: 无 session 时本地保持的待定模式 (React state → 即时刷新 UI)
  const [pendingMode, setPendingMode] = useState<ChatMode>(
    ((window as unknown as Record<string, unknown>).__nextChatMode as ChatMode) || 'work',
  );

  // 当前 session 的模式
  const currentChatMode: ChatMode = useMemo(() => {
    if (currentSessionId) {
      const sess = sessionList.find(s => s.id === currentSessionId);
      if (sess?.chatMode) return sess.chatMode;
    }
    // 新对话: 使用本地 pendingMode (同步到 window.__nextChatMode)
    return pendingMode;
  }, [currentSessionId, sessionList, pendingMode]);

  // 模式切换弹出框
  const [modePopoverOpen, setModePopoverOpen] = useState(false);
  const modePopoverRef = useRef<HTMLDivElement>(null);

  // 关闭 popover 当点击外部
  useEffect(() => {
    if (!modePopoverOpen) return;
    const handler = (e: MouseEvent) => {
      if (modePopoverRef.current && !modePopoverRef.current.contains(e.target as Node)) setModePopoverOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modePopoverOpen]);

  const handleModeSwitch = async (mode: ChatMode) => {
    if (mode === currentChatMode) {
      setModePopoverOpen(false);
      return;
    }
    if (currentSessionId) {
      // 已有 session → 更新 DB
      try {
        await window.automater.session.updateChatMode(currentSessionId, mode);
        // 刷新 session 列表以反映新模式
        const list = await window.automater.metaAgent.listChatSessions(currentProjectId);
        if (list) {
          useAppStore
            .getState()
            .setMetaSessionList((list || []).map(s => ({ ...s, title: s.title ?? undefined })) as MetaSessionItem[]);
        }
      } catch {
        /* silent */
      }
    } else {
      // 无 session → 更新本地 pendingMode + window 临时变量
      setPendingMode(mode);
      (window as unknown as Record<string, unknown>).__nextChatMode = mode;
    }
    setModePopoverOpen(false);
  };

  const [sending, setSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentName, setAgentName] = useState('元Agent · 项目管家');
  const [greetingText, setGreetingText] = useState(GREETING.content);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // 思维过程 (工作消息)
  const metaCK = currentProjectId ? currentProjectId + ':meta-agent' : 'meta-agent';
  const metaAgentWorkMsgsRaw = useAppStore(s => s.agentWorkMessages.get(metaCK));
  const metaAgentWorkMsgs = metaAgentWorkMsgsRaw ?? EMPTY_WORK_MSGS;
  const sendingStartMsgIndexRef = useRef(0);

  // Load config for dynamic name + greeting
  useEffect(() => {
    window.automater.metaAgent
      .getConfig()
      .then((config: MetaAgentConfig) => {
        if (config.name) setAgentName(config.name);
        if (config.greeting) setGreetingText(config.greeting);
      })
      .catch(() => {});
  }, [settingsOpen]);

  // 监听 SessionListPanel 的新对话模式选择
  useEffect(() => {
    const handler = (e: Event) => {
      const mode = (e as CustomEvent).detail as ChatMode;
      if (mode) setPendingMode(mode);
    };
    window.addEventListener('meta-agent:mode-change', handler);
    return () => window.removeEventListener('meta-agent:mode-change', handler);
  }, []);

  // 切换项目时恢复最近活跃会话
  useEffect(() => {
    // 不再无条件清除 sessionId — 仅当项目变化时才重置
    const _prevProjectId = useAppStore.getState().currentMetaSessionId
      ? undefined // 有活跃 session 时不轻易清除
      : null;

    (async () => {
      try {
        const sessions = await window.automater.metaAgent.listChatSessions(currentProjectId, 1);
        if (sessions?.length) {
          const latest = sessions[0];
          if (latest.status === 'active') {
            // 如果已经是当前 session 且 zustand 中有消息，跳过重新加载
            if (
              currentSessionId === latest.id &&
              messagesMap.has(latest.id) &&
              (messagesMap.get(latest.id)?.length || 0) > 0
            ) {
              return;
            }
            const rows = await window.automater.metaAgent.loadMessages(latest.id);
            if (rows?.length) {
              useAppStore.getState().setMetaAgentMessages(
                latest.id,
                rows.map(r => ({
                  id: r.id,
                  role: r.role as 'user' | 'assistant',
                  content: r.content,
                  timestamp: new Date(r.createdAt).getTime(),
                  triggeredWish: r.triggeredWish || undefined,
                  attachments: r.attachments?.map(a => ({ ...a, type: a.type as 'image' | 'file' })) || undefined,
                })),
              );
              setCurrentSessionId(latest.id);
              return;
            }
          }
        }
        // 没有活跃 session 时才清除
        if (currentSessionId) setCurrentSessionId(null);
      } catch {
        // DB 查询失败时保持现状
      }
    })();
  }, [currentProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for daemon messages
  useEffect(() => {
    const unsub = window.automater.on(
      'meta-agent:daemon-message',
      (data: { type: string; reply: string; timestamp?: string }) => {
        const typeLabel = data.type === 'heartbeat' ? '💓 心跳' : data.type === 'hook' ? '🪝 事件' : '⏰ 定时';
        const daemonMsg: MetaAgentMessage = {
          id: `daemon-${Date.now()}`,
          role: 'assistant',
          content: `[${typeLabel}] ${data.reply}`,
          timestamp: Number(data.timestamp) || Date.now(),
        };
        addMessage(chatKey, daemonMsg);
      },
    );
    return unsub;
  }, [chatKey, addMessage]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, metaAgentWorkMsgs.length]);

  const handleSend = async (inputText: string, inputAttachments: ChatAttachment[]) => {
    if ((!inputText.trim() && inputAttachments.length === 0) || sending) return;

    // 新对话时创建 session (含 chatMode)
    let sessionId = currentSessionId;
    if (!sessionId) {
      try {
        const modeForNew = currentChatMode;
        const newSession = await window.automater.session.create(
          currentProjectId,
          META_AGENT_ID,
          'meta-agent',
          modeForNew,
        );
        sessionId = newSession.id;
        setCurrentSessionId(sessionId);
        // 清除临时变量
        delete (window as unknown as Record<string, unknown>).__nextChatMode;
      } catch {
        sessionId = null;
      }
    }

    const activeChatKey = sessionId || currentProjectId || '_global';

    // v28.0: 将 ChatInput attachments 转换为 MetaAgentMessage 格式
    const msgAttachments =
      inputAttachments.length > 0
        ? inputAttachments.map(a => ({ type: a.type, name: a.name, data: a.data, mimeType: a.mimeType }))
        : undefined;

    const userMsg: MetaAgentMessage = {
      id: String(Date.now()),
      role: 'user',
      content: inputText.trim(),
      timestamp: Date.now(),
      attachments: msgAttachments,
    };
    addMessage(activeChatKey, userMsg);
    setSending(true);
    sendingStartMsgIndexRef.current = metaAgentWorkMsgs.length;

    // 持久化 user 消息 (含附件 JSON)
    if (sessionId) {
      window.automater.metaAgent
        .saveMessage({
          id: userMsg.id,
          sessionId,
          projectId: currentProjectId,
          role: 'user',
          content: userMsg.content,
          attachments: msgAttachments ? JSON.stringify(msgAttachments) : undefined,
        })
        .catch(() => {});
    }

    // Placeholder
    const assistantMsgId = String(Date.now() + 1);
    const placeholderMsg: MetaAgentMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '思考中...',
      timestamp: Date.now(),
    };
    addMessage(activeChatKey, placeholderMsg);

    try {
      const history = (messagesMap.get(activeChatKey) || []).slice(-20).map(m => ({
        role: m.role as string,
        content: m.content,
      }));

      const result = await window.automater.metaAgent.chat(
        currentProjectId,
        userMsg.content,
        history,
        msgAttachments, // v28.0: 传递附件
        currentChatMode,
        sessionId, // v25.0: 传递 sessionId 避免后端重复创建
      );

      updateLastAssistant(activeChatKey, result.reply);

      // 持久化 assistant 回复
      if (sessionId) {
        window.automater.metaAgent
          .saveMessage({
            id: assistantMsgId,
            sessionId,
            projectId: currentProjectId,
            role: 'assistant',
            content: result.reply,
            triggeredWish: result.wishCreated,
          })
          .catch(() => {});
      }

      if (result.wishCreated) {
        window.dispatchEvent(new CustomEvent('meta-agent:wish-created'));
      }
    } catch (err: unknown) {
      const errContent = `❌ 请求失败: ${friendlyErrorMessage(err) || '未知错误'}。请检查 LLM 设置。`;
      updateLastAssistant(activeChatKey, errContent);
      if (sessionId) {
        window.automater.metaAgent
          .saveMessage({
            id: assistantMsgId,
            sessionId,
            projectId: currentProjectId,
            role: 'assistant',
            content: errContent,
          })
          .catch(() => {});
      }
    } finally {
      setSending(false);
    }
  };

  const dynamicGreeting: MetaAgentMessage = { ...GREETING, content: greetingText };
  const displayMessages = messages.length === 0 ? [dynamicGreeting] : messages;
  const modeInfo = CHAT_MODE_INFO[currentChatMode];

  return (
    <div className="flex h-full">
      {/* 左侧: 会话历史列表 (仅在非 compact 模式) */}
      {!compact && <SessionListPanel />}

      {/* 右侧: 对话区 */}
      <div className="flex-1 flex flex-col min-w-0">
        {!compact && (
          <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-forge-500 to-indigo-600 flex items-center justify-center text-sm">
              🤖
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-slate-200">{agentName}</div>
              {/* ── 可点击的模式切换器 ── */}
              <div className="relative" ref={modePopoverRef}>
                <button
                  onClick={() => setModePopoverOpen(!modePopoverOpen)}
                  className="flex items-center gap-2 text-[10px] text-slate-500 hover:text-slate-300 transition-colors group"
                >
                  <span className={`${modeInfo.color}`}>
                    {modeInfo.icon} {modeInfo.label}模式
                  </span>
                  <span className="text-slate-700">·</span>
                  <span>{modeInfo.desc}</span>
                  <svg
                    className="w-3 h-3 text-slate-600 group-hover:text-slate-400 transition-colors"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M3 5l3 3 3-3" />
                  </svg>
                </button>
                {modePopoverOpen && (
                  <div className="absolute left-0 top-6 z-50 flex items-stretch bg-slate-900 border border-slate-700 rounded-xl shadow-2xl shadow-black/50 overflow-hidden">
                    {(['work', 'chat', 'deep', 'admin'] as ChatMode[]).map(m => {
                      const mi = CHAT_MODE_INFO[m];
                      const isActive = m === currentChatMode;
                      return (
                        <button
                          key={m}
                          onClick={() => handleModeSwitch(m)}
                          className={`relative flex flex-col items-center gap-1 px-3.5 py-2.5 transition-all min-w-[56px]
                            ${
                              isActive
                                ? 'bg-forge-600/20 border-b-2 border-forge-500'
                                : 'hover:bg-slate-800/80 border-b-2 border-transparent'
                            }`}
                        >
                          <span className="text-base">{mi.icon}</span>
                          <span
                            className={`text-[10px] font-medium whitespace-nowrap ${isActive ? 'text-forge-400' : 'text-slate-400'}`}
                          >
                            {mi.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            <button
              onClick={() => setSettingsOpen(true)}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:text-forge-400 hover:bg-slate-800 transition-all"
              title="管家设置"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {displayMessages.map((msg, idx) => (
            <div key={msg.id}>
              <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-forge-600/20 text-forge-200 rounded-br-md whitespace-pre-wrap'
                      : 'bg-slate-800/80 text-slate-300 rounded-bl-md'
                  }`}
                >
                  {msg.role === 'assistant' ? (
                    <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                  ) : (
                    <>
                      {msg.content && <div className="whitespace-pre-wrap">{msg.content}</div>}
                      {msg.attachments && <MessageAttachments attachments={msg.attachments} />}
                    </>
                  )}
                  {msg.triggeredWish && <div className="mt-1 text-[10px] text-emerald-400">✅ 已创建需求</div>}
                  <div
                    className={`flex items-center gap-1.5 text-[9px] mt-1 ${msg.role === 'user' ? 'text-forge-400/50 justify-end' : 'text-slate-600'}`}
                  >
                    <span>
                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {msg.id !== 'greeting' && (
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(msg.id).catch(() => {});
                          const btn = e.currentTarget;
                          btn.textContent = '✓';
                          setTimeout(() => {
                            btn.textContent = `#${msg.id.slice(-6)}`;
                          }, 1200);
                        }}
                        className="font-mono opacity-40 hover:opacity-100 hover:text-forge-400 transition-opacity cursor-pointer"
                        title={`ID: ${msg.id} — 点击复制`}
                      >
                        #{msg.id.slice(-6)}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* 思维过程 / 工具调用 — 在最后一条 assistant 消息后内联展示 */}
              {sending &&
                idx === displayMessages.length - 1 &&
                msg.role === 'assistant' &&
                (() => {
                  const currentRoundWorkMsgs = metaAgentWorkMsgs.slice(sendingStartMsgIndexRef.current);
                  return currentRoundWorkMsgs.length > 0 ? (
                    <div className="mt-2 space-y-1.5 pl-1 max-w-[85%]">
                      <div className="flex items-center gap-1.5 text-[10px] text-slate-500 mb-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        <span>ReAct 工作流 · {currentRoundWorkMsgs.length} 条</span>
                      </div>
                      {currentRoundWorkMsgs.map(wm => (
                        <InlineWorkMessage key={wm.id} msg={wm} />
                      ))}
                    </div>
                  ) : null;
                })()}
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>

        {/* Input — v28.0: 支持附件上传 */}
        <ChatInput
          onSend={handleSend}
          sending={sending}
          placeholder={compact ? '发消息...' : `${modeInfo.icon} ${modeInfo.label}模式 — 发消息...`}
          compact={compact}
        />

        {settingsOpen && <MetaAgentSettings onClose={() => setSettingsOpen(false)} />}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

interface WishItem {
  id: string;
  project_id?: string;
  content: string;
  status: string;
  pm_analysis?: string | null;
  design_doc?: string | null;
  created_at: string;
  updated_at?: string;
  /** @deprecated kept for compat */
  analysis?: string;
}

interface FeatureItem {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  category: string;
  group_name?: string | null;
  depends_on: string | null;
  locked_by: string | null;
  acceptance_criteria: string | null;
  affected_files: string | null;
  notes?: string | null;
  created_at: string;
  completed_at?: string | null;
  pm_verdict?: string | null;
  pm_verdict_score?: number | null;
  pm_verdict_feedback?: string | null;
}

// ═══════════════════════════════════════
// Feature status constants
// ═══════════════════════════════════════

const FEATURE_STATUS: Record<string, { text: string; color: string; bg: string; icon: string }> = {
  todo: { text: '待做', color: 'text-slate-400', bg: 'bg-slate-500/20', icon: '📋' },
  in_progress: { text: '开发中', color: 'text-blue-400', bg: 'bg-blue-500/20', icon: '🔨' },
  reviewing: { text: '审查中', color: 'text-amber-400', bg: 'bg-amber-500/20', icon: '🔍' },
  passed: { text: '已完成', color: 'text-emerald-400', bg: 'bg-emerald-500/20', icon: '✅' },
  failed: { text: '失败', color: 'text-red-400', bg: 'bg-red-500/20', icon: '❌' },
};

// ═══════════════════════════════════════
// WishDetailPanel — 需求详情面板
// ═══════════════════════════════════════

function WishDetailPanel({
  wish,
  features,
  onBack,
  onDelete,
}: {
  wish: WishItem;
  features: FeatureItem[];
  onBack: () => void;
  onDelete: (id: string) => void;
}) {
  const st = WISH_STATUS[wish.status] || WISH_STATUS.pending;
  const [expandedFeatureId, setExpandedFeatureId] = useState<string | null>(null);
  const [showPmAnalysis, setShowPmAnalysis] = useState(false);

  // ── Stall diagnosis ──
  const stallDiagnosis = useMemo(() => {
    if (features.length === 0) return null;

    const reasons: { featureId: string; title: string; reasons: string[] }[] = [];
    const featureMap = new Map(features.map(f => [f.id, f]));

    for (const f of features) {
      if (f.status === 'passed') continue; // completed, skip
      const featureReasons: string[] = [];

      // 1) QA failure
      if (f.status === 'failed') {
        featureReasons.push(
          f.pm_verdict_feedback ? `QA 未通过: ${f.pm_verdict_feedback.slice(0, 120)}` : 'QA 审查未通过',
        );
      }

      // 2) PM verdict rejection
      if (f.pm_verdict === 'rejected' || f.pm_verdict === 'fail') {
        featureReasons.push(
          f.pm_verdict_feedback ? `PM 验收拒绝: ${f.pm_verdict_feedback.slice(0, 120)}` : 'PM 验收未通过',
        );
      }

      // 3) Unmet dependencies
      let deps: string[] = [];
      try {
        deps = JSON.parse(f.depends_on || '[]');
      } catch {
        /* ignore */
      }
      const unmetDeps = deps.filter(depId => {
        const dep = featureMap.get(depId);
        return !dep || dep.status !== 'passed';
      });
      if (unmetDeps.length > 0) {
        const depNames = unmetDeps.map(id => {
          const dep = featureMap.get(id);
          return dep ? `${id}(${dep.title.slice(0, 20)})` : id;
        });
        featureReasons.push(`等待前置依赖完成: ${depNames.join(', ')}`);
      }

      // 4) Locked / in_progress but not actively locked
      if (f.status === 'in_progress' && !f.locked_by) {
        featureReasons.push('状态为开发中但无 Agent 锁定，可能已中断');
      }

      // 5) Still todo with no blocker — just waiting
      if (f.status === 'todo' && unmetDeps.length === 0) {
        featureReasons.push('排队等待 Agent 分配');
      }

      if (featureReasons.length > 0) {
        reasons.push({ featureId: f.id, title: f.title, reasons: featureReasons });
      }
    }
    return reasons.length > 0 ? reasons : null;
  }, [features]);

  const passedCount = features.filter(f => f.status === 'passed').length;
  const totalCount = features.length;
  const progressPct = totalCount > 0 ? Math.round((passedCount / totalCount) * 100) : 0;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-slate-800 flex items-center gap-3 shrink-0">
        <button
          onClick={onBack}
          className="text-slate-500 hover:text-slate-300 transition-colors text-sm"
          title="返回对话"
        >
          ← 返回
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs">{st.icon}</span>
            <span className={`text-xs font-medium ${st.color}`}>{st.text}</span>
            <span className="text-[10px] text-slate-600">{new Date(wish.created_at).toLocaleString()}</span>
          </div>
        </div>
        <button
          onClick={async () => {
            const { confirmed } = await confirm({
              title: '删除需求',
              message: '确定要删除此需求吗？此操作无法撤销。',
              confirmText: '删除',
              danger: true,
            });
            if (confirmed) onDelete(wish.id);
          }}
          className="text-[10px] text-red-500/60 hover:text-red-400 transition-colors"
          title="删除需求"
        >
          🗑 删除
        </button>
      </div>

      {/* Content scrollable */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {/* ── 需求内容 ── */}
        <section>
          <h3 className="text-sm font-bold text-slate-200 mb-2">需求描述</h3>
          <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap bg-slate-800/40 rounded-lg px-4 py-3">
            {wish.content}
          </p>
        </section>

        {/* ── PM 分析 ── */}
        {(wish.pm_analysis || wish.analysis) && (
          <section>
            <button
              onClick={() => setShowPmAnalysis(!showPmAnalysis)}
              className="flex items-center gap-2 text-sm font-bold text-slate-200 hover:text-slate-100 transition-colors"
            >
              <span className={`text-[10px] transition-transform ${showPmAnalysis ? 'rotate-90' : ''}`}>▶</span>
              PM 分析结果
            </button>
            {showPmAnalysis && (
              <div className="mt-2 text-xs text-slate-400 leading-relaxed whitespace-pre-wrap bg-slate-800/30 rounded-lg px-4 py-3 max-h-60 overflow-y-auto">
                {wish.pm_analysis || wish.analysis}
              </div>
            )}
          </section>
        )}

        {/* ── 进度总览 ── */}
        {totalCount > 0 && (
          <section>
            <h3 className="text-sm font-bold text-slate-200 mb-2">开发进度</h3>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="text-xs text-slate-400 shrink-0">
                {passedCount}/{totalCount} ({progressPct}%)
              </span>
            </div>
            <div className="flex gap-3 mt-2 text-[10px]">
              {Object.entries(FEATURE_STATUS).map(([key, s]) => {
                const count = features.filter(f => f.status === key).length;
                if (count === 0) return null;
                return (
                  <span key={key} className={`${s.color} flex items-center gap-1`}>
                    {s.icon} {s.text}: {count}
                  </span>
                );
              })}
            </div>
          </section>
        )}

        {/* ── 停滞原因诊断 ── */}
        {stallDiagnosis && stallDiagnosis.length > 0 && (
          <section>
            <h3 className="text-sm font-bold text-amber-400 mb-2">⚠ 未推进原因诊断</h3>
            <div className="space-y-2">
              {stallDiagnosis.map(item => (
                <div key={item.featureId} className="bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-mono text-amber-500/80">{item.featureId}</span>
                    <span className="text-xs text-slate-300 truncate">{item.title}</span>
                  </div>
                  <ul className="space-y-0.5">
                    {item.reasons.map((r, i) => (
                      <li key={i} className="text-[11px] text-amber-300/70 flex items-start gap-1.5">
                        <span className="shrink-0 mt-0.5">•</span>
                        <span>{r}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Feature 列表 ── */}
        {totalCount > 0 && (
          <section>
            <h3 className="text-sm font-bold text-slate-200 mb-2">关联 Feature ({totalCount})</h3>
            <div className="space-y-1.5">
              {features.map(f => {
                const fst = FEATURE_STATUS[f.status] || FEATURE_STATUS.todo;
                const isExpanded = expandedFeatureId === f.id;
                let deps: string[] = [];
                try {
                  deps = JSON.parse(f.depends_on || '[]');
                } catch {
                  /* ignore */
                }
                let criteria: string[] = [];
                try {
                  criteria = JSON.parse(f.acceptance_criteria || '[]');
                } catch {
                  /* ignore */
                }

                return (
                  <div key={f.id} className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
                    {/* Card header — clickable */}
                    <button
                      onClick={() => setExpandedFeatureId(isExpanded ? null : f.id)}
                      className="w-full text-left px-3 py-2.5 flex items-center gap-2 hover:bg-slate-800/50 transition-colors"
                    >
                      <span className={`text-[10px] transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${fst.bg} ${fst.color} font-medium`}>
                        {fst.icon} {fst.text}
                      </span>
                      <span className="text-xs text-slate-300 truncate flex-1">{f.title || f.description}</span>
                      <span
                        className={`text-[10px] px-1 py-0.5 rounded ${
                          f.priority === 0
                            ? 'bg-red-500/20 text-red-400'
                            : f.priority === 1
                              ? 'bg-amber-500/20 text-amber-400'
                              : 'bg-slate-700 text-slate-500'
                        }`}
                      >
                        P{f.priority}
                      </span>
                      {f.locked_by && <span className="text-[10px] text-forge-400">🔨 {f.locked_by}</span>}
                    </button>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <div className="px-3 pb-3 pt-0 space-y-2 border-t border-slate-800">
                        {/* ID + group */}
                        <div className="flex items-center gap-3 pt-2 text-[10px] text-slate-600">
                          <span className="font-mono">{f.id}</span>
                          {f.group_name && <span>📁 {f.group_name}</span>}
                          {f.category && <span>#{f.category}</span>}
                        </div>

                        {/* Description */}
                        {f.description && (
                          <div>
                            <div className="text-[10px] text-slate-500 mb-0.5">描述</div>
                            <p className="text-xs text-slate-400 leading-relaxed">{f.description}</p>
                          </div>
                        )}

                        {/* Dependencies */}
                        {deps.length > 0 && (
                          <div>
                            <div className="text-[10px] text-slate-500 mb-0.5">前置依赖</div>
                            <div className="flex flex-wrap gap-1">
                              {deps.map(depId => {
                                const dep = features.find(df => df.id === depId);
                                const depDone = dep?.status === 'passed';
                                return (
                                  <span
                                    key={depId}
                                    className={`text-[10px] px-1.5 py-0.5 rounded ${
                                      depDone ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-700 text-slate-400'
                                    }`}
                                  >
                                    {depDone ? '✅' : '⏳'} {depId}
                                    {dep ? ` · ${dep.title.slice(0, 15)}` : ''}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Acceptance criteria */}
                        {criteria.length > 0 && (
                          <div>
                            <div className="text-[10px] text-slate-500 mb-0.5">验收标准</div>
                            <ul className="space-y-0.5">
                              {criteria.map((c, i) => (
                                <li key={i} className="text-[11px] text-slate-400 flex items-start gap-1.5">
                                  <span className="text-slate-600 shrink-0">{i + 1}.</span>
                                  <span>{typeof c === 'string' ? c : JSON.stringify(c)}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* PM verdict */}
                        {f.pm_verdict && (
                          <div
                            className={`rounded-md px-2.5 py-1.5 text-[11px] ${
                              f.pm_verdict === 'pass' || f.pm_verdict === 'approved'
                                ? 'bg-emerald-500/10 text-emerald-400'
                                : 'bg-red-500/10 text-red-400'
                            }`}
                          >
                            <span className="font-medium">PM 验收: {f.pm_verdict}</span>
                            {f.pm_verdict_score != null && <span className="ml-2">({f.pm_verdict_score}分)</span>}
                            {f.pm_verdict_feedback && <p className="mt-0.5 opacity-80">{f.pm_verdict_feedback}</p>}
                          </div>
                        )}

                        {/* Notes */}
                        {f.notes && f.notes.trim() && (
                          <div>
                            <div className="text-[10px] text-slate-500 mb-0.5">备注</div>
                            <p className="text-[11px] text-slate-500 leading-relaxed">{f.notes}</p>
                          </div>
                        )}

                        {/* Timestamps */}
                        <div className="flex gap-4 text-[10px] text-slate-600 pt-1">
                          <span>创建: {new Date(f.created_at).toLocaleString()}</span>
                          {f.completed_at && <span>完成: {new Date(f.completed_at).toLocaleString()}</span>}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Empty state: no features */}
        {totalCount === 0 && wish.status !== 'pending' && wish.status !== 'rejected' && (
          <div className="text-center py-8 text-slate-600 text-xs">
            <div className="text-2xl mb-2">📦</div>
            暂无关联 Feature
            <br />
            可能还在 PM 分析阶段或尚未进入开发
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// Main WishPage
// ═══════════════════════════════════════

export function WishPage() {
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const addLog = useAppStore(s => s.addLog);
  const settingsConfigured = useAppStore(s => s.settingsConfigured);
  const _setGlobalPage = useAppStore(s => s.setGlobalPage);
  const setProjectPage = useAppStore(s => s.setProjectPage);

  // ── State ──
  const [wishes, setWishes] = useState<WishItem[]>([]);
  const [selectedWishId, setSelectedWishId] = useState<string | null>(null);
  const [newWish, setNewWish] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showNewWish, setShowNewWish] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [features, setFeatures] = useState<FeatureItem[]>([]);

  // ── Load data ──
  const loadWishes = useCallback(async () => {
    if (!currentProjectId) return;
    const list = await window.automater.wish.list(currentProjectId);
    setWishes(list || []);
    if (!selectedWishId && list?.length > 0) setSelectedWishId(list[0].id);
  }, [currentProjectId, selectedWishId]);

  // ── Load features ──
  const loadFeatures = useCallback(async () => {
    if (!currentProjectId) return;
    const data = await window.automater.project.getFeatures(currentProjectId);
    setFeatures((data || []) as FeatureItem[]);
  }, [currentProjectId]);

  useEffect(() => {
    loadWishes();
  }, [loadWishes]);
  useEffect(() => {
    loadFeatures();
  }, [loadFeatures]);
  useEffect(() => {
    const t = setInterval(() => {
      loadWishes();
      loadFeatures();
    }, 5000);
    return () => clearInterval(t);
  }, [loadWishes, loadFeatures]);
  // 元Agent创建需求后刷新列表
  useEffect(() => {
    const handler = () => {
      loadWishes();
    };
    window.addEventListener('meta-agent:wish-created', handler);
    return () => window.removeEventListener('meta-agent:wish-created', handler);
  }, [loadWishes]);

  const selected = wishes.find(w => w.id === selectedWishId) || null;

  // ── Handlers ──
  const handleSubmitWish = async () => {
    if (!newWish.trim() || !currentProjectId || submitting) return;
    setSubmitting(true);
    try {
      const res = await window.automater.wish.create(currentProjectId, newWish.trim());
      addLog({ projectId: currentProjectId, agentId: 'system', content: '✨ 新需求已提交' });

      await window.automater.project.setWish(currentProjectId, newWish.trim());
      await window.automater.wish.update(res.wishId, { status: 'developing' });

      if (settingsConfigured) {
        await window.automater.project.start(currentProjectId);
        addLog({ projectId: currentProjectId, agentId: 'system', content: '🚀 Agent 团队已自动启动, 开始创造!' });
      } else {
        addLog({ projectId: currentProjectId, agentId: 'system', content: '⚠️ 请先在设置中配置 LLM API Key' });
      }

      setNewWish('');
      setShowNewWish(false);
      setSelectedWishId(res.wishId);
      setProjectPage('overview');
      await loadWishes();
    } catch (err: unknown) {
      const msg = friendlyErrorMessage(err);
      addLog({ projectId: currentProjectId, agentId: 'system', content: `❌ ${msg}` });
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteWish = async (id: string) => {
    await window.automater.wish.delete(id);
    if (selectedWishId === id) {
      setSelectedWishId(null);
      setShowDetail(false);
    }
    loadWishes();
  };

  if (!currentProjectId) {
    return <div className="h-full flex items-center justify-center text-slate-500">加载中...</div>;
  }

  return (
    <div className="h-full flex overflow-hidden">
      {/* ═══ 左侧: 需求列表 ═══ */}
      <div className="w-72 border-r border-slate-800 flex flex-col flex-shrink-0">
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-200">需求管理</h2>
          <button
            onClick={() => {
              setShowNewWish(true);
              setSelectedWishId(null);
            }}
            className="text-[10px] px-2 py-1 rounded-lg bg-forge-600 hover:bg-forge-500 text-white transition-colors"
            title="新需求"
          >
            + 需求
          </button>
        </div>

        {/* Wish List */}
        <div className="flex-1 overflow-y-auto">
          {wishes.length === 0 && !showNewWish && (
            <EmptyState
              icon="✨"
              title="暂无需求"
              description="点击「+ 需求」创建，或直接告诉右侧管家你想做什么"
              action={{ label: '+ 新建需求', onClick: () => setShowNewWish(true) }}
            />
          )}
          {wishes.map(w => {
            const st = WISH_STATUS[w.status] || WISH_STATUS.pending;
            const hasDocs = !!(w.pm_analysis || w.analysis);
            return (
              <button
                key={w.id}
                onClick={() => {
                  setSelectedWishId(w.id);
                  setShowNewWish(false);
                  setShowDetail(true);
                }}
                className={`w-full text-left px-4 py-3 border-b border-slate-800/50 transition-colors ${
                  selectedWishId === w.id
                    ? 'bg-forge-600/10 border-l-2 border-l-forge-500'
                    : 'hover:bg-slate-800/50 border-l-2 border-l-transparent'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs">{st.icon}</span>
                  <span className={`text-[10px] font-medium ${st.color}`}>{st.text}</span>
                  {hasDocs && <span className="text-[10px] text-slate-600">📄</span>}
                  <span className="text-[10px] text-slate-600 ml-auto">
                    {new Date(w.created_at).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed">{w.content}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* ═══ 右侧: 需求详情 / 新建 / 元Agent对话 ═══ */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {showNewWish ? (
          /* ── 快速新建需求 ── */
          <div className="p-6 max-w-2xl mx-auto space-y-4">
            <h3 className="text-lg font-bold text-slate-200">提交新需求</h3>
            <p className="text-xs text-slate-500">描述你想要实现的功能或改动, Agent 会自动识别并处理。</p>
            <textarea
              value={newWish}
              onChange={e => setNewWish(e.target.value)}
              placeholder="详细描述你的需求..."
              rows={8}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-slate-100 placeholder-slate-600 resize-y focus:outline-none focus:border-forge-500 transition-colors text-sm leading-relaxed"
              onKeyDown={e => {
                if (e.key === 'Enter' && e.ctrlKey) handleSubmitWish();
              }}
              autoFocus
            />
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-600">{newWish.length} 字符 · Ctrl+Enter 提交</span>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowNewWish(false)}
                  className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleSubmitWish}
                  disabled={!newWish.trim() || submitting}
                  className="px-5 py-2 rounded-lg text-sm bg-forge-600 hover:bg-forge-500 text-white transition-all disabled:bg-slate-800 disabled:text-slate-600"
                >
                  {submitting ? '启动中...' : '🚀 提交并启动开发'}
                </button>
              </div>
            </div>
          </div>
        ) : showDetail && selected ? (
          /* ── 需求详情面板 ── */
          <WishDetailPanel
            wish={selected}
            features={features}
            onBack={() => setShowDetail(false)}
            onDelete={handleDeleteWish}
          />
        ) : (
          /* ── 元Agent对话区 ── */
          <MetaAgentChat />
        )}
      </div>
    </div>
  );
}
