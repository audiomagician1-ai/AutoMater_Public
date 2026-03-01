import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../stores/app-store';

// ═══════════════════════════════════════
// Sub-components
// ═══════════════════════════════════════

/** MCP 服务器配置表单 (新增/编辑) */
function McpServerForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: McpServerStatus;
  onSubmit: (config: Partial<McpServerConfig>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name || '');
  const [transport, setTransport] = useState<'stdio' | 'sse'>(initial?.transport || 'stdio');
  const [command, setCommand] = useState(initial?.command || '');
  const [args, setArgs] = useState((initial?.args || []).join(' '));
  const [cwd, setCwd] = useState(initial?.cwd || '');
  const [envText, setEnvText] = useState(
    Object.entries(initial?.env || {}).map(([k, v]) => `${k}=${v}`).join('\n')
  );
  const [url, setUrl] = useState(initial?.url || '');
  const [headersText, setHeadersText] = useState(
    Object.entries(initial?.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n')
  );

  const handleSubmit = () => {
    const config: Partial<McpServerConfig> = {
      name: name.trim() || 'Unnamed',
      transport,
      enabled: initial?.enabled ?? true,
    };

    if (transport === 'stdio') {
      config.command = command.trim();
      config.args = args.trim() ? args.trim().split(/\s+/) : [];
      config.cwd = cwd.trim() || undefined;
      config.env = parseKvLines(envText);
    } else {
      config.url = url.trim();
      config.headers = parseHeaderLines(headersText);
    }

    onSubmit(config);
  };

  return (
    <div className="space-y-3 p-4 bg-slate-800/50 rounded-lg border border-slate-700">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-slate-400">名称</label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="My MCP Server"
          className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500" />
      </div>

      <div className="flex gap-2">
        {(['stdio', 'sse'] as const).map(t => (
          <button key={t} onClick={() => setTransport(t)}
            className={`px-3 py-1.5 rounded text-xs font-medium ${transport === t ? 'bg-forge-600 text-white' : 'bg-slate-800 text-slate-400'}`}>
            {t === 'stdio' ? 'Stdio (子进程)' : 'SSE (HTTP)'}
          </button>
        ))}
      </div>

      {transport === 'stdio' ? (
        <>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">命令 <span className="text-slate-600">如 npx, python, node</span></label>
            <input value={command} onChange={e => setCommand(e.target.value)} placeholder="npx"
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-forge-500" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">参数 <span className="text-slate-600">空格分隔</span></label>
            <input value={args} onChange={e => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /path"
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-forge-500" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">工作目录 <span className="text-slate-600">可选</span></label>
            <input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="/path/to/server"
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-forge-500" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">环境变量 <span className="text-slate-600">每行 KEY=VALUE</span></label>
            <textarea value={envText} onChange={e => setEnvText(e.target.value)} rows={2} placeholder="API_KEY=xxx"
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-forge-500 resize-y" />
          </div>
        </>
      ) : (
        <>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">URL</label>
            <input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://localhost:3000/mcp"
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-forge-500" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">请求头 <span className="text-slate-600">每行 Key: Value</span></label>
            <textarea value={headersText} onChange={e => setHeadersText(e.target.value)} rows={2} placeholder="Authorization: Bearer xxx"
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-forge-500 resize-y" />
          </div>
        </>
      )}

      <div className="flex gap-2 pt-2">
        <button onClick={handleSubmit}
          className="px-4 py-2 bg-forge-600 hover:bg-forge-500 rounded text-sm font-medium transition-all">
          {initial ? '保存' : '添加'}
        </button>
        <button onClick={onCancel}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm font-medium transition-all">
          取消
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

function parseKvLines(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return result;
}

function parseHeaderLines(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return result;
}

// ═══════════════════════════════════════
// Main Component
// ═══════════════════════════════════════

export function SettingsPage() {
  const { setSettingsConfigured } = useAppStore();

  // ── LLM Settings ──
  const [settings, setSettings] = useState<AppSettings>({
    llmProvider: 'openai',
    apiKey: '',
    baseUrl: 'https://api.openai.com',
    strongModel: '',
    workerModel: '',
    fastModel: '',
    workerCount: 0,
    dailyBudgetUsd: 0,
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // ── MCP ──
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [editingMcpId, setEditingMcpId] = useState<string | null>(null);
  const [mcpConnecting, setMcpConnecting] = useState<string | null>(null);
  const [mcpTools, setMcpTools] = useState<McpToolSummary[]>([]);

  // ── Skill ──
  const [skillDir, setSkillDir] = useState('');
  const [skillDirInput, setSkillDirInput] = useState('');
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillErrors, setSkillErrors] = useState<Array<{ file: string; error: string }>>([]);
  const [skillLoading, setSkillLoading] = useState(false);

  // ── Tab ──
  const [activeTab, setActiveTab] = useState<'llm' | 'mcp' | 'skill'>('llm');

  // ── Load ──
  useEffect(() => {
    window.agentforge.settings.get().then((s: AppSettings) => {
      setSettings({
        ...s,
        fastModel: s.fastModel ?? '',
        workerCount: s.workerCount ?? 0,
        dailyBudgetUsd: s.dailyBudgetUsd ?? 0,
      });
    });
    refreshMcpServers();
    refreshSkills();
  }, []);

  const refreshMcpServers = useCallback(async () => {
    const servers = await window.agentforge.mcp.listServers();
    setMcpServers(servers);
    const tools = await window.agentforge.mcp.listTools();
    setMcpTools(tools);
  }, []);

  const refreshSkills = useCallback(async () => {
    const dir = await window.agentforge.skill.getDirectory();
    setSkillDir(dir);
    setSkillDirInput(dir);
    const list = await window.agentforge.skill.list();
    setSkills(list);
  }, []);

  // ── LLM Handlers ──
  const handleProviderChange = (provider: 'openai' | 'anthropic' | 'custom') => {
    const presets: Record<string, { baseUrl: string; strong: string; worker: string; fast: string }> = {
      openai:    { baseUrl: 'https://api.openai.com',    strong: 'gpt-4o',                      worker: 'gpt-4o-mini',                fast: 'gpt-4o-mini' },
      anthropic: { baseUrl: 'https://api.anthropic.com', strong: 'claude-sonnet-4-20250514', worker: 'claude-3-5-haiku-20241022', fast: 'claude-3-5-haiku-20241022' },
      custom:    { baseUrl: 'http://localhost:11434',     strong: '',                             worker: '',                            fast: '' },
    };
    const p = presets[provider];
    setSettings(prev => ({
      ...prev,
      llmProvider: provider,
      baseUrl: p.baseUrl,
      strongModel: p.strong,
      workerModel: p.worker,
      fastModel: p.fast,
    }));
    setTestResult(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const result = await window.agentforge.llm.testConnection({
      type: settings.llmProvider,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
    });
    setTestResult(result);
    setTesting(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    await window.agentforge.settings.save(settings);
    setSettingsConfigured(!!settings.apiKey);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const parseNumberInput = (value: string): number => {
    if (!value.trim() || value.trim() === '∞') return 0;
    const n = parseInt(value, 10);
    return Number.isNaN(n) || n < 0 ? 0 : n;
  };

  const formatNumberDisplay = (value: number): string => {
    return value === 0 ? '' : String(value);
  };

  // ── MCP Handlers ──
  const handleAddMcp = async (config: Partial<McpServerConfig>) => {
    await window.agentforge.mcp.addServer(config as Omit<McpServerConfig, 'id'>);
    setShowMcpForm(false);
    await refreshMcpServers();
  };

  const handleUpdateMcp = async (config: Partial<McpServerConfig>) => {
    if (editingMcpId) {
      await window.agentforge.mcp.updateServer(editingMcpId, config);
      setEditingMcpId(null);
      await refreshMcpServers();
    }
  };

  const handleRemoveMcp = async (id: string) => {
    await window.agentforge.mcp.removeServer(id);
    await refreshMcpServers();
  };

  const handleToggleMcpConnection = async (server: McpServerStatus) => {
    setMcpConnecting(server.id);
    try {
      if (server.connected) {
        await window.agentforge.mcp.disconnectServer(server.id);
      } else {
        await window.agentforge.mcp.connectServer(server.id);
      }
    } catch { /* ignore */ }
    setMcpConnecting(null);
    await refreshMcpServers();
  };

  // ── Skill Handlers ──
  const handleSetSkillDir = async () => {
    setSkillLoading(true);
    const result = await window.agentforge.skill.setDirectory(skillDirInput.trim());
    setSkillDir(skillDirInput.trim());
    setSkills(result.skills || []);
    setSkillErrors(result.errors || []);
    setSkillLoading(false);
  };

  const handleReloadSkills = async () => {
    setSkillLoading(true);
    const result = await window.agentforge.skill.reload();
    setSkills(result.skills || []);
    setSkillErrors(result.errors || []);
    setSkillLoading(false);
  };

  // ═══════════════════════════════════════
  // Render
  // ═══════════════════════════════════════

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <h2 className="text-2xl font-bold">设置</h2>

        {/* ── Tab Bar ── */}
        <div className="flex gap-1 bg-slate-800/50 rounded-lg p-1">
          {([
            { key: 'llm' as const, label: 'LLM 模型', icon: '🤖' },
            { key: 'mcp' as const, label: 'MCP 服务器', icon: '🔌' },
            { key: 'skill' as const, label: 'Skill 目录', icon: '🧩' },
          ]).map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 px-4 py-2.5 rounded-md text-sm font-medium transition-all ${
                activeTab === tab.key
                  ? 'bg-forge-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
              }`}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {/* ═══════ LLM Tab ═══════ */}
        {activeTab === 'llm' && (
          <div className="space-y-6">
            {/* Provider */}
            <section className="space-y-3">
              <label className="text-sm font-medium text-slate-300">LLM 服务商</label>
              <div className="flex gap-2">
                {(['openai', 'anthropic', 'custom'] as const).map(p => (
                  <button key={p} onClick={() => handleProviderChange(p)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                      settings.llmProvider === p ? 'bg-forge-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                    }`}>
                    {p === 'openai' ? 'OpenAI' : p === 'anthropic' ? 'Anthropic' : '自定义'}
                  </button>
                ))}
              </div>
            </section>

            {/* API Key */}
            <section className="space-y-2">
              <label className="text-sm font-medium text-slate-300">API Key</label>
              <input type="password" value={settings.apiKey}
                onChange={e => setSettings(prev => ({ ...prev, apiKey: e.target.value }))}
                placeholder={settings.llmProvider === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500" />
            </section>

            {/* Base URL */}
            <section className="space-y-2">
              <label className="text-sm font-medium text-slate-300">API Base URL</label>
              <input type="text" value={settings.baseUrl}
                onChange={e => setSettings(prev => ({ ...prev, baseUrl: e.target.value }))}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500" />
            </section>

            {/* Test */}
            <div className="flex items-center gap-3">
              <button onClick={handleTest} disabled={!settings.apiKey || testing}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition-all disabled:opacity-40">
                {testing ? '测试中...' : '🔌 测试连接'}
              </button>
              {testResult && (
                <span className={`text-sm ${testResult.success ? 'text-emerald-400' : 'text-red-400'}`}>
                  {testResult.success ? '✅ 连接成功!' : `❌ ${testResult.message}`}
                </span>
              )}
            </div>

            {/* Models */}
            <section className="space-y-4">
              <h3 className="text-sm font-semibold text-slate-200 border-b border-slate-800 pb-2">模型配置</h3>
              <p className="text-[10px] text-slate-500">直接输入模型名称，支持任何兼容 OpenAI / Anthropic API 的模型</p>
              <div className="space-y-3">
                {([
                  { key: 'strongModel', label: '强模型', desc: 'PM 需求分析 / 架构设计 / QA 审查', ph: 'gpt-4o, claude-sonnet-4-20250514' },
                  { key: 'workerModel', label: '工作模型', desc: 'Developer 编码 / 计划制定', ph: 'gpt-4o-mini, claude-3-5-haiku-20241022' },
                  { key: 'fastModel', label: '快速模型', desc: '摘要 / 格式化 / 子Agent (留空=工作模型)', ph: '可留空' },
                ] as const).map(m => (
                  <div key={m.key} className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-400">
                      {m.label} <span className="text-slate-600">— {m.desc}</span>
                    </label>
                    <input type="text" value={(settings as any)[m.key]}
                      onChange={e => setSettings(prev => ({ ...prev, [m.key]: e.target.value }))}
                      placeholder={m.ph}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 font-mono" />
                  </div>
                ))}
              </div>
            </section>

            {/* Limits */}
            <section className="space-y-4">
              <h3 className="text-sm font-semibold text-slate-200 border-b border-slate-800 pb-2">限制</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-400">最大并行 Agent 数</label>
                  <input type="text" value={formatNumberDisplay(settings.workerCount)}
                    onChange={e => setSettings(prev => ({ ...prev, workerCount: parseNumberInput(e.target.value) }))}
                    placeholder="留空 = 无上限"
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 font-mono" />
                  <p className="text-[10px] text-slate-600">{settings.workerCount === 0 ? '♾️ 无上限' : `最多 ${settings.workerCount} 个`}</p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-400">每日预算上限 (USD)</label>
                  <input type="text" value={formatNumberDisplay(settings.dailyBudgetUsd)}
                    onChange={e => setSettings(prev => ({ ...prev, dailyBudgetUsd: parseNumberInput(e.target.value) }))}
                    placeholder="留空 = 无上限"
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 font-mono" />
                  <p className="text-[10px] text-slate-600">{settings.dailyBudgetUsd === 0 ? '♾️ 无上限' : `超过 $${settings.dailyBudgetUsd} 自动暂停`}</p>
                </div>
              </div>
            </section>

            {/* Save */}
            <button onClick={handleSave}
              className="w-full py-3 bg-forge-600 hover:bg-forge-500 rounded-lg font-medium transition-all shadow-lg shadow-forge-600/20">
              {saving ? '保存中...' : saved ? '✅ 已保存' : '💾 保存设置'}
            </button>
          </div>
        )}

        {/* ═══════ MCP Tab ═══════ */}
        {activeTab === 'mcp' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-200">MCP 服务器</h3>
                <p className="text-xs text-slate-500 mt-1">
                  通过 Model Context Protocol 连接外部工具服务器, 让 Agent 使用更多工具
                </p>
              </div>
              <button onClick={() => { setShowMcpForm(true); setEditingMcpId(null); }}
                className="px-3 py-1.5 bg-forge-600 hover:bg-forge-500 rounded text-sm font-medium transition-all">
                + 添加服务器
              </button>
            </div>

            {/* Add/Edit Form */}
            {showMcpForm && !editingMcpId && (
              <McpServerForm
                onSubmit={handleAddMcp}
                onCancel={() => setShowMcpForm(false)}
              />
            )}

            {/* Server List */}
            {mcpServers.length === 0 && !showMcpForm && (
              <div className="text-center py-12 text-slate-500">
                <p className="text-3xl mb-3">🔌</p>
                <p className="text-sm">暂无 MCP 服务器</p>
                <p className="text-xs mt-1">点击 "添加服务器" 连接外部工具</p>
              </div>
            )}

            {mcpServers.map(server => (
              <div key={server.id} className="border border-slate-700 rounded-lg overflow-hidden">
                {editingMcpId === server.id ? (
                  <McpServerForm
                    initial={server}
                    onSubmit={handleUpdateMcp}
                    onCancel={() => setEditingMcpId(null)}
                  />
                ) : (
                  <div className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className={`w-2.5 h-2.5 rounded-full ${server.connected ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                        <div>
                          <span className="text-sm font-medium text-slate-200">{server.name}</span>
                          <span className="text-xs text-slate-500 ml-2">
                            {server.transport === 'stdio' ? server.command : server.url}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {server.connected && (
                          <span className="text-xs text-emerald-400">{server.toolCount} 工具</span>
                        )}
                        <button
                          onClick={() => handleToggleMcpConnection(server)}
                          disabled={mcpConnecting === server.id}
                          className={`px-3 py-1 rounded text-xs font-medium transition-all disabled:opacity-40 ${
                            server.connected
                              ? 'bg-red-900/50 text-red-300 hover:bg-red-900'
                              : 'bg-emerald-900/50 text-emerald-300 hover:bg-emerald-900'
                          }`}
                        >
                          {mcpConnecting === server.id ? '...' : server.connected ? '断开' : '连接'}
                        </button>
                        <button onClick={() => setEditingMcpId(server.id)}
                          className="px-2 py-1 rounded text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-700">
                          编辑
                        </button>
                        <button onClick={() => handleRemoveMcp(server.id)}
                          className="px-2 py-1 rounded text-xs text-red-400 hover:text-red-300 hover:bg-red-900/30">
                          删除
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Discovered Tools Summary */}
            {mcpTools.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">已发现的 MCP 工具 ({mcpTools.length})</h4>
                <div className="grid grid-cols-2 gap-2">
                  {mcpTools.map((tool, i) => (
                    <div key={i} className="px-3 py-2 bg-slate-800/50 rounded text-xs">
                      <span className="font-mono text-forge-400">{tool.name}</span>
                      <p className="text-slate-500 mt-0.5 line-clamp-1">{tool.description}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {/* ═══════ Skill Tab ═══════ */}
        {activeTab === 'skill' && (
          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-slate-200">Skill 目录</h3>
              <p className="text-xs text-slate-500 mt-1">
                指定一个包含 JSON 技能定义文件的目录, Agent 将自动加载其中的工具
              </p>
            </div>

            {/* Directory Input */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-400">目录路径</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={skillDirInput}
                  onChange={e => setSkillDirInput(e.target.value)}
                  placeholder="例: D:\skills 或 /home/user/skills"
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 font-mono placeholder-slate-600 focus:outline-none focus:border-forge-500"
                />
                <button onClick={handleSetSkillDir} disabled={skillLoading}
                  className="px-4 py-2.5 bg-forge-600 hover:bg-forge-500 rounded-lg text-sm font-medium transition-all disabled:opacity-40">
                  {skillLoading ? '...' : '应用'}
                </button>
                {skillDir && (
                  <button onClick={handleReloadSkills} disabled={skillLoading}
                    className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition-all disabled:opacity-40">
                    🔄 重新扫描
                  </button>
                )}
              </div>
              {skillDir && (
                <p className="text-[10px] text-slate-500">当前目录: {skillDir}</p>
              )}
            </div>

            {/* Skill File Format Guide */}
            <details className="group">
              <summary className="text-xs font-medium text-slate-400 cursor-pointer hover:text-slate-200">
                📖 技能文件格式说明
              </summary>
              <div className="mt-2 p-3 bg-slate-800/50 rounded-lg text-xs text-slate-400">
                <p className="mb-2">在目录中放置 <code className="text-forge-400">.json</code> 文件, 每个文件定义一个或多个工具:</p>
                <pre className="bg-slate-900 rounded p-2 text-[10px] font-mono overflow-x-auto">{`{
  "name": "my_tool",
  "description": "工具描述",
  "parameters": {
    "type": "object",
    "properties": {
      "input": { "type": "string", "description": "输入参数" }
    },
    "required": ["input"]
  },
  "execution": {
    "type": "command",
    "command": "python",
    "args": ["script.py", "{{input}}"],
    "timeout": 30000
  }
}`}</pre>
                <p className="mt-2 text-slate-500">
                  execution.type 支持: <code className="text-forge-400">command</code> (子进程) |
                  <code className="text-forge-400"> http</code> (HTTP 请求) |
                  <code className="text-forge-400"> script</code> (内联 JS)
                </p>
              </div>
            </details>

            {/* Loaded Skills */}
            {skills.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  已加载技能 ({skills.length})
                </h4>
                <div className="space-y-1">
                  {skills.map((skill, i) => (
                    <div key={i} className="flex items-center gap-3 px-3 py-2 bg-slate-800/50 rounded">
                      <span className="text-xs font-mono text-forge-400">{skill.name}</span>
                      <span className="text-xs text-slate-500 flex-1 truncate">{skill.description}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {skills.length === 0 && skillDir && !skillLoading && (
              <div className="text-center py-8 text-slate-500">
                <p className="text-2xl mb-2">🧩</p>
                <p className="text-sm">目录中未找到有效的技能文件</p>
              </div>
            )}

            {!skillDir && (
              <div className="text-center py-12 text-slate-500">
                <p className="text-3xl mb-3">🧩</p>
                <p className="text-sm">未设置技能目录</p>
                <p className="text-xs mt-1">输入目录路径并点击 "应用" 以加载本地技能</p>
              </div>
            )}

            {/* Errors */}
            {skillErrors.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-xs font-semibold text-red-400 uppercase tracking-wider">加载错误</h4>
                {skillErrors.map((err, i) => (
                  <div key={i} className="px-3 py-2 bg-red-900/20 border border-red-900/50 rounded text-xs text-red-300">
                    <span className="font-mono">{err.file}</span>: {err.error}
                  </div>
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
