/**
 * MetaAgentPanel — 全局右侧可伸缩元Agent对话面板
 *
 * v5.4: Zustand store 持久化消息 + LLM 后端
 * v7.0: 动态名字/开场白 + 管理入口
 * v16.0: 思考过程完整内联展示 + 面板宽度可拖拽调整
 * v20.0: session 持久化 (DB) + 顶栏下拉选单切换会话
 *        完整会话历史列表在 WishPage (许愿页) 常驻
 */

import { useState, useEffect, useRef, useCallback, useMemo, type MouseEvent as ReactMouseEvent } from 'react';
import { useAppStore, type MetaAgentMessage, type AgentWorkMessage } from '../stores/app-store';
import type { MetaSessionItem, ChatMode } from '../stores/slices/meta-agent-slice';
import { MetaAgentSettings } from './MetaAgentSettings';
import { MSG_STYLES } from './chat';
import { InlineWorkMessage } from './chat/InlineWorkMessage';
import { CollapsibleWorkBlock } from './chat/CollapsibleWorkBlock';
import { friendlyErrorMessage } from '../utils/errors';
import { renderMarkdown } from '../utils/markdown';
import { ChatInput, type ChatAttachment, type ChatInputHandle } from './ChatInput';
import { MessageAttachments } from './MessageAttachments';

const EMPTY_WORK_MSGS: readonly AgentWorkMessage[] = [];
const META_AGENT_ID = 'meta-agent';

/** 对话模式元数据 — 与 WishPage 保持一致 */
const CHAT_MODE_INFO: Record<ChatMode, { icon: string; label: string; desc: string; color: string }> = {
  work: { icon: '🔧', label: '工作', desc: '指挥调度 · 派发任务给团队', color: 'text-amber-400' },
  chat: { icon: '💬', label: '闲聊', desc: '自由对话 · 不触发工作流', color: 'text-blue-400' },
  deep: { icon: '🔬', label: '深度', desc: '深入分析 · 可输出文件/派发任务', color: 'text-purple-400' },
  admin: { icon: '🛠️', label: '管理', desc: '修改团队/工作流/项目配置', color: 'text-rose-400' },
};

// v31.0: InlineWorkMessage + CollapsibleWorkBlock moved to components/chat/
// See imports at top of file.
// ═══════════════════════════════════════
// SessionDropdown — 顶栏下拉选单
// ═══════════════════════════════════════

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function SessionDropdown({ onClose }: { onClose: () => void }) {
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const sessionList = useAppStore(s => s.metaSessionList);
  const setSessionList = useAppStore(s => s.setMetaSessionList);
  const currentSessionId = useAppStore(s => s.currentMetaSessionId);
  const setCurrentSessionId = useAppStore(s => s.setCurrentMetaSessionId);
  const setMessages = useAppStore(s => s.setMetaAgentMessages);
  const messagesMap = useAppStore(s => s.metaAgentMessages);
  const [modeSubmenu, setModeSubmenu] = useState<string | null>(null); // 右键菜单中展开模式子菜单的 sessId

  // 加载 session 列表
  const loadSessions = useCallback(() => {
    window.automater.metaAgent
      .listChatSessions(currentProjectId, undefined, true)
      .then(list => {
        setSessionList((list || []).map(s => ({ ...s, title: s.title ?? undefined })) as MetaSessionItem[]);
      })
      .catch(() => {});
  }, [currentProjectId, setSessionList]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleSelect = async (sessId: string) => {
    setCurrentSessionId(sessId);
    if (!messagesMap.has(sessId) || (messagesMap.get(sessId)?.length ?? 0) === 0) {
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
    }
    onClose();
  };

  // ── 右键菜单 ──
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; sessId: string } | null>(null);
  const handleCtx = (e: ReactMouseEvent, sessId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, sessId });
  };
  const closeCtx = () => setCtxMenu(null);

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

  /** 切换指定 session 的对话模式 */
  const handleSwitchMode = async (sessId: string, mode: ChatMode) => {
    try {
      await window.automater.session.updateChatMode(sessId, mode);
      // 立即更新本地 sessionList（不等远程刷新）
      setSessionList(sessionList.map(s => (s.id === sessId ? { ...s, chatMode: mode } : s)) as MetaSessionItem[]);
      // 后台完整刷新
      loadSessions();
    } catch (err) {
      console.error('[SessionDropdown] switchMode failed:', err);
    }
    setModeSubmenu(null);
    closeCtx();
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        onClick={() => {
          onClose();
          closeCtx();
        }}
      />
      {/* 右键菜单 */}
      {ctxMenu && (
        <div
          className="fixed z-[60] w-44 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl py-1 text-[11px]"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
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
          {/* 切换模式 — 展开子菜单 */}
          <div className="relative">
            <button
              onClick={() => setModeSubmenu(modeSubmenu === ctxMenu.sessId ? null : ctxMenu.sessId)}
              className="w-full text-left px-3 py-1.5 text-slate-300 hover:bg-slate-800 transition-colors flex items-center gap-2"
            >
              <span>🔄</span>切换模式
              <span className="ml-auto text-slate-600 text-[9px]">▸</span>
            </button>
            {modeSubmenu === ctxMenu.sessId && (
              <div
                className="fixed z-[70] w-40 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl py-1"
                style={{ left: ctxMenu.x + 160, top: ctxMenu.y }}
              >
                {(['work', 'chat', 'deep', 'admin'] as ChatMode[]).map(m => {
                  const mi = CHAT_MODE_INFO[m];
                  const sess = sessionList.find(s => s.id === ctxMenu.sessId);
                  const isActive = (sess?.chatMode || 'work') === m;
                  return (
                    <button
                      key={m}
                      onClick={() => handleSwitchMode(ctxMenu.sessId, m)}
                      className={`w-full text-left px-3 py-1.5 transition-colors flex items-center gap-2 ${
                        isActive ? 'text-forge-400 bg-forge-600/10' : 'text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      <span>{mi.icon}</span>
                      <span className={isActive ? 'font-medium' : ''}>{mi.label}</span>
                      {isActive && <span className="ml-auto text-[9px]">✓</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="border-t border-slate-800 my-0.5" />
          <button
            onClick={handleOpenFolder}
            className="w-full text-left px-3 py-1.5 text-slate-300 hover:bg-slate-800 transition-colors flex items-center gap-2"
          >
            <span>📁</span>跳转至所在文件夹
          </button>
        </div>
      )}
      {/* Dropdown */}
      <div className="absolute top-10 right-1 z-50 w-64 max-h-80 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden flex flex-col">
        {/* Session list */}
        <div className="flex-1 overflow-y-auto">
          {sessionList.length === 0 && <div className="text-center py-6 text-[10px] text-slate-600">暂无历史会话</div>}
          {sessionList.map(sess => {
            const isSelected = currentSessionId === sess.id;
            const title = sess.customTitle || sess.title || `会话 #${sess.agentSeq}`;
            const modeInfo = CHAT_MODE_INFO[(sess.chatMode as ChatMode) || 'work'];
            return (
              <button
                key={sess.id}
                onClick={() => handleSelect(sess.id)}
                onContextMenu={e => handleCtx(e, sess.id)}
                className={`w-full text-left px-3 py-2 text-[11px] transition-colors border-b border-slate-800/50
                  ${isSelected ? 'bg-forge-600/10 text-slate-200' : 'text-slate-400 hover:bg-slate-800/60'}`}
              >
                <div className="flex items-center gap-1.5">
                  {sess.status === 'active' && (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                  )}
                  <span className="truncate font-medium flex-1">{title}</span>
                  <span className={`shrink-0 text-[10px] ${modeInfo.color}`} title={`${modeInfo.label}模式`}>
                    {modeInfo.icon}
                  </span>
                </div>
                <div className="text-[9px] text-slate-600 mt-0.5">{formatTime(sess.createdAt)}</div>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════
// Main Component
// ═══════════════════════════════════════

export function MetaAgentPanel() {
  const open = useAppStore(s => s.metaAgentPanelOpen);
  const toggle = useAppStore(s => s.toggleMetaAgentPanel);
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const messagesMap = useAppStore(s => s.metaAgentMessages);
  const addMessage = useAppStore(s => s.addMetaAgentMessage);
  const updateLastAssistant = useAppStore(s => s.updateLastAssistantMessage);
  const attachWorkMsgs = useAppStore(s => s.attachWorkMessagesToLast);
  const settingsOpen = useAppStore(s => s.metaAgentSettingsOpen);
  const setSettingsOpen = useAppStore(s => s.setMetaAgentSettingsOpen);
  const currentSessionId = useAppStore(s => s.currentMetaSessionId);
  const setCurrentSessionId = useAppStore(s => s.setCurrentMetaSessionId);
  const sessionList = useAppStore(s => s.metaSessionList);
  const setSessionList = useAppStore(s => s.setMetaSessionList);

  // chatKey: session 优先, 否则用 projectId/_global
  const chatKey = currentSessionId || currentProjectId || '_global';
  const messages = useMemo(() => messagesMap.get(chatKey) || [], [messagesMap, chatKey]);

  // ── 模式管理 ──
  const [pendingMode, setPendingMode] = useState<ChatMode>('work');
  const currentChatMode: ChatMode = useMemo(() => {
    if (currentSessionId) {
      const sess = sessionList.find(s => s.id === currentSessionId);
      if (sess?.chatMode) return sess.chatMode;
    }
    return pendingMode;
  }, [currentSessionId, sessionList, pendingMode]);
  const currentModeInfo = CHAT_MODE_INFO[currentChatMode];
  const [modePopoverOpen, setModePopoverOpen] = useState(false);
  const modePopoverRef = useRef<HTMLDivElement>(null);
  const modePopoverContentRef = useRef<HTMLDivElement>(null);
  const [modePopoverPos, setModePopoverPos] = useState<{ top: number; left: number } | null>(null);
  const [modeToast, setModeToast] = useState<string | null>(null);

  // 关闭模式 popover 当点击外部（排除触发按钮和 popover 内容区）
  useEffect(() => {
    if (!modePopoverOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (modePopoverRef.current?.contains(target)) return;
      if (modePopoverContentRef.current?.contains(target)) return;
      setModePopoverOpen(false);
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
      try {
        await window.automater.session.updateChatMode(currentSessionId, mode);
        // 立即更新本地 sessionList 中的 chatMode（不等远程刷新）
        const store = useAppStore.getState();
        const updatedList = store.metaSessionList.map(s => (s.id === currentSessionId ? { ...s, chatMode: mode } : s));
        store.setMetaSessionList(updatedList as MetaSessionItem[]);
        // 同时后台刷新完整列表
        window.automater.metaAgent
          .listChatSessions(currentProjectId, undefined, true)
          .then(list => {
            if (list) {
              useAppStore
                .getState()
                .setMetaSessionList(
                  (list || []).map(s => ({ ...s, title: s.title ?? undefined })) as MetaSessionItem[],
                );
            }
          })
          .catch(() => {});
        const mi = CHAT_MODE_INFO[mode];
        setModeToast(`${mi.icon} 已切换为${mi.label}模式`);
        setTimeout(() => setModeToast(null), 1800);
      } catch (err) {
        console.error('[MetaAgentPanel] handleModeSwitch failed:', err);
        setModeToast('❌ 模式切换失败');
        setTimeout(() => setModeToast(null), 1800);
      }
    } else {
      setPendingMode(mode);
      const mi = CHAT_MODE_INFO[mode];
      setModeToast(`${mi.icon} 新对话将使用${mi.label}模式`);
      setTimeout(() => setModeToast(null), 1800);
    }
    setModePopoverOpen(false);
  };

  const [sending, setSending] = useState(false);
  const [agentName, setAgentName] = useState('元Agent · 管家');
  const [greeting, setGreeting] = useState('你好！我是元Agent管家。告诉我你的需求，或问我任何项目相关的问题。');
  const [panelWidth, setPanelWidth] = useState(380);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [showWorkDetails, setShowWorkDetails] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const [panelDragOver, setPanelDragOver] = useState(false);
  const resizingRef = useRef(false);
  const sendingStartMsgIndexRef = useRef(0);
  const metaAgentCK = currentProjectId ? currentProjectId + ':' + META_AGENT_ID : META_AGENT_ID;
  const metaAgentWorkMsgsRaw = useAppStore(s => s.agentWorkMessages.get(metaAgentCK));
  const metaAgentWorkMsgs = metaAgentWorkMsgsRaw ?? EMPTY_WORK_MSGS;

  // Load config
  useEffect(() => {
    window.automater.metaAgent
      .getConfig()
      .then((config: MetaAgentConfig) => {
        if (config.name) setAgentName(config.name);
        if (config.greeting) setGreeting(config.greeting);
      })
      .catch(() => {});
  }, [settingsOpen]);

  // Auto-scroll on new messages / work messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, metaAgentWorkMsgs.length]);

  // v31.0: 实时接收管家思考过程，替换"思考中..."占位符
  useEffect(() => {
    const unsub = window.automater.on(
      'meta-agent:reply-chunk',
      (data: { projectId: string; content: string; type: string; iteration: number }) => {
        if (!data.content) return;
        const prefix = data.type === 'thinking' ? '💭 ' : '';
        updateLastAssistant(chatKey, prefix + data.content);
      },
    );
    return unsub;
  }, [chatKey, updateLastAssistant]);

  // 切换项目时恢复最近活跃会话
  useEffect(() => {
    (async () => {
      try {
        const sessions = await window.automater.metaAgent.listChatSessions(currentProjectId, 1);
        if (sessions?.length) {
          const latest = sessions[0];
          if (latest.status === 'active') {
            // 已经是当前 session 且有缓存消息 → 跳过
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
        // 没有活跃 session 才清除
        if (currentSessionId) setCurrentSessionId(null);
      } catch {
        /* silent */
      }
    })();
  }, [currentProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag-to-resize
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      const startX = e.clientX;
      const startW = panelWidth;
      const onMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        setPanelWidth(Math.max(280, Math.min(700, startW + (startX - ev.clientX))));
      };
      const onUp = () => {
        resizingRef.current = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [panelWidth],
  );

  const greetingMessage: MetaAgentMessage = {
    id: 'greeting',
    role: 'assistant',
    content: greeting,
    timestamp: Date.now(),
  };

  // ── 全面板拖拽/粘贴 → 委托给 ChatInput ──
  const dragCounterRef = useRef(0); // 防止子元素 dragLeave 误触
  const handlePanelDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) setPanelDragOver(true);
  }, []);
  const handlePanelDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);
  const handlePanelDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setPanelDragOver(false);
    }
  }, []);
  const handlePanelDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setPanelDragOver(false);
    if (e.dataTransfer.files.length > 0 && chatInputRef.current) {
      await chatInputRef.current.addFilesFromDrop(e.dataTransfer.files);
      chatInputRef.current.focus();
    }
  }, []);
  /** 全面板粘贴监听 — 当焦点不在 textarea 时也能粘贴图片 */
  const handlePanelPaste = useCallback((e: React.ClipboardEvent) => {
    // 如果焦点已经在 textarea 上，ChatInput 自己会处理，这里不重复
    if ((e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault();
        chatInputRef.current?.addImageFromClipboard(items);
        chatInputRef.current?.focus();
        return;
      }
    }
  }, []);

  const handleSend = async (inputText: string, inputAttachments: ChatAttachment[]) => {
    if ((!inputText.trim() && inputAttachments.length === 0) || sending) return;

    let sessionId = currentSessionId;
    if (!sessionId) {
      try {
        const newSession = await window.automater.session.create(
          currentProjectId,
          META_AGENT_ID,
          'meta-agent',
          currentChatMode,
        );
        sessionId = newSession.id;
        setCurrentSessionId(sessionId);
      } catch {
        sessionId = null;
      }
    }

    const activeChatKey = sessionId || currentProjectId || '_global';

    // v28.0: 附件处理
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

    // 持久化 user 消息 (含附件)
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

    const assistantMsgId = String(Date.now() + 1);
    addMessage(activeChatKey, { id: assistantMsgId, role: 'assistant', content: '思考中...', timestamp: Date.now() });

    try {
      const currentMsgs = messagesMap.get(activeChatKey) || [];
      const history = [...currentMsgs].slice(-20).map(m => ({ role: m.role as string, content: m.content }));
      const result = await window.automater.metaAgent.chat(
        currentProjectId,
        userMsg.content,
        history,
        msgAttachments,
        currentChatMode,
        sessionId,
      );
      updateLastAssistant(activeChatKey, result.reply);

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
      if (result.wishCreated) window.dispatchEvent(new CustomEvent('meta-agent:wish-created'));
    } catch (err: unknown) {
      const errContent = `❌ 错误: ${friendlyErrorMessage(err) || '未知'}`;
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
      // v28.1: 把本轮工作消息持久绑定到最后一条 assistant 消息
      const roundWorkMsgs = metaAgentWorkMsgs.slice(sendingStartMsgIndexRef.current);
      if (roundWorkMsgs.length > 0) {
        attachWorkMsgs(activeChatKey, [...roundWorkMsgs]);
      }
      setSending(false);
    }
  };

  const displayMessages = messages.length === 0 ? [greetingMessage] : messages;
  const currentRoundWorkMsgs = sending ? metaAgentWorkMsgs.slice(sendingStartMsgIndexRef.current) : [];

  // SVG icons
  const gearIcon = (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="13"
      height="13"
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
  );

  return (
    <>
      <div
        className="h-full border-l border-slate-800 flex flex-col bg-slate-950 transition-all duration-300 ease-in-out relative flex-shrink-0"
        style={{ width: open ? `${panelWidth}px` : '40px' }}
        onDragEnter={handlePanelDragEnter}
        onDragOver={handlePanelDragOver}
        onDragLeave={handlePanelDragLeave}
        onDrop={handlePanelDrop}
        onPaste={handlePanelPaste}
      >
        {/* 模式切换 Toast */}
        {modeToast && (
          <div className="absolute top-12 left-1/2 -translate-x-1/2 z-[80] px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg shadow-xl text-[11px] text-slate-200 whitespace-nowrap animate-fade-in">
            {modeToast}
          </div>
        )}
        {/* 模式切换 Popover — fixed 定位避免 overflow 裁剪 */}
        {modePopoverOpen && modePopoverPos && (
          <div
            ref={modePopoverContentRef}
            className="fixed z-[60] flex items-stretch bg-slate-900 border border-slate-700 rounded-xl shadow-2xl shadow-black/50 overflow-hidden"
            style={{ top: modePopoverPos.top, left: modePopoverPos.left }}
            onClick={e => e.stopPropagation()}
          >
            {(['work', 'chat', 'deep', 'admin'] as ChatMode[]).map(m => {
              const mi = CHAT_MODE_INFO[m];
              const isActive = m === currentChatMode;
              return (
                <button
                  key={m}
                  onClick={() => handleModeSwitch(m)}
                  className={`relative flex flex-col items-center gap-1 px-3 py-2 transition-all min-w-[50px]
                    ${isActive ? 'bg-forge-600/20 border-b-2 border-forge-500' : 'hover:bg-slate-800/80 border-b-2 border-transparent'}`}
                >
                  <span className="text-sm">{mi.icon}</span>
                  <span
                    className={`text-[9px] font-medium whitespace-nowrap ${isActive ? 'text-forge-400' : 'text-slate-400'}`}
                  >
                    {mi.label}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {/* 左边缘拖拽手柄 */}
        {open && (
          <div
            onMouseDown={handleResizeStart}
            className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-forge-500/40 transition-colors z-10"
          />
        )}

        {/* Toggle button bar */}
        <div className="h-10 flex items-center border-b border-slate-800 shrink-0 relative">
          <div
            onClick={toggle}
            className="flex-1 h-full flex items-center justify-center gap-1.5 hover:bg-slate-900 transition-colors cursor-pointer"
            title={open ? '收起管家面板' : '展开管家面板'}
          >
            {open ? (
              <>
                <span className="text-xs">🤖</span>
                <span className="text-[11px] text-slate-400 font-medium flex-1 text-left truncate">{agentName}</span>
              </>
            ) : (
              <span className="text-sm" title={agentName}>
                🤖
              </span>
            )}
          </div>
          {/* 模式指示器 · 点击切换 — 独立于 toggle 区域，避免 button 嵌套 */}
          {open && (
            <span className="inline-flex items-center mr-1" ref={modePopoverRef}>
              <button
                onClick={e => {
                  e.stopPropagation();
                  if (!modePopoverOpen && modePopoverRef.current) {
                    const rect = modePopoverRef.current.getBoundingClientRect();
                    setModePopoverPos({ top: rect.bottom + 4, left: rect.left });
                  }
                  setModePopoverOpen(!modePopoverOpen);
                }}
                className={`text-[9px] px-1.5 py-0.5 rounded-md ${currentModeInfo.color} hover:bg-slate-800 transition-colors`}
                title={`${currentModeInfo.label}模式 · 点击切换`}
              >
                {currentModeInfo.icon} {currentModeInfo.label}
              </button>
            </span>
          )}
          {open && (
            <>
              {/* 会话切换下拉按钮 */}
              <button
                onClick={e => {
                  e.stopPropagation();
                  setDropdownOpen(!dropdownOpen);
                }}
                className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-forge-400 hover:bg-slate-800 rounded-lg transition-all"
                title="切换会话"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </button>
              {/* v26.0: 工作过程开关 */}
              <button
                onClick={e => {
                  e.stopPropagation();
                  setShowWorkDetails(!showWorkDetails);
                }}
                className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all ${
                  showWorkDetails
                    ? 'text-forge-400 bg-forge-600/15 hover:bg-forge-600/25'
                    : 'text-slate-600 hover:text-slate-400 hover:bg-slate-800'
                }`}
                title={showWorkDetails ? '隐藏工作过程' : '显示工作过程'}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                  <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                </svg>
              </button>
              <button
                onClick={e => {
                  e.stopPropagation();
                  setSettingsOpen(true);
                }}
                className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-forge-400 hover:bg-slate-800 rounded-lg transition-all"
                title="管家设置"
              >
                {gearIcon}
              </button>
              <button
                onClick={toggle}
                className="w-8 h-8 flex items-center justify-center text-slate-600 hover:text-slate-400 transition-colors mr-1"
                title="收起"
              >
                <span className="text-xs">▸</span>
              </button>
            </>
          )}
          {/* 下拉选单 */}
          {open && dropdownOpen && <SessionDropdown onClose={() => setDropdownOpen(false)} />}
        </div>

        {open && (
          <>
            {/* 拖拽覆盖层 */}
            {panelDragOver && (
              <div className="absolute inset-0 z-[70] bg-forge-600/10 border-2 border-dashed border-forge-500/50 rounded-lg flex items-center justify-center pointer-events-none">
                <div className="bg-slate-900/90 border border-forge-500/40 rounded-xl px-4 py-3 text-center shadow-2xl">
                  <div className="text-2xl mb-1">📎</div>
                  <div className="text-xs text-forge-400">松开以添加附件</div>
                </div>
              </div>
            )}
            {/* Messages + 内联思考过程 */}
            <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
              {displayMessages.map((msg, idx) => (
                <div key={msg.id}>
                  <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[90%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-forge-600/20 text-forge-200 rounded-br-sm whitespace-pre-wrap'
                          : 'bg-slate-800/80 text-slate-300 rounded-bl-sm'
                      }`}
                    >
                      {msg.role === 'assistant' ? (
                        <div
                          className="markdown-body"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                        />
                      ) : (
                        <>
                          {msg.content && <div className="whitespace-pre-wrap">{msg.content}</div>}
                          {msg.attachments && <MessageAttachments attachments={msg.attachments} />}
                        </>
                      )}
                      {msg.triggeredWish && <div className="mt-0.5 text-[9px] text-emerald-400">✅ 已创建需求</div>}
                      <div
                        className={`flex items-center gap-1.5 text-[8px] mt-0.5 ${msg.role === 'user' ? 'text-forge-400/40 justify-end' : 'text-slate-600'}`}
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

                  {/* v31.0: 实时工作过程 — 受 showWorkDetails 开关控制 */}
                  {showWorkDetails &&
                    sending &&
                    idx === displayMessages.length - 1 &&
                    msg.role === 'assistant' &&
                    currentRoundWorkMsgs.length > 0 && (
                      <div className="mt-2 space-y-1.5 pl-1">
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-500 mb-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          <span>ReAct 工作流 · {currentRoundWorkMsgs.length} 条</span>
                        </div>
                        {currentRoundWorkMsgs.map(wm => (
                          <InlineWorkMessage key={wm.id} msg={wm} />
                        ))}
                      </div>
                    )}
                  {/* v31.0: 已完成对话的工作过程回顾 — Compact/Full 双模式 (showWorkDetails 控制) */}
                  {showWorkDetails &&
                    !sending &&
                    msg.role === 'assistant' &&
                    msg.workMessages &&
                    msg.workMessages.length > 0 && (
                      <CollapsibleWorkBlock workMessages={msg.workMessages} compact defaultExpanded />
                    )}
                  {/* Compact 模式: 仅显示步骤数摘要 */}
                  {!showWorkDetails &&
                    !sending &&
                    msg.role === 'assistant' &&
                    msg.workMessages &&
                    msg.workMessages.length > 0 && (
                      <div className="mt-0.5 text-[9px] text-slate-600">
                        📋 {msg.workMessages.length} 步工作过程
                        {msg.workMessages.filter(m => m.diff).length > 0 && (
                          <span className="ml-1 text-amber-500/50">
                            📝{msg.workMessages.filter(m => m.diff).length}
                          </span>
                        )}
                      </div>
                    )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            {/* Input — v29.0: 支持附件上传 + 全面板拖拽/粘贴 (紧凑版) */}
            <ChatInput ref={chatInputRef} onSend={handleSend} sending={sending} placeholder="发消息..." compact />
          </>
        )}
      </div>

      {settingsOpen && <MetaAgentSettings onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
