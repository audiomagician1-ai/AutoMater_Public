/**
 * OverviewPage — 项目全景 (v6.1 refactored)
 *
 * 子组件已提取到 ./overview/ 目录:
 *   InteractiveGraph — 三层级 DAG 可视化 (dagre 布局)
 *   ProgressRing / StatCard — 数据展示原子组件
 *   PipelineBar / DocCompletionBar — 流水线 & 文档进度
 *   AgentActivityPanel — Agent 实时工作面板
 */

import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../stores/app-store';
import { TechBackground } from '../components/TechBackground';
import { SystemMonitor } from '../components/SystemMonitor';
import { ActivityCharts } from '../components/ActivityCharts';
import {
  InteractiveGraph, ProgressRing, StatCard,
  PipelineBar, PIPELINE_STAGES, DocCompletionBar,
  AgentActivityPanel,
  STATUS_COLOR, CATEGORY_BADGE, PROJECT_STATUS,
  type Feature,
} from './overview';

export function OverviewPage() {
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const featureStatuses = useAppStore(s => s.featureStatuses);
  const addLog = useAppStore(s => s.addLog);
  const settingsConfigured = useAppStore(s => s.settingsConfigured);
  const setGlobalPage = useAppStore(s => s.setGlobalPage);
  const setProjectPage = useAppStore(s => s.setProjectPage);
  const showAcceptancePanel = useAppStore(s => s.showAcceptancePanel);
  const setShowAcceptancePanel = useAppStore(s => s.setShowAcceptancePanel);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [project, setProject] = useState<any>(null);

  // v5.1: 导入分析实时进度
  const [importProgress, setImportProgress] = useState<{
    phase: number; step: string; progress: number; done?: boolean; error?: boolean;
  } | null>(null);

  // 切换项目时清空残留的分析进度
  useEffect(() => {
    setImportProgress(null);
  }, [currentProjectId]);

  const load = useCallback(async () => {
    if (!currentProjectId) return;
    const [feats, st, proj] = await Promise.all([
      window.automater.project.getFeatures(currentProjectId),
      window.automater.project.getStats(currentProjectId),
      window.automater.project.get(currentProjectId),
    ]);
    setFeatures(feats || []);
    setStats(st);
    setProject(proj);
    // 如果项目进入 analyzing 状态但没有进度信息，设初始值
    if (proj?.status === 'analyzing' && !importProgress) {
      setImportProgress({ phase: 0, step: '分析中...', progress: 0 });
    }
    // 分析完成后清除进度
    if (proj?.status !== 'analyzing' && importProgress?.done) {
      // 保留完成消息 5 秒后清除
      setTimeout(() => setImportProgress(null), 8000);
    }
  }, [currentProjectId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  // 订阅后端 import-progress 事件
  useEffect(() => {
    const unsub = window.automater.on('project:import-progress', (data: IpcImportProgressData) => {
      if (data.projectId === currentProjectId) {
        setImportProgress({
          phase: data.phase,
          step: data.step,
          progress: data.progress,
          done: data.done,
          error: !!data.error,
        });
        if (data.done) load(); // 刷新项目数据
      }
    });
    return unsub;
  }, [currentProjectId, load]);

  const [starting, setStarting] = useState(false);

  const handleStart = async () => {
    if (!currentProjectId || starting) return;
    if (!settingsConfigured) { setGlobalPage('settings'); return; }
    setStarting(true);
    try {
      await window.automater.project.start(currentProjectId);
      addLog({ projectId: currentProjectId, agentId: 'system', content: '🚀 Agent 团队开始工作' });
      load();
    } finally {
      // 1.5 秒后才允许再次点击，防止快速双击
      setTimeout(() => setStarting(false), 1500);
    }
  };
  const handleStop = async () => {
    if (!currentProjectId) return;
    await window.automater.project.stop(currentProjectId);
    addLog({ projectId: currentProjectId, agentId: 'system', content: '⏸ 已暂停' });
    load();
  };

  if (!currentProjectId) {
    return <div className="h-full flex items-center justify-center text-slate-500"><p>加载中...</p></div>;
  }

  const enriched = features.map(f => ({ ...f, status: featureStatuses.get(f.id) || f.status }));

  const f = stats?.features || {};
  const a = stats?.agents || {};
  const total = f.total ?? 0;
  const passed = f.passed ?? 0;
  const inProgress = f.in_progress ?? 0;
  const reviewing = f.reviewing ?? 0;
  const failed = f.failed ?? 0;
  const todo = f.todo ?? 0;
  const progress = total > 0 ? (passed / total) * 100 : 0;

  const categoryCount = new Map<string, number>();
  enriched.forEach(feat => {
    const cat = feat.category || 'other';
    categoryCount.set(cat, (categoryCount.get(cat) ?? 0) + 1);
  });

  // 项目状态判断
  const isAnalyzing = project?.status === 'analyzing';
  const isActive = project && (project.status === 'initializing' || project.status === 'analyzing' || project.status === 'developing' || project.status === 'reviewing');
  const canStart = project && !isActive && project.wish?.trim();
  const canResume = project && (project.status === 'paused' || project.status === 'error');
  const noWish = project && !isActive && !canResume && !project.wish?.trim();

  // 导入项目启动分析
  const handleAnalyze = async () => {
    if (!currentProjectId) return;
    if (!settingsConfigured) { setGlobalPage('settings'); return; }
    await window.automater.project.start(currentProjectId);
    addLog({ projectId: currentProjectId, agentId: 'system', content: '📥 启动项目导入分析...' });
    load();
  };

  return (
    <div className="h-full flex flex-col overflow-y-auto relative">
      {/* 科技感动态背景 */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <TechBackground intensity={isActive ? 1.5 : 0.6} />
        {/* 渐变遮罩保证内容可读性 */}
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950/40 via-slate-950/80 to-slate-950/95" />
      </div>
      {/* ═══════ Command Center Header ═══════ */}
      <div className="flex-shrink-0 px-6 pt-6 pb-2 relative z-10">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xl font-bold">指挥中心</h2>
          <button onClick={load} className="text-sm text-slate-500 hover:text-slate-300 transition-colors" title="刷新">🔄</button>
        </div>
      </div>

      {/* ═══════ Compact Control Bar ═══════ */}
      <div className="flex-shrink-0 mx-6 mb-4 relative z-10">
        <div className={`relative overflow-hidden rounded-2xl border transition-all duration-500 ${
          isActive
            ? 'border-emerald-500/30 bg-gradient-to-br from-emerald-950/50 via-slate-900 to-cyan-950/50'
            : canResume
              ? 'border-amber-500/30 bg-gradient-to-br from-amber-950/30 via-slate-900 to-orange-950/30'
              : 'border-slate-700/50 bg-gradient-to-br from-slate-900 via-slate-900/80 to-forge-950/50'
        }`}>
          {isActive && (
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute top-0 left-1/4 w-20 h-20 bg-emerald-500/5 rounded-full blur-3xl animate-pulse" />
              <div className="absolute bottom-0 right-1/4 w-24 h-24 bg-cyan-500/5 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
            </div>
          )}

          <div className="relative flex items-center gap-4 py-3 px-6">
            {/* Status indicator + Action button (inline compact) */}
            {project && (() => {
              const st = PROJECT_STATUS[project.status] || { text: project.status, color: 'text-slate-500' };
              return (
                <div className="flex items-center gap-2 shrink-0">
                  {isActive && <span className="relative flex h-2.5 w-2.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span><span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span></span>}
                  {canResume && <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />}
                  {!isActive && !canResume && <span className="w-2.5 h-2.5 rounded-full bg-slate-600" />}
                  <span className={`text-sm font-semibold ${st.color}`}>{st.text}</span>
                </div>
              );
            })()}

            {/* Action button — compact inline */}
            <div className="flex-1 flex items-center justify-center">
              {isAnalyzing && importProgress ? (
                <button onClick={handleStop}
                  className="group flex items-center gap-2 px-5 py-2 rounded-xl bg-cyan-900/40 hover:bg-red-900/40 border border-cyan-500/20 hover:border-red-500/30 transition-all">
                  <span className="text-lg group-hover:hidden">📥</span>
                  <span className="text-lg hidden group-hover:inline">⏸</span>
                  <span className="text-sm font-bold text-cyan-300 group-hover:text-red-300 transition-colors">分析中</span>
                  <span className="text-[10px] text-cyan-400/60 group-hover:text-red-400/80 transition-colors">点击中断</span>
                </button>
              ) : isAnalyzing && !importProgress ? (
                <button onClick={handleAnalyze}
                  className="group flex items-center gap-2 px-5 py-2 rounded-xl bg-cyan-900/30 hover:bg-cyan-800/40 border border-cyan-500/20 hover:border-cyan-400/40 transition-all hover:shadow-lg hover:shadow-cyan-500/10">
                  <span className="text-lg group-hover:scale-110 transition-all">📥</span>
                  <span className="text-sm font-bold text-cyan-300 group-hover:text-white transition-colors">开始分析</span>
                  <span className="text-[10px] text-cyan-400/60">导入项目</span>
                </button>
              ) : isActive ? (
                <button onClick={handleStop}
                  className="group flex items-center gap-2 px-5 py-2 rounded-xl bg-emerald-900/40 hover:bg-red-900/40 border border-emerald-500/20 hover:border-red-500/30 transition-all">
                  <span className="text-lg group-hover:hidden">⚡</span>
                  <span className="text-lg hidden group-hover:inline">⏸</span>
                  <span className="text-sm font-bold text-emerald-300 group-hover:text-red-300 transition-colors">运行中</span>
                  <span className="text-[10px] text-emerald-400/60 group-hover:text-red-400/80 transition-colors">点击暂停</span>
                </button>
              ) : canResume ? (
                <button onClick={handleStart} disabled={starting}
                  className="group flex items-center gap-2 px-5 py-2 rounded-xl bg-amber-900/30 hover:bg-emerald-900/40 border border-amber-500/20 hover:border-emerald-500/30 transition-all hover:shadow-lg hover:shadow-emerald-500/10 disabled:opacity-50 disabled:cursor-not-allowed">
                  <span className="text-lg">▶️</span>
                  <span className="text-sm font-bold text-amber-300 group-hover:text-emerald-300 transition-colors">已暂停</span>
                  <span className="text-[10px] text-amber-400/60 group-hover:text-emerald-400/80 transition-colors">点击继续</span>
                </button>
              ) : canStart ? (
                <button onClick={handleStart} disabled={starting}
                  className="group flex items-center gap-2 px-5 py-2 rounded-xl bg-forge-800/50 hover:bg-forge-700/60 border border-forge-500/20 hover:border-forge-400/40 transition-all hover:shadow-lg hover:shadow-forge-500/20 disabled:opacity-50 disabled:cursor-not-allowed">
                  <span className="text-lg group-hover:scale-110 group-hover:rotate-12 transition-all">🚀</span>
                  <span className="text-sm font-bold text-forge-300 group-hover:text-white transition-colors">启动开发</span>
                </button>
              ) : noWish ? (
                <button onClick={() => setProjectPage('wish')}
                  className="group flex items-center gap-2 px-5 py-2 rounded-xl border border-dashed border-slate-700 hover:border-forge-500/40 transition-all">
                  <span className="text-lg">✨</span>
                  <span className="text-sm font-bold text-slate-400 group-hover:text-forge-300 transition-colors">去许愿</span>
                </button>
              ) : null}
            </div>

            {/* Live stats (right side) */}
            {isActive && (
              <div className="flex items-center gap-4 text-xs text-slate-500 shrink-0">
                <span>🤖 {a.total ?? 0}</span>
                <span>📊 {a.total_tokens ? `${(a.total_tokens / 1000).toFixed(1)}k` : '0'}</span>
                <span>💰 {a.total_cost ? `$${a.total_cost.toFixed(3)}` : '$0'}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 px-6 pb-6 space-y-6 relative z-10">
        {/* ═══════ Real-time Monitoring Dashboard (v6.0) — 置顶 ═══════ */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-slate-400">📡 实时监控</h3>
            <span className="text-[9px] text-slate-600">每 2 秒采样</span>
          </div>
          <SystemMonitor />
        </section>

        {/* ═══════ Activity Timeseries Charts (v6.0) ═══════ */}
        {currentProjectId && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-slate-400">📈 活动趋势 <span className="text-[10px] text-slate-600 font-normal">过去 30 分钟</span></h3>
              <span className="text-[9px] text-slate-600">每 10 秒刷新</span>
            </div>
            <ActivityCharts projectId={currentProjectId} />
          </section>
        )}

        {/* Project Import Analysis — Real-time Progress (v5.1) */}
        {project?.status === 'analyzing' && (
          <section className="bg-gradient-to-r from-cyan-900/15 to-slate-900/30 border border-cyan-800/30 rounded-xl p-5 animate-in fade-in">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                {importProgress?.done && !importProgress?.error ? (
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                ) : importProgress?.error ? (
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
                ) : (
                  <div className="w-2.5 h-2.5 rounded-full bg-cyan-500 animate-pulse" />
                )}
                <span className="text-sm font-medium text-cyan-300">
                  📥 项目导入分析
                  {importProgress?.done && !importProgress?.error && ' — 完成 ✅'}
                  {importProgress?.error && ' — 失败 ❌'}
                </span>
              </div>
              <span className="text-[10px] text-slate-500 font-mono">
                Step {Math.min((importProgress?.phase ?? 0) + 1, 2)}/2
              </span>
            </div>

            {/* Phase 指示器 */}
            <div className="grid grid-cols-2 gap-2 mb-4">
              {[
                { phase: 0, label: '收集快照', icon: '📸', desc: '目录树 / 配置 / 符号索引' },
                { phase: 1, label: 'AI 分析', icon: '🤖', desc: '大模型理解项目 → 生成文档' },
              ].map((p) => {
                const current = importProgress?.phase ?? -1;
                const isDone = current > p.phase || (current === p.phase && importProgress?.done && !importProgress?.error);
                const isActive = current === p.phase && !importProgress?.done;
                const isPending = current < p.phase;
                return (
                  <div
                    key={p.phase}
                    className={`rounded-lg p-3 text-center transition-all duration-500 ${
                      isDone ? 'bg-emerald-900/30 border border-emerald-700/30' :
                      isActive ? 'bg-cyan-900/40 border border-cyan-600/40 shadow-lg shadow-cyan-900/20' :
                      'bg-slate-800/30 border border-slate-700/20'
                    }`}
                  >
                    <div className={`text-xl mb-1 ${isActive ? 'animate-bounce' : ''}`}>{p.icon}</div>
                    <div className={`text-[11px] font-medium ${
                      isDone ? 'text-emerald-400' : isActive ? 'text-cyan-300' : 'text-slate-600'
                    }`}>
                      {isDone ? '✓ ' : ''}{p.label}
                    </div>
                    <div className={`text-[9px] mt-0.5 ${
                      isDone ? 'text-emerald-500/70' : isActive ? 'text-cyan-400/70' : 'text-slate-700'
                    }`}>
                      {p.desc}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 当前步骤详情 + 进度条 */}
            {importProgress && (
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className={`text-xs ${importProgress.error ? 'text-red-400' : importProgress.done ? 'text-emerald-400' : 'text-cyan-400'}`}>
                    {importProgress.step}
                  </span>
                  <span className="text-[10px] text-slate-500 font-mono">
                    {Math.round(importProgress.progress * 100)}%
                  </span>
                </div>
                <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ease-out ${
                      importProgress.error ? 'bg-red-500' : importProgress.done ? 'bg-emerald-500' : 'bg-cyan-500'
                    }`}
                    style={{ width: `${Math.max(2, importProgress.progress * 100)}%` }}
                  />
                </div>
              </div>
            )}

            {/* 完成后提示 */}
            {importProgress?.done && !importProgress?.error && (
              <p className="text-[11px] text-emerald-500/80 mt-3">
                🎉 分析完成！查看「文档」页浏览自动生成的架构文档和需求文档，或在「许愿」页输入新需求开始开发。
              </p>
            )}
          </section>
        )}

        {/* Static analysis info for projects without import */}
        {enriched.length === 0 && !importProgress && project?.status !== 'analyzing' && (
          <section className="bg-gradient-to-r from-cyan-900/10 to-slate-900/30 border border-cyan-800/20 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-slate-600" />
                <span className="text-xs text-slate-500 uppercase tracking-wider font-medium">📥 项目导入分析</span>
              </div>
              <span className="text-[10px] text-slate-600">Phase 0~3 自动化</span>
            </div>
            <p className="text-[10px] text-slate-600">
              💡 在「项目」页选择「导入已有项目」可自动分析大型代码库并生成文档框架。Hot/Warm/Cold 三层记忆确保 Token 高效利用。
            </p>
          </section>
        )}

        {/* Skeleton placeholder modules when no features yet */}
        {enriched.length === 0 && !isActive && (
          <div className="space-y-6">
            {/* Skeleton: Real-time status bar */}
            <section className="bg-slate-900/30 border border-slate-800/50 border-dashed rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full bg-slate-700" />
                <span className="text-xs text-slate-600 uppercase tracking-wider">📡 实时状态</span>
              </div>
              <div className="grid grid-cols-5 gap-3">
                {['待做', '开发中', '审查中', '已完成', '失败'].map(l => (
                  <div key={l} className="bg-slate-800/30 rounded-lg p-3 text-center">
                    <div className="text-lg font-bold text-slate-700">—</div>
                    <div className="text-[10px] text-slate-700">{l}</div>
                  </div>
                ))}
              </div>
            </section>

            {/* Skeleton: Pipeline */}
            <section className="bg-slate-900/30 border border-slate-800/50 border-dashed rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full bg-slate-700" />
                <span className="text-xs text-slate-600 uppercase tracking-wider">🔄 流水线进度</span>
              </div>
              <div className="flex items-center gap-1">
                {PIPELINE_STAGES.map((stage, i) => (
                  <div key={stage.key} className="flex items-center flex-1">
                    <div className="flex flex-col items-center gap-1 flex-1">
                      <div className="w-8 h-8 rounded-lg bg-slate-800/50 flex items-center justify-center text-sm text-slate-700">{stage.icon}</div>
                      <span className="text-[9px] text-slate-700 text-center truncate w-full">{stage.label}</span>
                    </div>
                    {i < PIPELINE_STAGES.length - 1 && <div className="h-0.5 w-4 flex-shrink-0 bg-slate-800/50" />}
                  </div>
                ))}
              </div>
            </section>

            {/* Skeleton: Architecture graph */}
            <section className="bg-slate-900/30 border border-slate-800/50 border-dashed rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full bg-slate-700" />
                <span className="text-xs text-slate-600 uppercase tracking-wider">🗺️ 系统架构图</span>
              </div>
              <div className="h-48 flex items-center justify-center">
                <div className="text-center text-slate-700 space-y-2">
                  <div className="flex items-center justify-center gap-4">
                    {['模块A', '模块B', '模块C'].map(m => (
                      <div key={m} className="w-24 h-12 rounded-lg border border-slate-800/50 bg-slate-800/20 flex items-center justify-center text-[10px] text-slate-700">{m}</div>
                    ))}
                  </div>
                  <div className="text-[10px]">PM 分析后自动生成</div>
                </div>
              </div>
            </section>

            {/* Skeleton: Progress dashboard */}
            <section className="bg-slate-900/30 border border-slate-800/50 border-dashed rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full bg-slate-700" />
                <span className="text-xs text-slate-600 uppercase tracking-wider">📊 进度看板</span>
              </div>
              <div className="grid grid-cols-4 gap-3">
                {['Agents', 'Tokens', '成本', '分类'].map(l => (
                  <div key={l} className="bg-slate-800/30 rounded-lg p-3 text-center">
                    <div className="text-lg font-bold text-slate-700">—</div>
                    <div className="text-[10px] text-slate-700">{l}</div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* Progress dashboard */}
        {enriched.length > 0 && (
          <section>
            <h3 className="text-sm font-medium text-slate-400 mb-3">📊 进度概览</h3>
            <div className="flex flex-wrap gap-6 items-start">
              <div className="flex gap-4">
                <ProgressRing value={progress} label="总进度" color="#22c55e" />
                {failed > 0 && <ProgressRing value={total > 0 ? (failed / total) * 100 : 0} size={80} label="失败率" color="#ef4444" />}
              </div>
              <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 min-w-[300px]">
                <StatCard icon="⬜" label="待做" value={String(todo)} />
                <StatCard icon="🔨" label="开发中" value={String(inProgress)} />
                <StatCard icon="🔍" label="审查中" value={String(reviewing)} />
                <StatCard icon="✅" label="已完成" value={String(passed)} />
                <StatCard icon="❌" label="失败" value={String(failed)} />
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard icon="🤖" label="Agents" value={String(a.total ?? 0)} />
              <StatCard icon="📊" label="Tokens" value={a.total_tokens ? `${(a.total_tokens / 1000).toFixed(1)}k` : '0'} />
              <StatCard icon="💰" label="成本" value={a.total_cost ? `$${a.total_cost.toFixed(3)}` : '$0'} />
              <StatCard icon="📁" label="分类" value={String(categoryCount.size)}
                sub={[...categoryCount.entries()].map(([k, v]) => `${CATEGORY_BADGE[k] || '📦'}${k}: ${v}`).join('  ')} />
            </div>
          </section>
        )}

        {/* Pipeline + Doc completion (v4.4) */}
        {enriched.length > 0 && project && (
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <PipelineBar projectStatus={project.status} features={enriched} />
            <DocCompletionBar features={enriched} projectId={currentProjectId!} />
          </section>
        )}

        {/* User acceptance prompt */}
        {project?.status === 'awaiting_user_acceptance' && !showAcceptancePanel && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-5 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🎯</span>
              <div>
                <div className="text-sm font-medium text-amber-300">项目等待您的验收</div>
                <div className="text-xs text-amber-400/60">所有 Feature 已通过开发和 QA 审查, 请做出最终决定</div>
              </div>
            </div>
            <button
              onClick={() => setShowAcceptancePanel(true)}
              className="px-5 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium transition-all"
            >
              开始验收
            </button>
          </div>
        )}

        {/* DAG graph */}
        {enriched.length > 0 && (
          <section>
            <h3 className="text-sm font-medium text-slate-400 mb-3">🗺️ 系统架构图</h3>
            <InteractiveGraph features={enriched} onDrillDown={() => {}} />
            <div className="flex gap-4 mt-2 text-[10px] text-slate-500">
              {Object.entries(STATUS_COLOR).map(([key, sc]) => (
                <span key={key} className="flex items-center gap-1">
                  <span className={`w-2 h-2 rounded-full ${sc.bg}`} />
                  {key === 'todo' ? '待做' : key === 'in_progress' ? '开发中' : key === 'reviewing' ? '审查中' : key === 'passed' ? '已完成' : '失败'}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* ═══════ Agent 实时活动面板 (v6.1) ═══════ */}
        <AgentActivityPanel />

        {/* Feature roadmap */}
        {enriched.length > 0 && (
          <section>
            <h3 className="text-sm font-medium text-slate-400 mb-3">📋 Feature 路线图</h3>
            <div className="space-y-1">
              {enriched
                .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
                .map(feat => {
                  const sc = STATUS_COLOR[feat.status] || STATUS_COLOR.todo;
                  return (
                    <div key={feat.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-900/70 transition-colors">
                      <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: sc.stroke }} />
                      <span className="text-[10px] text-slate-600 font-mono w-12 flex-shrink-0">{feat.id}</span>
                      <span className="text-[10px] w-5">{CATEGORY_BADGE[feat.category] || '📦'}</span>
                      <span className="text-xs text-slate-300 flex-1 truncate">{feat.title || feat.description}</span>
                      {feat.group_name && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">{feat.group_name}</span>
                      )}
                      <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: sc.text, backgroundColor: sc.fill }}>
                        {feat.status === 'todo' ? '待做' : feat.status === 'in_progress' ? '开发中' : feat.status === 'reviewing' ? '审查中' : feat.status === 'passed' ? '✓' : '✗'}
                      </span>
                      <span className="text-[10px] text-slate-600">P{feat.priority}</span>
                    </div>
                  );
                })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
