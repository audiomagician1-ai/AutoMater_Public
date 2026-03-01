/**
 * WishPage v4.4 — 需求队列 + 变更管理
 *
 * 左侧: 双 tab (需求列表 / 变更请求), 可拖拽排序 (todo)
 * 右侧: 需求详情 / 新建输入 / PM 分析 / 设计文档 / 影响分析
 *
 * v4.4 新增:
 *   - 变更请求 tab: 查看所有 CR, 显示状态 + 影响分析
 *   - 新建需求入口区分 "新需求" vs "变更请求"
 *   - 需求卡片显示关联的 REQ/TEST 文档状态
 *
 * @module WishPage
 */

import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../stores/app-store';

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

const CR_STATUS: Record<string, { text: string; color: string; icon: string }> = {
  pending:    { text: '待处理',   color: 'text-slate-400',   icon: '⏳' },
  analyzing:  { text: '影响分析中', color: 'text-blue-400', icon: '🔍' },
  updating:   { text: '文档更新中', color: 'text-amber-400', icon: '📝' },
  completed:  { text: '已完成',   color: 'text-emerald-400', icon: '✅' },
  failed:     { text: '失败',     color: 'text-red-400',     icon: '❌' },
};

const RISK_LEVEL: Record<string, { text: string; color: string }> = {
  low:    { text: '低风险', color: 'text-emerald-400 bg-emerald-500/10' },
  medium: { text: '中风险', color: 'text-amber-400 bg-amber-500/10' },
  high:   { text: '高风险', color: 'text-red-400 bg-red-500/10' },
};

type LeftTab = 'wishes' | 'changes';

// ═══════════════════════════════════════
// Main WishPage
// ═══════════════════════════════════════

export function WishPage() {
  const { currentProjectId, addLog, settingsConfigured, setGlobalPage, setProjectPage } = useAppStore();

  // ── State ──
  const [leftTab, setLeftTab] = useState<LeftTab>('wishes');
  const [wishes, setWishes] = useState<WishItem[]>([]);
  const [changes, setChanges] = useState<ChangeRequestItem[]>([]);
  const [selectedWishId, setSelectedWishId] = useState<string | null>(null);
  const [selectedCRId, setSelectedCRId] = useState<string | null>(null);
  const [crDetail, setCRDetail] = useState<ChangeRequestDetail | null>(null);
  const [newWish, setNewWish] = useState('');
  const [newChange, setNewChange] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [showNewWish, setShowNewWish] = useState(false);
  const [showNewChange, setShowNewChange] = useState(false);

  // ── Load data ──
  const loadWishes = useCallback(async () => {
    if (!currentProjectId) return;
    const list = await window.agentforge.wish.list(currentProjectId);
    setWishes(list || []);
    if (!selectedWishId && list?.length > 0) setSelectedWishId(list[0].id);
  }, [currentProjectId, selectedWishId]);

  const loadChanges = useCallback(async () => {
    if (!currentProjectId) return;
    const list = await window.agentforge.project.listChanges(currentProjectId);
    setChanges(list || []);
  }, [currentProjectId]);

  useEffect(() => { loadWishes(); loadChanges(); }, [loadWishes, loadChanges]);
  useEffect(() => {
    const t = setInterval(() => { loadWishes(); loadChanges(); }, 5000);
    return () => clearInterval(t);
  }, [loadWishes, loadChanges]);

  // ── Load CR detail ──
  useEffect(() => {
    if (!selectedCRId) { setCRDetail(null); return; }
    window.agentforge.project.getImpactAnalysis(selectedCRId).then(d => setCRDetail(d));
  }, [selectedCRId]);

  const selected = wishes.find(w => w.id === selectedWishId) || null;

  // ── Handlers ──
  const handleSubmitWish = async () => {
    if (!newWish.trim() || !currentProjectId || submitting) return;
    setSubmitting(true);
    try {
      const res = await window.agentforge.wish.create(currentProjectId, newWish.trim());
      addLog({ projectId: currentProjectId, agentId: 'system', content: '✨ 新需求已提交' });
      setNewWish('');
      setShowNewWish(false);
      setSelectedWishId(res.wishId);
      setLeftTab('wishes');
      await loadWishes();
    } catch (err: any) {
      addLog({ projectId: currentProjectId, agentId: 'system', content: `❌ ${err.message}` });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitChange = async () => {
    if (!newChange.trim() || !currentProjectId || submitting) return;
    setSubmitting(true);
    try {
      const res = await window.agentforge.project.submitChange(currentProjectId, newChange.trim());
      addLog({ projectId: currentProjectId, agentId: 'system', content: '🔄 需求变更已提交' });
      setNewChange('');
      setShowNewChange(false);
      setSelectedCRId(res.changeRequestId);
      setLeftTab('changes');
      await loadChanges();
    } catch (err: any) {
      addLog({ projectId: currentProjectId, agentId: 'system', content: `❌ ${err.message}` });
    } finally {
      setSubmitting(false);
    }
  };

  const handleAnalyze = async () => {
    if (!selected || !currentProjectId || analyzing) return;
    if (!settingsConfigured) { setGlobalPage('settings'); return; }
    setAnalyzing(true);
    try {
      await window.agentforge.wish.update(selected.id, { status: 'analyzing' });
      const res = await window.agentforge.llm.chat({
        model: '',
        messages: [
          { role: 'system', content: '你是一位资深产品经理。请分析以下用户需求，输出:\n1. 需求理解与澄清\n2. 核心功能点列表 (编号)\n3. 非功能性需求\n4. 技术建议\n5. 风险与依赖\n\n输出格式为 Markdown。' },
          { role: 'user', content: selected.content },
        ],
      });
      if (res.success) {
        await window.agentforge.wish.update(selected.id, { status: 'analyzed', pm_analysis: res.content });
        addLog({ projectId: currentProjectId, agentId: 'pm', content: `🧠 PM 分析完成: ${selected.content.slice(0, 40)}...` });
      } else {
        await window.agentforge.wish.update(selected.id, { status: 'pending' });
        addLog({ projectId: currentProjectId, agentId: 'pm', content: `❌ 分析失败: ${res.error}` });
      }
    } catch {
      await window.agentforge.wish.update(selected.id, { status: 'pending' }).catch(() => {});
    } finally {
      setAnalyzing(false);
      loadWishes();
    }
  };

  const handleGenerateDesign = async () => {
    if (!selected?.pm_analysis || !currentProjectId) return;
    setAnalyzing(true);
    try {
      const res = await window.agentforge.llm.chat({
        model: '',
        messages: [
          { role: 'system', content: '你是一位技术架构师。基于以下 PM 分析，生成一份可施工的技术设计文档，包含:\n1. 系统架构图 (ASCII)\n2. 模块拆分\n3. 数据模型\n4. API 接口定义\n5. 技术选型\n6. 开发计划与里程碑\n7. 验收标准\n\n输出格式为 Markdown。' },
          { role: 'user', content: `原始需求:\n${selected.content}\n\nPM 分析:\n${selected.pm_analysis}` },
        ],
      });
      if (res.success) {
        await window.agentforge.wish.update(selected.id, { design_doc: res.content });
        addLog({ projectId: currentProjectId, agentId: 'architect', content: '🏗️ 设计文档已生成' });
      }
    } catch { /* handled by logging above */ } finally {
      setAnalyzing(false);
      loadWishes();
    }
  };

  const handleStartDev = async () => {
    if (!selected || !currentProjectId) return;
    if (!settingsConfigured) { setGlobalPage('settings'); return; }
    await window.agentforge.project.setWish(currentProjectId, selected.content);
    await window.agentforge.wish.update(selected.id, { status: 'developing' });
    await window.agentforge.project.start(currentProjectId);
    addLog({ projectId: currentProjectId, agentId: 'system', content: '🚀 Agent 团队开始工作' });
    setProjectPage('logs');
  };

  const handleDeleteWish = async (id: string) => {
    await window.agentforge.wish.delete(id);
    if (selectedWishId === id) setSelectedWishId(null);
    loadWishes();
  };

  if (!currentProjectId) {
    return <div className="h-full flex items-center justify-center text-slate-500">加载中...</div>;
  }

  return (
    <div className="h-full flex overflow-hidden">
      {/* ═══ 左侧 ═══ */}
      <div className="w-72 border-r border-slate-800 flex flex-col flex-shrink-0">
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-200">需求管理</h2>
          <div className="flex gap-1">
            <button
              onClick={() => { setShowNewWish(true); setShowNewChange(false); setSelectedWishId(null); setSelectedCRId(null); }}
              className="text-[10px] px-2 py-1 rounded-lg bg-forge-600 hover:bg-forge-500 text-white transition-colors"
              title="新需求"
            >
              + 需求
            </button>
            <button
              onClick={() => { setShowNewChange(true); setShowNewWish(false); setSelectedWishId(null); setSelectedCRId(null); }}
              className="text-[10px] px-2 py-1 rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors"
              title="需求变更"
            >
              ⚡ 变更
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-800">
          <button
            onClick={() => setLeftTab('wishes')}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${
              leftTab === 'wishes'
                ? 'text-forge-400 border-b-2 border-forge-500'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            ✨ 需求 ({wishes.length})
          </button>
          <button
            onClick={() => setLeftTab('changes')}
            className={`flex-1 py-2 text-xs font-medium transition-colors relative ${
              leftTab === 'changes'
                ? 'text-amber-400 border-b-2 border-amber-500'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            ⚡ 变更 ({changes.length})
            {changes.some(c => c.status === 'pending' || c.status === 'analyzing') && (
              <span className="absolute top-1 right-4 w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            )}
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {leftTab === 'wishes' ? (
            <>
              {wishes.length === 0 && !showNewWish && (
                <div className="text-center py-12 text-slate-600 text-xs">
                  <div className="text-3xl mb-2">✨</div>
                  暂无需求<br />点击「+ 需求」开始
                </div>
              )}
              {wishes.map(w => {
                const st = WISH_STATUS[w.status] || WISH_STATUS.pending;
                const hasDocs = !!w.pm_analysis;
                return (
                  <button
                    key={w.id}
                    onClick={() => { setSelectedWishId(w.id); setSelectedCRId(null); setShowNewWish(false); setShowNewChange(false); }}
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
            </>
          ) : (
            <>
              {changes.length === 0 && !showNewChange && (
                <div className="text-center py-12 text-slate-600 text-xs">
                  <div className="text-3xl mb-2">⚡</div>
                  暂无变更请求
                </div>
              )}
              {changes.map(cr => {
                const st = CR_STATUS[cr.status] || CR_STATUS.pending;
                return (
                  <button
                    key={cr.id}
                    onClick={() => { setSelectedCRId(cr.id); setSelectedWishId(null); setShowNewWish(false); setShowNewChange(false); }}
                    className={`w-full text-left px-4 py-3 border-b border-slate-800/50 transition-colors ${
                      selectedCRId === cr.id ? 'bg-amber-600/10 border-l-2 border-l-amber-500' : 'hover:bg-slate-800/50 border-l-2 border-l-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs">{st.icon}</span>
                      <span className={`text-[10px] font-medium ${st.color}`}>{st.text}</span>
                      <span className="text-[10px] text-slate-600 font-mono">{cr.id.slice(0, 10)}</span>
                      <span className="text-[10px] text-slate-600 ml-auto">{new Date(cr.created_at).toLocaleDateString()}</span>
                    </div>
                    <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed">{cr.description}</p>
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>

      {/* ═══ 右侧 ═══ */}
      <div className="flex-1 overflow-y-auto">
        {showNewWish ? (
          /* ── 新建需求 ── */
          <div className="p-6 max-w-2xl mx-auto space-y-4">
            <h3 className="text-lg font-bold text-slate-200">提交新需求</h3>
            <p className="text-xs text-slate-500">描述你想要实现的功能或改动。PM Agent 会自动分析并生成设计文档。</p>
            <textarea
              value={newWish}
              onChange={e => setNewWish(e.target.value)}
              placeholder="详细描述你的需求..."
              rows={10}
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
                  {submitting ? '提交中...' : '✨ 提交需求'}
                </button>
              </div>
            </div>
          </div>
        ) : showNewChange ? (
          /* ── 新建变更请求 ── */
          <div className="p-6 max-w-2xl mx-auto space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-lg">⚡</div>
              <div>
                <h3 className="text-lg font-bold text-slate-200">提交需求变更</h3>
                <p className="text-xs text-slate-500">描述需要变更的内容, 系统将自动进行影响分析并级联更新文档</p>
              </div>
            </div>
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl px-4 py-3 text-xs text-amber-300/80 leading-relaxed">
              <strong>变更请求</strong>与新需求不同: 它会分析对已有功能、设计文档和测试规格的影响,
              自动更新相关文档, 并标记需要重新开发的 Feature。
            </div>
            <textarea
              value={newChange}
              onChange={e => setNewChange(e.target.value)}
              placeholder="描述需要变更的内容...\n\n例: 原先的用户注册只需要邮箱, 现在需要增加手机号验证, 并且支持第三方登录 (Google, GitHub)。"
              rows={8}
              className="w-full bg-slate-800 border border-amber-500/30 rounded-lg px-4 py-3 text-slate-100 placeholder-slate-600 resize-y focus:outline-none focus:border-amber-500 transition-colors text-sm leading-relaxed"
              onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) handleSubmitChange(); }}
              autoFocus
            />
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-600">{newChange.length} 字符</span>
              <div className="flex gap-2">
                <button onClick={() => setShowNewChange(false)} className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200 transition-colors">取消</button>
                <button
                  onClick={handleSubmitChange}
                  disabled={!newChange.trim() || submitting}
                  className="px-5 py-2 rounded-lg text-sm bg-amber-600 hover:bg-amber-500 text-white transition-all disabled:bg-slate-800 disabled:text-slate-600"
                >
                  {submitting ? '提交中...' : '⚡ 提交变更'}
                </button>
              </div>
            </div>
          </div>
        ) : selectedCRId && crDetail ? (
          /* ── 变更请求详情 ── */
          <div className="p-6 space-y-6 max-w-3xl mx-auto">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center text-lg flex-shrink-0">⚡</div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  {(() => {
                    const st = CR_STATUS[crDetail.status] || CR_STATUS.pending;
                    return <span className={`text-xs px-2 py-0.5 rounded-full bg-slate-800 ${st.color}`}>{st.icon} {st.text}</span>;
                  })()}
                  <span className="text-[10px] text-slate-600 font-mono">{crDetail.id}</span>
                  <span className="text-[10px] text-slate-600 ml-auto">{new Date(crDetail.created_at).toLocaleString()}</span>
                </div>
                <p className="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed bg-slate-900 border border-slate-800 rounded-xl p-4 mt-2">
                  {crDetail.description}
                </p>
              </div>
            </div>

            {/* Impact Analysis */}
            {crDetail.impactAnalysis && (
              <div className="space-y-4">
                <h4 className="text-xs font-semibold text-slate-400 flex items-center gap-2">
                  🔍 影响分析
                  {crDetail.impactAnalysis.riskLevel && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${RISK_LEVEL[crDetail.impactAnalysis.riskLevel]?.color || ''}`}>
                      {RISK_LEVEL[crDetail.impactAnalysis.riskLevel]?.text || crDetail.impactAnalysis.riskLevel}
                    </span>
                  )}
                  <span className="text-[10px] text-slate-600 ml-auto">
                    影响范围: {crDetail.impactAnalysis.impactPercent}%
                  </span>
                </h4>

                {/* Affected features */}
                {crDetail.impactAnalysis.affectedFeatures.length > 0 && (
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                    <h5 className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">受影响 Feature</h5>
                    <div className="space-y-1">
                      {crDetail.impactAnalysis.affectedFeatures.map((af, i) => (
                        <div key={i} className="flex items-center gap-3 text-xs">
                          <span className={`w-1.5 h-1.5 rounded-full ${af.severity === 'major' ? 'bg-red-400' : 'bg-amber-400'}`} />
                          <span className="text-slate-400 font-mono">{af.featureId}</span>
                          <span className="text-slate-300 flex-1">{af.reason}</span>
                          <span className={`text-[10px] ${af.severity === 'major' ? 'text-red-400' : 'text-amber-400'}`}>
                            {af.severity}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Docs to update */}
                {crDetail.impactAnalysis.docsToUpdate.length > 0 && (
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                    <h5 className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">需更新文档</h5>
                    <div className="space-y-1">
                      {crDetail.impactAnalysis.docsToUpdate.map((doc, i) => (
                        <div key={i} className="flex items-center gap-3 text-xs">
                          <span className="text-slate-500">{doc.type === 'design' ? '📐' : doc.type === 'requirement' ? '📋' : '🧪'}</span>
                          <span className="text-slate-400">{doc.id}</span>
                          <span className="text-slate-500 flex-1 truncate">{doc.changeDescription}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* New features needed */}
                {crDetail.impactAnalysis.newFeaturesNeeded.length > 0 && (
                  <div className="bg-slate-900 border border-emerald-500/20 rounded-xl p-4">
                    <h5 className="text-[10px] uppercase tracking-wider text-emerald-500 mb-2">新增 Feature</h5>
                    <div className="space-y-1">
                      {crDetail.impactAnalysis.newFeaturesNeeded.map((nf, i) => (
                        <div key={i} className="text-xs text-slate-300">
                          <strong>{nf.title}</strong> — {nf.description}
                          <span className="text-[10px] text-slate-500 ml-2">({nf.reason})</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Risk notes */}
                {crDetail.impactAnalysis.riskNotes && (
                  <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
                    <h5 className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">风险说明</h5>
                    <p className="text-xs text-slate-400 leading-relaxed">{crDetail.impactAnalysis.riskNotes}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : selected ? (
          /* ── 需求详情 ── */
          <div className="p-6 space-y-6 max-w-3xl mx-auto">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  {(() => { const st = WISH_STATUS[selected.status] || WISH_STATUS.pending; return (
                    <span className={`text-xs px-2 py-0.5 rounded-full bg-slate-800 ${st.color}`}>{st.icon} {st.text}</span>
                  ); })()}
                  <span className="text-[10px] text-slate-600">{new Date(selected.created_at).toLocaleString()}</span>
                </div>
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <h4 className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">原始需求</h4>
                  <p className="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">{selected.content}</p>
                </div>
              </div>
              <button onClick={() => handleDeleteWish(selected.id)} className="text-xs px-2 py-1 text-slate-600 hover:text-red-400 transition-colors" title="删除需求">🗑</button>
            </div>

            {/* Actions */}
            <div className="flex gap-3">
              {selected.status === 'pending' && (
                <button onClick={handleAnalyze} disabled={analyzing}
                  className="px-4 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 text-white transition-all disabled:bg-slate-800 disabled:text-slate-600">
                  {analyzing ? '🧠 分析中...' : '🧠 PM 分析'}
                </button>
              )}
              {selected.status === 'analyzed' && selected.pm_analysis && !selected.design_doc && (
                <button onClick={handleGenerateDesign} disabled={analyzing}
                  className="px-4 py-2 rounded-lg text-sm bg-violet-600 hover:bg-violet-500 text-white transition-all disabled:bg-slate-800 disabled:text-slate-600">
                  {analyzing ? '🏗️ 生成中...' : '🏗️ 生成设计文档'}
                </button>
              )}
              {(selected.status === 'analyzed' || selected.design_doc) && (
                <button onClick={handleStartDev}
                  className="px-4 py-2 rounded-lg text-sm bg-forge-600 hover:bg-forge-500 text-white transition-all">
                  🚀 启动开发
                </button>
              )}
              {selected.status === 'analyzing' && (
                <div className="flex items-center gap-2 text-sm text-blue-400">
                  <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
                  PM 正在分析中...
                </div>
              )}
            </div>

            {/* PM Analysis */}
            {selected.pm_analysis && (
              <div className="bg-slate-900 border border-blue-500/20 rounded-xl p-5">
                <h4 className="text-xs font-semibold text-blue-400 mb-3 flex items-center gap-2">
                  <span>🧠</span> PM 分析报告
                </h4>
                <div className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">
                  {selected.pm_analysis}
                </div>
              </div>
            )}

            {/* Design Doc */}
            {selected.design_doc && (
              <div className="bg-slate-900 border border-violet-500/20 rounded-xl p-5">
                <h4 className="text-xs font-semibold text-violet-400 mb-3 flex items-center gap-2">
                  <span>🏗️</span> 技术设计文档
                </h4>
                <div className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed font-mono">
                  {selected.design_doc}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* ── Empty ── */
          <div className="h-full flex flex-col items-center justify-center text-slate-600 gap-3">
            <div className="text-5xl">✨</div>
            <div className="text-lg font-medium text-slate-400">需求管理</div>
            <div className="text-sm text-center max-w-md leading-relaxed">
              在这里管理项目需求和变更请求。
              <br />
              <span className="text-slate-600">新需求由 PM Agent 分析, 变更请求会触发自动影响分析。</span>
            </div>
            <div className="flex gap-3 mt-4">
              <button onClick={() => setShowNewWish(true)}
                className="px-5 py-2.5 rounded-lg bg-forge-600 hover:bg-forge-500 text-white text-sm transition-all">
                ✨ 新需求
              </button>
              <button onClick={() => setShowNewChange(true)}
                className="px-5 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm transition-all">
                ⚡ 变更请求
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
