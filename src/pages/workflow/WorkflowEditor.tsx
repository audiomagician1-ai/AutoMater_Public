/**
 * WorkflowEditor — Modal for editing/creating workflow presets
 */

import { useState } from 'react';

export function WorkflowEditor({ preset, availableStages, onSave, onClose }: {
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

  const toggleRetry = (index: number) => {
    setStages(prev => prev.map((s, i) => {
      if (i !== index) return s;
      const trans = (s as { transitions?: Array<{ target: string; condition: string; maxRetries?: number }> }).transitions || [];
      const hasSelfRetry = trans.some(t => t.target === s.id && t.condition === 'failure');
      if (hasSelfRetry) {
        return { ...s, transitions: trans.filter(t => !(t.target === s.id && t.condition === 'failure')) } as WorkflowStageInfo;
      } else {
        return { ...s, transitions: [...trans, { target: s.id, condition: 'failure', maxRetries: 3 }] } as WorkflowStageInfo;
      }
    }));
  };

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
              <input value={icon} onChange={e => setIcon(e.target.value)}
                className="w-12 h-12 text-center text-2xl bg-slate-800 border border-slate-700 rounded-lg focus:border-forge-500 outline-none" maxLength={2} />
            </div>
            <div className="space-y-2">
              <div>
                <label className="text-[10px] text-slate-500 block mb-1">名称</label>
                <input value={name} onChange={e => setName(e.target.value)}
                  className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200 focus:border-forge-500 outline-none" placeholder="工作流名称" />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 block mb-1">描述</label>
                <input value={desc} onChange={e => setDesc(e.target.value)}
                  className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-300 focus:border-forge-500 outline-none" placeholder="应用场景和说明" />
              </div>
            </div>
          </div>

          {/* Current stages */}
          <div>
            <label className="text-[10px] text-slate-500 block mb-2">阶段序列 ({stages.length} 个)</label>
            <div className="space-y-1">
              {stages.map((stage, i) => {
                const trans = (stage as { transitions?: Array<{ target: string; condition: string; maxRetries?: number }> }).transitions || [];
                const hasSelfRetry = trans.some(t => t.target === stage.id && t.condition === 'failure');
                return (
                <div key={stage.id + '-' + i} className="flex items-center gap-2 bg-slate-800/50 rounded-lg px-3 py-1.5 group">
                  <span className="text-sm">{stage.icon}</span>
                  <span className="text-xs text-slate-300 flex-1">{stage.label}</span>
                  {hasSelfRetry && <span className="text-[9px] text-red-400/70 bg-red-900/20 px-1 rounded">🔄重试</span>}
                  {stage.skippable && <span className="text-[9px] text-slate-600">可跳</span>}
                  <button onClick={() => toggleRetry(i)} className="text-[10px] text-slate-500 hover:text-amber-400 opacity-0 group-hover:opacity-100" title={hasSelfRetry ? '取消失败重试' : '启用失败重试'}>🔄</button>
                  <button onClick={() => moveStage(i, i - 1)} className="text-[10px] text-slate-500 hover:text-slate-200 opacity-0 group-hover:opacity-100" title="上移">↑</button>
                  <button onClick={() => moveStage(i, i + 1)} className="text-[10px] text-slate-500 hover:text-slate-200 opacity-0 group-hover:opacity-100" title="下移">↓</button>
                  <button onClick={() => removeStage(i)} className="text-[10px] text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100" title="移除">✕</button>
                </div>
                );
              })}
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
                  <button key={stage.id} onClick={() => addStage(stage)}
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
          <button onClick={onClose} className="px-4 py-1.5 rounded-lg border border-slate-700 text-xs text-slate-400 hover:text-slate-200 transition-colors">取消</button>
          <button onClick={() => onSave({ name, description: desc, icon, stages })}
            disabled={!name.trim() || stages.length === 0}
            className="px-4 py-1.5 rounded-lg bg-forge-600 hover:bg-forge-500 text-xs text-white font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
