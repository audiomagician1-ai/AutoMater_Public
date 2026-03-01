import { useState, useEffect } from 'react';
import { useAppStore } from '../stores/app-store';

export function SettingsPage() {
  const { setSettingsConfigured } = useAppStore();
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

  // 加载已保存的设置
  useEffect(() => {
    window.agentforge.settings.get().then((s: AppSettings) => {
      setSettings({
        ...s,
        fastModel: s.fastModel ?? '',
        workerCount: s.workerCount ?? 0,
        dailyBudgetUsd: s.dailyBudgetUsd ?? 0,
      });
    });
  }, []);

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

  /** 处理数字输入，支持空值(=0=无限) */
  const parseNumberInput = (value: string): number => {
    if (!value.trim() || value.trim() === '∞') return 0;
    const n = parseInt(value, 10);
    return Number.isNaN(n) || n < 0 ? 0 : n;
  };

  const formatNumberDisplay = (value: number): string => {
    return value === 0 ? '' : String(value);
  };

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="max-w-xl mx-auto space-y-8">
        <h2 className="text-2xl font-bold">设置</h2>

        {/* ── Provider ── */}
        <section className="space-y-3">
          <label className="text-sm font-medium text-slate-300">LLM 服务商</label>
          <div className="flex gap-2">
            {(['openai', 'anthropic', 'custom'] as const).map(p => (
              <button
                key={p}
                onClick={() => handleProviderChange(p)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  settings.llmProvider === p
                    ? 'bg-forge-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                }`}
              >
                {p === 'openai' ? 'OpenAI' : p === 'anthropic' ? 'Anthropic' : '自定义'}
              </button>
            ))}
          </div>
        </section>

        {/* ── API Key ── */}
        <section className="space-y-2">
          <label className="text-sm font-medium text-slate-300">API Key</label>
          <input
            type="password"
            value={settings.apiKey}
            onChange={e => setSettings(prev => ({ ...prev, apiKey: e.target.value }))}
            placeholder={settings.llmProvider === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500"
          />
        </section>

        {/* ── Base URL ── */}
        <section className="space-y-2">
          <label className="text-sm font-medium text-slate-300">API Base URL</label>
          <input
            type="text"
            value={settings.baseUrl}
            onChange={e => setSettings(prev => ({ ...prev, baseUrl: e.target.value }))}
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500"
          />
        </section>

        {/* ── Test Connection ── */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleTest}
            disabled={!settings.apiKey || testing}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition-all disabled:opacity-40"
          >
            {testing ? '测试中...' : '🔌 测试连接'}
          </button>
          {testResult && (
            <span className={`text-sm ${testResult.success ? 'text-emerald-400' : 'text-red-400'}`}>
              {testResult.success ? '✅ 连接成功!' : `❌ ${testResult.message}`}
            </span>
          )}
        </div>

        {/* ── Models ── */}
        <section className="space-y-4">
          <h3 className="text-sm font-semibold text-slate-200 border-b border-slate-800 pb-2">模型配置</h3>
          <p className="text-[10px] text-slate-500">直接输入模型名称，支持任何兼容 OpenAI / Anthropic API 的模型</p>

          <div className="space-y-3">
            {/* 强模型 */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400">
                强模型 <span className="text-slate-600">— PM 需求分析 / 架构设计 / QA 审查</span>
              </label>
              <input
                type="text"
                value={settings.strongModel}
                onChange={e => setSettings(prev => ({ ...prev, strongModel: e.target.value }))}
                placeholder="例: gpt-4o, claude-sonnet-4-20250514, deepseek-chat"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 font-mono"
              />
            </div>

            {/* 工作模型 */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400">
                工作模型 <span className="text-slate-600">— Developer 编码 / 计划制定</span>
              </label>
              <input
                type="text"
                value={settings.workerModel}
                onChange={e => setSettings(prev => ({ ...prev, workerModel: e.target.value }))}
                placeholder="例: gpt-4o-mini, claude-3-5-haiku-20241022, deepseek-chat"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 font-mono"
              />
            </div>

            {/* 快速模型 */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400">
                快速模型 <span className="text-slate-600">— 摘要 / 格式化 / 子Agent (留空则用工作模型)</span>
              </label>
              <input
                type="text"
                value={settings.fastModel}
                onChange={e => setSettings(prev => ({ ...prev, fastModel: e.target.value }))}
                placeholder="例: gpt-4o-mini, claude-3-5-haiku-20241022 (可留空)"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 font-mono"
              />
            </div>
          </div>
        </section>

        {/* ── Limits ── */}
        <section className="space-y-4">
          <h3 className="text-sm font-semibold text-slate-200 border-b border-slate-800 pb-2">限制</h3>

          <div className="grid grid-cols-2 gap-4">
            {/* Worker Count */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400">最大并行 Agent 数</label>
              <input
                type="text"
                value={formatNumberDisplay(settings.workerCount)}
                onChange={e => setSettings(prev => ({ ...prev, workerCount: parseNumberInput(e.target.value) }))}
                placeholder="留空 = 无上限"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 font-mono"
              />
              <p className="text-[10px] text-slate-600">
                {settings.workerCount === 0 ? '♾️ 无上限' : `最多 ${settings.workerCount} 个`}
              </p>
            </div>

            {/* Daily Budget */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400">每日预算上限 (USD)</label>
              <input
                type="text"
                value={formatNumberDisplay(settings.dailyBudgetUsd)}
                onChange={e => setSettings(prev => ({ ...prev, dailyBudgetUsd: parseNumberInput(e.target.value) }))}
                placeholder="留空 = 无上限"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 font-mono"
              />
              <p className="text-[10px] text-slate-600">
                {settings.dailyBudgetUsd === 0 ? '♾️ 无上限' : `超过 $${settings.dailyBudgetUsd} 自动暂停`}
              </p>
            </div>
          </div>
        </section>

        {/* ── Save ── */}
        <button
          onClick={handleSave}
          className="w-full py-3 bg-forge-600 hover:bg-forge-500 rounded-lg font-medium transition-all shadow-lg shadow-forge-600/20"
        >
          {saving ? '保存中...' : saved ? '✅ 已保存' : '💾 保存设置'}
        </button>
      </div>
    </div>
  );
}
