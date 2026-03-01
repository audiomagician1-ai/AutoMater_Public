/**
 * MetaAgentPanel — 全局右侧可伸缩元Agent对话面板
 *
 * 收起时: 窄条 (40px) 带 🤖 图标按钮
 * 展开时: 1/5 宽度 (~280px) 带完整对话
 *
 * v5.4: 使用 Zustand store 持久化消息 + 真实 LLM 后端
 */

import { useState, useEffect, useRef } from 'react';
import { useAppStore, type MetaAgentMessage } from '../stores/app-store';

const GREETING: MetaAgentMessage = {
  id: 'greeting',
  role: 'assistant',
  content: '你好！我是元Agent管家。告诉我你的需求，或问我任何项目相关的问题。',
  timestamp: Date.now(),
};

export function MetaAgentPanel() {
  const open = useAppStore(s => s.metaAgentPanelOpen);
  const toggle = useAppStore(s => s.toggleMetaAgentPanel);
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const messagesMap = useAppStore(s => s.metaAgentMessages);
  const addMessage = useAppStore(s => s.addMetaAgentMessage);
  const updateLastAssistant = useAppStore(s => s.updateLastAssistantMessage);

  const chatKey = currentProjectId || '_global';
  const messages = messagesMap.get(chatKey) || [];

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    const userMsg: MetaAgentMessage = {
      id: String(Date.now()),
      role: 'user',
      content: input.trim(),
      timestamp: Date.now(),
    };
    addMessage(chatKey, userMsg);
    setInput('');
    setSending(true);

    // Placeholder
    addMessage(chatKey, {
      id: String(Date.now() + 1),
      role: 'assistant',
      content: '思考中...',
      timestamp: Date.now(),
    });

    try {
      const history = messages.slice(-20).map(m => ({ role: m.role as string, content: m.content }));
      const result = await window.agentforge.metaAgent.chat(currentProjectId, userMsg.content, history);
      updateLastAssistant(chatKey, result.reply);
      if (result.wishCreated) {
        window.dispatchEvent(new CustomEvent('meta-agent:wish-created'));
      }
    } catch (err: any) {
      updateLastAssistant(chatKey, `❌ 错误: ${err.message || '未知'}`);
    } finally {
      setSending(false);
    }
  };

  const displayMessages = messages.length === 0 ? [GREETING] : messages;

  return (
    <div
      className={`h-full border-l border-slate-800 flex flex-col bg-slate-950 transition-all duration-300 ease-in-out ${
        open ? 'w-[280px]' : 'w-[40px]'
      } flex-shrink-0`}
    >
      {/* Toggle button bar */}
      <button
        onClick={toggle}
        className="h-10 flex items-center justify-center gap-1.5 border-b border-slate-800 hover:bg-slate-900 transition-colors shrink-0"
        title={open ? '收起管家面板' : '展开管家面板'}
      >
        {open ? (
          <>
            <span className="text-xs">🤖</span>
            <span className="text-[11px] text-slate-400 font-medium flex-1 text-left truncate">元Agent · 管家</span>
            <span className="text-slate-600 text-xs mr-2">▸</span>
          </>
        ) : (
          <span className="text-sm" title="元Agent管家">🤖</span>
        )}
      </button>

      {open && (
        <>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
            {displayMessages.map(msg => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[90%] rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-forge-600/20 text-forge-200 rounded-br-sm'
                      : 'bg-slate-800/80 text-slate-300 rounded-bl-sm'
                  }`}
                >
                  {msg.content}
                  {msg.triggeredWish && (
                    <div className="mt-0.5 text-[9px] text-emerald-400">✅ 已创建需求</div>
                  )}
                  <div className={`text-[8px] mt-0.5 ${msg.role === 'user' ? 'text-forge-400/40 text-right' : 'text-slate-600'}`}>
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          {/* Input */}
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
  );
}

