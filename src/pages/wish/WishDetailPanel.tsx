/**
 * WishDetailPanel — 需求详情面板
 *
 * 从 WishPage.tsx 拆分 (v30.2)
 */

import { useState, useMemo } from 'react';
import { renderMarkdown } from '../../utils/markdown';
import { confirm } from '../../stores/toast-store';
import { WISH_STATUS } from './wish-constants';
// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface WishItem {
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

export interface FeatureItem {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  category: string;
  group_name?: string | null;
  depends_on: string | null;
  locked_by: string | null;
  acceptance_criteria: string | null;
  affected_files: string | null;
  notes?: string | null;
  created_at: string;
  completed_at?: string | null;
  pm_verdict?: string | null;
  pm_verdict_score?: number | null;
  pm_verdict_feedback?: string | null;
}

// ═══════════════════════════════════════
// Feature status constants
// ═══════════════════════════════════════

const FEATURE_STATUS: Record<string, { text: string; color: string; bg: string; icon: string }> = {
  todo: { text: '待做', color: 'text-slate-400', bg: 'bg-slate-500/20', icon: '📋' },
  in_progress: { text: '开发中', color: 'text-blue-400', bg: 'bg-blue-500/20', icon: '🔨' },
  reviewing: { text: '审查中', color: 'text-amber-400', bg: 'bg-amber-500/20', icon: '🔍' },
  passed: { text: '已完成', color: 'text-emerald-400', bg: 'bg-emerald-500/20', icon: '✅' },
  failed: { text: '失败', color: 'text-red-400', bg: 'bg-red-500/20', icon: '❌' },
};

// ═══════════════════════════════════════
// WishDetailPanel — 需求详情面板
// ═══════════════════════════════════════

export function WishDetailPanel({
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
          f.pm_verdict_feedback ? `QA 未通过: ${f.pm_verdict_feedback.slice(0, 120)}` : 'QA 审查未通过',
        );
      }

      // 2) PM verdict rejection
      if (f.pm_verdict === 'rejected' || f.pm_verdict === 'fail') {
        featureReasons.push(
          f.pm_verdict_feedback ? `PM 验收拒绝: ${f.pm_verdict_feedback.slice(0, 120)}` : 'PM 验收未通过',
        );
      }

      // 3) Unmet dependencies
      let deps: string[] = [];
      try {
        deps = JSON.parse(f.depends_on || '[]');
      } catch {
        /* ignore */
      }
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
          onClick={async () => {
            const { confirmed } = await confirm({
              title: '删除需求',
              message: '确定要删除此需求吗？此操作无法撤销。',
              confirmText: '删除',
              danger: true,
            });
            if (confirmed) onDelete(wish.id);
          }}
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
              <span className="text-xs text-slate-400 shrink-0">
                {passedCount}/{totalCount} ({progressPct}%)
              </span>
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
                try {
                  deps = JSON.parse(f.depends_on || '[]');
                } catch {
                  /* ignore */
                }
                let criteria: string[] = [];
                try {
                  criteria = JSON.parse(f.acceptance_criteria || '[]');
                } catch {
                  /* ignore */
                }

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
                      <span
                        className={`text-[10px] px-1 py-0.5 rounded ${
                          f.priority === 0
                            ? 'bg-red-500/20 text-red-400'
                            : f.priority === 1
                              ? 'bg-amber-500/20 text-amber-400'
                              : 'bg-slate-700 text-slate-500'
                        }`}
                      >
                        P{f.priority}
                      </span>
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
                                  <span
                                    key={depId}
                                    className={`text-[10px] px-1.5 py-0.5 rounded ${
                                      depDone ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-700 text-slate-400'
                                    }`}
                                  >
                                    {depDone ? '✅' : '⏳'} {depId}
                                    {dep ? ` · ${dep.title.slice(0, 15)}` : ''}
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
                          <div
                            className={`rounded-md px-2.5 py-1.5 text-[11px] ${
                              f.pm_verdict === 'pass' || f.pm_verdict === 'approved'
                                ? 'bg-emerald-500/10 text-emerald-400'
                                : 'bg-red-500/10 text-red-400'
                            }`}
                          >
                            <span className="font-medium">PM 验收: {f.pm_verdict}</span>
                            {f.pm_verdict_score != null && <span className="ml-2">({f.pm_verdict_score}分)</span>}
                            {f.pm_verdict_feedback && <p className="mt-0.5 opacity-80">{f.pm_verdict_feedback}</p>}
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
            暂无关联 Feature
            <br />
            可能还在 PM 分析阶段或尚未进入开发
          </div>
        )}
      </div>
    </div>
  );
}
