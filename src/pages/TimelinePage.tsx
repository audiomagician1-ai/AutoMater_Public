/**
 * TimelinePage — 事件流时间线 + 项目分析 (v2.0)
 *
 * 可视化展示项目的所有事件:
 * - 按时间排列的事件时间线
 * - Feature 维度的事件筛选
 * - 工具调用统计面板
 * - 成本/token 分析图表
 * - Mission 检查点列表
 * - 进度报告生成
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '../stores/app-store';
import { createLogger } from '../utils/logger';

const log = createLogger('TimelinePage');

type TabId = 'timeline' | 'replay' | 'analytics' | 'checkpoints' | 'knowledge';

/** v17.0: stats 接口 — 来自 events.getStats() */
interface TimelineStats {
  totalEvents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  eventsByType: Record<string, number>;
  toolStats: Array<{ toolName: string; calls: number; avgDurationMs: number; successRate: number }>;
  featureStats: Array<{ featureId: string; events: number; durationMs: number; costUsd: number; toolCalls: number; llmCalls: number }>;
  [key: string]: unknown;
}

/** v17.0: MissionRecord 扩展（含运行时计算字段） */
interface MissionStatusRecord extends MissionRecord {
  passed?: number;
  total?: number;
  canResume?: boolean;
  estimatedRemainingCostUsd?: number;
}

/** v17.0: knowledge stats 接口 */
interface KnowledgeStats {
  totalEntries: number;
  topUsed: Array<{ id: string; tags: string[]; summary: string; useCount: number }>;
  byTag: Record<string, number>;
  [key: string]: unknown;
}

const EVENT_ICONS: Record<string, string> = {
  'project:start': '🚀',
  'project:stop': '⏹️',
  'project:complete': '🏁',
  'phase:pm:start': '🧠',
  'phase:pm:end': '✅',
  'phase:architect:start': '🏗️',
  'phase:architect:end': '📐',
  'phase:dev:start': '⚡',
  'phase:dev:end': '✅',
  'feature:locked': '🔒',
  'feature:passed': '✅',
  'feature:failed': '❌',
  'feature:qa:start': '🔍',
  'feature:qa:result': '📋',
  'react:iteration': '🔄',
  'react:complete': '🎯',
  'tool:call': '🔧',
  'tool:result': '📥',
  'llm:call': '🤖',
  'llm:result': '💬',
  'subagent:start': '🔬',
  'subagent:result': '📝',
  'memory:write': '💾',
  'lesson:extracted': '📖',
  'error': '❗',
};

export default function TimelinePage() {
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const [tab, setTab] = useState<TabId>('timeline');
  const [events, setEvents] = useState<any[]>([]);
  const [stats, setStats] = useState<TimelineStats | null>(null);
  const [checkpoints, setCheckpoints] = useState<any[]>([]);
  const [missionStatus, setMissionStatus] = useState<MissionStatusRecord | null>(null);
  const [knowledgeStats, setKnowledgeStats] = useState<KnowledgeStats | null>(null);
  const [filterType, setFilterType] = useState<string>('all');
  const [loading, setLoading] = useState(false);

  // G12: Replay state
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(500); // ms per event
  const [replayFeatureFilter, setReplayFeatureFilter] = useState<string>('all');
  const replayTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const projectId = currentProjectId;

  const loadData = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [evts, st, cps, ms] = await Promise.all([
        window.automater.events.query(projectId, { limit: 200 }),
        window.automater.events.getStats(projectId),
        window.automater.mission.getCheckpoints(projectId),
        window.automater.mission.getStatus(projectId),
      ]);
      setEvents(evts);
      setStats(st as TimelineStats);
      setCheckpoints(cps);
      setMissionStatus(ms as MissionStatusRecord);
    } catch (err) {
      log.error('Failed to load timeline data:', err);
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => { loadData(); }, [loadData]);

  // G12: Replay timer
  const replayEvents = replayFeatureFilter === 'all'
    ? events
    : events.filter(e => e.featureId === replayFeatureFilter);

  useEffect(() => {
    if (replayPlaying && replayEvents.length > 0) {
      replayTimerRef.current = setInterval(() => {
        setReplayIndex(prev => {
          if (prev >= replayEvents.length - 1) {
            setReplayPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, replaySpeed);
    }
    return () => {
      if (replayTimerRef.current) clearInterval(replayTimerRef.current);
    };
  }, [replayPlaying, replaySpeed, replayEvents.length]);

  const replayFeatureIds = [...new Set(events.filter(e => e.featureId).map(e => e.featureId))];

  useEffect(() => {
    if (tab === 'knowledge' && !knowledgeStats) {
      window.automater.knowledge.getStats().then((ks) => setKnowledgeStats(ks as KnowledgeStats)).catch(() => {});
    }
  }, [tab, knowledgeStats]);

  const filteredEvents = filterType === 'all'
    ? events
    : events.filter(e => e.type === filterType || e.type.startsWith(filterType));

  const eventTypes = [...new Set(events.map(e => e.type))];

  if (!projectId) {
    return <div className="p-6 text-slate-400">请先选择一个项目</div>;
  }

  // 空状态
  const isEmpty = events.length === 0 && !loading;

  return (
    <div className="h-full flex flex-col bg-slate-900">
      {/* Tab bar */}
      <div className="flex items-center border-b border-slate-700 px-4">
        {(['timeline', 'replay', 'analytics', 'checkpoints', 'knowledge'] as TabId[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? 'border-indigo-400 text-indigo-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {t === 'timeline' ? '📜 时间线' : t === 'replay' ? '🎬 重放' : t === 'analytics' ? '📊 分析' : t === 'checkpoints' ? '🏁 检查点' : '🌐 经验池'}
          </button>
        ))}
        <div className="ml-auto">
          <button
            onClick={loadData}
            className="px-3 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded"
          >
            刷新
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {loading && <div className="text-slate-400 text-center py-8">加载中...</div>}

        {/* ── 空状态 ── */}
        {isEmpty && tab === 'timeline' && (
          <div className="flex flex-col items-center justify-center py-16 gap-4 text-slate-500">
            <div className="text-5xl">📜</div>
            <div className="text-lg font-medium text-slate-400">事件时间线</div>
            <div className="text-sm text-center max-w-md">
              Agent 开始工作后，所有事件（需求分析、架构设计、代码编写、测试审查）
              <br />都会按时间顺序记录在这里，支持按类型筛选和统计分析。
            </div>
            <div className="grid grid-cols-4 gap-3 mt-4 text-xs">
              {[
                { icon: '🧠', label: 'PM 分析' },
                { icon: '🏗️', label: '架构设计' },
                { icon: '⚡', label: '代码编写' },
                { icon: '🔍', label: 'QA 审查' },
              ].map(item => (
                <div key={item.label} className="bg-slate-800 rounded-lg px-4 py-3 text-center">
                  <div className="text-2xl mb-1">{item.icon}</div>
                  <div className="text-slate-400">{item.label}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Timeline Tab ── */}
        {tab === 'timeline' && !loading && events.length > 0 && (
          <div>
            {/* Filter */}
            <div className="flex items-center gap-2 mb-4 flex-wrap">
              <span className="text-xs text-slate-400">筛选:</span>
              <button
                onClick={() => setFilterType('all')}
                className={`px-2 py-1 text-xs rounded ${filterType === 'all' ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-300'}`}
              >
                全部 ({events.length})
              </button>
              {eventTypes.slice(0, 12).map(t => (
                <button
                  key={t}
                  onClick={() => setFilterType(t)}
                  className={`px-2 py-1 text-xs rounded ${filterType === t ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-300'}`}
                >
                  {EVENT_ICONS[t] || '•'} {t.split(':').pop()} ({events.filter(e => e.type === t).length})
                </button>
              ))}
            </div>

            {/* Event list */}
            <div className="space-y-1">
              {filteredEvents.length === 0 && (
                <div className="text-slate-500 text-center py-8">暂无事件记录</div>
              )}
              {filteredEvents.map((evt, i) => (
                <div key={evt.id || i} className="flex items-start gap-3 px-3 py-2 bg-slate-800/50 rounded hover:bg-slate-800 transition-colors">
                  <span className="text-lg flex-shrink-0">{EVENT_ICONS[evt.type] || '•'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-indigo-400">{evt.type}</span>
                      {evt.agentId && <span className="text-xs text-slate-500">{evt.agentId}</span>}
                      {evt.featureId && <span className="text-xs bg-slate-700 text-slate-300 px-1 rounded">{evt.featureId}</span>}
                      {evt.costUsd != null && evt.costUsd > 0 && (
                        <span className="text-xs text-emerald-400">${evt.costUsd.toFixed(4)}</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5 truncate">
                      {typeof evt.data === 'object' ? JSON.stringify(evt.data).slice(0, 150) : String(evt.data)}
                    </div>
                  </div>
                  <span className="text-[10px] text-slate-600 flex-shrink-0 whitespace-nowrap">
                    {evt.timestamp?.replace('T', ' ').slice(0, 19)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Replay Tab (G12) ── */}
        {tab === 'replay' && !loading && (
          <div>
            {/* Replay controls */}
            <div className="bg-slate-800 rounded-lg p-4 mb-4">
              <div className="flex items-center gap-3 mb-3">
                <button
                  onClick={() => { setReplayIndex(0); setReplayPlaying(false); }}
                  className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded"
                  title="重置"
                >⏮</button>
                <button
                  onClick={() => setReplayIndex(Math.max(0, replayIndex - 1))}
                  className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded"
                  title="上一步"
                >⏪</button>
                <button
                  onClick={() => setReplayPlaying(!replayPlaying)}
                  className={`px-4 py-1.5 text-sm font-medium rounded transition-colors ${
                    replayPlaying ? 'bg-red-600 hover:bg-red-500 text-white' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
                  }`}
                >
                  {replayPlaying ? '⏸ 暂停' : '▶ 播放'}
                </button>
                <button
                  onClick={() => setReplayIndex(Math.min(replayEvents.length - 1, replayIndex + 1))}
                  className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded"
                  title="下一步"
                >⏩</button>
                <button
                  onClick={() => { setReplayIndex(replayEvents.length - 1); setReplayPlaying(false); }}
                  className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded"
                  title="到末尾"
                >⏭</button>

                <div className="ml-4 flex items-center gap-2">
                  <span className="text-xs text-slate-400">速度:</span>
                  {[1000, 500, 200, 50].map(speed => (
                    <button
                      key={speed}
                      onClick={() => setReplaySpeed(speed)}
                      className={`px-2 py-0.5 text-xs rounded ${
                        replaySpeed === speed ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-300'
                      }`}
                    >
                      {speed >= 1000 ? '1x' : speed >= 500 ? '2x' : speed >= 200 ? '5x' : '20x'}
                    </button>
                  ))}
                </div>

                <div className="ml-4 flex items-center gap-2">
                  <span className="text-xs text-slate-400">Feature:</span>
                  <select
                    value={replayFeatureFilter}
                    onChange={e => { setReplayFeatureFilter(e.target.value); setReplayIndex(0); setReplayPlaying(false); }}
                    className="text-xs bg-slate-700 text-slate-300 rounded px-2 py-1 border-none"
                  >
                    <option value="all">全部</option>
                    {replayFeatureIds.map(fid => (
                      <option key={fid} value={fid}>{fid}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Progress bar */}
              <div className="relative h-2 bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 bg-indigo-500 rounded-full transition-all duration-200"
                  style={{ width: `${replayEvents.length > 0 ? (replayIndex / (replayEvents.length - 1)) * 100 : 0}%` }}
                />
              </div>
              <div className="flex justify-between mt-1 text-[10px] text-slate-500">
                <span>事件 {replayIndex + 1} / {replayEvents.length}</span>
                <span>{replayEvents[replayIndex]?.timestamp?.replace('T', ' ').slice(0, 19) || ''}</span>
              </div>
            </div>

            {/* Current event detail */}
            {replayEvents.length > 0 && replayIndex < replayEvents.length && (
              <div className="bg-slate-800 rounded-lg p-4 mb-4 border border-indigo-500/30">
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-2xl">{EVENT_ICONS[replayEvents[replayIndex].type] || '•'}</span>
                  <div>
                    <div className="text-sm font-medium text-indigo-300">{replayEvents[replayIndex].type}</div>
                    <div className="text-xs text-slate-400">
                      {replayEvents[replayIndex].agentId && `Agent: ${replayEvents[replayIndex].agentId}`}
                      {replayEvents[replayIndex].featureId && ` | Feature: ${replayEvents[replayIndex].featureId}`}
                      {replayEvents[replayIndex].costUsd > 0 && ` | 成本: $${replayEvents[replayIndex].costUsd.toFixed(4)}`}
                      {replayEvents[replayIndex].durationMs && ` | 耗时: ${replayEvents[replayIndex].durationMs}ms`}
                    </div>
                  </div>
                </div>
                <pre className="text-xs text-slate-300 bg-slate-900 rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap">
                  {JSON.stringify(replayEvents[replayIndex].data, null, 2)}
                </pre>
              </div>
            )}

            {/* Event timeline (scrolled to current) */}
            <div className="space-y-0.5 max-h-[40vh] overflow-auto">
              {replayEvents.slice(0, replayIndex + 1).map((evt, i) => (
                <div
                  key={evt.id || i}
                  className={`flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors cursor-pointer ${
                    i === replayIndex ? 'bg-indigo-900/50 border border-indigo-500/30' : 'bg-slate-800/30 hover:bg-slate-800/60'
                  }`}
                  onClick={() => { setReplayIndex(i); setReplayPlaying(false); }}
                >
                  <span className="flex-shrink-0">{EVENT_ICONS[evt.type] || '•'}</span>
                  <span className="font-mono text-indigo-400 w-32 truncate">{evt.type}</span>
                  {evt.featureId && <span className="bg-slate-700 px-1 rounded text-slate-300">{evt.featureId}</span>}
                  <span className="text-slate-500 truncate flex-1">
                    {typeof evt.data === 'object' ? JSON.stringify(evt.data).slice(0, 80) : String(evt.data).slice(0, 80)}
                  </span>
                  <span className="text-[10px] text-slate-600 flex-shrink-0">{evt.timestamp?.slice(11, 19)}</span>
                </div>
              ))}
            </div>

            {replayEvents.length === 0 && (
              <div className="text-center text-slate-500 py-12">
                <div className="text-4xl mb-2">🎬</div>
                <div>暂无事件可重放。运行项目后再试。</div>
              </div>
            )}
          </div>
        )}

        {/* ── Analytics Tab ── */}
        {tab === 'analytics' && !loading && stats && (
          <div className="space-y-6">
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: '总事件', value: stats.totalEvents, color: 'text-blue-400' },
                { label: '总 Token', value: `${((stats.totalInputTokens + stats.totalOutputTokens) / 1000).toFixed(1)}K`, color: 'text-purple-400' },
                { label: '总成本', value: `$${stats.totalCostUsd.toFixed(4)}`, color: 'text-emerald-400' },
                { label: '工具调用', value: stats.eventsByType['tool:call'] || 0, color: 'text-orange-400' },
                { label: 'LLM 调用', value: stats.eventsByType['llm:call'] || 0, color: 'text-cyan-400' },
              ].map(card => (
                <div key={card.label} className="bg-slate-800 rounded-lg p-3">
                  <div className="text-xs text-slate-400">{card.label}</div>
                  <div className={`text-xl font-bold ${card.color}`}>{card.value}</div>
                </div>
              ))}
            </div>

            {/* Tool stats */}
            {stats.toolStats?.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-slate-300 mb-2">🔧 工具调用统计</h3>
                <div className="bg-slate-800 rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-slate-400 border-b border-slate-700">
                        <th className="px-3 py-2 text-left">工具</th>
                        <th className="px-3 py-2 text-right">调用次数</th>
                        <th className="px-3 py-2 text-right">平均耗时</th>
                        <th className="px-3 py-2 text-right">成功率</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.toolStats.map((t: { toolName: string; calls: number; avgDurationMs: number; successRate: number }) => (
                        <tr key={t.toolName} className="border-b border-slate-700/50 text-slate-300">
                          <td className="px-3 py-1.5 font-mono">{t.toolName}</td>
                          <td className="px-3 py-1.5 text-right">{t.calls}</td>
                          <td className="px-3 py-1.5 text-right">{t.avgDurationMs}ms</td>
                          <td className="px-3 py-1.5 text-right">
                            <span className={t.successRate >= 0.9 ? 'text-green-400' : t.successRate >= 0.7 ? 'text-yellow-400' : 'text-red-400'}>
                              {(t.successRate * 100).toFixed(0)}%
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Feature stats */}
            {stats.featureStats?.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-slate-300 mb-2">📦 Feature 统计</h3>
                <div className="bg-slate-800 rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-slate-400 border-b border-slate-700">
                        <th className="px-3 py-2 text-left">Feature</th>
                        <th className="px-3 py-2 text-right">事件数</th>
                        <th className="px-3 py-2 text-right">工具调用</th>
                        <th className="px-3 py-2 text-right">LLM 调用</th>
                        <th className="px-3 py-2 text-right">成本</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.featureStats.map((f: { featureId: string; events: number; toolCalls: number; llmCalls: number; costUsd: number }) => (
                        <tr key={f.featureId} className="border-b border-slate-700/50 text-slate-300">
                          <td className="px-3 py-1.5 font-mono">{f.featureId}</td>
                          <td className="px-3 py-1.5 text-right">{f.events}</td>
                          <td className="px-3 py-1.5 text-right">{f.toolCalls}</td>
                          <td className="px-3 py-1.5 text-right">{f.llmCalls}</td>
                          <td className="px-3 py-1.5 text-right text-emerald-400">${f.costUsd.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Mission status */}
            {missionStatus && (
              <div className="bg-slate-800 rounded-lg p-4">
                <h3 className="text-sm font-medium text-slate-300 mb-2">📋 Mission 状态</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                  <div><span className="text-slate-400">状态:</span> <span className="text-white">{missionStatus.status}</span></div>
                  <div><span className="text-slate-400">完成:</span> <span className="text-green-400">{missionStatus.passed}/{missionStatus.total}</span></div>
                  <div><span className="text-slate-400">可续跑:</span> <span className={missionStatus.canResume ? 'text-green-400' : 'text-slate-500'}>{missionStatus.canResume ? '是' : '否'}</span></div>
                  <div><span className="text-slate-400">预估剩余:</span> <span className="text-orange-400">${missionStatus.estimatedRemainingCostUsd?.toFixed(4)}</span></div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Checkpoints Tab ── */}
        {tab === 'checkpoints' && !loading && (
          <div className="space-y-3">
            {checkpoints.length === 0 && (
              <div className="text-slate-500 text-center py-8">暂无检查点</div>
            )}
            {checkpoints.map(cp => (
              <div key={cp.id} className="bg-slate-800 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-slate-200">🏁 {cp.label}</span>
                  <span className="text-xs text-slate-500">{cp.createdAt?.replace('T', ' ').slice(0, 19)}</span>
                </div>
                <div className="text-xs text-slate-400">{cp.progressSummary}</div>
                <div className="flex gap-4 mt-2 text-xs text-slate-500">
                  <span>Features: {cp.featuresCompleted}/{cp.featuresTotal}</span>
                  <span>Tokens: {(cp.totalTokens / 1000).toFixed(1)}K</span>
                  <span>Cost: ${cp.totalCostUsd.toFixed(4)}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Knowledge Tab ── */}
        {tab === 'knowledge' && !loading && (
          <div className="space-y-4">
            {knowledgeStats ? (
              <>
                <div className="bg-slate-800 rounded-lg p-4">
                  <h3 className="text-sm font-medium text-slate-300 mb-2">🌐 全局经验池统计</h3>
                  <div className="text-xs text-slate-400">
                    总经验条目: <span className="text-white">{knowledgeStats.totalEntries}</span>
                  </div>
                  {Object.keys(knowledgeStats.byTag || {}).length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {Object.entries(knowledgeStats.byTag).map(([tag, count]) => (
                        <span key={tag} className="px-2 py-1 bg-slate-700 text-slate-300 rounded text-xs">
                          {tag}: {count as number}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {knowledgeStats.topUsed?.length > 0 && (
                  <div className="bg-slate-800 rounded-lg p-4">
                    <h3 className="text-sm font-medium text-slate-300 mb-2">🔥 最常引用经验</h3>
                    {knowledgeStats.topUsed.map((e: { useCount: number; summary: string }, i: number) => (
                      <div key={i} className="flex items-center gap-2 py-1 text-xs">
                        <span className="text-indigo-400">×{e.useCount}</span>
                        <span className="text-slate-300">{e.summary}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="text-slate-500 text-center py-8">经验池为空。完成项目后经验会自动提取。</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
