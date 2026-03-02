/**
 * AcceptancePanel v4.4 — 用户验收面板
 *
 * 浮动模态框, 当项目进入 awaiting_user_acceptance 状态时触发。
 * 展示:
 *   1. 项目总体完成情况 (进度 / feature 数量)
 *   2. PM 验收报告 (各 feature 的 PM 结论)
 *   3. QA 测试汇总 (passed / failed / coverage)
 *   4. 文档完成度概览
 *   5. 用户操作: 通过 / 驳回 (附理由)
 *
 * 数据来源:
 *   - project:get-features → feature 状态
 *   - project:get-stats → 汇总统计
 *   - project:get-design-doc → 设计文档存在性
 *   - project:user-accept → 提交验收决定
 *
 * @module AcceptancePanel
 */

import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../stores/app-store';
import { toErrorMessage } from '../utils/errors';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

interface FeatureSummary {
  id: string;
  title: string;
  status: string;
  pm_verdict: string | null;
  category: string;
  priority: number;
}

// ═══════════════════════════════════════
// Constants
// ═══════════════════════════════════════

const VERDICT_STYLES: Record<string, { icon: string; text: string; color: string }> = {
  approved:       { icon: '✅', text: '已通过',  color: 'text-emerald-400' },
  passed:         { icon: '✅', text: '已通过',  color: 'text-emerald-400' },
  rejected:       { icon: '❌', text: '已驳回',  color: 'text-red-400' },
  pm_rejected:    { icon: '❌', text: 'PM 驳回', color: 'text-red-400' },
  qa_passed:      { icon: '🧪', text: 'QA 通过', color: 'text-emerald-400' },
  todo:           { icon: '⬜', text: '待开发',  color: 'text-slate-400' },
  in_progress:    { icon: '🔨', text: '开发中',  color: 'text-blue-400' },
  reviewing:      { icon: '🔍', text: '审查中',  color: 'text-amber-400' },
  failed:         { icon: '❌', text: '失败',    color: 'text-red-400' },
};

// ═══════════════════════════════════════
// Main Component
// ═══════════════════════════════════════

export function AcceptancePanel() {
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const showAcceptancePanel = useAppStore(s => s.showAcceptancePanel);
  const setShowAcceptancePanel = useAppStore(s => s.setShowAcceptancePanel);
  const addLog = useAppStore(s => s.addLog);
  const setProjectPage = useAppStore(s => s.setProjectPage);
  const [features, setFeatures] = useState<FeatureSummary[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [hasDesignDoc, setHasDesignDoc] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showRejectForm, setShowRejectForm] = useState(false);

  const loadData = useCallback(async () => {
    if (!currentProjectId || !showAcceptancePanel) return;
    const [feats, st, design] = await Promise.all([
      window.automater.project.getFeatures(currentProjectId),
      window.automater.project.getStats(currentProjectId),
      window.automater.project.getDesignDoc(currentProjectId),
    ]);
    setFeatures(feats || []);
    setStats(st);
    setHasDesignDoc(!!design);
  }, [currentProjectId, showAcceptancePanel]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleAccept = async () => {
    if (!currentProjectId || submitting) return;
    setSubmitting(true);
    try {
      await window.automater.project.userAccept(currentProjectId, true);
      addLog({ projectId: currentProjectId, agentId: 'user', content: '✅ 用户验收通过' });
      setShowAcceptancePanel(false);
    } catch (err: unknown) {
      addLog({ projectId: currentProjectId, agentId: 'system', content: `❌ 验收失败: ${toErrorMessage(err)}` });
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (!currentProjectId || submitting || !rejectReason.trim()) return;
    setSubmitting(true);
    try {
      await window.automater.project.userAccept(currentProjectId, false, rejectReason.trim());
      addLog({ projectId: currentProjectId, agentId: 'user', content: `❌ 用户验收驳回: ${rejectReason.trim().slice(0, 80)}` });
      setShowAcceptancePanel(false);
      setRejectReason('');
      setShowRejectForm(false);
    } catch (err: unknown) {
      addLog({ projectId: currentProjectId, agentId: 'system', content: `❌ 驳回失败: ${toErrorMessage(err)}` });
    } finally {
      setSubmitting(false);
    }
  };

  if (!showAcceptancePanel) return null;

  // ── Computed stats ──
  const f = stats?.features || {};
  const total = f.total ?? 0;
  const passed = f.passed ?? 0;
  const failed = f.failed ?? 0;
  const progress = total > 0 ? Math.round((passed / total) * 100) : 0;

  const qaPassCount = features.filter(feat => feat.status === 'qa_passed' || feat.status === 'passed').length;
  const pmApproveCount = features.filter(feat => feat.pm_verdict === 'approved' || feat.status === 'passed').length;
  const hasIssues = failed > 0 || progress < 100;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setShowAcceptancePanel(false)}
      />

      {/* Modal */}
      <div className="relative bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl shadow-black/40 w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-lg">
              🎯
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-100">用户验收</h2>
              <p className="text-xs text-slate-500">请审查开发成果并做出验收决定</p>
            </div>
          </div>
          <button
            onClick={() => setShowAcceptancePanel(false)}
            className="w-8 h-8 rounded-lg hover:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-slate-200 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Body (scrollable) */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Progress overview */}
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-slate-800/50 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-slate-100">{progress}%</div>
              <div className="text-[10px] text-slate-500 mt-0.5">总完成度</div>
            </div>
            <div className="bg-slate-800/50 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-emerald-400">{passed}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">已完成</div>
            </div>
            <div className="bg-slate-800/50 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-red-400">{failed}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">失败</div>
            </div>
            <div className="bg-slate-800/50 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-slate-300">{total}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">总 Feature</div>
            </div>
          </div>

          {/* Document status */}
          <div className="bg-slate-800/30 border border-slate-800 rounded-xl p-4">
            <h3 className="text-xs font-semibold text-slate-400 mb-3">📄 文档完成度</h3>
            <div className="grid grid-cols-3 gap-3 text-xs">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${hasDesignDoc ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                <span className="text-slate-300">设计文档</span>
                <span className={`ml-auto ${hasDesignDoc ? 'text-emerald-400' : 'text-slate-600'}`}>
                  {hasDesignDoc ? '✓' : '—'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${qaPassCount > 0 ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                <span className="text-slate-300">QA 审查</span>
                <span className="ml-auto text-slate-400">{qaPassCount}/{total}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${pmApproveCount > 0 ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                <span className="text-slate-300">PM 验收</span>
                <span className="ml-auto text-slate-400">{pmApproveCount}/{total}</span>
              </div>
            </div>
          </div>

          {/* Feature list */}
          <div>
            <h3 className="text-xs font-semibold text-slate-400 mb-2">📋 Feature 详情</h3>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {features
                .sort((a, b) => a.priority - b.priority)
                .map(feat => {
                  const verdict = VERDICT_STYLES[feat.status] || VERDICT_STYLES.todo;
                  return (
                    <div key={feat.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-800/50 transition-colors">
                      <span className="text-xs">{verdict.icon}</span>
                      <span className="text-[10px] text-slate-600 font-mono w-14 flex-shrink-0">{feat.id}</span>
                      <span className="text-xs text-slate-300 flex-1 truncate">{feat.title}</span>
                      <span className={`text-[10px] ${verdict.color}`}>{verdict.text}</span>
                    </div>
                  );
                })}
            </div>
          </div>

          {/* Warning banner */}
          {hasIssues && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 flex items-start gap-3">
              <span className="text-amber-400 text-sm flex-shrink-0 mt-0.5">⚠️</span>
              <div className="text-xs text-amber-300/80 leading-relaxed">
                <strong>注意:</strong> 当前有 {failed} 个 Feature 处于失败状态, 
                总完成度 {progress}%。您仍然可以选择验收通过, 但建议先检查失败项。
              </div>
            </div>
          )}

          {/* Reject form */}
          {showRejectForm && (
            <div className="space-y-2">
              <label className="text-xs text-slate-400">驳回理由:</label>
              <textarea
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                placeholder="请描述不满足预期的部分, 或需要修改的内容..."
                rows={3}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-slate-100 placeholder-slate-600 resize-y focus:outline-none focus:border-red-500 transition-colors text-sm"
                autoFocus
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-between flex-shrink-0">
          <button
            onClick={() => { setShowAcceptancePanel(false); setProjectPage('docs'); }}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            📄 查看文档详情
          </button>
          <div className="flex gap-3">
            {showRejectForm ? (
              <>
                <button
                  onClick={() => setShowRejectForm(false)}
                  className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleReject}
                  disabled={!rejectReason.trim() || submitting}
                  className="px-5 py-2 rounded-lg text-sm bg-red-600 hover:bg-red-500 text-white transition-all disabled:bg-slate-800 disabled:text-slate-600"
                >
                  {submitting ? '提交中...' : '❌ 确认驳回'}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setShowRejectForm(true)}
                  className="px-4 py-2 rounded-lg text-sm border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-all"
                >
                  ❌ 驳回
                </button>
                <button
                  onClick={handleAccept}
                  disabled={submitting}
                  className="px-6 py-2 rounded-lg text-sm bg-emerald-600 hover:bg-emerald-500 text-white transition-all disabled:bg-slate-800 disabled:text-slate-600 font-medium"
                >
                  {submitting ? '提交中...' : '✅ 验收通过'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}