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

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAppStore, type MetaAgentMessage } from '../stores/app-store';
import { toErrorMessage } from '../utils/errors';

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
    } catch (err: unknown) {
      updateLastAssistant(chatKey, `❌ 请求失败: ${toErrorMessage(err) || '未知错误'}。请检查 LLM 设置。`);
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
  group_name: string | null;
  depends_on: string;
  locked_by: string | null;
  acceptance_criteria: string;
  affected_files: string;
  notes: string;
  created_at: string;
  completed_at: string | null;
  pm_verdict?: string | null;
  pm_verdict_score?: number | null;
  pm_verdict_feedback?: string | null;
}

// ═══════════════════════════════════════
// Feature status constants
// ═══════════════════════════════════════

const FEATURE_STATUS: Record<string, { text: string; color: string; bg: string; icon: string }> = {
  todo:        { text: '待做',   color: 'text-slate-400',   bg: 'bg-slate-500/20',   icon: '📋' },
  in_progress: { text: '开发中', color: 'text-blue-400',    bg: 'bg-blue-500/20',    icon: '🔨' },
  reviewing:   { text: '审查中', color: 'text-amber-400',   bg: 'bg-amber-500/20',   icon: '🔍' },
  passed:      { text: '已完成', color: 'text-emerald-400', bg: 'bg-emerald-500/20', icon: '✅' },
  failed:      { text: '失败',   color: 'text-red-400',     bg: 'bg-red-500/20',     icon: '❌' },
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
          f.pm_verdict_feedback
            ? `QA 未通过: ${f.pm_verdict_feedback.slice(0, 120)}`
            : 'QA 审查未通过'
        );
      }

      // 2) PM verdict rejection
      if (f.pm_verdict === 'rejected' || f.pm_verdict === 'fail') {
        featureReasons.push(
          f.pm_verdict_feedback
            ? `PM 验收拒绝: ${f.pm_verdict_feedback.slice(0, 120)}`
            : 'PM 验收未通过'
        );
      }

      // 3) Unmet dependencies
      let deps: string[] = [];
      try { deps = JSON.parse(f.depends_on || '[]'); } catch { /* ignore */ }
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
          onClick={() => { if (confirm('确认删除此需求？')) onDelete(wish.id); }}
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
              <span className="text-xs text-slate-400 shrink-0">{passedCount}/{totalCount} ({progressPct}%)</span>
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
                try { deps = JSON.parse(f.depends_on || '[]'); } catch { /* ignore */ }
                let criteria: string[] = [];
                try { criteria = JSON.parse(f.acceptance_criteria || '[]'); } catch { /* ignore */ }

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
                      <span className={`text-[10px] px-1 py-0.5 rounded ${
                        f.priority === 0 ? 'bg-red-500/20 text-red-400' : f.priority === 1 ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-700 text-slate-500'
                      }`}>P{f.priority}</span>
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
                                  <span key={depId} className={`text-[10px] px-1.5 py-0.5 rounded ${
                                    depDone ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-700 text-slate-400'
                                  }`}>
                                    {depDone ? '✅' : '⏳'} {depId}{dep ? ` · ${dep.title.slice(0, 15)}` : ''}
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
                          <div className={`rounded-md px-2.5 py-1.5 text-[11px] ${
                            f.pm_verdict === 'pass' || f.pm_verdict === 'approved'
                              ? 'bg-emerald-500/10 text-emerald-400'
                              : 'bg-red-500/10 text-red-400'
                          }`}>
                            <span className="font-medium">PM 验收: {f.pm_verdict}</span>
                            {f.pm_verdict_score != null && <span className="ml-2">({f.pm_verdict_score}分)</span>}
                            {f.pm_verdict_feedback && (
                              <p className="mt-0.5 opacity-80">{f.pm_verdict_feedback}</p>
                            )}
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
            暂无关联 Feature<br />
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
  const setGlobalPage = useAppStore(s => s.setGlobalPage);
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
    setFeatures(data || []);
  }, [currentProjectId]);

  useEffect(() => { loadWishes(); }, [loadWishes]);
  useEffect(() => { loadFeatures(); }, [loadFeatures]);
  useEffect(() => {
    const t = setInterval(() => { loadWishes(); loadFeatures(); }, 5000);
    return () => clearInterval(t);
  }, [loadWishes, loadFeatures]);
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
    } catch (err: unknown) {
      addLog({ projectId: currentProjectId, agentId: 'system', content: `❌ ${toErrorMessage(err)}` });
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
            const hasDocs = !!(w.pm_analysis || w.analysis);
            return (
              <button
                key={w.id}
                onClick={() => { setSelectedWishId(w.id); setShowNewWish(false); setShowDetail(true); }}
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
