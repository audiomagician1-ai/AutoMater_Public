/**
 * WishPage v5.0 — 需求管理 + 元Agent对话
 *
 * 左侧: 需求列表 (agent自主识别迭代需求)
 * 右侧: 元Agent对话页面 — 跨项目通用管家, 默认轻量上下文
 *        用户可通过管家按需查询任何项目的设计细节和技术架构
 *        分诊新需求/迭代需求的职责由 PM 承担 (需要项目上下文)
 *
 * @module WishPage
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore, type MetaAgentMessage } from '../stores/app-store';

// ═══════════════════════════════════════
// Constants
// ═══════════════════════════════════════

const WISH_STATUS: Record<string, { text: string; color: string; icon: string }> = {
  pending:    { text: '待分析',   color: 'text-slate-400',   icon: '⏳' },
  analyzing:  { text: 'PM 分析中', color: 'text-blue-400',  icon: '🧠' },
  analyzed:   { text: '已分析',   color: 'text-emerald-400', icon: '✅' },
  developing: { text: '开发中',   color: 'text-amber-400',   icon: '🔨' },
  done:       { text: '已完成',   color: 'text-green-400',   icon: '🎉' },
  rejected:   { text: '已拒绝',   color: 'text-red-400',     icon: '❌' },
};

// ═══════════════════════════════════════
// Meta Agent Chat Panel — 元Agent对话区
// ═══════════════════════════════════════

const GREETING: MetaAgentMessage = {
  id: 'greeting',
  role: 'assistant',
  content: '你好！我是元Agent管家，你的一站式项目助手。你可以：\n• 直接告诉我你的需求想法，我会自动创建并启动开发\n• 查询任何项目的设计文档、技术架构、进度状态\n• 调整工作流程、查看团队配置\n有什么需要？',
  timestamp: Date.now(),
};

function MetaAgentChat({ compact = false }: { compact?: boolean }) {
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

    // Add placeholder
    const placeholderMsg: MetaAgentMessage = {
      id: String(Date.now() + 1),
      role: 'assistant',
      content: '思考中...',
      timestamp: Date.now(),
    };
    addMessage(chatKey, placeholderMsg);

    try {
      // Build history for LLM
      const history = messages.slice(-20).map(m => ({
        role: m.role as string,
        content: m.content,
      }));

      const result = await window.automater.metaAgent.chat(
        currentProjectId,
        userMsg.content,
        history,
      );

      // Replace placeholder with real reply
      updateLastAssistant(chatKey, result.reply);

      // If wish was created, notify the wish list to refresh
      if (result.wishCreated) {
        // Trigger a refresh by dispatching a custom event
        window.dispatchEvent(new CustomEvent('meta-agent:wish-created'));
      }
    } catch (err: any) {
      updateLastAssistant(chatKey, `❌ 请求失败: ${err.message || '未知错误'}。请检查 LLM 设置。`);
    } finally {
      setSending(false);
    }
  };

  // Include greeting if no messages yet
  const displayMessages = messages.length === 0 ? [GREETING] : messages;

  return (
    <div className="flex flex-col h-full">
      {!compact && (
        <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-forge-500 to-indigo-600 flex items-center justify-center text-sm">🤖</div>
          <div>
            <div className="text-sm font-bold text-slate-200">元Agent · 项目管家</div>
            <div className="text-[10px] text-slate-500">需求创建 · 项目查询 · 工作流管理</div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {displayMessages.map(msg => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
              msg.role === 'user'
                ? 'bg-forge-600/20 text-forge-200 rounded-br-md'
                : 'bg-slate-800/80 text-slate-300 rounded-bl-md'
            }`}>
              {msg.content}
              {msg.triggeredWish && (
                <div className="mt-1 text-[10px] text-emerald-400">✅ 已创建需求</div>
              )}
              <div className={`text-[9px] mt-1 ${msg.role === 'user' ? 'text-forge-400/50 text-right' : 'text-slate-600'}`}>
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          </div>
        ))}
        {sending && messages.length > 0 && messages[messages.length - 1]?.content === '思考中...' && (
          <div className="flex justify-start">
            <div className="bg-slate-800/80 rounded-2xl rounded-bl-md px-4 py-2.5 text-sm text-slate-500">
              <span className="animate-pulse">🧠 元Agent 思考中...</span>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-3 py-2 border-t border-slate-800">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder={compact ? '发消息...' : '告诉管家你的需求想法、问题或指令...'}
            className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 transition-colors"
            disabled={sending}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className="px-3 py-2 rounded-xl bg-forge-600 hover:bg-forge-500 text-white text-sm transition-all disabled:bg-slate-800 disabled:text-slate-600 shrink-0"
          >
            {sending ? '...' : '↑'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// Main WishPage
// ═══════════════════════════════════════

interface WishItem {
  id: string;
  content: string;
  status: string;
  created_at: string;
  analysis?: string;
}

export function WishPage() {
  const { currentProjectId, addLog, settingsConfigured, setGlobalPage, setProjectPage } = useAppStore();

  // ── State ──
  const [wishes, setWishes] = useState<WishItem[]>([]);
  const [selectedWishId, setSelectedWishId] = useState<string | null>(null);
  const [newWish, setNewWish] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showNewWish, setShowNewWish] = useState(false);

  // ── Load data ──
  const loadWishes = useCallback(async () => {
    if (!currentProjectId) return;
    const list = await window.automater.wish.list(currentProjectId);
    setWishes(list || []);
    if (!selectedWishId && list?.length > 0) setSelectedWishId(list[0].id);
  }, [currentProjectId, selectedWishId]);

  useEffect(() => { loadWishes(); }, [loadWishes]);
  useEffect(() => {
    const t = setInterval(() => { loadWishes(); }, 5000);
    return () => clearInterval(t);
  }, [loadWishes]);
  // 元Agent创建需求后刷新列表
  useEffect(() => {
    const handler = () => { loadWishes(); };
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
    } catch (err: any) {
      addLog({ projectId: currentProjectId, agentId: 'system', content: `❌ ${err.message}` });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteWish = async (id: string) => {
    await window.automater.wish.delete(id);
    if (selectedWishId === id) setSelectedWishId(null);
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
            onClick={() => { setShowNewWish(true); setSelectedWishId(null); }}
            className="text-[10px] px-2 py-1 rounded-lg bg-forge-600 hover:bg-forge-500 text-white transition-colors"
            title="新需求"
          >
            + 需求
          </button>
        </div>

        {/* Wish List */}
        <div className="flex-1 overflow-y-auto">
          {wishes.length === 0 && !showNewWish && (
            <div className="text-center py-12 text-slate-600 text-xs">
              <div className="text-3xl mb-2">✨</div>
              暂无需求<br />点击「+ 需求」或直接告诉管家
            </div>
          )}
          {wishes.map(w => {
            const st = WISH_STATUS[w.status] || WISH_STATUS.pending;
            const hasDocs = !!w.analysis;
            return (
              <button
                key={w.id}
                onClick={() => { setSelectedWishId(w.id); setShowNewWish(false); }}
                className={`w-full text-left px-4 py-3 border-b border-slate-800/50 transition-colors ${
                  selectedWishId === w.id ? 'bg-forge-600/10 border-l-2 border-l-forge-500' : 'hover:bg-slate-800/50 border-l-2 border-l-transparent'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs">{st.icon}</span>
                  <span className={`text-[10px] font-medium ${st.color}`}>{st.text}</span>
                  {hasDocs && <span className="text-[10px] text-slate-600">📄</span>}
                  <span className="text-[10px] text-slate-600 ml-auto">{new Date(w.created_at).toLocaleDateString()}</span>
                </div>
                <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed">{w.content}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* ═══ 右侧: 元Agent对话 ═══ */}
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
              onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) handleSubmitWish(); }}
              autoFocus
            />
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-600">{newWish.length} 字符 · Ctrl+Enter 提交</span>
              <div className="flex gap-2">
                <button onClick={() => setShowNewWish(false)} className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200 transition-colors">取消</button>
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
        ) : (
          /* ── 元Agent对话区 ── */
          <MetaAgentChat />
        )}
      </div>
    </div>
  );
}
