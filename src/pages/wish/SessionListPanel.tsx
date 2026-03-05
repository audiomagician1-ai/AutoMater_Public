/**
 * SessionListPanel — 会话历史列表 (常驻在许愿页)
 *
 * 从 WishPage.tsx 拆分 (v30.2)
 */

import { useState, useEffect, useCallback, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { useAppStore } from '../../stores/app-store';
import type { MetaSessionItem, ChatMode } from '../../stores/slices/meta-agent-slice';
import { MetaAgentSettings } from '../../components/MetaAgentSettings';
import { toast, confirm } from '../../stores/toast-store';
import { EmptyState } from '../../components/EmptyState';
import { CHAT_MODE_INFO, formatSessionTime, formatTokens } from './wish-constants';
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
    } catch (err) {
      console.error('[ModeSwitchBadge] updateChatMode failed:', err);
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

export function SessionListPanel() {
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
  }, [currentProjectId, loadSessions]);
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
  const [toast, setToast] = useState<string | null>(null);
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1800);
  };

  const handleTogglePin = async () => {
    if (!ctxMenu) return;
    try {
      const res = await window.automater.session.togglePin(ctxMenu.sessId);
      await loadSessions();
      showToast(res.pinned ? '📌 已置顶' : '已取消置顶');
    } catch (err) {
      console.error('[WishPage] togglePin failed:', err);
      showToast('❌ 置顶失败');
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
      showToast('✏️ 已重命名');
    } catch (err) {
      console.error('[WishPage] rename failed:', err);
      showToast('❌ 重命名失败');
    }
    setRenameTarget(null);
  };

  const handleToggleHidden = async () => {
    if (!ctxMenu) return;
    try {
      const res = await window.automater.session.toggleHidden(ctxMenu.sessId);
      await loadSessions();
      showToast(res.hidden ? '🙈 已隐藏' : '👁️ 已取消隐藏');
    } catch (err) {
      console.error('[WishPage] toggleHidden failed:', err);
      showToast('❌ 隐藏操作失败');
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
    <div className="w-56 shrink-0 border-r border-slate-800 flex flex-col bg-slate-950/60 relative" onClick={closeCtx}>
      {/* Toast 提示 */}
      {toast && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[80] px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg shadow-xl text-[11px] text-slate-200 whitespace-nowrap animate-fade-in">
          {toast}
        </div>
      )}
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
