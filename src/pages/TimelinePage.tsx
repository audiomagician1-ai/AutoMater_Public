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

import React, { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../stores/app-store';

type TabId = 'timeline' | 'analytics' | 'checkpoints' | 'knowledge';

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
  const { currentProject } = useAppStore();
  const [tab, setTab] = useState<TabId>('timeline');
  const [events, setEvents] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [checkpoints, setCheckpoints] = useState<any[]>([]);
  const [missionStatus, setMissionStatus] = useState<any>(null);
  const [knowledgeStats, setKnowledgeStats] = useState<any>(null);
  const [filterType, setFilterType] = useState<string>('all');
  const [loading, setLoading] = useState(false);

  const projectId = currentProject?.id;

  const loadData = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [evts, st, cps, ms] = await Promise.all([
        window.agentforge.events.query(projectId, { limit: 200 }),
        window.agentforge.events.getStats(projectId),
        window.agentforge.mission.getCheckpoints(projectId),
        window.agentforge.mission.getStatus(projectId),
      ]);
      setEvents(evts);
      setStats(st);
      setCheckpoints(cps);
      setMissionStatus(ms);
    } catch (err) {
      console.error('Failed to load timeline data:', err);
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (tab === 'knowledge' && !knowledgeStats) {
      window.agentforge.knowledge.getStats().then(setKnowledgeStats).catch(() => {});
    }
  }, [tab, knowledgeStats]);

  const filteredEvents = filterType === 'all'
    ? events
    : events.filter(e => e.type === filterType || e.type.startsWith(filterType));

  const eventTypes = [...new Set(events.map(e => e.type))];

  if (!projectId) {
    return <div className="p-6 text-slate-400">请先选择一个项目</div>;
  }

  return (
    <div className="h-full flex flex-col bg-slate-900">
      {/* Tab bar */}
      <div className="flex items-center border-b border-slate-700 px-4">
        {(['timeline', 'analytics', 'checkpoints', 'knowledge'] as TabId[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? 'border-indigo-400 text-indigo-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {t === 'timeline' ? '📜 时间线' : t === 'analytics' ? '📊 分析' : t === 'checkpoints' ? '🏁 检查点' : '🌐 经验池'}
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

        {/* ── Timeline Tab ── */}
        {tab === 'timeline' && !loading && (
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
                      {stats.toolStats.map((t: any) => (
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
                      {stats.featureStats.map((f: any) => (
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
                    {knowledgeStats.topUsed.map((e: any, i: number) => (
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
