/**
 * WorkflowPage — v3.0 多工作流预设 + 大尺寸预览
 *
 * 顶部 1/3: 工作流可视化预览图 (SVG 流水线)
 * 中部: 预设选择器 + 编辑器
 * 底部: 临时任务面板 + 历史
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAppStore } from '../stores/app-store';

// ═══════════════════════════════════════
// Mission Types (临时工作流)
// ═══════════════════════════════════════

const MISSION_TYPES = [
  { type: 'regression_test', icon: '🧪', label: '回归测试', desc: '全量 Feature 回归' },
  { type: 'code_review',    icon: '🔍', label: '代码审查', desc: '质量/安全/性能审查' },
  { type: 'retrospective',  icon: '📊', label: '架构复盘', desc: '多维度架构分析' },
  { type: 'security_audit', icon: '🔒', label: '安全审计', desc: 'OWASP + CWE 扫描' },
  { type: 'perf_benchmark', icon: '⚡', label: '性能基准', desc: '关键路径性能分析' },
] as const;

// ═══════════════════════════════════════
// Color lookup for stage bg
// ═══════════════════════════════════════

const COLOR_MAP: Record<string, { bg: string; border: string; text: string }> = {
  'bg-violet-500':  { bg: '#7c3aed', border: '#8b5cf6', text: '#c4b5fd' },
  'bg-blue-500':    { bg: '#3b82f6', border: '#60a5fa', text: '#93c5fd' },
  'bg-cyan-500':    { bg: '#06b6d4', border: '#22d3ee', text: '#67e8f9' },
  'bg-amber-500':   { bg: '#f59e0b', border: '#fbbf24', text: '#fcd34d' },
  'bg-emerald-500': { bg: '#10b981', border: '#34d399', text: '#6ee7b7' },
  'bg-indigo-500':  { bg: '#6366f1', border: '#818cf8', text: '#a5b4fc' },
  'bg-rose-500':    { bg: '#f43f5e', border: '#fb7185', text: '#fda4af' },
  'bg-teal-500':    { bg: '#14b8a6', border: '#2dd4bf', text: '#5eead4' },
  'bg-orange-500':  { bg: '#f97316', border: '#fb923c', text: '#fdba74' },
  'bg-red-500':     { bg: '#ef4444', border: '#f87171', text: '#fca5a5' },
  'bg-forge-500':   { bg: '#5c7cfa', border: '#748ffc', text: '#91a7ff' },
};

function getStageColor(colorClass: string) {
  return COLOR_MAP[colorClass] || { bg: '#475569', border: '#64748b', text: '#94a3b8' };
}

// ═══════════════════════════════════════
// WorkflowPreview — 大尺寸 SVG 流水线图 (占 1/3 高度)
// ═══════════════════════════════════════

function WorkflowPreview({ stages, activeStageIndex }: {
  stages: WorkflowStageInfo[];
  activeStageIndex: number;
}) {
  if (stages.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-slate-600">
        <div className="text-center">
          <div className="text-4xl mb-2">🔄</div>
          <div className="text-sm">选择或创建工作流</div>
        </div>
      </div>
    );
  }

  const nodeW = 110;
  const nodeH = 64;
  const gap = 40;
  const totalW = stages.length * (nodeW + gap) - gap + 80;
  const totalH = nodeH + 80;

  return (
    <div className="h-full w-full overflow-x-auto overflow-y-hidden flex items-center">
      <svg
        width={Math.max(totalW, 600)}
        height={totalH}
        viewBox={`0 0 ${Math.max(totalW, 600)} ${totalH}`}
        className="mx-auto"
      >
        <defs>
          <marker id="wf-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569" />
          </marker>
          <marker id="wf-arrow-active" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#5c7cfa" />
          </marker>
          <filter id="glow">
            <feGaussianBlur in="SourceAlpha" stdDeviation="4" result="blur" />
            <feFlood floodColor="#5c7cfa" floodOpacity="0.4" result="color" />
            <feComposite in2="blur" operator="in" result="shadow" />
            <feMerge>
              <feMergeNode in="shadow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {stages.map((stage, i) => {
          const x = 40 + i * (nodeW + gap);
          const y = (totalH - nodeH) / 2;
          const sc = getStageColor(stage.color);
          const isActive = i === activeStageIndex;
          const isPast = i < activeStageIndex;
          const isFuture = i > activeStageIndex;

          return (
            <g key={stage.id + '-' + i}>
              {/* Connector arrow */}
              {i > 0 && (
                <line
                  x1={x - gap + 4}
                  y1={y + nodeH / 2}
                  x2={x - 4}
                  y2={y + nodeH / 2}
                  stroke={isPast || isActive ? '#5c7cfa' : '#334155'}
                  strokeWidth={isPast || isActive ? 2 : 1.5}
                  markerEnd={isPast || isActive ? 'url(#wf-arrow-active)' : 'url(#wf-arrow)'}
                />
              )}

              {/* Node */}
              <g filter={isActive ? 'url(#glow)' : undefined}>
                <rect
                  x={x} y={y} width={nodeW} height={nodeH} rx={12}
                  fill={isActive ? sc.bg + '30' : isPast ? sc.bg + '18' : '#1e293b'}
                  stroke={isActive ? sc.border : isPast ? sc.bg + '60' : '#334155'}
                  strokeWidth={isActive ? 2.5 : 1.5}
                  opacity={isFuture ? 0.5 : 1}
                />
                {isActive && (
                  <rect
                    x={x} y={y} width={nodeW} height={nodeH} rx={12}
                    fill="none" stroke={sc.border} strokeWidth={2} opacity={0.4}
                  >
                    <animate attributeName="opacity" values="0.4;0.1;0.4" dur="2s" repeatCount="indefinite" />
                  </rect>
                )}
              </g>

              {/* Icon */}
              <text
                x={x + nodeW / 2} y={y + 24}
                textAnchor="middle" fontSize={18}
                opacity={isFuture ? 0.4 : 1}
              >
                {isPast ? '✓' : stage.icon}
              </text>

              {/* Label */}
              <text
                x={x + nodeW / 2} y={y + 44}
                textAnchor="middle" fontSize={10}
                fill={isActive ? sc.text : isPast ? '#94a3b8' : '#64748b'}
                fontFamily="sans-serif" fontWeight={isActive ? 'bold' : 'normal'}
              >
                {stage.label.length > 10 ? stage.label.slice(0, 9) + '…' : stage.label}
              </text>

              {/* Skippable badge */}
              {stage.skippable && (
                <text x={x + nodeW - 6} y={y + 12} textAnchor="end" fontSize={8} fill="#64748b">可跳</text>
              )}

              {/* Step number */}
              <text x={x + 8} y={y + 12} fontSize={8} fill="#475569" fontFamily="monospace">{i + 1}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ═══════════════════════════════════════
// Preset Selector Card
// ═══════════════════════════════════════

function PresetCard({ preset, isActive, onActivate, onEdit, onDuplicate, onDelete }: {
  preset: WorkflowPresetInfo;
  isActive: boolean;
  onActivate: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`group relative rounded-xl border p-3 transition-all cursor-pointer ${
      isActive
        ? 'border-forge-500/50 bg-forge-600/10 ring-1 ring-forge-500/20 shadow-lg shadow-forge-500/10'
        : 'border-slate-700/40 bg-slate-800/20 hover:border-slate-600/60 hover:bg-slate-800/40'
    }`}
      onClick={onActivate}
    >
      <div className="flex items-start gap-2.5">
        <div className="text-2xl flex-shrink-0">{preset.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-bold ${isActive ? 'text-forge-300' : 'text-slate-200'}`}>
              {preset.name}
            </span>
            {isActive && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-forge-500/20 text-forge-400 font-medium">当前</span>
            )}
            {preset.isBuiltin && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-slate-700/50 text-slate-500">内置</span>
            )}
          </div>
          <p className="text-[10px] text-slate-500 mt-0.5 line-clamp-2 leading-relaxed">{preset.description}</p>
          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
            {preset.stages.slice(0, 6).map((s, i) => (
              <span key={i} className="text-xs" title={s.label}>{s.icon}</span>
            ))}
            {preset.stages.length > 6 && (
              <span className="text-[9px] text-slate-600">+{preset.stages.length - 6}</span>
            )}
            <span className="text-[9px] text-slate-600 ml-1">{preset.stages.length} 阶段</span>
          </div>
        </div>
      </div>

      {/* Actions — visible on hover */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          className="w-6 h-6 rounded bg-slate-700/80 hover:bg-slate-600 text-[10px] flex items-center justify-center text-slate-300"
          title="编辑"
        >✏️</button>
        <button
          onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
          className="w-6 h-6 rounded bg-slate-700/80 hover:bg-slate-600 text-[10px] flex items-center justify-center text-slate-300"
          title="复制"
        >📋</button>
        {!preset.isBuiltin && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="w-6 h-6 rounded bg-slate-700/80 hover:bg-red-800/60 text-[10px] flex items-center justify-center text-slate-300 hover:text-red-300"
            title="删除"
          >🗑️</button>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// Workflow Editor Modal
// ═══════════════════════════════════════

function WorkflowEditor({ preset, availableStages, onSave, onClose }: {
  preset: WorkflowPresetInfo | null;
  availableStages: WorkflowStageInfo[];
  onSave: (data: { name: string; description: string; icon: string; stages: WorkflowStageInfo[] }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(preset?.name || '');
  const [desc, setDesc] = useState(preset?.description || '');
  const [icon, setIcon] = useState(preset?.icon || '🔧');
  const [stages, setStages] = useState<WorkflowStageInfo[]>(preset?.stages || []);

  const addStage = (stage: WorkflowStageInfo) => {
    setStages(prev => [...prev, { ...stage }]);
  };

  const removeStage = (index: number) => {
    setStages(prev => prev.filter((_, i) => i !== index));
  };

  const moveStage = (from: number, to: number) => {
    if (to < 0 || to >= stages.length) return;
    const next = [...stages];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setStages(next);
  };

  const unusedStages = availableStages.filter(
    as => !stages.some(s => s.id === as.id)
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-[640px] max-h-[80vh] overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-200">{preset ? '编辑工作流' : '新建工作流'}</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-lg">✕</button>
        </div>

        <div className="px-5 py-4 overflow-y-auto max-h-[60vh] space-y-4">
          {/* Basic info */}
          <div className="grid grid-cols-[48px_1fr] gap-3">
            <div>
              <label className="text-[10px] text-slate-500 block mb-1">图标</label>
              <input
                value={icon}
                onChange={e => setIcon(e.target.value)}
                className="w-12 h-12 text-center text-2xl bg-slate-800 border border-slate-700 rounded-lg focus:border-forge-500 outline-none"
                maxLength={2}
              />
            </div>
            <div className="space-y-2">
              <div>
                <label className="text-[10px] text-slate-500 block mb-1">名称</label>
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200 focus:border-forge-500 outline-none"
                  placeholder="工作流名称"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 block mb-1">描述</label>
                <input
                  value={desc}
                  onChange={e => setDesc(e.target.value)}
                  className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-300 focus:border-forge-500 outline-none"
                  placeholder="应用场景和说明"
                />
              </div>
            </div>
          </div>

          {/* Current stages */}
          <div>
            <label className="text-[10px] text-slate-500 block mb-2">阶段序列 ({stages.length} 个)</label>
            <div className="space-y-1">
              {stages.map((stage, i) => (
                <div key={stage.id + '-' + i} className="flex items-center gap-2 bg-slate-800/50 rounded-lg px-3 py-1.5 group">
                  <span className="text-sm">{stage.icon}</span>
                  <span className="text-xs text-slate-300 flex-1">{stage.label}</span>
                  {stage.skippable && <span className="text-[9px] text-slate-600">可跳</span>}
                  <button onClick={() => moveStage(i, i - 1)} className="text-[10px] text-slate-500 hover:text-slate-200 opacity-0 group-hover:opacity-100" title="上移">↑</button>
                  <button onClick={() => moveStage(i, i + 1)} className="text-[10px] text-slate-500 hover:text-slate-200 opacity-0 group-hover:opacity-100" title="下移">↓</button>
                  <button onClick={() => removeStage(i)} className="text-[10px] text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100" title="移除">✕</button>
                </div>
              ))}
              {stages.length === 0 && (
                <div className="text-[10px] text-slate-600 py-4 text-center">从下方选择阶段添加到工作流</div>
              )}
            </div>
          </div>

          {/* Available stages to add */}
          <div>
            <label className="text-[10px] text-slate-500 block mb-2">可用阶段 (点击添加)</label>
            <div className="flex flex-wrap gap-1.5">
              {availableStages.map(stage => {
                const alreadyUsed = stages.some(s => s.id === stage.id);
                return (
                  <button
                    key={stage.id}
                    onClick={() => addStage(stage)}
                    className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] border transition-all ${
                      alreadyUsed
                        ? 'border-slate-700/30 bg-slate-800/20 text-slate-600 cursor-default'
                        : 'border-slate-700/50 bg-slate-800/40 text-slate-300 hover:border-forge-500/40 hover:bg-forge-900/20 cursor-pointer'
                    }`}
                    disabled={false}
                  >
                    <span>{stage.icon}</span>
                    <span>{stage.label}</span>
                    {alreadyUsed && <span className="text-[9px]">✓</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-slate-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-1.5 rounded-lg border border-slate-700 text-xs text-slate-400 hover:text-slate-200 transition-colors">
            取消
          </button>
          <button
            onClick={() => onSave({ name, description: desc, icon, stages })}
            disabled={!name.trim() || stages.length === 0}
            className="px-4 py-1.5 rounded-lg bg-forge-600 hover:bg-forge-500 text-xs text-white font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// Main WorkflowPage
// ═══════════════════════════════════════

export function WorkflowPage() {
  const { currentProjectId } = useAppStore();

  // Workflow presets state
  const [presets, setPresets] = useState<WorkflowPresetInfo[]>([]);
  const [availableStages, setAvailableStages] = useState<WorkflowStageInfo[]>([]);
  const [editingPreset, setEditingPreset] = useState<WorkflowPresetInfo | null | 'new'>(null);

  // Mission state
  const [missions, setMissions] = useState<MissionRecord[]>([]);
  const [launchingMission, setLaunchingMission] = useState(false);
  const [missionError, setMissionError] = useState<string | null>(null);
  const [expandedMission, setExpandedMission] = useState<string | null>(null);
  const [expandedTasks, setExpandedTasks] = useState<MissionTaskRecord[]>([]);

  // Load presets
  const loadPresets = useCallback(async () => {
    if (!currentProjectId) return;
    const [list, stages] = await Promise.all([
      window.automater.workflow.list(currentProjectId),
      window.automater.workflow.availableStages(),
    ]);
    setPresets(list || []);
    setAvailableStages(stages || []);
  }, [currentProjectId]);

  useEffect(() => { loadPresets(); }, [loadPresets]);

  const activePreset = useMemo(() => presets.find(p => p.isActive) || null, [presets]);

  const handleActivate = async (presetId: string) => {
    if (!currentProjectId) return;
    await window.automater.workflow.activate(currentProjectId, presetId);
    loadPresets();
  };

  const handleCreatePreset = () => setEditingPreset('new');
  const handleEditPreset = (p: WorkflowPresetInfo) => setEditingPreset(p);

  const handleSavePreset = async (data: { name: string; description: string; icon: string; stages: WorkflowStageInfo[] }) => {
    if (!currentProjectId) return;
    if (editingPreset === 'new') {
      await window.automater.workflow.create(currentProjectId, data);
    } else if (editingPreset) {
      await window.automater.workflow.update(editingPreset.id, data);
    }
    setEditingPreset(null);
    loadPresets();
  };

  const handleDuplicate = async (presetId: string) => {
    await window.automater.workflow.duplicate(presetId);
    loadPresets();
  };

  const handleDeletePreset = async (presetId: string) => {
    await window.automater.workflow.delete(presetId);
    loadPresets();
  };

  // Load missions
  const loadMissions = useCallback(async () => {
    if (!currentProjectId) return;
    const list = await window.automater.ephemeralMission.list(currentProjectId);
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
      const res = await window.automater.ephemeralMission.create(currentProjectId, type, { maxWorkers: 3 });
      if (!res?.success) {
        setMissionError(res?.error || '创建任务失败');
        return;
      }
      setMissionError(null);
      await loadMissions();
    } catch (err: any) {
      setMissionError(err.message || '创建任务时出错');
    } finally {
      setLaunchingMission(false);
    }
  };

  const handleCancelMission = async (id: string) => {
    await window.automater.ephemeralMission.cancel(id);
    loadMissions();
  };

  const handleDeleteMission = async (id: string) => {
    if (expandedMission === id) setExpandedMission(null);
    await window.automater.ephemeralMission.delete(id);
    loadMissions();
  };

  const handleToggleMission = async (id: string) => {
    if (expandedMission === id) {
      setExpandedMission(null);
      setExpandedTasks([]);
      return;
    }
    setExpandedMission(id);
    try {
      const tasks = await window.automater.ephemeralMission.getTasks(id);
      setExpandedTasks(tasks || []);
    } catch {
      setExpandedTasks([]);
    }
  };

  useEffect(() => {
    if (!expandedMission) return;
    const t = setInterval(async () => {
      try {
        const tasks = await window.automater.ephemeralMission.getTasks(expandedMission);
        setExpandedTasks(tasks || []);
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(t);
  }, [expandedMission]);

  if (!currentProjectId) {
    return <div className="h-full flex items-center justify-center text-slate-500">请先选择一个项目</div>;
  }

  const activeMissions = missions.filter(m => ['pending', 'planning', 'executing', 'judging'].includes(m.status));
  const historyMissions = missions.filter(m => !['pending', 'planning', 'executing', 'judging'].includes(m.status));

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 py-3 border-b border-slate-800 shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold text-slate-100">🔄 工作流</h1>
          {activePreset && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-forge-500/15 text-forge-400 border border-forge-500/20">
              {activePreset.icon} {activePreset.name}
            </span>
          )}
        </div>
        <button
          onClick={handleCreatePreset}
          className="text-[11px] px-3 py-1 rounded-lg border border-slate-700 text-slate-400 hover:text-forge-300 hover:border-forge-500/30 transition-colors"
        >
          + 新建工作流
        </button>
      </div>

      {/* ═══════ TOP 1/3: 工作流可视化预览 ═══════ */}
      <div className="shrink-0 border-b border-slate-800/60 bg-slate-950/40" style={{ height: 'calc(100vh / 3)' }}>
        <div className="h-full px-6 py-4 flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-medium text-slate-500">
              {activePreset ? `${activePreset.icon} ${activePreset.name} — ${activePreset.stages.length} 阶段流水线` : '未选择工作流'}
            </h3>
            {activePreset && (
              <span className="text-[9px] text-slate-600">{activePreset.description.slice(0, 80)}</span>
            )}
          </div>
          <div className="flex-1 bg-slate-900/40 border border-slate-800/40 rounded-xl overflow-hidden">
            <WorkflowPreview stages={activePreset?.stages || []} activeStageIndex={-1} />
          </div>
        </div>
      </div>

      {/* ═══════ BOTTOM 2/3: 预设选择 + 临时任务 ═══════ */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">

        {/* ═══════ 工作流预设选择器 ═══════ */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-bold text-slate-400">📐 工作流预设</h3>
            <span className="text-[9px] text-slate-600">选择一个工作流驱动开发流水线, 或自定义阶段</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {presets.map(p => (
              <PresetCard
                key={p.id}
                preset={p}
                isActive={p.isActive}
                onActivate={() => handleActivate(p.id)}
                onEdit={() => handleEditPreset(p)}
                onDuplicate={() => handleDuplicate(p.id)}
                onDelete={() => handleDeletePreset(p.id)}
              />
            ))}
          </div>
        </section>

        {/* ═══════ 常驻临时任务面板 ═══════ */}
        <section className="bg-gradient-to-r from-cyan-900/10 to-slate-900/20 border border-cyan-800/20 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-sm">🎯</span>
              <span className="text-xs font-bold text-cyan-300">临时任务</span>
              <span className="text-[9px] text-slate-600">独立于主工作流 · Planner → Workers → Judge</span>
            </div>
            {activeMissions.length > 0 && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400">
                {activeMissions.length} 进行中
              </span>
            )}
          </div>

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

          {missionError && (
            <div className="mt-2 px-3 py-2 rounded-lg bg-red-900/30 border border-red-700/30 text-red-300 text-[11px] flex items-center justify-between">
              <span>⚠️ {missionError}</span>
              <button onClick={() => setMissionError(null)} className="text-red-500 hover:text-red-300 ml-2">✕</button>
            </div>
          )}
        </section>

        {/* ═══════ 进行中的任务 ═══════ */}
        {activeMissions.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-bold text-slate-400">⚡ 进行中</h3>
            {activeMissions.map(m => (
              <MissionCard
                key={m.id}
                mission={m}
                onCancel={handleCancelMission}
                onDelete={handleDeleteMission}
                expanded={expandedMission === m.id}
                onToggle={handleToggleMission}
                tasks={expandedMission === m.id ? expandedTasks : []}
              />
            ))}
          </section>
        )}

        {/* ═══════ 历史记录 ═══════ */}
        {historyMissions.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-bold text-slate-400">📦 历史记录</h3>
            {historyMissions.map(m => (
              <MissionCard
                key={m.id}
                mission={m}
                onCancel={handleCancelMission}
                onDelete={handleDeleteMission}
                expanded={expandedMission === m.id}
                onToggle={handleToggleMission}
                tasks={expandedMission === m.id ? expandedTasks : []}
              />
            ))}
          </section>
        )}
      </div>

      {/* ═══════ Editor Modal ═══════ */}
      {editingPreset !== null && (
        <WorkflowEditor
          preset={editingPreset === 'new' ? null : editingPreset}
          availableStages={availableStages}
          onSave={handleSavePreset}
          onClose={() => setEditingPreset(null)}
        />
      )}
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

const TASK_STATUS_STYLE: Record<string, { icon: string; color: string }> = {
  pending:  { icon: '○', color: 'text-slate-500' },
  running:  { icon: '◉', color: 'text-amber-400' },
  passed:   { icon: '✓', color: 'text-emerald-400' },
  failed:   { icon: '✗', color: 'text-red-400' },
  skipped:  { icon: '–', color: 'text-slate-600' },
};

function MissionCard({ mission: m, onCancel, onDelete, expanded, onToggle, tasks }: {
  mission: MissionRecord;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  expanded: boolean;
  onToggle: (id: string) => void;
  tasks: MissionTaskRecord[];
}) {
  const st = MISSION_STATUS[m.status] || MISSION_STATUS.pending;
  const typeInfo = MISSION_TYPES.find(t => t.type === m.type);
  const isRunning = ['pending', 'planning', 'executing', 'judging'].includes(m.status);

  const doneTasks = tasks.filter(t => ['passed', 'failed', 'skipped'].includes(t.status)).length;
  const totalTasks = tasks.length;
  const progressPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  return (
    <div className={`rounded-lg border transition-all ${
      isRunning ? 'border-cyan-600/30 bg-cyan-900/10' : 'border-slate-800 bg-slate-900/30'
    }`}>
      <div
        className="flex items-center gap-3 p-3 cursor-pointer hover:bg-slate-800/30 transition-colors rounded-lg"
        onClick={() => onToggle(m.id)}
      >
        <span className="text-lg">{typeInfo?.icon || '🎯'}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-200">{typeInfo?.label || m.type}</span>
            <span className={`text-[10px] ${st.color}`}>{st.icon} {st.text}</span>
            {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />}
            {totalTasks > 0 && (
              <span className="text-[9px] text-slate-500">{doneTasks}/{totalTasks}</span>
            )}
          </div>
          {isRunning && totalTasks > 0 && (
            <div className="mt-1 h-1 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-cyan-500 rounded-full transition-all duration-500" style={{ width: `${progressPct}%` }} />
            </div>
          )}
          {!expanded && m.conclusion && (
            <p className="text-[10px] text-slate-500 mt-0.5 truncate">{m.conclusion.slice(0, 100)}...</p>
          )}
          <div className="text-[9px] text-slate-600 mt-0.5">
            {m.token_usage > 0 && <span>{(m.token_usage / 1000).toFixed(1)}k tokens</span>}
            {m.cost_usd > 0 && <span className="ml-2">${m.cost_usd.toFixed(4)}</span>}
            <span className="ml-2">{new Date(m.created_at + 'Z').toLocaleString()}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className={`text-[10px] transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
          {isRunning ? (
            <button onClick={(e) => { e.stopPropagation(); onCancel(m.id); }} className="text-[10px] px-2 py-1 rounded bg-red-900/20 text-red-400 hover:bg-red-800/30 transition-colors">取消</button>
          ) : (
            <button onClick={(e) => { e.stopPropagation(); onDelete(m.id); }} className="text-[10px] px-2 py-1 rounded bg-slate-800 text-slate-500 hover:text-red-400 transition-colors">删除</button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-0 border-t border-slate-800/50">
          {tasks.length > 0 && (
            <div className="mt-2 space-y-1">
              <div className="text-[10px] font-bold text-slate-400 mb-1">📋 任务清单 ({tasks.length})</div>
              {tasks.map(task => {
                const ts = TASK_STATUS_STYLE[task.status] || TASK_STATUS_STYLE.pending;
                return (
                  <details key={task.id} className="group">
                    <summary className="flex items-center gap-2 cursor-pointer list-none text-[11px] py-1 hover:bg-slate-800/30 rounded px-1">
                      <span className={`${ts.color} font-mono`}>{ts.icon}</span>
                      <span className="text-slate-300 truncate flex-1">{task.title}</span>
                      <span className={`text-[9px] ${ts.color}`}>{task.status}</span>
                    </summary>
                    {task.output && (
                      <pre className="mt-1 ml-5 text-[10px] text-slate-500 bg-slate-900/60 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
                        {task.output.length > 2000 ? task.output.slice(0, 2000) + '\n\n... (截断)' : task.output}
                      </pre>
                    )}
                  </details>
                );
              })}
            </div>
          )}
          {tasks.length === 0 && isRunning && (
            <div className="text-[10px] text-slate-600 py-2">⏳ 正在规划任务...</div>
          )}
          {tasks.length === 0 && !isRunning && !m.conclusion && (
            <div className="text-[10px] text-slate-600 py-2">暂无任务数据</div>
          )}
          {m.conclusion && (
            <div className="mt-3">
              <div className="text-[10px] font-bold text-slate-400 mb-1">📝 结论</div>
              <div className="text-[11px] text-slate-300 bg-slate-900/60 rounded p-3 max-h-60 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">
                {m.conclusion}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}