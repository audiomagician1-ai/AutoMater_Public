/**
 * Pricing Tab — 模型定价管理
 */
import { useState, useEffect } from 'react';

interface PricingTabProps {
  settings: AppSettings;
}

export function PricingTab({ settings }: PricingTabProps) {
  const [modelPricing, setModelPricing] = useState<Record<string, { input: string; output: string }>>({});
  const [builtinPricing, setBuiltinPricing] = useState<Record<string, { input: number; output: number }>>({});
  const [newPricingModel, setNewPricingModel] = useState('');
  const [pricingSaved, setPricingSaved] = useState(false);

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
    window.automater.monitor.getBuiltinPricing().then(setBuiltinPricing);
  }, []);

  const addModel = (name: string) => {
    if (!name) return;
    const builtin = builtinPricing[name];
    setModelPricing(prev => ({
      ...prev,
      [name]: { input: String(builtin?.input ?? ''), output: String(builtin?.output ?? '') },
    }));
  };

  const handleSavePricing = async () => {
    setPricingSaved(false);
    const numericPricing: Record<string, { input: number; output: number }> = {};
    for (const [model, p] of Object.entries(modelPricing)) {
      const inp = parseFloat(p.input);
      const outp = parseFloat(p.output);
      if (!isNaN(inp) && !isNaN(outp) && (inp > 0 || outp > 0)) {
        numericPricing[model] = { input: inp, output: outp };
      }
    }
    const current = await window.automater.settings.get();
    await window.automater.settings.save({ ...current, modelPricing: numericPricing });
    setPricingSaved(true);
    setTimeout(() => setPricingSaved(false), 3000);
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">模型定价</h3>
        <p className="text-xs text-slate-500 mt-1">
          为每个模型设置 <span className="text-forge-400">输入 / 输出</span> 价格 (USD / 1K tokens)。
          <br />未设置的模型将使用内置价格表或默认 $0.002/$0.008。
        </p>
      </div>

      {Object.keys(modelPricing).length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">已配置模型</h4>
          <div className="space-y-2">
            {Object.entries(modelPricing).map(([model, pricing]) => {
              const builtin = builtinPricing[model];
              return (
                <div key={model} className="flex items-center gap-3 p-3 bg-slate-800/50 rounded-lg border border-slate-700/50">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-mono text-forge-400 truncate">{model}</div>
                    {builtin && <div className="text-[9px] text-slate-600 mt-0.5">内置: ${builtin.input} / ${builtin.output}</div>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="space-y-0.5">
                      <label className="text-[9px] text-slate-600 block">输入 $/1K</label>
                      <input type="text" value={pricing.input}
                        onChange={e => setModelPricing(prev => ({ ...prev, [model]: { ...prev[model], input: e.target.value } }))}
                        className="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 font-mono focus:outline-none focus:border-forge-500" placeholder="0.002" />
                    </div>
                    <div className="space-y-0.5">
                      <label className="text-[9px] text-slate-600 block">输出 $/1K</label>
                      <input type="text" value={pricing.output}
                        onChange={e => setModelPricing(prev => ({ ...prev, [model]: { ...prev[model], output: e.target.value } }))}
                        className="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 font-mono focus:outline-none focus:border-forge-500" placeholder="0.008" />
                    </div>
                    <button onClick={() => { const next = { ...modelPricing }; delete next[model]; setModelPricing(next); }}
                      className="px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded ml-1" title="删除">✕</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">添加模型</h4>
        <div className="flex gap-2">
          <input type="text" value={newPricingModel} onChange={e => setNewPricingModel(e.target.value)}
            placeholder="模型名称, 如 gpt-4o-mini"
            className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 font-mono placeholder-slate-600 focus:outline-none focus:border-forge-500"
            onKeyDown={e => { if (e.key === 'Enter' && newPricingModel.trim()) { addModel(newPricingModel.trim()); setNewPricingModel(''); } }} />
          <button onClick={() => { addModel(newPricingModel.trim()); setNewPricingModel(''); }}
            className="px-4 py-2.5 bg-forge-600 hover:bg-forge-500 rounded-lg text-sm font-medium transition-all">+ 添加</button>
        </div>
        {settings.strongModel && !modelPricing[settings.strongModel] && (
          <button onClick={() => addModel(settings.strongModel)} className="text-xs text-forge-400 hover:text-forge-300 transition-colors">
            + 快捷添加 <span className="font-mono">{settings.strongModel}</span> (强模型)
          </button>
        )}
        {settings.workerModel && settings.workerModel !== settings.strongModel && !modelPricing[settings.workerModel] && (
          <button onClick={() => addModel(settings.workerModel)} className="text-xs text-forge-400 hover:text-forge-300 transition-colors ml-3">
            + 快捷添加 <span className="font-mono">{settings.workerModel}</span> (工作模型)
          </button>
        )}
      </div>

      <details className="group">
        <summary className="text-xs font-medium text-slate-400 cursor-pointer hover:text-slate-200">
          📋 内置价格表参考 ({Object.keys(builtinPricing).length} 个模型)
        </summary>
        <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
          {Object.entries(builtinPricing).map(([model, p]) => (
            <div key={model} className="flex items-center gap-3 px-3 py-1.5 text-xs hover:bg-slate-800/50 rounded">
              <span className="font-mono text-slate-300 flex-1 truncate">{model}</span>
              <span className="text-slate-500">${p.input} / ${p.output}</span>
              {!modelPricing[model] && (
                <button onClick={() => setModelPricing(prev => ({ ...prev, [model]: { input: String(p.input), output: String(p.output) } }))}
                  className="text-forge-500 hover:text-forge-400 text-[10px]">+</button>
              )}
            </div>
          ))}
        </div>
      </details>

      <button onClick={handleSavePricing}
        className="w-full py-3 bg-forge-600 hover:bg-forge-500 rounded-lg font-medium transition-all shadow-lg shadow-forge-600/20">
        {pricingSaved ? '✅ 定价已保存' : '💾 保存定价设置'}
      </button>
    </div>
  );
}
