/**
 * WorkflowPage — v2.0 任务优先
 *
 * 顶部: 紧凑流水线缩略图 (单行)
 * 首屏: 常驻临时任务面板 (无需按键/滚动)
 * 底部: 任务历史记录
 */

import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../stores/app-store';

/** Mission record from DB */
interface MissionRecord {
  id: string;
  type: string;
  status: string;
  plan?: string;
  conclusion?: string;
  token_usage?: number;
  cost_usd?: number;
  created_at?: string;
  completed_at?: string;
}

// ═══════════════════════════════════════
// Mission Types (临时工作流)
// ═══════════════════════════════════════

const MISSION_TYPES = [
  { type: 'regression_test', icon: '🧪', label: '全量回归测试', desc: '对所有 Feature 执行回归测试' },
  { type: 'code_review',    icon: '🔍', label: '全量代码审查', desc: '审查代码质量、安全性、性能' },
  { type: 'retrospective',  icon: '📊', label: '架构复盘',     desc: '多维度分析架构，输出改进建议' },
  { type: 'security_audit', icon: '🔒', label: '安全审计',     desc: 'OWASP Top 10 + CWE 漏洞扫描' },
  { type: 'perf_benchmark', icon: '⚡', label: '性能基准',     desc: '关键路径性能分析，识别瓶颈' },
] as const;

// ═══════════════════════════════════════
// Compact Pipeline definition
// ═══════════════════════════════════════

const PIPELINE_COMPACT = [
  { id: 'intake',    icon: '🤖', label: '接收',   color: 'bg-forge-500' },
  { id: 'pm',        icon: '🧠', label: 'PM',     color: 'bg-violet-500' },
  { id: 'architect', icon: '🏗️', label: '架构',   color: 'bg-blue-500' },
  { id: 'docs',      icon: '📋', label: '文档',   color: 'bg-cyan-500' },
  { id: 'dev',       icon: '💻', label: '开发',   color: 'bg-amber-500' },
  { id: 'qa',        icon: '🧪', label: 'QA',     color: 'bg-emerald-500' },
  { id: 'devops',    icon: '🚀', label: 'DevOps', color: 'bg-rose-500' },
  { id: 'accept',    icon: '🎯', label: '交付',   color: 'bg-orange-500' },
];

// ═══════════════════════════════════════
// Main WorkflowPage
// ═══════════════════════════════════════

export function WorkflowPage() {
  const { currentProjectId } = useAppStore();

  // Mission state
  const [missions, setMissions] = useState<MissionRecord[]>([]);
  const [launchingMission, setLaunchingMission] = useState(false);

  // Load missions
  const loadMissions = useCallback(async () => {
    if (!currentProjectId) return;
    const list = await window.agentforge.ephemeralMission.list(currentProjectId);
    setMissions(list || []);
  }, [currentProjectId]);

  useEffect(() => { loadMissions(); }, [loadMissions]);
  useEffect(() => {
    const t = setInterval(loadMissions, 5000);
    return () => clearInterval(t);
  }, [loadMissions]);

  const handleLaunchMission = async (type: string) => {
    if (!currentProjectId || launchingMission) return;
    setLaunchingMission(true);
    try {
      await window.agentforge.ephemeralMission.create(currentProjectId, type, { maxWorkers: 3 });
      await loadMissions();
    } finally {
      setLaunchingMission(false);
    }
  };

  const handleCancelMission = async (id: string) => {
    await window.agentforge.ephemeralMission.cancel(id);
    loadMissions();
  };

  const handleDeleteMission = async (id: string) => {
    await window.agentforge.ephemeralMission.delete(id);
    loadMissions();
  };

  if (!currentProjectId) {
    return <div className="h-full flex items-center justify-center text-slate-500">请先选择一个项目</div>;
  }

  const activeMissions = missions.filter(m => ['pending', 'planning', 'executing', 'judging'].includes(m.status));
  const historyMissions = missions.filter(m => !['pending', 'planning', 'executing', 'judging'].includes(m.status));

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 py-3 border-b border-slate-800 shrink-0">
        <h1 className="text-lg font-bold text-slate-100">🔄 工作流</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {/* ═══════ Compact Pipeline (单行缩略) ═══════ */}
        <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl px-4 py-3">
          <div className="flex items-center gap-0.5">
            {PIPELINE_COMPACT.map((stage, i) => (
              <div key={stage.id} className="flex items-center flex-1 min-w-0">
                <div className="flex flex-col items-center gap-0.5 flex-1 min-w-0">
                  <div className={`w-7 h-7 rounded-lg ${stage.color}/20 flex items-center justify-center text-sm`}>
                    {stage.icon}
                  </div>
                  <span className="text-[9px] text-slate-500 text-center truncate w-full">{stage.label}</span>
                </div>
                {i < PIPELINE_COMPACT.length - 1 && (
                  <div className="h-px w-3 bg-slate-700 flex-shrink-0" />
                )}
              </div>
            ))}
          </div>
          <p className="text-[9px] text-slate-600 text-center mt-1">
            需求接收 → PM 分诊 → 架构+设计 → 批量文档 → ReAct 开发 → QA+PM 验收 → 用户交付
          </p>
        </div>

        {/* ═══════ 常驻临时任务面板 ═══════ */}
        <div className="bg-gradient-to-r from-cyan-900/10 to-slate-900/20 border border-cyan-800/20 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-sm">🎯</span>
              <span className="text-xs font-bold text-cyan-300">临时任务</span>
              <span className="text-[9px] text-slate-600">Planner → Workers → Judge · 独立生命周期</span>
            </div>
            {activeMissions.length > 0 && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400">
                {activeMissions.length} 进行中
              </span>
            )}
          </div>

          {/* Mission type cards — 常驻显示 */}
          <div className="grid grid-cols-5 gap-2">
            {MISSION_TYPES.map(mt => (
              <button
                key={mt.type}
                onClick={() => handleLaunchMission(mt.type)}
                disabled={launchingMission}
                className="group text-left p-2.5 rounded-lg border border-slate-700/40 hover:border-cyan-500/30 bg-slate-800/20 hover:bg-cyan-900/20 transition-all disabled:opacity-50"
              >
                <div className="text-base mb-0.5">{mt.icon}</div>
                <div className="text-[11px] font-bold text-slate-200 group-hover:text-cyan-300 transition-colors leading-tight">{mt.label}</div>
                <div className="text-[9px] text-slate-500 mt-0.5 leading-tight line-clamp-2">{mt.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* ═══════ 进行中的任务 ═══════ */}
        {activeMissions.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-bold text-slate-400">⚡ 进行中</h3>
            {activeMissions.map(m => (
              <MissionCard key={m.id} mission={m} onCancel={handleCancelMission} onDelete={handleDeleteMission} />
            ))}
          </div>
        )}

        {/* ═══════ 历史记录 ═══════ */}
        {historyMissions.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-bold text-slate-400">📦 历史记录</h3>
            {historyMissions.map(m => (
              <MissionCard key={m.id} mission={m} onCancel={handleCancelMission} onDelete={handleDeleteMission} />
            ))}
          </div>
        )}

        {/* 空状态 */}
        {missions.length === 0 && (
          <div className="text-center py-8 text-slate-600">
            <div className="text-3xl mb-2">🎯</div>
            <div className="text-sm">尚无临时任务</div>
            <div className="text-[10px] text-slate-700 mt-1">点击上方任务类型卡片发起一次任务</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// MissionCard — 单个任务卡片
// ═══════════════════════════════════════

const MISSION_STATUS: Record<string, { text: string; color: string; icon: string }> = {
  pending:   { text: '等待中', color: 'text-slate-400', icon: '⏳' },
  planning:  { text: '规划中', color: 'text-blue-400', icon: '📋' },
  executing: { text: '执行中', color: 'text-amber-400', icon: '⚡' },
  judging:   { text: '评估中', color: 'text-violet-400', icon: '⚖️' },
  completed: { text: '已完成', color: 'text-emerald-400', icon: '✅' },
  failed:    { text: '失败', color: 'text-red-400', icon: '❌' },
  cancelled: { text: '已取消', color: 'text-slate-500', icon: '⏹' },
};

function MissionCard({ mission: m, onCancel, onDelete }: {
  mission: MissionRecord;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const st = MISSION_STATUS[m.status] || MISSION_STATUS.pending;
  const typeInfo = MISSION_TYPES.find(t => t.type === m.type);
  const isRunning = ['pending', 'planning', 'executing', 'judging'].includes(m.status);

  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg border transition-all ${
      isRunning ? 'border-cyan-600/30 bg-cyan-900/10' : 'border-slate-800 bg-slate-900/30'
    }`}>
      <span className="text-lg">{typeInfo?.icon || '🎯'}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-slate-200">{typeInfo?.label || m.type}</span>
          <span className={`text-[10px] ${st.color}`}>{st.icon} {st.text}</span>
          {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />}
        </div>
        {m.conclusion && (
          <p className="text-[10px] text-slate-500 mt-0.5 truncate">{m.conclusion.slice(0, 100)}...</p>
        )}
        <div className="text-[9px] text-slate-600 mt-0.5">
          {m.token_usage > 0 && <span>{(m.token_usage / 1000).toFixed(1)}k tokens</span>}
          {m.cost_usd > 0 && <span className="ml-2">${m.cost_usd.toFixed(4)}</span>}
          <span className="ml-2">{new Date(m.created_at + 'Z').toLocaleString()}</span>
        </div>
      </div>
      <div className="flex gap-1 shrink-0">
        {isRunning && (
          <button onClick={() => onCancel(m.id)} className="text-[10px] px-2 py-1 rounded bg-red-900/20 text-red-400 hover:bg-red-800/30 transition-colors">取消</button>
        )}
        {!isRunning && (
          <button onClick={() => onDelete(m.id)} className="text-[10px] px-2 py-1 rounded bg-slate-800 text-slate-500 hover:text-red-400 transition-colors">删除</button>
        )}
      </div>
    </div>
  );
}