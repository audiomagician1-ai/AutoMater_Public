/**
 * MetaAgentPanel — 全局右侧可伸缩元Agent对话面板
 *
 * v5.4: Zustand store 持久化消息 + LLM 后端
 * v7.0: 动态名字/开场白 + 管理入口
 * v16.0: 思考过程完整内联展示 + 面板宽度可拖拽调整
 * v20.0: session 持久化 (DB) + 顶栏下拉选单切换会话
 *        完整会话历史列表在 WishPage (许愿页) 常驻
 */

import { useState, useEffect, useRef, useCallback, type MouseEvent as ReactMouseEvent } from 'react';
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
            <span
              className={`text-[10px] font-mono px-1 py-0.5 rounded ${msg.tool.success ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}
            >
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

  // 加载 session 列表
  useEffect(() => {
    window.automater.metaAgent
      .listChatSessions(currentProjectId)
      .then(list => {
        setSessionList((list || []).map(s => ({ ...s, title: s.title ?? undefined })) as MetaSessionItem[]);
      })
      .catch(() => {});
  }, [currentProjectId, setSessionList]);

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
            const title = sess.title || `会话 #${sess.agentSeq}`;
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
                  <span className="truncate font-medium">{title}</span>
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
  const settingsOpen = useAppStore(s => s.metaAgentSettingsOpen);
  const setSettingsOpen = useAppStore(s => s.setMetaAgentSettingsOpen);
  const currentSessionId = useAppStore(s => s.currentMetaSessionId);
  const setCurrentSessionId = useAppStore(s => s.setCurrentMetaSessionId);

  // chatKey: session 优先, 否则用 projectId/_global
  const chatKey = currentSessionId || currentProjectId || '_global';
  const messages = messagesMap.get(chatKey) || [];

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [agentName, setAgentName] = useState('元Agent · 管家');
  const [greeting, setGreeting] = useState('你好！我是元Agent管家。告诉我你的需求，或问我任何项目相关的问题。');
  const [panelWidth, setPanelWidth] = useState(380);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
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

  const handleSend = async () => {
    if (!input.trim() || sending) return;

    let sessionId = currentSessionId;
    if (!sessionId) {
      try {
        const newSession = await window.automater.session.create(currentProjectId, META_AGENT_ID, 'meta-agent');
        sessionId = newSession.id;
        setCurrentSessionId(sessionId);
      } catch {
        sessionId = null;
      }
    }

    const activeChatKey = sessionId || currentProjectId || '_global';

    const userMsg: MetaAgentMessage = {
      id: String(Date.now()),
      role: 'user',
      content: input.trim(),
      timestamp: Date.now(),
    };
    addMessage(activeChatKey, userMsg);
    setInput('');
    setSending(true);
    sendingStartMsgIndexRef.current = metaAgentWorkMsgs.length;

    // 持久化 user 消息
    if (sessionId) {
      window.automater.metaAgent
        .saveMessage({
          id: userMsg.id,
          sessionId,
          projectId: currentProjectId,
          role: 'user',
          content: userMsg.content,
        })
        .catch(() => {});
    }

    const assistantMsgId = String(Date.now() + 1);
    addMessage(activeChatKey, { id: assistantMsgId, role: 'assistant', content: '思考中...', timestamp: Date.now() });

    try {
      const currentMsgs = messagesMap.get(activeChatKey) || [];
      const history = [...currentMsgs].slice(-20).map(m => ({ role: m.role as string, content: m.content }));
      const result = await window.automater.metaAgent.chat(currentProjectId, userMsg.content, history);
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
      >
        {/* 左边缘拖拽手柄 */}
        {open && (
          <div
            onMouseDown={handleResizeStart}
            className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-forge-500/40 transition-colors z-10"
          />
        )}

        {/* Toggle button bar */}
        <div className="h-10 flex items-center border-b border-slate-800 shrink-0 relative">
          <button
            onClick={toggle}
            className="flex-1 h-full flex items-center justify-center gap-1.5 hover:bg-slate-900 transition-colors"
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
          </button>
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
                        msg.content
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

                  {sending &&
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
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            {/* Input — 所有会话均可继续对话 */}
            <div className="shrink-0 px-2 py-1.5 border-t border-slate-800">
              <div className="flex gap-1">
                <input
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="发消息..."
                  className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 transition-colors"
                  disabled={sending}
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || sending}
                  className="px-2 py-1.5 rounded-lg bg-forge-600 hover:bg-forge-500 text-white text-xs transition-all disabled:bg-slate-800 disabled:text-slate-600 shrink-0"
                >
                  {sending ? '·' : '↑'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {settingsOpen && <MetaAgentSettings onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
