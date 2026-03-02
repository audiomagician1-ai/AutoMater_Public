/**
 * MetaAgentPanel — 全局右侧可伸缩元Agent对话面板
 *
 * v5.4: Zustand store 持久化消息 + LLM 后端
 * v7.0: 动态名字/开场白 + 管理入口
 * v16.0: 思考过程完整内联展示 + 面板宽度可拖拽调整
 * v20.0: 左侧 session 历史列表 + 新建对话 + 会话切换
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppStore, type MetaAgentMessage, type AgentWorkMessage } from '../stores/app-store';
import type { MetaSessionItem } from '../stores/slices/meta-agent-slice';
import { MetaAgentSettings } from './MetaAgentSettings';
import { MSG_STYLES } from './AgentWorkFeed';
import { friendlyErrorMessage } from '../utils/errors';
import { renderMarkdown } from '../utils/markdown';

const EMPTY_WORK_MSGS: readonly AgentWorkMessage[] = [];
const META_AGENT_ID = 'meta-agent';

// ═══════════════════════════════════════
// InlineWorkMessage — 内联工具活动消息卡片
// ═══════════════════════════════════════

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
            <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${msg.tool.success ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
              {msg.tool.name}
            </span>
            <span className="text-[10px] text-slate-500 truncate max-w-[200px]">{msg.tool.args}</span>
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
        <div className="text-[9px] text-slate-600 mt-0.5 cursor-pointer hover:text-slate-400" onClick={() => setExpanded(true)}>
          点击展开 ▸
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════
// Session 列表项标题提取
// ═══════════════════════════════════════

function sessionTitle(sess: MetaSessionItem, messages: MetaAgentMessage[]): string {
  if (sess.title) return sess.title;
  // 尝试从该 session 的第一条 user 消息提取标题
  const firstUser = messages.find(m => m.role === 'user');
  if (firstUser) return firstUser.content.slice(0, 30) + (firstUser.content.length > 30 ? '…' : '');
  return `会话 #${sess.agentSeq}`;
}

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

// ═══════════════════════════════════════
// SessionSidebar — 左侧会话列表
// ═══════════════════════════════════════

function SessionSidebar({ onNewChat }: { onNewChat: () => void }) {
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const sessionList = useAppStore(s => s.metaSessionList);
  const currentSessionId = useAppStore(s => s.currentMetaSessionId);
  const setCurrentSessionId = useAppStore(s => s.setCurrentMetaSessionId);
  const setSessionList = useAppStore(s => s.setMetaSessionList);
  const loading = useAppStore(s => s.metaSessionsLoading);
  const setLoading = useAppStore(s => s.setMetaSessionsLoading);
  const messagesMap = useAppStore(s => s.metaAgentMessages);
  const setMessages = useAppStore(s => s.setMetaAgentMessages);

  // 加载 session 列表 — 使用 listChatSessions 获取带标题的列表
  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.automater.metaAgent.listChatSessions(currentProjectId);
      const enriched: MetaSessionItem[] = (list || []).map((s) => ({
        id: s.id,
        projectId: s.projectId,
        agentId: s.agentId,
        agentRole: s.agentRole,
        agentSeq: s.agentSeq,
        status: s.status,
        createdAt: s.createdAt,
        completedAt: s.completedAt,
        messageCount: s.messageCount,
        totalTokens: s.totalTokens,
        totalCost: s.totalCost,
        title: (s as { title?: string | null }).title || undefined,
      }));
      setSessionList(enriched);
    } catch { /* silent */ }
    setLoading(false);
  }, [currentProjectId, setLoading, setSessionList]);

  useEffect(() => { loadSessions(); }, [currentProjectId]);

  // 定时刷新
  useEffect(() => {
    const t = setInterval(loadSessions, 15_000);
    return () => clearInterval(t);
  }, [loadSessions]);

  // 选中某个历史 session — 从 DB 加载消息
  const selectSession = useCallback(async (sessId: string) => {
    setCurrentSessionId(sessId);
    // 如果已有缓存消息则直接使用
    if (messagesMap.has(sessId) && (messagesMap.get(sessId)?.length ?? 0) > 0) return;
    // 从 DB 加载持久化消息
    try {
      const rows = await window.automater.metaAgent.loadMessages(sessId);
      if (rows?.length) {
        const mapped: MetaAgentMessage[] = rows.map((r) => ({
          id: r.id,
          role: r.role as 'user' | 'assistant',
          content: r.content,
          timestamp: new Date(r.createdAt).getTime(),
          triggeredWish: r.triggeredWish || undefined,
          attachments: r.attachments?.map((a: { type: string; name: string; data: string; mimeType: string }) => ({
            ...a,
            type: a.type as 'image' | 'file',
          })) || undefined,
        }));
        setMessages(sessId, mapped);
      }
    } catch { /* silent: session message load failure */ }
  }, [messagesMap, setCurrentSessionId, setMessages]);

  const isNewChat = currentSessionId === null;

  return (
    <div className="w-48 shrink-0 border-r border-slate-800 bg-slate-950/80 flex flex-col">
      {/* 新建对话按钮 */}
      <div className="px-2 py-2 border-b border-slate-800">
        <button
          onClick={onNewChat}
          className={`w-full px-2.5 py-2 rounded-lg text-left text-xs transition-colors flex items-center gap-2
            ${isNewChat
              ? 'bg-forge-600/20 border border-forge-500/40 text-forge-300'
              : 'bg-slate-900 border border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-300'}`}
        >
          <span className="text-sm">✦</span>
          <span className="font-medium">新对话</span>
        </button>
      </div>

      {/* Session 列表 */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
        {loading && sessionList.length === 0 && (
          <div className="text-center py-6 text-slate-600 text-[10px] animate-pulse">加载中...</div>
        )}

        {sessionList.map(sess => {
          const isSelected = currentSessionId === sess.id;
          const msgs = messagesMap.get(sess.id) || [];
          const title = sessionTitle(sess, msgs);
          const isActive = sess.status === 'active';

          return (
            <button
              key={sess.id}
              onClick={() => selectSession(sess.id)}
              className={`w-full text-left px-2.5 py-2 rounded-lg text-[11px] transition-colors group
                ${isSelected
                  ? 'bg-forge-600/15 border border-forge-500/30 text-slate-200'
                  : 'border border-transparent hover:bg-slate-900/80 hover:border-slate-800 text-slate-400'}`}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                {isActive && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />}
                <span className="truncate font-medium">{title}</span>
              </div>
              <div className="flex items-center gap-1.5 text-[9px] text-slate-600">
                <span>{formatTime(sess.createdAt)}</span>
                {sess.totalTokens > 0 && <span>{formatTokens(sess.totalTokens)}</span>}
                {sess.totalCost > 0 && <span className="text-emerald-700">${sess.totalCost.toFixed(3)}</span>}
              </div>
            </button>
          );
        })}

        {!loading && sessionList.length === 0 && (
          <div className="text-center py-8 text-slate-600 text-[10px]">
            <div className="text-lg mb-1.5">💬</div>
            暂无历史会话<br />
            <span className="text-slate-700">点击「新对话」开始</span>
          </div>
        )}
      </div>

      {/* 底部统计 */}
      {sessionList.length > 0 && (
        <div className="px-2.5 py-1.5 border-t border-slate-800 text-[9px] text-slate-600">
          共 {sessionList.length} 个会话
        </div>
      )}
    </div>
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
  const settingsOpen = useAppStore(s => s.metaAgentSettingsOpen);
  const setSettingsOpen = useAppStore(s => s.setMetaAgentSettingsOpen);
  const sidebarOpen = useAppStore(s => s.metaSessionSidebarOpen);
  const toggleSidebar = useAppStore(s => s.toggleMetaSessionSidebar);
  const currentSessionId = useAppStore(s => s.currentMetaSessionId);
  const setCurrentSessionId = useAppStore(s => s.setCurrentMetaSessionId);

  // chatKey: session 优先, 否则用 projectId/_global
  const chatKey = currentSessionId || currentProjectId || '_global';
  const messages = messagesMap.get(chatKey) || [];

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [agentName, setAgentName] = useState('元Agent · 管家');
  const [greeting, setGreeting] = useState('你好！我是元Agent管家。告诉我你的需求，或问我任何项目相关的问题。');
  const [panelWidth, setPanelWidth] = useState(420);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);
  const sendingStartMsgIndexRef = useRef(0);
  const metaAgentWorkMsgsRaw = useAppStore(s => s.agentWorkMessages.get(META_AGENT_ID));
  const metaAgentWorkMsgs = metaAgentWorkMsgsRaw ?? EMPTY_WORK_MSGS;

  // Load config
  useEffect(() => {
    window.automater.metaAgent.getConfig().then((config: MetaAgentConfig) => {
      if (config.name) setAgentName(config.name);
      if (config.greeting) setGreeting(config.greeting);
    }).catch(() => {});
  }, [settingsOpen]);

  // Auto-scroll on new messages / work messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, metaAgentWorkMsgs.length]);

  // 切换项目时重置 session + 恢复最近活跃会话
  useEffect(() => {
    setCurrentSessionId(null);
    // 启动时/切换项目时: 从 DB 加载最近活跃会话并恢复
    (async () => {
      try {
        const sessions = await window.automater.metaAgent.listChatSessions(currentProjectId, 1);
        if (sessions?.length) {
          const latest = sessions[0];
          if (latest.status === 'active') {
            // 恢复活跃会话的消息
            const rows = await window.automater.metaAgent.loadMessages(latest.id);
            if (rows?.length) {
              const mapped: MetaAgentMessage[] = rows.map(r => ({
                id: r.id,
                role: r.role as 'user' | 'assistant',
                content: r.content,
                timestamp: new Date(r.createdAt).getTime(),
                triggeredWish: r.triggeredWish || undefined,
                attachments: r.attachments?.map((a: { type: string; name: string; data: string; mimeType: string }) => ({
                  ...a,
                  type: a.type as 'image' | 'file',
                })) || undefined,
              }));
              useAppStore.getState().setMetaAgentMessages(latest.id, mapped);
              setCurrentSessionId(latest.id);
            }
          }
        }
      } catch { /* silent: first load may fail */ }
    })();
  }, [currentProjectId, setCurrentSessionId]);

  // Drag-to-resize
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const startX = e.clientX;
    const startW = panelWidth;
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      setPanelWidth(Math.max(340, Math.min(900, startW + (startX - ev.clientX))));
    };
    const onUp = () => {
      resizingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panelWidth]);

  const greetingMessage: MetaAgentMessage = {
    id: 'greeting', role: 'assistant', content: greeting, timestamp: Date.now(),
  };

  // 新建对话 — 清空当前 session, 进入干净状态
  const handleNewChat = useCallback(() => {
    setCurrentSessionId(null);
  }, [setCurrentSessionId]);

  const handleSend = async () => {
    if (!input.trim() || sending) return;

    // 如果是新对话(无 sessionId), 先创建 session
    let sessionId = currentSessionId;
    if (!sessionId) {
      try {
        const newSession = await window.automater.session.create(currentProjectId, META_AGENT_ID, 'meta-agent');
        sessionId = newSession.id;
        setCurrentSessionId(sessionId);
      } catch {
        // 创建失败, 用 fallback chatKey
        sessionId = null;
      }
    }

    const activeChatKey = sessionId || currentProjectId || '_global';

    const userMsg: MetaAgentMessage = {
      id: String(Date.now()), role: 'user', content: input.trim(), timestamp: Date.now(),
    };
    addMessage(activeChatKey, userMsg);
    setInput('');
    setSending(true);
    sendingStartMsgIndexRef.current = metaAgentWorkMsgs.length;

    // 持久化 user 消息到 DB
    if (sessionId) {
      window.automater.metaAgent.saveMessage({
        id: userMsg.id, sessionId, projectId: currentProjectId,
        role: 'user', content: userMsg.content,
      }).catch(() => { /* silent */ });
    }

    // Placeholder assistant message
    const assistantMsgId = String(Date.now() + 1);
    addMessage(activeChatKey, { id: assistantMsgId, role: 'assistant', content: '思考中...', timestamp: Date.now() });

    try {
      const currentMsgs = messagesMap.get(activeChatKey) || [];
      const history = [...currentMsgs].slice(-20).map(m => ({ role: m.role as string, content: m.content }));
      const result = await window.automater.metaAgent.chat(currentProjectId, userMsg.content, history);
      updateLastAssistant(activeChatKey, result.reply);

      // 持久化 assistant 回复到 DB
      if (sessionId) {
        window.automater.metaAgent.saveMessage({
          id: assistantMsgId, sessionId, projectId: currentProjectId,
          role: 'assistant', content: result.reply,
          triggeredWish: result.wishCreated,
        }).catch(() => { /* silent */ });
      }

      if (result.wishCreated) window.dispatchEvent(new CustomEvent('meta-agent:wish-created'));
    } catch (err: unknown) {
      const errContent = `❌ 错误: ${friendlyErrorMessage(err) || '未知'}`;
      updateLastAssistant(activeChatKey, errContent);
      // 持久化错误消息
      if (sessionId) {
        window.automater.metaAgent.saveMessage({
          id: assistantMsgId, sessionId, projectId: currentProjectId,
          role: 'assistant', content: errContent,
        }).catch(() => { /* silent */ });
      }
    } finally {
      setSending(false);
    }
  };

  const displayMessages = messages.length === 0 ? [greetingMessage] : messages;
  const currentRoundWorkMsgs = sending ? metaAgentWorkMsgs.slice(sendingStartMsgIndexRef.current) : [];

  // 查看历史会话时禁用输入
  const isViewingHistory = currentSessionId !== null && (() => {
    const sessionList = useAppStore.getState().metaSessionList;
    const sess = sessionList.find(s => s.id === currentSessionId);
    return sess?.status === 'completed' || sess?.status === 'archived';
  })();

  // SVG icon
  const gearIcon = (
    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );

  const sidebarIcon = (
    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );

  return (
    <>
      <div
        className="h-full border-l border-slate-800 flex bg-slate-950 transition-all duration-300 ease-in-out relative flex-shrink-0"
        style={{ width: open ? `${panelWidth}px` : '40px' }}
      >
        {/* 左边缘拖拽手柄 */}
        {open && (
          <div onMouseDown={handleResizeStart} className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-forge-500/40 transition-colors z-10" />
        )}

        {/* Session 列表侧栏 */}
        {open && sidebarOpen && <SessionSidebar onNewChat={handleNewChat} />}

        {/* 右侧主内容区 */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Toggle button bar */}
          <div className="h-10 flex items-center border-b border-slate-800 shrink-0">
            {open && (
              <button onClick={toggleSidebar} className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-forge-400 hover:bg-slate-800 rounded-lg transition-all ml-1" title={sidebarOpen ? '隐藏会话列表' : '显示会话列表'}>
                {sidebarIcon}
              </button>
            )}
            <button onClick={toggle} className="flex-1 h-full flex items-center justify-center gap-1.5 hover:bg-slate-900 transition-colors" title={open ? '收起管家面板' : '展开管家面板'}>
              {open
                ? <><span className="text-xs">🤖</span><span className="text-[11px] text-slate-400 font-medium flex-1 text-left truncate">{agentName}</span></>
                : <span className="text-sm" title={agentName}>🤖</span>}
            </button>
            {open && (
              <>
                <button onClick={(e) => { e.stopPropagation(); setSettingsOpen(true); }} className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-forge-400 hover:bg-slate-800 rounded-lg transition-all mr-0.5" title="管家设置">
                  {gearIcon}
                </button>
                <button onClick={toggle} className="w-8 h-8 flex items-center justify-center text-slate-600 hover:text-slate-400 transition-colors mr-1" title="收起">
                  <span className="text-xs">▸</span>
                </button>
              </>
            )}
          </div>

          {open && (
            <>
              {/* Messages + 内联思考过程 */}
              <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
                {displayMessages.map((msg, idx) => (
                  <div key={msg.id}>
                    <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[90%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-forge-600/20 text-forge-200 rounded-br-sm whitespace-pre-wrap'
                          : 'bg-slate-800/80 text-slate-300 rounded-bl-sm'
                      }`}>
                        {msg.role === 'assistant'
                          ? <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                          : msg.content}
                        {msg.triggeredWish && <div className="mt-0.5 text-[9px] text-emerald-400">✅ 已创建需求</div>}
                        <div className={`text-[8px] mt-0.5 ${msg.role === 'user' ? 'text-forge-400/40 text-right' : 'text-slate-600'}`}>
                          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    </div>

                    {/* 内联思考过程 — 在最后一条 assistant 消息后展示当前轮工作流 */}
                    {sending && idx === displayMessages.length - 1 && msg.role === 'assistant' && currentRoundWorkMsgs.length > 0 && (
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
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>

              {/* Input — 查看历史已完成会话时显示提示 */}
              <div className="shrink-0 px-2 py-1.5 border-t border-slate-800">
                {isViewingHistory ? (
                  <div className="flex items-center justify-center gap-2 py-1.5">
                    <span className="text-[10px] text-slate-500">历史会话 (只读)</span>
                    <button onClick={handleNewChat} className="text-[10px] text-forge-400 hover:text-forge-300 transition-colors">
                      开始新对话 →
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-1">
                    <input
                      value={input}
                      onChange={e => setInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                      placeholder="发消息..."
                      className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 transition-colors"
                      disabled={sending}
                    />
                    <button onClick={handleSend} disabled={!input.trim() || sending} className="px-2 py-1.5 rounded-lg bg-forge-600 hover:bg-forge-500 text-white text-xs transition-all disabled:bg-slate-800 disabled:text-slate-600 shrink-0">
                      {sending ? '·' : '↑'}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {settingsOpen && <MetaAgentSettings onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
