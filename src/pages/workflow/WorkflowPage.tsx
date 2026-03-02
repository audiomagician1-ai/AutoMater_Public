/**
 * WorkflowPage — v3.0 多工作流预设 + 大尺寸预览
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAppStore } from '../../stores/app-store';
import { friendlyErrorMessage } from '../../utils/errors';
import { toast, confirm } from '../../stores/toast-store';
import { MISSION_TYPES } from './types';
import { WorkflowPreview } from './WorkflowPreview';
import { PresetCard } from './PresetCard';
import { WorkflowEditor } from './WorkflowEditor';
import { MissionCard } from './MissionCard';

export function WorkflowPage() {
  const currentProjectId = useAppStore(s => s.currentProjectId);

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
    const ok = await confirm({
      title: '删除工作流预设',
      message: '确定要删除此工作流预设吗？此操作无法撤销。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    await window.automater.workflow.delete(presetId);
    toast.success('工作流预设已删除');
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
    } catch (err: unknown) {
      setMissionError(friendlyErrorMessage(err) || '创建任务时出错');
    } finally {
      setLaunchingMission(false);
    }
  };

  const handleCancelMission = async (id: string) => {
    await window.automater.ephemeralMission.cancel(id);
    loadMissions();
  };

  const handleDeleteMission = async (id: string) => {
    const ok = await confirm({
      title: '删除任务',
      message: '确定要删除此任务吗？',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    if (expandedMission === id) setExpandedMission(null);
    await window.automater.ephemeralMission.delete(id);
    toast.success('任务已删除');
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
      } catch { /* silent: polling */ }
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
        <button onClick={handleCreatePreset}
          className="text-[11px] px-3 py-1 rounded-lg border border-slate-700 text-slate-400 hover:text-forge-300 hover:border-forge-500/30 transition-colors">
          + 新建工作流
        </button>
      </div>

      {/* TOP 1/3: 工作流可视化预览 */}
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

      {/* BOTTOM 2/3: 预设选择 + 临时任务 */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">

        {/* 工作流预设选择器 */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-bold text-slate-400">📐 工作流预设</h3>
            <span className="text-[9px] text-slate-600">选择一个工作流驱动开发流水线, 或自定义阶段</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {presets.map(p => (
              <PresetCard key={p.id} preset={p} isActive={p.isActive}
                onActivate={() => handleActivate(p.id)} onEdit={() => handleEditPreset(p)}
                onDuplicate={() => handleDuplicate(p.id)} onDelete={() => handleDeletePreset(p.id)} />
            ))}
          </div>
        </section>

        {/* 临时任务面板 */}
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
              <button key={mt.type} onClick={() => handleLaunchMission(mt.type)} disabled={launchingMission}
                className="group text-left p-2.5 rounded-lg border border-slate-700/40 hover:border-cyan-500/30 bg-slate-800/20 hover:bg-cyan-900/20 transition-all disabled:opacity-50">
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

        {/* 进行中的任务 */}
        {activeMissions.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-bold text-slate-400">⚡ 进行中</h3>
            {activeMissions.map(m => (
              <MissionCard key={m.id} mission={m} onCancel={handleCancelMission} onDelete={handleDeleteMission}
                expanded={expandedMission === m.id} onToggle={handleToggleMission}
                tasks={expandedMission === m.id ? expandedTasks : []} />
            ))}
          </section>
        )}

        {/* 历史记录 */}
        {historyMissions.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-bold text-slate-400">📦 历史记录</h3>
            {historyMissions.map(m => (
              <MissionCard key={m.id} mission={m} onCancel={handleCancelMission} onDelete={handleDeleteMission}
                expanded={expandedMission === m.id} onToggle={handleToggleMission}
                tasks={expandedMission === m.id ? expandedTasks : []} />
            ))}
          </section>
        )}
      </div>

      {/* Editor Modal */}
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
