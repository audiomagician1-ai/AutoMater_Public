/**
 * SettingsPage — 设置页面 (thin shell)
 *
 * 拆分自原 955 行单文件 → 6 个子组件:
 *   LlmTab, McpTab, SkillTab, PricingTab, DisplayTab, McpServerForm
 *
 * v12.3: 代码质量审计产物
 */

import { useState, useEffect } from 'react';
import { useAppStore } from '../stores/app-store';
import { LlmTab } from './settings/LlmTab';
import { McpTab } from './settings/McpTab';
import { SkillTab } from './settings/SkillTab';
import { PricingTab } from './settings/PricingTab';
import { DisplayTab } from './settings/DisplayTab';

type TabId = 'llm' | 'mcp' | 'skill' | 'pricing' | 'display';

const TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'llm',     label: 'LLM',       icon: '🧠' },
  { id: 'mcp',     label: 'MCP',       icon: '🔌' },
  { id: 'skill',   label: '技能',      icon: '🧩' },
  { id: 'pricing', label: '定价',      icon: '💰' },
  { id: 'display', label: '显示',      icon: '🖥️' },
];

export function SettingsPage() {
  const setSettingsConfigured = useAppStore(s => s.setSettingsConfigured);
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
  const [activeTab, setActiveTab] = useState<TabId>('llm');

  useEffect(() => {
    window.automater.settings.get().then((s: AppSettings) => {
      setSettings({
        ...s,
        fastModel: s.fastModel ?? '',
        workerCount: s.workerCount ?? 0,
        dailyBudgetUsd: s.dailyBudgetUsd ?? 0,
      });
    });
  }, []);

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <h2 className="text-2xl font-bold">设置</h2>

        {/* Tab Bar */}
        <div className="flex gap-1 bg-slate-900 rounded-lg p-1 border border-slate-800">
          {TABS.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`flex-1 py-2 rounded-md text-sm font-medium transition-all ${
                activeTab === tab.id
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-300'
              }`}>
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'llm' && (
          <LlmTab settings={settings} setSettings={setSettings} setSettingsConfigured={setSettingsConfigured} />
        )}
        {activeTab === 'mcp' && <McpTab />}
        {activeTab === 'skill' && <SkillTab />}
        {activeTab === 'pricing' && <PricingTab settings={settings} />}
        {activeTab === 'display' && <DisplayTab />}
      </div>
    </div>
  );
}

