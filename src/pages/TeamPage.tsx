/**
 * TeamPage — 虚拟团队 (v1.1)
 *
 * Agent 卡片可点击展开详情面板：
 * - 上下文快照 (TokenBudgetBar + ContextSection 列表)
 * - ReAct 迭代时间线 (消息链条 token 增长曲线 + 分类堆叠)
 * - 工具调用历史
 */

import { useState, useEffect, useMemo } from 'react';
import { useAppStore } from '../stores/app-store';

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

const ROLE_COLORS: Record<string, string> = {
  system: 'bg-violet-500',
  user: 'bg-blue-500',
  assistant: 'bg-emerald-500',
  tool: 'bg-amber-500',
};

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ═══════════════════════════════════════
// ContextTimeline — 消息链条 token 增长 SVG 面积图
// ═══════════════════════════════════════
function ContextTimeline({ iterations, maxWindow }: { iterations: ReactIterationState[]; maxWindow: number }) {
  if (iterations.length === 0) return null;

  const W = 600;
  const H = 160;
  const padL = 40, padR = 16, padT = 20, padB = 28;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const maxTokens = Math.max(maxWindow, ...iterations.map(i => i.totalContextTokens)) * 1.1;
  const maxIter = iterations.length;

  const x = (i: number) => padL + (i / Math.max(maxIter - 1, 1)) * chartW;
  const y = (t: number) => padT + chartH - (t / maxTokens) * chartH;

  // 按 role 构建面积层
  const roles: ('system' | 'user' | 'assistant' | 'tool')[] = ['system', 'user', 'assistant', 'tool'];
  const roleStacks: Record<string, number[]> = {};
  for (const role of roles) roleStacks[role] = [];
  for (const iter of iterations) {
    const byRole: Record<string, number> = {};
    for (const b of iter.breakdown) byRole[b.role] = b.tokens;
    let cumulative = 0;
    for (const role of roles) {
      cumulative += byRole[role] ?? 0;
      roleStacks[role].push(cumulative);
    }
  }

  // max context window 警告线
  const windowY = y(maxWindow);

  return (
    <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-medium text-slate-400">上下文 Token 增长曲线</h3>
        <div className="flex gap-3 text-[10px]">
          {roles.map(r => (
            <span key={r} className="flex items-center gap-1">
              <span className={`w-2 h-2 rounded-sm ${ROLE_COLORS[r]}`} />
              <span className="text-slate-500">{r}</span>
            </span>
          ))}
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet">
        {/* Grid lines */}
        {[0.25, 0.5, 0.75, 1].map(ratio => (
          <g key={ratio}>
            <line x1={padL} y1={y(maxTokens * ratio)} x2={W - padR} y2={y(maxTokens * ratio)}
              stroke="#334155" strokeWidth="0.5" strokeDasharray="4,2" />
            <text x={padL - 4} y={y(maxTokens * ratio) + 3} textAnchor="end"
              fill="#64748b" fontSize="8">{formatTokens(maxTokens * ratio)}</text>
          </g>
        ))}

        {/* Max window line */}
        <line x1={padL} y1={windowY} x2={W - padR} y2={windowY}
          stroke="#ef4444" strokeWidth="1" strokeDasharray="6,3" opacity="0.6" />
        <text x={W - padR} y={windowY - 4} textAnchor="end"
          fill="#ef4444" fontSize="8" opacity="0.8">max window {formatTokens(maxWindow)}</text>

        {/* Stacked areas (reverse order for correct layering) */}
        {[...roles].reverse().map(role => {
          const stack = roleStacks[role];
          if (stack.length < 2) return null;
          const points = stack.map((v, i) => `${x(i)},${y(v)}`).join(' ');
          // bottom edge: previous role or 0
          const roleIdx = roles.indexOf(role);
          const prevRole = roleIdx > 0 ? roles[roleIdx - 1] : null;
          const bottomStack = prevRole ? roleStacks[prevRole] : iterations.map(() => 0);
          const bottomPoints = [...bottomStack].reverse().map((v, i) => `${x(stack.length - 1 - i)},${y(v)}`).join(' ');
          const color = ROLE_COLORS[role].replace('bg-', '');
          const colorMap: Record<string, string> = {
            'violet-500': '#8b5cf6', 'blue-500': '#3b82f6',
            'emerald-500': '#10b981', 'amber-500': '#f59e0b',
          };
          return (
            <polygon key={role} points={`${points} ${bottomPoints}`}
              fill={colorMap[color] || '#64748b'} opacity="0.3" />
          );
        })}

        {/* Top line (total) */}
        {iterations.length > 1 && (
          <polyline
            points={iterations.map((iter, i) => `${x(i)},${y(iter.totalContextTokens)}`).join(' ')}
            fill="none" stroke="#e2e8f0" strokeWidth="1.5" opacity="0.8"
          />
        )}

        {/* Data points */}
        {iterations.map((iter, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(iter.totalContextTokens)} r="3"
              fill={iter.completed ? '#10b981' : '#e2e8f0'} stroke="#0f172a" strokeWidth="1" />
            {/* X label */}
            <text x={x(i)} y={H - 6} textAnchor="middle" fill="#64748b" fontSize="8">
              {iter.iteration}
            </text>
          </g>
        ))}
      </svg>

      {/* Iteration stats row */}
      <div className="flex gap-1 mt-2 overflow-x-auto">
        {iterations.slice(-10).map(iter => (
          <div key={iter.iteration} className="shrink-0 text-center px-2 py-1 bg-slate-800/50 rounded text-[10px]">
            <div className="text-slate-400">#{iter.iteration}</div>
            <div className="text-slate-200 font-mono">{formatTokens(iter.totalContextTokens)}</div>
            <div className="text-slate-500">{iter.toolCallsThisIteration.length} tools</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// MessageChainView — 消息链条 token 分布条
// ═══════════════════════════════════════
function MessageChainView({ iterations }: { iterations: ReactIterationState[] }) {
  const latest = iterations[iterations.length - 1];
  if (!latest) return null;

  const total = latest.totalContextTokens || 1;

  return (
    <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-4">
      <h3 className="text-xs font-medium text-slate-400 mb-3">消息链条 Token 分布 (最新一轮)</h3>

      {/* Stacked bar */}
      <div className="h-5 bg-slate-800 rounded-full overflow-hidden flex mb-3">
        {latest.breakdown.map(b => {
          const pct = (b.tokens / total) * 100;
          if (pct < 0.5) return null;
          return (
            <div key={b.role}
              className={`${ROLE_COLORS[b.role] || 'bg-slate-500'} h-full transition-all relative group`}
              style={{ width: `${pct}%` }}
              title={`${b.role}: ${formatTokens(b.tokens)} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>

      {/* Detail table */}
      <div className="grid grid-cols-4 gap-2">
        {latest.breakdown.map(b => (
          <div key={b.role} className="flex items-center gap-2 text-xs">
            <span className={`w-2.5 h-2.5 rounded-sm ${ROLE_COLORS[b.role] || 'bg-slate-500'}`} />
            <div>
              <div className="text-slate-300 font-medium">{b.role}</div>
              <div className="text-slate-500">{formatTokens(b.tokens)} · {b.count}条</div>
            </div>
          </div>
        ))}
      </div>

      {/* Summary */}
      <div className="mt-3 flex gap-4 text-xs text-slate-500 border-t border-slate-800 pt-2">
        <span>总消息: <span className="text-slate-300">{latest.messageCount}</span></span>
        <span>总 Token: <span className="text-slate-300">{formatTokens(latest.totalContextTokens)}</span></span>
        <span>本轮 In/Out: <span className="text-slate-300">{formatTokens(latest.inputTokensThisCall)}/{formatTokens(latest.outputTokensThisCall)}</span></span>
        <span>累计成本: <span className="text-emerald-400">${latest.cumulativeCost.toFixed(4)}</span></span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// MiniContextSnapshot — 精简版上下文快照
// ═══════════════════════════════════════
function MiniContextSnapshot({ snapshot }: { snapshot: ContextSnapshot }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const usedRatio = snapshot.totalTokens / snapshot.tokenBudget;

  const SOURCE_COLORS: Record<string, { bar: string; text: string }> = {
    'project-config': { bar: 'bg-violet-500', text: 'text-violet-400' },
    'architecture':   { bar: 'bg-blue-500',   text: 'text-blue-400' },
    'file-tree':      { bar: 'bg-emerald-500', text: 'text-emerald-400' },
    'repo-map':       { bar: 'bg-amber-500',   text: 'text-amber-400' },
    'dependency':     { bar: 'bg-cyan-500',    text: 'text-cyan-400' },
    'keyword-match':  { bar: 'bg-pink-500',    text: 'text-pink-400' },
    'plan':           { bar: 'bg-orange-500',  text: 'text-orange-400' },
    'qa-feedback':    { bar: 'bg-red-500',     text: 'text-red-400' },
  };

  return (
    <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-slate-400">初始上下文快照</h3>
        <span className={`text-xs font-mono ${usedRatio > 0.8 ? 'text-amber-400' : 'text-emerald-400'}`}>
          {formatTokens(snapshot.totalTokens)} / {formatTokens(snapshot.tokenBudget)} ({(usedRatio * 100).toFixed(0)}%)
        </span>
      </div>

      {/* Budget bar */}
      <div className="h-3 bg-slate-800 rounded-full overflow-hidden flex mb-3">
        {snapshot.sections.map(sec => {
          const pct = (sec.tokens / snapshot.tokenBudget) * 100;
          if (pct < 0.5) return null;
          const color = SOURCE_COLORS[sec.source]?.bar || 'bg-slate-500';
          return (
            <div key={sec.id} className={`${color} h-full`} style={{ width: `${Math.min(pct, 100)}%` }}
              title={`${sec.name}: ${formatTokens(sec.tokens)}`} />
          );
        })}
      </div>

      {/* Section list */}
      <div className="space-y-1">
        {snapshot.sections.map(sec => {
          const color = SOURCE_COLORS[sec.source] || { bar: 'bg-slate-500', text: 'text-slate-400' };
          const isExpanded = expandedId === sec.id;
          return (
            <div key={sec.id}>
              <button
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-800/50 transition-colors text-left"
                onClick={() => setExpandedId(isExpanded ? null : sec.id)}
              >
                <span className={`w-2 h-2 rounded-sm shrink-0 ${color.bar}`} />
                <span className={`text-xs flex-1 truncate ${color.text}`}>{sec.name}</span>
                {sec.truncated && <span className="text-[9px] px-1 rounded bg-amber-500/20 text-amber-400">截断</span>}
                {sec.files && <span className="text-[9px] text-slate-600">{sec.files.length}f</span>}
                <span className="text-[10px] font-mono text-slate-500 shrink-0">{formatTokens(sec.tokens)}</span>
                <span className="text-slate-600 text-[10px]">{isExpanded ? '▼' : '▶'}</span>
              </button>
              {isExpanded && (
                <pre className="text-[10px] text-slate-500 font-mono ml-4 mr-2 mt-1 mb-2 p-2 bg-slate-900 rounded border border-slate-800 max-h-48 overflow-y-auto whitespace-pre-wrap break-all">
                  {sec.content.slice(0, 3000)}{sec.content.length > 3000 ? '\n...[截断]' : ''}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// AgentDetailPanel — 点击 Agent 卡片后的详情面板
// ═══════════════════════════════════════
function AgentDetailPanel({ agent, onClose }: { agent: any; onClose: () => void }) {
  const { contextSnapshots, agentReactStates } = useAppStore();
  const snapshot = contextSnapshots.get(agent.id) ?? null;
  const reactState = agentReactStates.get(agent.id) ?? null;
  const info = ROLE_INFO[agent.role] || { icon: '🤖', title: agent.role };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-8 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-slate-950 border border-slate-800 rounded-2xl shadow-2xl w-[90%] max-w-4xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center gap-4 shrink-0">
          <span className="text-3xl">{info.icon}</span>
          <div className="flex-1">
            <h2 className="text-lg font-bold text-slate-100">{info.title}</h2>
            <div className="text-xs text-slate-500 font-mono">{agent.id} · {agent.status}</div>
          </div>
          {/* Quick stats */}
          <div className="flex gap-3 text-center text-xs">
            <div>
              <div className="text-slate-500">会话</div>
              <div className="text-lg font-bold text-slate-200">{agent.session_count}</div>
            </div>
            <div>
              <div className="text-slate-500">Tokens</div>
              <div className="text-lg font-bold text-slate-200">{formatTokens(agent.total_input_tokens + agent.total_output_tokens)}</div>
            </div>
            <div>
              <div className="text-slate-500">成本</div>
              <div className="text-lg font-bold text-emerald-400">${agent.total_cost_usd.toFixed(3)}</div>
            </div>
            {reactState && (
              <div>
                <div className="text-slate-500">迭代</div>
                <div className="text-lg font-bold text-slate-200">{reactState.iterations.length}</div>
              </div>
            )}
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl transition-colors ml-2">✕</button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Current task */}
          {agent.current_task && (
            <div className="bg-forge-600/10 border border-forge-500/30 rounded-lg px-4 py-2 text-sm">
              <span className="text-forge-400 font-medium">🔨 正在处理: </span>
              <span className="text-slate-300">{agent.current_task}</span>
            </div>
          )}

          {/* ReAct Timeline Chart */}
          {reactState && reactState.iterations.length > 0 && (
            <ContextTimeline
              iterations={reactState.iterations}
              maxWindow={reactState.maxContextWindow}
            />
          )}

          {/* Message Chain Breakdown */}
          {reactState && reactState.iterations.length > 0 && (
            <MessageChainView iterations={reactState.iterations} />
          )}

          {/* Initial Context Snapshot */}
          {snapshot && (
            <MiniContextSnapshot snapshot={snapshot} />
          )}

          {/* Tool call history from react state */}
          {reactState && reactState.iterations.length > 0 && (
            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-4">
              <h3 className="text-xs font-medium text-slate-400 mb-3">工具调用时间线</h3>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {reactState.iterations.map(iter => (
                  iter.toolCallsThisIteration.length > 0 && (
                    <div key={iter.iteration} className="flex items-center gap-2 text-[11px]">
                      <span className="text-slate-500 w-6 text-right">#{iter.iteration}</span>
                      <div className="flex flex-wrap gap-1">
                        {iter.toolCallsThisIteration.map((tool, j) => (
                          <span key={j} className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">{tool}</span>
                        ))}
                      </div>
                      <span className="text-slate-600 ml-auto shrink-0">
                        {formatTokens(iter.totalContextTokens)} ctx · ${iter.costThisCall.toFixed(4)}
                      </span>
                    </div>
                  )
                ))}
              </div>
            </div>
          )}

          {/* Empty state */}
          {!snapshot && !reactState && (
            <div className="text-center py-12 text-slate-600">
              <div className="text-3xl mb-2">📊</div>
              <div>该 Agent 尚无上下文数据</div>
              <div className="text-xs mt-1">Agent 开始 ReAct 循环后将实时展示上下文变化</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// TeamPage — 主页面 (v3.1: 手动编辑团队)
// ═══════════════════════════════════════
export function TeamPage() {
  const { currentProjectId, agentReactStates, contextSnapshots } = useAppStore();
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

  // 首次加载时拉取缓存的 react states
  useEffect(() => {
    if (!currentProjectId) return;
    window.agentforge.project.getReactStates(currentProjectId).then(data => {
      const store = useAppStore.getState();
      for (const [, state] of Object.entries(data)) {
        store.updateAgentReactState(state as AgentReactState);
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
      capabilities: caps,
      system_prompt: newPrompt || undefined,
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
      capabilities: capsArr,
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

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {members.map(m => {
                  const info = ROLE_INFO[m.role] || { icon: '🤖', title: m.role };
                  let caps: string[] = [];
                  try { caps = JSON.parse(m.capabilities || '[]'); } catch { caps = []; }

                  return (
                    <div key={m.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
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
                      {/* System prompt */}
                      {m.system_prompt && (
                        <p className="text-[11px] text-slate-500 line-clamp-2">{m.system_prompt}</p>
                      )}
                      <div className="text-[10px] text-slate-600">
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
              <div className="bg-slate-950 border border-slate-800 rounded-2xl p-6 w-[480px] space-y-4" onClick={e => e.stopPropagation()}>
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
                    <textarea value={editingMember.system_prompt || ''} onChange={e => setEditingMember({ ...editingMember, system_prompt: e.target.value })} rows={3}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 resize-y focus:outline-none focus:border-forge-500" />
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
        /* ══════ 运行状态 (原有逻辑) ══════ */
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {agents.map(agent => {
              const info = ROLE_INFO[agent.role] || { icon: '🤖', title: agent.role };
              const reactState = agentReactStates.get(agent.id);
              const snapshot = contextSnapshots.get(agent.id);
              const latestIter = reactState?.iterations[reactState.iterations.length - 1];
              const hasContext = !!snapshot || !!reactState;

              return (
                <button key={agent.id} onClick={() => setSelectedAgent(agent)}
                  className={`text-left bg-slate-900 border rounded-xl p-4 space-y-3 transition-all ${
                    hasContext ? 'border-forge-500/30 hover:border-forge-400/50 hover:shadow-lg' : 'border-slate-800 hover:border-slate-700'
                  }`}>
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{info.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-slate-200 truncate">{info.title}</div>
                      <div className="text-xs text-slate-500 font-mono">{agent.id}</div>
                    </div>
                    <div className={`w-2.5 h-2.5 rounded-full ${STATUS_STYLES[agent.status] || 'bg-slate-600'}`} title={agent.status} />
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="bg-slate-800/50 rounded-lg p-2">
                      <div className="text-sm font-semibold text-slate-200">{agent.session_count}</div>
                      <div className="text-[10px] text-slate-500">会话</div>
                    </div>
                    <div className="bg-slate-800/50 rounded-lg p-2">
                      <div className="text-sm font-semibold text-slate-200">{((agent.total_input_tokens + agent.total_output_tokens) / 1000).toFixed(1)}k</div>
                      <div className="text-[10px] text-slate-500">tokens</div>
                    </div>
                    <div className="bg-slate-800/50 rounded-lg p-2">
                      <div className="text-sm font-semibold text-slate-200">${agent.total_cost_usd.toFixed(2)}</div>
                      <div className="text-[10px] text-slate-500">成本</div>
                    </div>
                  </div>
                  {latestIter && (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${
                          latestIter.totalContextTokens / (reactState?.maxContextWindow || 128000) > 0.8 ? 'bg-amber-500' : 'bg-emerald-500'
                        }`} style={{ width: `${Math.min((latestIter.totalContextTokens / (reactState?.maxContextWindow || 128000)) * 100, 100)}%` }} />
                      </div>
                      <span className="text-[10px] text-slate-500 shrink-0">{formatTokens(latestIter.totalContextTokens)} ctx</span>
                    </div>
                  )}
                  {agent.current_task && <div className="text-xs text-forge-400 truncate">🔨 {agent.current_task}</div>}
                  {hasContext && <div className="text-[10px] text-slate-600 text-center">点击查看详情 →</div>}
                </button>
              );
            })}
            {agents.length === 0 && (
              <div className="col-span-full text-center py-12 text-slate-600">
                <div className="text-3xl mb-2">🤖</div>
                尚无活跃 Agent<br />
                <span className="text-slate-500 text-xs">发布需求并启动后，Agent 会自动上线</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Agent Detail Modal */}
      {selectedAgent && (
        <AgentDetailPanel agent={selectedAgent} onClose={() => setSelectedAgent(null)} />
      )}
    </div>
  );
}
