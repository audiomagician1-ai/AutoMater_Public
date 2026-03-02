/**
 * LLM Settings Tab — Provider选择、API Key、模型配置、限制
 */
import { useState } from 'react';

interface LlmTabProps {
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  setSettingsConfigured: (v: boolean) => void;
}

export function LlmTab({ settings, setSettings, setSettingsConfigured }: LlmTabProps) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

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
    const result = await window.automater.llm.testConnection({
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
    await window.automater.settings.save(settings);
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

  const modelFields = [
    { key: 'strongModel' as const, label: '强模型', desc: 'PM 需求分析 / 架构设计 / QA 审查', ph: 'gpt-4o, claude-sonnet-4-20250514' },
    { key: 'workerModel' as const, label: '工作模型', desc: 'Developer 编码 / 计划制定', ph: 'gpt-4o-mini, claude-3-5-haiku-20241022' },
    { key: 'fastModel' as const, label: '快速模型', desc: '摘要 / 格式化 / 子Agent (留空=工作模型)', ph: '可留空' },
  ];

  return (
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
          {modelFields.map(m => (
            <div key={m.key} className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400">
                {m.label} <span className="text-slate-600">— {m.desc}</span>
              </label>
              <input type="text" value={settings[m.key] ?? ''}
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
            <input type="text" value={formatNumberDisplay(settings.workerCount ?? 0)}
              onChange={e => setSettings(prev => ({ ...prev, workerCount: parseNumberInput(e.target.value) }))}
              placeholder="留空 = 无上限"
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 font-mono" />
            <p className="text-[10px] text-slate-600">{(settings.workerCount ?? 0) === 0 ? '♾️ 无上限' : `最多 ${settings.workerCount} 个`}</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">每日预算上限 (USD)</label>
            <input type="text" value={formatNumberDisplay(settings.dailyBudgetUsd ?? 0)}
              onChange={e => setSettings(prev => ({ ...prev, dailyBudgetUsd: parseNumberInput(e.target.value) }))}
              placeholder="留空 = 无上限"
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 font-mono" />
            <p className="text-[10px] text-slate-600">{(settings.dailyBudgetUsd ?? 0) === 0 ? '♾️ 无上限' : `超过 $${settings.dailyBudgetUsd} 自动暂停`}</p>
          </div>
        </div>
      </section>

      {/* Save */}
      <button onClick={handleSave}
        className="w-full py-3 bg-forge-600 hover:bg-forge-500 rounded-lg font-medium transition-all shadow-lg shadow-forge-600/20">
        {saving ? '保存中...' : saved ? '✅ 已保存' : '💾 保存设置'}
      </button>
    </div>
  );
}
