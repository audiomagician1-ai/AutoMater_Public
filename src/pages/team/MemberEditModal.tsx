/**
 * MemberEditModal — v11.0 多 Tab 编辑弹窗
 * (基础 / 模型 / MCP / Skill)
 */

import { useState } from 'react';
import { ROLE_INFO, INPUT_CLS, LABEL_CLS, type EditTab } from './types';

interface MemberLLMConfig {
  provider?: 'openai' | 'anthropic' | 'custom';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export function MemberEditModal({ member, onClose, onSave, onChange }: {
  member: TeamMember;
  onClose: () => void;
  onSave: () => void;
  onChange: (m: TeamMember) => void;
}) {
  const [editTab, setEditTab] = useState<EditTab>('basic');
  const [modelTesting, setModelTesting] = useState(false);
  const [modelTestResult, setModelTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // ── LLM Config 解析 ──
  const llmConfig: MemberLLMConfig = (() => {
    try { return member.llm_config ? JSON.parse(member.llm_config) : {}; } catch { return {}; }
  })();
  const updateLLM = (patch: Partial<MemberLLMConfig>) => {
    const next = { ...llmConfig, ...patch };
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next)) {
      if (v !== undefined && v !== '') cleaned[k] = v;
    }
    onChange({ ...member, llm_config: Object.keys(cleaned).length ? JSON.stringify(cleaned) : null });
  };

  // ── MCP 解析 ──
  const mcpServers: MemberMcpServer[] = (() => {
    try { return member.mcp_servers ? JSON.parse(member.mcp_servers) : []; } catch { return []; }
  })();
  const updateMcpServers = (servers: MemberMcpServer[]) => {
    onChange({ ...member, mcp_servers: servers.length ? JSON.stringify(servers) : null });
  };
  const [newMcpName, setNewMcpName] = useState('');
  const [newMcpTransport, setNewMcpTransport] = useState<'stdio' | 'sse'>('stdio');
  const [newMcpCommand, setNewMcpCommand] = useState('');
  const [newMcpArgs, setNewMcpArgs] = useState('');
  const [newMcpUrl, setNewMcpUrl] = useState('');
  const [showMcpAdd, setShowMcpAdd] = useState(false);

  // ── Skill 解析 ──
  const skills: string[] = (() => {
    try { return member.skills ? JSON.parse(member.skills) : []; } catch { return []; }
  })();
  const updateSkills = (list: string[]) => {
    onChange({ ...member, skills: list.length ? JSON.stringify(list) : null });
  };
  const [newSkillName, setNewSkillName] = useState('');

  // ── 模型连通测试 ──
  const handleTestModel = async () => {
    setModelTesting(true);
    setModelTestResult(null);
    const result = await window.automater.team.testMemberModel(member.id, {
      provider: llmConfig.provider,
      apiKey: llmConfig.apiKey,
      baseUrl: llmConfig.baseUrl,
      model: llmConfig.model || member.model || undefined,
    });
    setModelTestResult(result);
    setModelTesting(false);
  };

  const EDIT_TABS: Array<{ key: EditTab; label: string; icon: string }> = [
    { key: 'basic', label: '基础', icon: '📋' },
    { key: 'model', label: '模型', icon: '🤖' },
    { key: 'mcp', label: 'MCP', icon: '🔌' },
    { key: 'skill', label: 'Skill', icon: '🧩' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-slate-950 border border-slate-800 rounded-2xl w-[780px] max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header + Tab bar */}
        <div className="shrink-0 p-5 pb-0 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-slate-200">
              {(ROLE_INFO[member.role] || { icon: '🤖' }).icon} 编辑: {member.name}
            </h3>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-lg transition-colors">✕</button>
          </div>
          <div className="flex gap-1 bg-slate-800/50 rounded-lg p-0.5">
            {EDIT_TABS.map(t => (
              <button key={t.key} onClick={() => setEditTab(t.key)}
                className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  editTab === t.key ? 'bg-forge-600 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
                }`}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto px-5 py-4">

          {/* ─── 基础 Tab ─── */}
          {editTab === 'basic' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL_CLS}>名称</label>
                  <input value={member.name} onChange={e => onChange({ ...member, name: e.target.value })} className={INPUT_CLS} />
                </div>
                <div>
                  <label className={LABEL_CLS}>角色</label>
                  <select value={member.role} onChange={e => onChange({ ...member, role: e.target.value })} className={INPUT_CLS}>
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
                <label className={LABEL_CLS}>能力标签 (逗号分隔)</label>
                <input
                  value={(() => { try { return JSON.parse(member.capabilities || '[]').join(', '); } catch { return member.capabilities; } })()}
                  onChange={e => onChange({ ...member, capabilities: e.target.value })}
                  className={INPUT_CLS}
                />
              </div>
              <div>
                <label className={LABEL_CLS}>系统提示词</label>
                <textarea value={member.system_prompt || ''} onChange={e => onChange({ ...member, system_prompt: e.target.value })} rows={10}
                  className={`${INPUT_CLS} resize-y font-mono leading-relaxed`} />
              </div>
              <div>
                <label className={LABEL_CLS}>上下文窗口 (tokens)</label>
                <input value={member.max_context_tokens} onChange={e => onChange({ ...member, max_context_tokens: parseInt(e.target.value) || 128000 })} className={INPUT_CLS} />
              </div>
            </div>
          )}

          {/* ─── 模型 Tab ─── */}
          {editTab === 'model' && (
            <div className="space-y-4">
              <div className="p-3 bg-slate-800/30 rounded-lg border border-slate-800">
                <p className="text-xs text-slate-400">
                  为此成员配置独立的 LLM。留空的字段将自动使用全局设置中的值。
                </p>
              </div>

              {/* Provider */}
              <div>
                <label className={LABEL_CLS}>服务商 <span className="text-slate-600">— 留空用全局</span></label>
                <div className="flex gap-2">
                  {([
                    { val: '', label: '跟随全局' },
                    { val: 'openai', label: 'OpenAI' },
                    { val: 'anthropic', label: 'Anthropic' },
                    { val: 'custom', label: '自定义' },
                  ] as const).map(p => (
                    <button key={p.val} onClick={() => updateLLM({ provider: p.val || undefined })}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        (llmConfig.provider || '') === p.val ? 'bg-forge-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                      }`}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* API Key */}
              <div>
                <label className={LABEL_CLS}>API Key <span className="text-slate-600">— 留空用全局</span></label>
                <input type="password" value={llmConfig.apiKey || ''} onChange={e => updateLLM({ apiKey: e.target.value || undefined })}
                  placeholder="留空则继承全局 API Key"
                  className={`${INPUT_CLS} font-mono`} />
              </div>

              {/* Base URL */}
              <div>
                <label className={LABEL_CLS}>API Base URL <span className="text-slate-600">— 留空用全局</span></label>
                <input value={llmConfig.baseUrl || ''} onChange={e => updateLLM({ baseUrl: e.target.value || undefined })}
                  placeholder="留空则继承全局 Base URL"
                  className={`${INPUT_CLS} font-mono`} />
              </div>

              {/* Model */}
              <div>
                <label className={LABEL_CLS}>模型名称 <span className="text-slate-600">— 留空用全局 (按角色分配)</span></label>
                <input value={llmConfig.model || ''} onChange={e => {
                  updateLLM({ model: e.target.value || undefined });
                }}
                  placeholder="gpt-4o, claude-sonnet-4-20250514, deepseek-chat, ..."
                  className={`${INPUT_CLS} font-mono`} />
              </div>

              {/* Test connection */}
              <div className="flex items-center gap-3 pt-2">
                <button onClick={handleTestModel} disabled={modelTesting}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition-all disabled:opacity-40">
                  {modelTesting ? '🔄 测试中...' : '🔌 测试连通性'}
                </button>
                {modelTestResult && (
                  <span className={`text-xs flex-1 ${modelTestResult.success ? 'text-emerald-400' : 'text-red-400'}`}>
                    {modelTestResult.message}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* ─── MCP Tab ─── */}
          {editTab === 'mcp' && (
            <div className="space-y-4">
              <div className="p-3 bg-slate-800/30 rounded-lg border border-slate-800">
                <p className="text-xs text-slate-400">
                  为此成员配置专属 MCP 服务器。这些 MCP 仅对该成员生效，与全局 MCP 共存。
                </p>
              </div>

              {/* 已有 MCP 列表 */}
              {mcpServers.map((srv, i) => (
                <div key={srv.id} className="flex items-center gap-3 p-3 bg-slate-800/50 rounded-lg border border-slate-700/50">
                  <span className={`w-2 h-2 rounded-full ${srv.enabled ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-200">{srv.name}</div>
                    <div className="text-[10px] text-slate-500 font-mono truncate">
                      {srv.transport === 'stdio' ? `${srv.command} ${(srv.args || []).join(' ')}` : srv.url}
                    </div>
                  </div>
                  <button onClick={() => {
                    const next = mcpServers.map((s, j) => j === i ? { ...s, enabled: !s.enabled } : s);
                    updateMcpServers(next);
                  }} className="text-xs text-slate-400 hover:text-slate-200">
                    {srv.enabled ? '🟢' : '🔴'}
                  </button>
                  <button onClick={() => {
                    updateMcpServers(mcpServers.filter((_, j) => j !== i));
                  }} className="text-xs text-red-400 hover:text-red-300">✕</button>
                </div>
              ))}

              {mcpServers.length === 0 && !showMcpAdd && (
                <div className="text-center py-6 text-slate-600 text-xs">
                  暂无成员专属 MCP · 全局 MCP 仍然生效
                </div>
              )}

              {/* 添加 MCP */}
              {showMcpAdd ? (
                <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={LABEL_CLS}>名称</label>
                      <input value={newMcpName} onChange={e => setNewMcpName(e.target.value)} placeholder="My MCP" className={INPUT_CLS} />
                    </div>
                    <div>
                      <label className={LABEL_CLS}>传输方式</label>
                      <div className="flex gap-2">
                        {(['stdio', 'sse'] as const).map(t => (
                          <button key={t} onClick={() => setNewMcpTransport(t)}
                            className={`px-3 py-2 rounded text-xs font-medium flex-1 ${newMcpTransport === t ? 'bg-forge-600 text-white' : 'bg-slate-900 text-slate-400'}`}>
                            {t === 'stdio' ? 'Stdio' : 'SSE'}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  {newMcpTransport === 'stdio' ? (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={LABEL_CLS}>命令</label>
                        <input value={newMcpCommand} onChange={e => setNewMcpCommand(e.target.value)} placeholder="npx" className={`${INPUT_CLS} font-mono`} />
                      </div>
                      <div>
                        <label className={LABEL_CLS}>参数</label>
                        <input value={newMcpArgs} onChange={e => setNewMcpArgs(e.target.value)} placeholder="-y @mcp/server" className={`${INPUT_CLS} font-mono`} />
                      </div>
                    </div>
                  ) : (
                    <div>
                      <label className={LABEL_CLS}>URL</label>
                      <input value={newMcpUrl} onChange={e => setNewMcpUrl(e.target.value)} placeholder="http://localhost:3000/mcp" className={`${INPUT_CLS} font-mono`} />
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button onClick={() => {
                      if (!newMcpName.trim()) return;
                      const srv: MemberMcpServer = {
                        id: 'mmcp-' + Date.now().toString(36),
                        name: newMcpName.trim(),
                        transport: newMcpTransport,
                        command: newMcpTransport === 'stdio' ? newMcpCommand.trim() : undefined,
                        args: newMcpTransport === 'stdio' ? newMcpArgs.trim().split(/\s+/).filter(Boolean) : undefined,
                        url: newMcpTransport === 'sse' ? newMcpUrl.trim() : undefined,
                        enabled: true,
                      };
                      updateMcpServers([...mcpServers, srv]);
                      setNewMcpName(''); setNewMcpCommand(''); setNewMcpArgs(''); setNewMcpUrl('');
                      setShowMcpAdd(false);
                    }} className="px-3 py-1.5 bg-forge-600 hover:bg-forge-500 rounded text-xs font-medium">
                      添加
                    </button>
                    <button onClick={() => setShowMcpAdd(false)} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs font-medium">
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setShowMcpAdd(true)}
                  className="w-full py-2 text-xs text-forge-400 hover:text-forge-300 border border-dashed border-slate-700 hover:border-forge-500/50 rounded-lg transition-all">
                  + 添加专属 MCP 服务器
                </button>
              )}
            </div>
          )}

          {/* ─── Skill Tab ─── */}
          {editTab === 'skill' && (
            <div className="space-y-4">
              <div className="p-3 bg-slate-800/30 rounded-lg border border-slate-800">
                <p className="text-xs text-slate-400">
                  为此成员配置专属 Skill。输入 Skill 名称（与全局 Skill 目录中的定义对应）。
                </p>
              </div>

              {/* 已有 Skills */}
              {skills.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {skills.map((s, i) => (
                    <span key={i} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 rounded-lg text-xs text-slate-200 border border-slate-700">
                      🧩 {s}
                      <button onClick={() => updateSkills(skills.filter((_, j) => j !== i))}
                        className="text-red-400 hover:text-red-300 ml-1">✕</button>
                    </span>
                  ))}
                </div>
              )}

              {skills.length === 0 && (
                <div className="text-center py-6 text-slate-600 text-xs">
                  暂无成员专属 Skill · 全局 Skill 仍然生效
                </div>
              )}

              {/* 添加 Skill */}
              <div className="flex gap-2">
                <input value={newSkillName} onChange={e => setNewSkillName(e.target.value)}
                  placeholder="Skill 名称, 如 my_custom_tool"
                  className={`flex-1 ${INPUT_CLS} font-mono`}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newSkillName.trim()) {
                      updateSkills([...skills, newSkillName.trim()]);
                      setNewSkillName('');
                    }
                  }} />
                <button onClick={() => {
                  if (!newSkillName.trim()) return;
                  updateSkills([...skills, newSkillName.trim()]);
                  setNewSkillName('');
                }} className="px-4 py-2 bg-forge-600 hover:bg-forge-500 rounded-lg text-xs font-medium">
                  + 添加
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 px-5 py-4 border-t border-slate-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors">取消</button>
          <button onClick={onSave} className="px-4 py-2 rounded-lg bg-forge-600 hover:bg-forge-500 text-white text-sm font-medium transition-all">
            💾 保存
          </button>
        </div>
      </div>
    </div>
  );
}
