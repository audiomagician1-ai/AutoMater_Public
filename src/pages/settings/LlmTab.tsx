/**
 * LLM Settings Tab — Provider选择、API Key、模型配置、定价、限制
 * v16.0: 回退为平铺布局, 定价内联到每个模型后面 (USD/MTokens)
 */
import { useState, useEffect } from 'react';
import { toast } from '../../stores/toast-store';

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

  // 定价状态: model → { input: string, output: string } (USD/MTokens)
  const [modelPricing, setModelPricing] = useState<Record<string, { input: string; output: string }>>({});
  const [builtinPricing, setBuiltinPricing] = useState<Record<string, { input: number; output: number }>>({});

  // 加载已保存的定价
  useEffect(() => {
    window.automater.settings.get().then(s => {
      if (s.modelPricing) {
        const mp: Record<string, { input: string; output: string }> = {};
        for (const [k, v] of Object.entries(s.modelPricing)) {
          mp[k] = { input: String((v as { input: number }).input), output: String((v as { output: number }).output) };
        }
        setModelPricing(mp);
      }
    });
    window.automater.monitor.getBuiltinPricing().then(setBuiltinPricing).catch(() => {});
  }, []);

  const PROVIDER_PRESETS: Record<string, { baseUrl: string; strong: string; worker: string; fast: string }> = {
    openai:    { baseUrl: 'https://api.openai.com',    strong: 'gpt-4o',                      worker: 'gpt-4o-mini',                fast: 'gpt-4o-mini' },
    anthropic: { baseUrl: 'https://api.anthropic.com', strong: 'claude-sonnet-4-20250514', worker: 'claude-3-5-haiku-20241022', fast: 'claude-3-5-haiku-20241022' },
    custom:    { baseUrl: 'http://localhost:11434',     strong: '',                             worker: '',                            fast: '' },
  };

  const handleProviderChange = (provider: 'openai' | 'anthropic' | 'custom') => {
    const p = PROVIDER_PRESETS[provider];
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
    try {
      const result = await window.automater.llm.testConnection({
        type: settings.llmProvider,
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
      });
      setTestResult(result);
    } catch { /* silent: LLM测试请求失败 */
      setTestResult({ success: false, message: '连接测试失败' });
    }
    setTesting(false);
  };

  const handleSave = async () => {
    if (!settings.apiKey?.trim()) {
      toast.warning('请先填写 API Key');
      return;
    }
    setSaving(true);
    setSaved(false);
    // 保存定价数据到 settings
    const numericPricing: Record<string, { input: number; output: number }> = {};
    for (const [model, p] of Object.entries(modelPricing)) {
      const inp = parseFloat(p.input);
      const outp = parseFloat(p.output);
      if (!isNaN(inp) || !isNaN(outp)) {
        numericPricing[model] = { input: isNaN(inp) ? 0 : inp, output: isNaN(outp) ? 0 : outp };
      }
    }
    await window.automater.settings.save({ ...settings, modelPricing: numericPricing });
    setSettingsConfigured(!!settings.apiKey);
    setSaving(false);
    setSaved(true);
    toast.success('LLM 设置已保存');
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

  // 获取模型名对应的定价 (用户填的 > 内置 > 空)
  const getPricing = (modelName: string) => {
    if (modelPricing[modelName]) return modelPricing[modelName];
    const b = builtinPricing[modelName];
    if (b) return { input: String(b.input), output: String(b.output) };
    return { input: '', output: '' };
  };

  const setPricingForModel = (modelName: string, field: 'input' | 'output', value: string) => {
    if (!modelName) return;
    setModelPricing(prev => ({
      ...prev,
      [modelName]: { ...(prev[modelName] || { input: '', output: '' }), [field]: value },
    }));
  };

  const modelFields = [
    { key: 'strongModel' as const, label: '🧠 思考模型', desc: '负责需求分析、架构设计、代码审查等复杂任务', ph: 'gpt-4o, claude-sonnet-4-20250514' },
    { key: 'workerModel' as const, label: '⚡ 执行模型', desc: '负责编码实现、计划制定等日常任务', ph: 'gpt-4o-mini, claude-3-5-haiku-20241022' },
    { key: 'fastModel' as const, label: '💨 速答模型', desc: '负责摘要、格式化等轻量任务（留空 = 同执行模型）', ph: '可留空' },
  ];

  return (
    <div className="space-y-6">
      {/* Provider */}
      <section className="space-y-3">
        <label className="text-sm font-medium text-slate-300">AI 服务商</label>
        <div className="flex gap-2">
          {(['openai', 'anthropic', 'custom'] as const).map(p => (
            <button key={p} onClick={() => handleProviderChange(p)}
              className={`px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                settings.llmProvider === p ? 'bg-forge-600 text-white shadow-lg shadow-forge-600/20' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}>
              {p === 'openai' ? '🟢 OpenAI' : p === 'anthropic' ? '🟣 Anthropic' : '⚙️ 自定义'}
            </button>
          ))}
        </div>
      </section>

      {/* API Key */}
      <section className="space-y-2">
        <label className="text-sm font-medium text-slate-300">API Key</label>
        <div className="relative">
          <input type="password" value={settings.apiKey}
            onChange={e => { setSettings(prev => ({ ...prev, apiKey: e.target.value })); setTestResult(null); }}
            placeholder={settings.llmProvider === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 pr-20" />
          {testResult && (
            <span className={`absolute right-3 top-1/2 -translate-y-1/2 text-xs ${testResult.success ? 'text-emerald-400' : 'text-red-400'}`}>
              {testResult.success ? '✅ 已验证' : '❌ 无效'}
            </span>
          )}
        </div>
      </section>

      {/* Base URL */}
      <section className="space-y-2">
        <label className="text-sm font-medium text-slate-300">API 地址</label>
        <input type="text" value={settings.baseUrl}
          onChange={e => setSettings(prev => ({ ...prev, baseUrl: e.target.value }))}
          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500" />
        <p className="text-[10px] text-slate-600">支持代理地址，如 https://your-proxy.com/v1</p>
      </section>

      {/* Test Connection */}
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

      {/* Models + 内联定价 */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-slate-200 border-b border-slate-800 pb-2">模型配置</h3>
        <div className="space-y-4">
          {modelFields.map(m => {
            const modelName = settings[m.key] ?? '';
            const pricing = getPricing(modelName);
            const builtin = modelName ? builtinPricing[modelName] : null;
            return (
              <div key={m.key} className="space-y-2">
                <label className="text-xs font-medium text-slate-400">
                  {m.label} <span className="text-slate-600">— {m.desc}</span>
                </label>
                <input type="text" value={modelName}
                  onChange={e => setSettings(prev => ({ ...prev, [m.key]: e.target.value }))}
                  placeholder={m.ph}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 font-mono" />
                {/* 内联定价 */}
                {modelName && (
                  <div className="flex items-center gap-3 pl-1">
                    <span className="text-[10px] text-slate-500 shrink-0">💰 定价</span>
                    <div className="flex items-center gap-1.5">
                      <input type="text" value={pricing.input}
                        onChange={e => setPricingForModel(modelName, 'input', e.target.value)}
                        placeholder="0"
                        className="w-20 bg-slate-900/60 border border-slate-700/50 rounded px-2 py-1 text-xs text-slate-100 font-mono focus:outline-none focus:border-forge-500 text-center" />
                      <span className="text-[10px] text-slate-600">/</span>
                      <input type="text" value={pricing.output}
                        onChange={e => setPricingForModel(modelName, 'output', e.target.value)}
                        placeholder="0"
                        className="w-20 bg-slate-900/60 border border-slate-700/50 rounded px-2 py-1 text-xs text-slate-100 font-mono focus:outline-none focus:border-forge-500 text-center" />
                      <span className="text-[10px] text-slate-600">USD/MTokens (输入/输出)</span>
                    </div>
                    {builtin && (
                      <span className="text-[9px] text-slate-600 ml-1">内置: ${builtin.input}/${builtin.output}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-[10px] text-slate-600">定价留空 = 预估费用按 $0 计算</p>
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
      <button onClick={handleSave} disabled={saving}
        className="w-full py-3 bg-forge-600 hover:bg-forge-500 disabled:opacity-50 rounded-lg font-medium transition-all shadow-lg shadow-forge-600/20">
        {saving ? '保存中...' : saved ? '✅ 已保存' : '💾 保存设置'}
      </button>
    </div>
  );
}
