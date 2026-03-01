/**
 * WishPage v3.1 — 需求队列
 *
 * 左侧: 需求历史列表 (可多条)
 * 右侧: 需求详情 / 新建输入 / PM 分析结果 / 设计文档
 */

import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../stores/app-store';

const WISH_STATUS: Record<string, { text: string; color: string; icon: string }> = {
  pending:    { text: '待分析', color: 'text-slate-400',   icon: '⏳' },
  analyzing:  { text: 'PM 分析中', color: 'text-blue-400',  icon: '🧠' },
  analyzed:   { text: '已分析', color: 'text-emerald-400',  icon: '✅' },
  developing: { text: '开发中', color: 'text-amber-400',    icon: '🔨' },
  done:       { text: '已完成', color: 'text-green-400',    icon: '🎉' },
  rejected:   { text: '已拒绝', color: 'text-red-400',      icon: '❌' },
};

export function WishPage() {
  const { currentProjectId, addLog, settingsConfigured, setGlobalPage, setProjectPage } = useAppStore();
  const [wishes, setWishes] = useState<WishItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newWish, setNewWish] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const loadWishes = useCallback(async () => {
    if (!currentProjectId) return;
    const list = await window.agentforge.wish.list(currentProjectId);
    setWishes(list || []);
    if (!selectedId && list?.length > 0) setSelectedId(list[0].id);
  }, [currentProjectId, selectedId]);

  useEffect(() => { loadWishes(); }, [loadWishes]);
  useEffect(() => { const t = setInterval(loadWishes, 5000); return () => clearInterval(t); }, [loadWishes]);

  const selected = wishes.find(w => w.id === selectedId) || null;

  /** 提交新需求 */
  const handleSubmit = async () => {
    if (!newWish.trim() || !currentProjectId || submitting) return;
    setSubmitting(true);
    try {
      const res = await window.agentforge.wish.create(currentProjectId, newWish.trim());
      addLog({ projectId: currentProjectId, agentId: 'system', content: `✨ 新需求已提交` });
      setNewWish('');
      setShowNew(false);
      setSelectedId(res.wishId);
      await loadWishes();
    } catch (err: any) {
      addLog({ projectId: currentProjectId, agentId: 'system', content: `❌ ${err.message}` });
    } finally {
      setSubmitting(false);
    }
  };

  /** PM 分析 (调用 LLM) */
  const handleAnalyze = async () => {
    if (!selected || !currentProjectId || analyzing) return;
    if (!settingsConfigured) { setGlobalPage('settings'); return; }
    setAnalyzing(true);
    try {
      await window.agentforge.wish.update(selected.id, { status: 'analyzing' });
      const res = await window.agentforge.llm.chat({
        model: '',  // will use settings default
        messages: [
          { role: 'system', content: '你是一位资深产品经理。请分析以下用户需求，输出:\n1. 需求理解与澄清\n2. 核心功能点列表 (编号)\n3. 非功能性需求\n4. 技术建议\n5. 风险与依赖\n\n输出格式为 Markdown。' },
          { role: 'user', content: selected.content },
        ],
      });
      if (res.success) {
        await window.agentforge.wish.update(selected.id, {
          status: 'analyzed',
          pm_analysis: res.content,
        });
        addLog({ projectId: currentProjectId, agentId: 'pm', content: `🧠 PM 分析完成: ${selected.content.slice(0, 40)}...` });
      } else {
        await window.agentforge.wish.update(selected.id, { status: 'pending' });
        addLog({ projectId: currentProjectId, agentId: 'pm', content: `❌ 分析失败: ${res.error}` });
      }
    } catch (err: any) {
      await window.agentforge.wish.update(selected.id, { status: 'pending' }).catch(() => {});
    } finally {
      setAnalyzing(false);
      loadWishes();
    }
  };

  /** 生成设计文档 */
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
        addLog({ projectId: currentProjectId, agentId: 'architect', content: `🏗️ 设计文档已生成` });
      }
    } catch { /* */ } finally {
      setAnalyzing(false);
      loadWishes();
    }
  };

  /** 启动开发 */
  const handleStartDev = async () => {
    if (!selected || !currentProjectId) return;
    if (!settingsConfigured) { setGlobalPage('settings'); return; }
    // 把 wish 同步到项目 wish 字段
    await window.agentforge.project.setWish(currentProjectId, selected.content);
    await window.agentforge.wish.update(selected.id, { status: 'developing' });
    await window.agentforge.project.start(currentProjectId);
    addLog({ projectId: currentProjectId, agentId: 'system', content: `🚀 Agent 团队开始工作` });
    setProjectPage('logs');
  };

  /** 删除需求 */
  const handleDelete = async (id: string) => {
    await window.agentforge.wish.delete(id);
    if (selectedId === id) setSelectedId(null);
    loadWishes();
  };

  if (!currentProjectId) {
    return <div className="h-full flex items-center justify-center text-slate-500">加载中...</div>;
  }

  return (
    <div className="h-full flex overflow-hidden">
      {/* ═══ 左侧: 需求列表 ═══ */}
      <div className="w-72 border-r border-slate-800 flex flex-col flex-shrink-0">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-200">需求队列</h2>
          <button
            onClick={() => { setShowNew(true); setSelectedId(null); }}
            className="text-xs px-2.5 py-1 rounded-lg bg-forge-600 hover:bg-forge-500 text-white transition-colors"
          >
            + 新需求
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {wishes.length === 0 && !showNew && (
            <div className="text-center py-12 text-slate-600 text-xs">
              <div className="text-3xl mb-2">✨</div>
              暂无需求<br />点击「+ 新需求」开始
            </div>
          )}
          {wishes.map(w => {
            const st = WISH_STATUS[w.status] || WISH_STATUS.pending;
            return (
              <button
                key={w.id}
                onClick={() => { setSelectedId(w.id); setShowNew(false); }}
                className={`w-full text-left px-4 py-3 border-b border-slate-800/50 transition-colors ${
                  selectedId === w.id ? 'bg-forge-600/10 border-l-2 border-l-forge-500' : 'hover:bg-slate-800/50 border-l-2 border-l-transparent'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs">{st.icon}</span>
                  <span className={`text-[10px] font-medium ${st.color}`}>{st.text}</span>
                  <span className="text-[10px] text-slate-600 ml-auto">{new Date(w.created_at).toLocaleDateString()}</span>
                </div>
                <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed">{w.content}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* ═══ 右侧: 详情/新建 ═══ */}
      <div className="flex-1 overflow-y-auto">
        {showNew ? (
          /* ── 新建需求 ── */
          <div className="p-6 max-w-2xl mx-auto space-y-4">
            <h3 className="text-lg font-bold text-slate-200">提交新需求</h3>
            <p className="text-xs text-slate-500">描述你想要实现的功能或改动。PM Agent 会自动分析并生成设计文档。</p>
            <textarea
              value={newWish}
              onChange={e => setNewWish(e.target.value)}
              placeholder={"详细描述你的需求...\n\n例: 为 MuseSea 社区添加创作者等级系统，包括经验值、徽章、排行榜、每日任务等功能。\n等级会影响用户在社区的权限和可见度。"}
              rows={10}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-slate-100 placeholder-slate-600 resize-y focus:outline-none focus:border-forge-500 transition-colors text-sm leading-relaxed"
              onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) handleSubmit(); }}
              autoFocus
            />
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-600">{newWish.length} 字符 · Ctrl+Enter 提交</span>
              <div className="flex gap-2">
                <button onClick={() => setShowNew(false)} className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200 transition-colors">取消</button>
                <button
                  onClick={handleSubmit}
                  disabled={!newWish.trim() || submitting}
                  className="px-5 py-2 rounded-lg text-sm bg-forge-600 hover:bg-forge-500 text-white transition-all disabled:bg-slate-800 disabled:text-slate-600"
                >
                  {submitting ? '提交中...' : '✨ 提交需求'}
                </button>
              </div>
            </div>
          </div>
        ) : selected ? (
          /* ── 需求详情 ── */
          <div className="p-6 space-y-6 max-w-3xl mx-auto">
            {/* 标题区 */}
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
              <button
                onClick={() => handleDelete(selected.id)}
                className="text-xs px-2 py-1 text-slate-600 hover:text-red-400 transition-colors"
                title="删除需求"
              >🗑</button>
            </div>

            {/* 操作按钮 */}
            <div className="flex gap-3">
              {(selected.status === 'pending') && (
                <button
                  onClick={handleAnalyze}
                  disabled={analyzing}
                  className="px-4 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 text-white transition-all disabled:bg-slate-800 disabled:text-slate-600"
                >
                  {analyzing ? '🧠 分析中...' : '🧠 PM 分析'}
                </button>
              )}
              {(selected.status === 'analyzed' && selected.pm_analysis && !selected.design_doc) && (
                <button
                  onClick={handleGenerateDesign}
                  disabled={analyzing}
                  className="px-4 py-2 rounded-lg text-sm bg-violet-600 hover:bg-violet-500 text-white transition-all disabled:bg-slate-800 disabled:text-slate-600"
                >
                  {analyzing ? '🏗️ 生成中...' : '🏗️ 生成设计文档'}
                </button>
              )}
              {(selected.status === 'analyzed' || selected.design_doc) && (
                <button
                  onClick={handleStartDev}
                  className="px-4 py-2 rounded-lg text-sm bg-forge-600 hover:bg-forge-500 text-white transition-all"
                >
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

            {/* PM 分析结果 */}
            {selected.pm_analysis && (
              <div className="bg-slate-900 border border-blue-500/20 rounded-xl p-5">
                <h4 className="text-xs font-semibold text-blue-400 mb-3 flex items-center gap-2">
                  <span>🧠</span> PM 分析报告
                </h4>
                <div className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed prose prose-invert prose-sm max-w-none">
                  {selected.pm_analysis}
                </div>
              </div>
            )}

            {/* 设计文档 */}
            {selected.design_doc && (
              <div className="bg-slate-900 border border-violet-500/20 rounded-xl p-5">
                <h4 className="text-xs font-semibold text-violet-400 mb-3 flex items-center gap-2">
                  <span>🏗️</span> 技术设计文档
                </h4>
                <div className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed prose prose-invert prose-sm max-w-none font-mono">
                  {selected.design_doc}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* ── 空状态 ── */
          <div className="h-full flex flex-col items-center justify-center text-slate-600 gap-3">
            <div className="text-5xl">✨</div>
            <div className="text-lg font-medium text-slate-400">许愿板</div>
            <div className="text-sm text-center max-w-md">
              在这里发布你的需求，PM Agent 会逐个分析并生成可施工的设计文档。
              <br />
              <span className="text-slate-600">每条需求可独立追踪进度。</span>
            </div>
            <button
              onClick={() => setShowNew(true)}
              className="mt-4 px-6 py-2.5 rounded-lg bg-forge-600 hover:bg-forge-500 text-white text-sm transition-all"
            >
              + 发布第一条需求
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
