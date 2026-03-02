/**
 * TeamPage — 虚拟团队 (v6.0 → v19.0)
 *
 * 运行状态 tab: 左侧精简成员卡片 + 右侧 SessionPanel (session列表 + 对话内容)
 * 团队配置 tab: 成员 CRUD
 */

import { useState, useEffect } from 'react';
import { useAppStore } from '../../stores/app-store';
import { SessionPanel } from '../../components/SessionPanel';
import { toast, confirm } from '../../stores/toast-store';
import { ROLE_INFO, INPUT_CLS } from './types';
import { MiniAgentCard } from './MiniAgentCard';
import { MemberEditModal } from './MemberEditModal';

export function TeamPage() {
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const [agents, setAgents] = useState<(TeamMember & { status?: string; current_task?: string })[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<(TeamMember & { status?: string; current_task?: string }) | null>(null);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [tab, setTab] = useState<'runtime' | 'config'>('runtime');

  // ── 新增成员表单 ──
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('developer');
  const [newModel, setNewModel] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [newCaps, setNewCaps] = useState('');
  const [newMaxTokens, setNewMaxTokens] = useState('128000');

  const loadAgents = async () => {
    if (!currentProjectId) return;
    const data = await window.automater.project.getAgents(currentProjectId);
    setAgents(data || []);
  };

  const loadMembers = async () => {
    if (!currentProjectId) return;
    const data = await window.automater.team.list(currentProjectId);
    setMembers(data || []);
  };

  useEffect(() => { loadAgents(); loadMembers(); }, [currentProjectId]);
  useEffect(() => {
    const timer = setInterval(() => { loadAgents(); }, 3000);
    return () => clearInterval(timer);
  }, [currentProjectId]);

  // v9.0: 监听 team:member-added 事件
  useEffect(() => {
    const unsub = window.automater.on('team:member-added', (data: {
      projectId: string; memberId: string; role: string; name: string;
    }) => {
      if (data.projectId === currentProjectId) {
        loadMembers();
        loadAgents();
      }
    });
    return unsub;
  }, [currentProjectId]);

  // 首次加载时拉取缓存的 react states
  useEffect(() => {
    if (!currentProjectId) return;
    window.automater.project.getReactStates(currentProjectId).then(data => {
      const store = useAppStore.getState();
      for (const [, state] of Object.entries(data)) {
        store.updateAgentReactState(state as Parameters<typeof store.updateAgentReactState>[0]);
      }
    }).catch(() => { /* silent: optional cache */ });
    window.automater.project.getContextSnapshots(currentProjectId).then(data => {
      const store = useAppStore.getState();
      for (const [, snap] of Object.entries(data)) {
        store.updateContextSnapshot(snap as ContextSnapshot);
      }
    }).catch(() => { /* silent: optional cache */ });
  }, [currentProjectId]);

  /** 初始化默认团队 */
  const handleInitDefaults = async () => {
    if (!currentProjectId) return;
    await window.automater.team.initDefaults(currentProjectId);
    loadMembers();
  };

  /** 添加成员 */
  const handleAddMember = async () => {
    if (!currentProjectId || !newName.trim()) return;
    const caps = newCaps.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    await window.automater.team.add(currentProjectId, {
      role: newRole,
      name: newName.trim(),
      model: newModel || undefined,
      capabilities: JSON.stringify(caps),
      system_prompt: newPrompt || null,
      max_context_tokens: parseInt(newMaxTokens) || 128000,
    });
    setShowAddForm(false);
    setNewName(''); setNewRole('developer'); setNewModel(''); setNewPrompt(''); setNewCaps(''); setNewMaxTokens('128000');
    loadMembers();
  };

  /** 删除成员 */
  const handleDeleteMember = async (id: string) => {
    const { confirmed } = await confirm({
      title: '删除团队成员',
      message: '确定要移除此成员吗？关联的配置将一并删除。',
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    await window.automater.team.delete(id);
    toast.success('成员已移除');
    loadMembers();
  };

  /** 保存编辑 — v11.0: 支持 llm_config / mcp_servers / skills */
  const handleSaveEdit = async () => {
    if (!editingMember) return;
    const caps = typeof editingMember.capabilities === 'string'
      ? editingMember.capabilities : JSON.stringify(editingMember.capabilities);
    let capsArr: string[];
    try { capsArr = JSON.parse(caps); } catch { capsArr = caps.split(/[,，]/).map(s => s.trim()).filter(Boolean); }
    await window.automater.team.update(editingMember.id, {
      ...editingMember,
      capabilities: JSON.stringify(capsArr),
      llm_config: editingMember.llm_config,
      mcp_servers: editingMember.mcp_servers,
      skills: editingMember.skills,
    });
    setEditingMember(null);
    loadMembers();
  };

  if (!currentProjectId) {
    return <div className="h-full flex items-center justify-center text-slate-500"><p>加载中...</p></div>;
  }

  return (
    <div className="h-full flex flex-col p-6 gap-4 overflow-hidden">
      <div className="flex items-center justify-between flex-shrink-0">
        <h2 className="text-xl font-bold">虚拟团队</h2>
        <div className="flex items-center gap-3">
          <div className="flex bg-slate-800 rounded-lg p-0.5">
            <button onClick={() => setTab('config')}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${tab === 'config' ? 'bg-forge-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              ⚙ 团队配置
            </button>
            <button onClick={() => setTab('runtime')}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${tab === 'runtime' ? 'bg-forge-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              📊 运行状态
            </button>
          </div>
        </div>
      </div>

      {tab === 'config' ? (
        /* ══════ 团队配置 ══════ */
        <div className="flex-1 overflow-y-auto space-y-4">
          {members.length === 0 ? (
            <div className="text-center py-16 text-slate-600">
              <div className="text-4xl mb-3">👥</div>
              <div className="text-lg text-slate-400 mb-2">尚未配置团队</div>
              <div className="text-sm mb-6">可以使用默认配置快速初始化，或手动添加成员</div>
              <div className="flex gap-3 justify-center">
                <button onClick={handleInitDefaults}
                  className="px-5 py-2 rounded-lg bg-forge-600 hover:bg-forge-500 text-white text-sm transition-all">
                  ⚡ 初始化默认团队
                </button>
                <button onClick={() => setShowAddForm(true)}
                  className="px-5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm transition-all">
                  + 手动添加
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-500">{members.length} 位成员</span>
                <button onClick={() => setShowAddForm(true)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-forge-600 hover:bg-forge-500 text-white transition-colors">
                  + 添加成员
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {members.map(m => {
                  const info = ROLE_INFO[m.role] || { icon: '🤖', title: m.role };
                  let caps: string[] = [];
                  try { caps = JSON.parse(m.capabilities || '[]'); } catch { caps = []; }

                    return (
                    <div key={m.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3 flex flex-col min-h-[220px]">
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{info.icon}</span>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-slate-200">{m.name}</div>
                          <div className="text-xs text-slate-500">{info.title} · {(() => {
                            try {
                              const cfg = m.llm_config ? JSON.parse(m.llm_config) : null;
                              if (cfg?.model) return cfg.model;
                            } catch { /* silent: parse fallback */ }
                            return m.model || '默认模型';
                          })()}</div>
                        </div>
                        <div className="flex gap-1">
                          <button onClick={() => setEditingMember({ ...m })}
                            className="text-xs px-2 py-1 text-slate-500 hover:text-forge-400 transition-colors">✏️</button>
                          <button onClick={() => handleDeleteMember(m.id)}
                            className="text-xs px-2 py-1 text-slate-500 hover:text-red-400 transition-colors">🗑</button>
                        </div>
                      </div>
                      {/* Capabilities */}
                      <div className="flex flex-wrap gap-1">
                        {caps.map((c, i) => (
                          <span key={i} className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300">{c}</span>
                        ))}
                      </div>
                      {/* v11.0: MCP / Skill 标签 */}
                      {(() => {
                        let mcpCount = 0;
                        let skillCount = 0;
                        try { mcpCount = m.mcp_servers ? JSON.parse(m.mcp_servers).length : 0; } catch { /* silent */ }
                        try { skillCount = m.skills ? JSON.parse(m.skills).length : 0; } catch { /* silent */ }
                        return (mcpCount > 0 || skillCount > 0) ? (
                          <div className="flex gap-2">
                            {mcpCount > 0 && <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-900/30 text-emerald-400">🔌 MCP ×{mcpCount}</span>}
                            {skillCount > 0 && <span className="text-[10px] px-2 py-0.5 rounded bg-violet-900/30 text-violet-400">🧩 Skill ×{skillCount}</span>}
                          </div>
                        ) : null;
                      })()}
                      {m.system_prompt && (
                        <p className="text-[11px] text-slate-500 line-clamp-5 flex-1">{m.system_prompt}</p>
                      )}
                      <div className="text-[10px] text-slate-600 mt-auto">
                        上下文: {(m.max_context_tokens / 1000).toFixed(0)}k tokens
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* ── 添加表单 ── */}
          {showAddForm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowAddForm(false)}>
              <div className="bg-slate-950 border border-slate-800 rounded-2xl p-6 w-[480px] space-y-4" onClick={e => e.stopPropagation()}>
                <h3 className="text-lg font-bold text-slate-200">添加团队成员</h3>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-slate-500 mb-1 block">名称</label>
                      <input value={newName} onChange={e => setNewName(e.target.value)}
                        className={INPUT_CLS}
                        placeholder="开发者 C" />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 mb-1 block">角色</label>
                      <select value={newRole} onChange={e => setNewRole(e.target.value)} className={INPUT_CLS}>
                        <option value="pm">产品经理</option>
                        <option value="architect">架构师</option>
                        <option value="developer">开发者</option>
                        <option value="qa">QA 工程师</option>
                        <option value="reviewer">Reviewer</option>
                        <option value="devops">DevOps</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">模型 (留空用全局配置)</label>
                    <input value={newModel} onChange={e => setNewModel(e.target.value)}
                      className={INPUT_CLS}
                      placeholder="gpt-5.3-codex" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">能力标签 (逗号分隔)</label>
                    <input value={newCaps} onChange={e => setNewCaps(e.target.value)}
                      className={INPUT_CLS}
                      placeholder="前端开发, React, TypeScript" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">系统提示词</label>
                    <textarea value={newPrompt} onChange={e => setNewPrompt(e.target.value)} rows={3}
                      className={`${INPUT_CLS} resize-y`}
                      placeholder="你是一位资深前端开发者..." />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">上下文窗口 (tokens)</label>
                    <input value={newMaxTokens} onChange={e => setNewMaxTokens(e.target.value)}
                      className={INPUT_CLS}
                      placeholder="128000" />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setShowAddForm(false)} className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200">取消</button>
                  <button onClick={handleAddMember} disabled={!newName.trim()}
                    className="px-4 py-2 rounded-lg bg-forge-600 hover:bg-forge-500 text-white text-sm disabled:bg-slate-800 disabled:text-slate-600">添加</button>
                </div>
              </div>
            </div>
          )}

          {/* ── 编辑弹窗 (v11.0: 多Tab) ── */}
          {editingMember && (
            <MemberEditModal
              member={editingMember}
              onClose={() => setEditingMember(null)}
              onSave={handleSaveEdit}
              onChange={setEditingMember}
            />
          )}
        </div>
      ) : (
        /* ══════ 运行状态 (v6.0: 左右分栏) ══════ */
        <div className="flex-1 flex gap-0 overflow-hidden rounded-xl border border-slate-800">
          {/* ── 左侧: 成员列表 (合并活跃 agent + 全部 members 兜底) ── */}
          <div className="w-56 shrink-0 border-r border-slate-800 bg-slate-950 overflow-y-auto p-2 space-y-1.5">
            {(() => {
              // 以 agents (含运行状态) 为主，补充 members 中未出现的成员
              const agentIds = new Set(agents.map(a => a.id));
              const merged: (TeamMember & { status?: string; current_task?: string })[] = [
                ...agents,
                ...members.filter(m => !agentIds.has(m.id)).map(m => ({ ...m, status: 'idle' as const, current_task: undefined })),
              ];
              return merged.length === 0 ? (
                <div className="text-center py-8 text-slate-600 text-xs">
                  <div className="text-2xl mb-2">👥</div>
                  尚无团队成员<br />
                  <span className="text-slate-700">前往「团队配置」添加成员</span>
                </div>
              ) : (
                merged.map(agent => (
                  <MiniAgentCard
                    key={agent.id}
                    agent={agent}
                    isSelected={selectedAgent?.id === agent.id}
                    onClick={() => setSelectedAgent(agent)}
                  />
                ))
              );
            })()}
          </div>

          {/* ── 右侧: Session 面板 (实时流 + 历史会话) ── */}
          <div className="flex-1 bg-slate-950/50">
            {selectedAgent && currentProjectId ? (
              <SessionPanel agentId={selectedAgent.id} projectId={currentProjectId} />
            ) : (
              <div className="h-full flex items-center justify-center text-slate-600">
                <div className="text-center">
                  <div className="text-4xl mb-3">👈</div>
                  <div className="text-sm">选择一位成员查看工作记录</div>
                  <div className="text-xs text-slate-700 mt-1">实时工作流 + 历史会话回放 · 关联具体任务项</div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
