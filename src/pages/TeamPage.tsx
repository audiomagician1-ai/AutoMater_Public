/**
 * TeamPage — 虚拟团队 (v6.0)
 *
 * 运行状态 tab: 左侧精简成员卡片 + 右侧对话式工作细节面板
 * 团队配置 tab: 成员 CRUD
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { useAppStore, type AgentWorkMessage } from '../stores/app-store';

const ROLE_INFO: Record<string, { icon: string; title: string }> = {
  pm: { icon: '🧠', title: '产品经理' },
  architect: { icon: '🏗️', title: '架构师' },
  developer: { icon: '💻', title: '开发者' },
  qa: { icon: '🧪', title: 'QA 工程师' },
  reviewer: { icon: '👁️', title: 'Reviewer' },
  devops: { icon: '🚀', title: 'DevOps' },
};

const STATUS_STYLES: Record<string, string> = {
  idle: 'bg-slate-600',
  working: 'bg-emerald-500 animate-pulse',
  waiting: 'bg-amber-500',
  error: 'bg-red-500',
  stopped: 'bg-slate-700',
};

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ═══════════════════════════════════════
// AgentWorkFeed — 对话式工作细节面板 (v6.0)
// ═══════════════════════════════════════

const MSG_STYLES: Record<AgentWorkMessage['type'], { icon: string; border: string; bg: string; label: string }> = {
  think:       { icon: '💭', border: 'border-l-blue-500',    bg: 'bg-blue-500/5',    label: '思考' },
  'tool-call': { icon: '🔧', border: 'border-l-amber-500',  bg: 'bg-amber-500/5',   label: '工具' },
  'tool-result':{ icon: '📦', border: 'border-l-emerald-500',bg: 'bg-emerald-500/5', label: '结果' },
  output:      { icon: '✅', border: 'border-l-green-500',   bg: 'bg-green-500/5',   label: '输出' },
  status:      { icon: '📌', border: 'border-l-slate-500',   bg: 'bg-slate-500/5',   label: '状态' },
  'sub-agent': { icon: '🔬', border: 'border-l-violet-500',  bg: 'bg-violet-500/5',  label: '子Agent' },
  error:       { icon: '⚠️', border: 'border-l-red-500',     bg: 'bg-red-500/5',     label: '错误' },
  plan:        { icon: '📋', border: 'border-l-orange-500',  bg: 'bg-orange-500/5',  label: '计划' },
};

function AgentWorkFeed({ agentId }: { agentId: string }) {
  const messages = useAppStore(s => s.agentWorkMessages.get(agentId) || []);
  const reactState = useAppStore(s => s.agentReactStates.get(agentId));
  const activeStream = useAppStore(s => s.activeStreams.get(agentId));
  const feedRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedMsgId, setExpandedMsgId] = useState<string | null>(null);

  // 自动滚动到底部
  useEffect(() => {
    if (autoScroll && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [messages.length, autoScroll, activeStream?.content]);

  // 检测手动滚动
  const handleScroll = () => {
    if (!feedRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = feedRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 60);
  };

  const latestIter = reactState?.iterations?.length
    ? reactState.iterations[reactState.iterations.length - 1]
    : undefined;

  const info = ROLE_INFO[agentId.split('-')[0]] || { icon: '🤖', title: agentId };

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="shrink-0 px-4 py-3 border-b border-slate-800 flex items-center gap-3">
        <span className="text-2xl">{info.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-slate-100 truncate">{info.title}</div>
          <div className="text-xs text-slate-500 font-mono">{agentId}</div>
        </div>
        {latestIter && (
          <div className="flex gap-3 text-xs text-slate-400">
            <span>迭代 <span className="text-slate-200 font-mono">{latestIter.iteration}</span></span>
            <span>Token <span className="text-slate-200 font-mono">{formatTokens(latestIter.totalContextTokens)}</span></span>
            <span>成本 <span className="text-emerald-400 font-mono">${latestIter.cumulativeCost.toFixed(4)}</span></span>
          </div>
        )}
      </div>

      {/* Message feed */}
      <div ref={feedRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {messages.length === 0 && !activeStream && (
          <div className="text-center text-slate-600 py-12">
            <div className="text-3xl mb-2">{info.icon}</div>
            <div>尚无工作记录</div>
            <div className="text-xs mt-1 text-slate-700">Agent 开始执行后，思考和操作将实时展示在这里</div>
          </div>
        )}

        {messages.map(msg => {
          const style = MSG_STYLES[msg.type] || MSG_STYLES.status;
          const isExpanded = expandedMsgId === msg.id;
          const isLong = msg.content.length > 200;

          return (
            <div
              key={msg.id}
              className={`border-l-2 ${style.border} ${style.bg} rounded-r-lg px-3 py-2 transition-colors hover:brightness-110`}
              onClick={() => isLong ? setExpandedMsgId(isExpanded ? null : msg.id) : undefined}
            >
              <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                <span>{style.icon}</span>
                <span className="font-medium text-slate-400">{style.label}</span>
                {msg.iteration && <span className="text-slate-600">#{msg.iteration}</span>}
                <span className="ml-auto text-slate-600">{new Date(msg.timestamp).toLocaleTimeString()}</span>
              </div>

              {/* Tool call 特殊样式 */}
              {msg.type === 'tool-result' && msg.tool ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${msg.tool.success ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                      {msg.tool.name}
                    </span>
                    <span className="text-xs text-slate-500 truncate">{msg.tool.args}</span>
                  </div>
                  {msg.tool.outputPreview && (
                    <pre className="text-[11px] text-slate-400 font-mono whitespace-pre-wrap break-all leading-relaxed">{msg.tool.outputPreview}</pre>
                  )}
                </div>
              ) : (
                <div className={`text-sm text-slate-300 leading-relaxed ${isLong && !isExpanded ? 'line-clamp-3 cursor-pointer' : 'whitespace-pre-wrap break-all'}`}>
                  {msg.content}
                </div>
              )}
              {isLong && !isExpanded && (
                <div className="text-[10px] text-slate-600 mt-1 cursor-pointer hover:text-slate-400">点击展开 ▸</div>
              )}
            </div>
          );
        })}

        {/* Streaming indicator */}
        {activeStream && (
          <div className="border-l-2 border-l-forge-500 bg-forge-500/5 rounded-r-lg px-3 py-2">
            <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-forge-400 animate-pulse" />
              <span className="text-forge-400 font-medium">输出中...</span>
              <span className="ml-auto text-slate-600">{activeStream.content.length} chars</span>
            </div>
            <pre className="text-sm text-slate-300 font-mono whitespace-pre-wrap break-all leading-relaxed max-h-40 overflow-y-auto">
              {activeStream.content.length > 1000 ? '...' + activeStream.content.slice(-1000) : activeStream.content}
              <span className="inline-block w-1.5 h-3.5 bg-forge-400/80 animate-pulse ml-0.5 align-text-bottom" />
            </pre>
          </div>
        )}
      </div>

      {/* Bottom status bar */}
      {latestIter && (
        <div className="shrink-0 px-4 py-2 border-t border-slate-800 flex items-center gap-4 text-[11px] text-slate-500">
          <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${
              latestIter.totalContextTokens / (reactState?.maxContextWindow || 128000) > 0.8 ? 'bg-amber-500' : 'bg-emerald-500'
            }`} style={{ width: `${Math.min((latestIter.totalContextTokens / (reactState?.maxContextWindow || 128000)) * 100, 100)}%` }} />
          </div>
          <span>ctx {formatTokens(latestIter.totalContextTokens)} / {formatTokens(reactState?.maxContextWindow || 128000)}</span>
          <span>{messages.length} 条消息</span>
          {!autoScroll && (
            <button onClick={() => { setAutoScroll(true); if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight; }}
              className="text-forge-400 hover:text-forge-300 transition-colors">↓ 回到最新</button>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════
// MiniAgentCard — 左侧精简成员卡片 (v6.0)
// ═══════════════════════════════════════
function MiniAgentCard({ agent, isSelected, onClick }: {
  agent: any; isSelected: boolean; onClick: () => void;
}) {
  const reactState = useAppStore(s => s.agentReactStates.get(agent.id));
  const liveStatus = useAppStore(s => s.agentStatuses.get(agent.id));
  const msgCount = useAppStore(s => (s.agentWorkMessages.get(agent.id) || []).length);
  const info = ROLE_INFO[agent.role] || { icon: '🤖', title: agent.role };
  const isWorking = agent.status === 'working' || liveStatus?.status === 'working';
  const latestIter = reactState?.iterations?.length ? reactState.iterations[reactState.iterations.length - 1] : undefined;

  return (
    <button onClick={onClick}
      className={`w-full text-left rounded-xl p-3 transition-all flex items-center gap-3 ${
        isSelected
          ? 'bg-forge-600/20 border border-forge-500/40 shadow-lg shadow-forge-500/5'
          : 'bg-slate-900 border border-slate-800 hover:border-slate-700'
      }`}>
      <div className="relative shrink-0">
        <span className="text-xl">{info.icon}</span>
        <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slate-950 ${
          isWorking ? 'bg-emerald-500 animate-pulse' : (STATUS_STYLES[agent.status] || 'bg-slate-600')
        }`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-slate-200 truncate">{info.title}</div>
        {isWorking && (liveStatus?.featureTitle || agent.current_task) && (
          <div className="text-[10px] text-emerald-400 truncate mt-0.5">{liveStatus?.featureTitle || agent.current_task}</div>
        )}
        {!isWorking && latestIter && (
          <div className="text-[10px] text-slate-500 mt-0.5">{formatTokens(latestIter.totalContextTokens)} ctx · ${latestIter.cumulativeCost.toFixed(3)}</div>
        )}
      </div>
      {msgCount > 0 && (
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono shrink-0 ${
          isSelected ? 'bg-forge-500/30 text-forge-300' : 'bg-slate-800 text-slate-500'
        }`}>{msgCount}</span>
      )}
    </button>
  );
}

// ═══════════════════════════════════════
// TeamPage — 主页面 (v3.1: 手动编辑团队)
// ═══════════════════════════════════════
export function TeamPage() {
  const { currentProjectId } = useAppStore();
  const [agents, setAgents] = useState<any[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<any>(null);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [tab, setTab] = useState<'runtime' | 'config'>('config');

  // ── 新增成员表单 ──
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('developer');
  const [newModel, setNewModel] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [newCaps, setNewCaps] = useState('');
  const [newMaxTokens, setNewMaxTokens] = useState('128000');

  const loadAgents = async () => {
    if (!currentProjectId) return;
    const data = await window.agentforge.project.getAgents(currentProjectId);
    setAgents(data || []);
  };

  const loadMembers = async () => {
    if (!currentProjectId) return;
    const data = await window.agentforge.team.list(currentProjectId);
    setMembers(data || []);
  };

  useEffect(() => { loadAgents(); loadMembers(); }, [currentProjectId]);
  useEffect(() => {
    const timer = setInterval(() => { loadAgents(); }, 3000);
    return () => clearInterval(timer);
  }, [currentProjectId]);

  // v9.0: 监听 team:member-added 事件 — 热加入实时反馈
  useEffect(() => {
    const unsub = window.agentforge.on('team:member-added', (data: {
      projectId: string; memberId: string; role: string; name: string;
    }) => {
      if (data.projectId === currentProjectId) {
        // 刷新成员列表和 Agent 列表以反映新成员
        loadMembers();
        loadAgents();
      }
    });
    return unsub;
  }, [currentProjectId]);

  // 首次加载时拉取缓存的 react states
  useEffect(() => {
    if (!currentProjectId) return;
    window.agentforge.project.getReactStates(currentProjectId).then(data => {
      const store = useAppStore.getState();
      for (const [, state] of Object.entries(data)) {
        store.updateAgentReactState(state as any);
      }
    }).catch(() => {});
    window.agentforge.project.getContextSnapshots(currentProjectId).then(data => {
      const store = useAppStore.getState();
      for (const [, snap] of Object.entries(data)) {
        store.updateContextSnapshot(snap as ContextSnapshot);
      }
    }).catch(() => {});
  }, [currentProjectId]);

  /** 初始化默认团队 */
  const handleInitDefaults = async () => {
    if (!currentProjectId) return;
    await window.agentforge.team.initDefaults(currentProjectId);
    loadMembers();
  };

  /** 添加成员 */
  const handleAddMember = async () => {
    if (!currentProjectId || !newName.trim()) return;
    const caps = newCaps.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    await window.agentforge.team.add(currentProjectId, {
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
    await window.agentforge.team.delete(id);
    loadMembers();
  };

  /** 保存编辑 */
  const handleSaveEdit = async () => {
    if (!editingMember) return;
    const caps = typeof editingMember.capabilities === 'string'
      ? editingMember.capabilities : JSON.stringify(editingMember.capabilities);
    let capsArr: string[];
    try { capsArr = JSON.parse(caps); } catch { capsArr = caps.split(/[,，]/).map(s => s.trim()).filter(Boolean); }
    await window.agentforge.team.update(editingMember.id, {
      ...editingMember,
      capabilities: JSON.stringify(capsArr),
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
          {/* Tab 切换 */}
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
                          <div className="text-xs text-slate-500">{info.title} · {m.model || '默认模型'}</div>
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
                      {/* System prompt — show more lines */}
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
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500"
                        placeholder="开发者 C" />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 mb-1 block">角色</label>
                      <select value={newRole} onChange={e => setNewRole(e.target.value)}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500">
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
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500"
                      placeholder="gpt-5.3-codex" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">能力标签 (逗号分隔)</label>
                    <input value={newCaps} onChange={e => setNewCaps(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500"
                      placeholder="前端开发, React, TypeScript" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">系统提示词</label>
                    <textarea value={newPrompt} onChange={e => setNewPrompt(e.target.value)} rows={3}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 resize-y focus:outline-none focus:border-forge-500"
                      placeholder="你是一位资深前端开发者..." />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">上下文窗口 (tokens)</label>
                    <input value={newMaxTokens} onChange={e => setNewMaxTokens(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500"
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

          {/* ── 编辑弹窗 ── */}
          {editingMember && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setEditingMember(null)}>
              <div className="bg-slate-950 border border-slate-800 rounded-2xl p-6 w-[720px] max-h-[85vh] overflow-y-auto space-y-4" onClick={e => e.stopPropagation()}>
                <h3 className="text-lg font-bold text-slate-200">编辑: {editingMember.name}</h3>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-slate-500 mb-1 block">名称</label>
                      <input value={editingMember.name} onChange={e => setEditingMember({ ...editingMember, name: e.target.value })}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500" />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 mb-1 block">角色</label>
                      <select value={editingMember.role} onChange={e => setEditingMember({ ...editingMember, role: e.target.value })}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500">
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
                    <label className="text-xs text-slate-500 mb-1 block">模型</label>
                    <input value={editingMember.model || ''} onChange={e => setEditingMember({ ...editingMember, model: e.target.value })}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">能力标签</label>
                    <input value={(() => { try { return JSON.parse(editingMember.capabilities || '[]').join(', '); } catch { return editingMember.capabilities; } })()}
                      onChange={e => setEditingMember({ ...editingMember, capabilities: e.target.value })}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">系统提示词</label>
                    <textarea value={editingMember.system_prompt || ''} onChange={e => setEditingMember({ ...editingMember, system_prompt: e.target.value })} rows={10}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 resize-y focus:outline-none focus:border-forge-500 font-mono leading-relaxed" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">上下文窗口</label>
                    <input value={editingMember.max_context_tokens} onChange={e => setEditingMember({ ...editingMember, max_context_tokens: parseInt(e.target.value) || 128000 })}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500" />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setEditingMember(null)} className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200">取消</button>
                  <button onClick={handleSaveEdit} className="px-4 py-2 rounded-lg bg-forge-600 hover:bg-forge-500 text-white text-sm">保存</button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* ══════ 运行状态 (v6.0: 左右分栏) ══════ */
        <div className="flex-1 flex gap-0 overflow-hidden rounded-xl border border-slate-800">
          {/* ── 左侧: 成员列表 ── */}
          <div className="w-56 shrink-0 border-r border-slate-800 bg-slate-950 overflow-y-auto p-2 space-y-1.5">
            {agents.length === 0 ? (
              <div className="text-center py-8 text-slate-600 text-xs">
                <div className="text-2xl mb-2">🤖</div>
                尚无活跃 Agent<br />
                <span className="text-slate-700">发布需求后自动上线</span>
              </div>
            ) : (
              agents.map(agent => (
                <MiniAgentCard
                  key={agent.id}
                  agent={agent}
                  isSelected={selectedAgent?.id === agent.id}
                  onClick={() => setSelectedAgent(agent)}
                />
              ))
            )}
          </div>

          {/* ── 右侧: 工作细节面板 ── */}
          <div className="flex-1 bg-slate-950/50">
            {selectedAgent ? (
              <AgentWorkFeed agentId={selectedAgent.id} />
            ) : (
              <div className="h-full flex items-center justify-center text-slate-600">
                <div className="text-center">
                  <div className="text-4xl mb-3">👈</div>
                  <div className="text-sm">选择一位成员查看工作细节</div>
                  <div className="text-xs text-slate-700 mt-1">思维链、工具调用、子Agent交互 一览无余</div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
