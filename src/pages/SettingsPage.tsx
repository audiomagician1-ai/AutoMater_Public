import { useState, useEffect } from 'react';
import { useAppStore } from '../stores/app-store';

const PROVIDER_PRESETS: Record<string, { baseUrl: string; models: string[] }> = {
  openai: {
    baseUrl: 'https://api.openai.com',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'],
  },
  custom: {
    baseUrl: 'http://localhost:11434',
    models: [],
  },
};

export function SettingsPage() {
  const { setSettingsConfigured } = useAppStore();
  const [settings, setSettings] = useState<AppSettings>({
    llmProvider: 'openai',
    apiKey: '',
    baseUrl: 'https://api.openai.com',
    strongModel: 'gpt-4o',
    workerModel: 'gpt-4o-mini',
    workerCount: 3,
    dailyBudgetUsd: 50,
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [models, setModels] = useState<string[]>([]);

  // 加载已保存的设置
  useEffect(() => {
    window.agentforge.settings.get().then((s: AppSettings) => {
      setSettings(s);
      if (s.llmProvider && PROVIDER_PRESETS[s.llmProvider]) {
        setModels(PROVIDER_PRESETS[s.llmProvider].models);
      }
    });
  }, []);

  const handleProviderChange = (provider: 'openai' | 'anthropic' | 'custom') => {
    const preset = PROVIDER_PRESETS[provider];
    setSettings(prev => ({
      ...prev,
      llmProvider: provider,
      baseUrl: preset.baseUrl,
      strongModel: preset.models[0] || '',
      workerModel: preset.models[1] || preset.models[0] || '',
    }));
    setModels(preset.models);
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

    // 如果连通，尝试拉模型列表
    if (result.success && settings.llmProvider !== 'anthropic') {
      const modelsResult = await window.agentforge.llm.listModels({
        type: settings.llmProvider,
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
      });
      if (modelsResult.success && modelsResult.models.length > 0) {
        setModels(modelsResult.models);
      }
    }
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

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="max-w-xl mx-auto space-y-8">
        <h2 className="text-2xl font-bold">设置</h2>

        {/* Provider */}
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

        {/* API Key */}
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

        {/* Base URL */}
        <section className="space-y-2">
          <label className="text-sm font-medium text-slate-300">API Base URL</label>
          <input
            type="text"
            value={settings.baseUrl}
            onChange={e => setSettings(prev => ({ ...prev, baseUrl: e.target.value }))}
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500"
          />
        </section>

        {/* Test Connection */}
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

        {/* Models */}
        <div className="grid grid-cols-2 gap-4">
          <section className="space-y-2">
            <label className="text-sm font-medium text-slate-300">强模型 (PM/架构师)</label>
            <select
              value={settings.strongModel}
              onChange={e => setSettings(prev => ({ ...prev, strongModel: e.target.value }))}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-100 focus:outline-none focus:border-forge-500"
            >
              {models.map(m => <option key={m} value={m}>{m}</option>)}
              {!models.includes(settings.strongModel) && settings.strongModel && (
                <option value={settings.strongModel}>{settings.strongModel}</option>
              )}
            </select>
          </section>

          <section className="space-y-2">
            <label className="text-sm font-medium text-slate-300">工作模型 (开发/QA)</label>
            <select
              value={settings.workerModel}
              onChange={e => setSettings(prev => ({ ...prev, workerModel: e.target.value }))}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-100 focus:outline-none focus:border-forge-500"
            >
              {models.map(m => <option key={m} value={m}>{m}</option>)}
              {!models.includes(settings.workerModel) && settings.workerModel && (
                <option value={settings.workerModel}>{settings.workerModel}</option>
              )}
            </select>
          </section>
        </div>

        {/* Worker Count */}
        <section className="space-y-2">
          <label className="text-sm font-medium text-slate-300">
            并行 Worker 数量: <span className="text-forge-400">{settings.workerCount}</span>
          </label>
          <input
            type="range"
            min={1}
            max={8}
            value={settings.workerCount}
            onChange={e => setSettings(prev => ({ ...prev, workerCount: parseInt(e.target.value) }))}
            className="w-full accent-forge-500"
          />
          <div className="flex justify-between text-xs text-slate-600">
            <span>1 (省钱)</span>
            <span>8 (快速)</span>
          </div>
        </section>

        {/* Save */}
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
