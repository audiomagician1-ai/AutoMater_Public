/**
 * WishPage v5.0 — 需求管理 + 元Agent对话
 *
 * 左侧: 需求列表 (agent自主识别迭代需求)
 * 右侧: 元Agent对话页面 — 跨项目通用管家, 默认轻量上下文
 *        用户可通过管家按需查询任何项目的设计细节和技术架构
 *        分诊新需求/迭代需求的职责由 PM 承担 (需要项目上下文)
 *
 * v20.0: 右侧对话区加入常驻会话历史列表 + session 持久化
 * v30.2: 拆分为 wish/ 子模块 (SessionListPanel/WishDetailPanel/constants)
 *
 * @module WishPage
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAppStore, type MetaAgentMessage, type AgentWorkMessage } from '../stores/app-store';
import type { MetaSessionItem, ChatMode } from '../stores/slices/meta-agent-slice';
import { friendlyErrorMessage } from '../utils/errors';
import { toast, confirm } from '../stores/toast-store';
import { renderMarkdown } from '../utils/markdown';
import { EmptyState } from '../components/EmptyState';
import { MSG_STYLES } from '../components/AgentWorkFeed';
import { ChatInput, type ChatAttachment, type ChatInputHandle } from '../components/ChatInput';
import { MessageAttachments } from '../components/MessageAttachments';
import { MetaAgentSettings } from '../components/MetaAgentSettings';

// v30.2: Sub-module imports
import { WISH_STATUS, CHAT_MODE_INFO } from './wish/wish-constants';
import { SessionListPanel } from './wish/SessionListPanel';
import { WishDetailPanel, type WishItem, type FeatureItem } from './wish/WishDetailPanel';

const GREETING: MetaAgentMessage = {
  id: 'greeting',
  role: 'assistant',
  content:
    '你好！我是元Agent管家，你的一站式项目助手。你可以：\n• 直接告诉我你的需求想法，我会自动创建并启动开发\n• 查询任何项目的设计文档、技术架构、进度状态\n• 调整工作流程、查看团队配置\n有什么需要？',
  timestamp: Date.now(),
};

const META_AGENT_ID = 'meta-agent';

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
// CollapsibleWorkBlock — 已完成对话的工作过程折叠区
// ═══════════════════════════════════════

function CollapsibleWorkBlock({ workMessages }: { workMessages: AgentWorkMessage[] }) {
  const [expanded, setExpanded] = useState(true);
  const thinkCount = workMessages.filter(m => m.type === 'think').length;
  const toolCount = workMessages.filter(m => m.type === 'tool-result' || m.type === 'tool-call').length;

  return (
    <div className="mt-1.5 max-w-[85%]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[10px] text-slate-500 hover:text-slate-300 transition-colors py-0.5 group"
      >
        <span className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>▸</span>
        <span className="w-1 h-1 rounded-full bg-slate-600 group-hover:bg-slate-400 shrink-0" />
        <span>工作过程 · {workMessages.length} 步</span>
        {thinkCount > 0 && <span className="text-blue-500/60">💭{thinkCount}</span>}
        {toolCount > 0 && <span className="text-emerald-500/60">🔧{toolCount}</span>}
      </button>
      {expanded && (
        <div className="mt-1 space-y-1 pl-1.5 border-l border-slate-800/50">
          {workMessages.map(wm => (
            <InlineWorkMessage key={wm.id} msg={wm} />
          ))}
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
  const messages = useMemo(() => messagesMap.get(chatKey) || [], [messagesMap, chatKey]);

  // v26.0: 全局开关 — 显示工作过程细节
  const [_showWorkDetails, _setShowWorkDetails] = useState(false); // reserved for future work-details toggle
  const [modeToast, setModeToast] = useState<string | null>(null);
  const showModeToast = (msg: string) => {
    setModeToast(msg);
    setTimeout(() => setModeToast(null), 1800);
  };

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
  const [modePopoverPos, setModePopoverPos] = useState<{ top: number; left: number } | null>(null);

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
        // 立即更新本地 sessionList 中的 chatMode（不等远程刷新）
        const store = useAppStore.getState();
        const updatedList = store.metaSessionList.map(s => (s.id === currentSessionId ? { ...s, chatMode: mode } : s));
        store.setMetaSessionList(updatedList as MetaSessionItem[]);
        // 同时后台刷新完整列表以同步其他字段
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
        showModeToast(`${mi.icon} 已切换为${mi.label}模式`);
      } catch (err) {
        console.error('[WishPage] handleModeSwitch failed:', err);
        showModeToast('❌ 模式切换失败');
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
  const chatInputRef = useRef<ChatInputHandle>(null);
  const [panelDragOver, setPanelDragOver] = useState(false);

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

  // ── 全面板拖拽/粘贴 → 委托给 ChatInput ──
  const dragCounterRef = useRef(0);
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
  const handlePanelPaste = useCallback((e: React.ClipboardEvent) => {
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
      // v28.1: 把本轮工作消息持久绑定到最后一条 assistant 消息, 防止消失
      const roundWorkMsgs = metaAgentWorkMsgs.slice(sendingStartMsgIndexRef.current);
      if (roundWorkMsgs.length > 0) {
        attachWorkMsgs(activeChatKey, [...roundWorkMsgs]);
      }
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
      <div
        className="flex-1 flex flex-col min-w-0 relative"
        onDragEnter={handlePanelDragEnter}
        onDragOver={handlePanelDragOver}
        onDragLeave={handlePanelDragLeave}
        onDrop={handlePanelDrop}
        onPaste={handlePanelPaste}
      >
        {/* 模式切换 Toast */}
        {modeToast && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[80] px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg shadow-xl text-[11px] text-slate-200 whitespace-nowrap animate-fade-in">
            {modeToast}
          </div>
        )}
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
                  onClick={() => {
                    if (!modePopoverOpen && modePopoverRef.current) {
                      const rect = modePopoverRef.current.getBoundingClientRect();
                      setModePopoverPos({ top: rect.bottom + 4, left: rect.left });
                    }
                    setModePopoverOpen(!modePopoverOpen);
                  }}
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
                {modePopoverOpen && modePopoverPos && (
                  <div
                    className="fixed z-[60] flex items-stretch bg-slate-900 border border-slate-700 rounded-xl shadow-2xl shadow-black/50 overflow-hidden"
                    style={{ top: modePopoverPos.top, left: modePopoverPos.left }}
                  >
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

        {/* 拖拽覆盖层 */}
        {panelDragOver && (
          <div className="absolute inset-0 z-[70] bg-forge-600/10 border-2 border-dashed border-forge-500/50 rounded-lg flex items-center justify-center pointer-events-none">
            <div className="bg-slate-900/90 border border-forge-500/40 rounded-xl px-5 py-4 text-center shadow-2xl">
              <div className="text-3xl mb-1.5">📎</div>
              <div className="text-sm text-forge-400">松开以添加附件</div>
              <div className="text-[10px] text-slate-500 mt-0.5">支持图片和文件</div>
            </div>
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

              {/* 思维过程 / 工具调用 — 实时展示(sending) 或 已完成回顾(workMessages) */}
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
              {/* v28.1: 已完成的消息 — 折叠式工作过程回顾 */}
              {!sending && msg.role === 'assistant' && msg.workMessages && msg.workMessages.length > 0 && (
                <CollapsibleWorkBlock workMessages={msg.workMessages} />
              )}
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>

        {/* Input — v29.0: 支持附件上传 + 全面板拖拽/粘贴 */}
        <ChatInput
          ref={chatInputRef}
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
