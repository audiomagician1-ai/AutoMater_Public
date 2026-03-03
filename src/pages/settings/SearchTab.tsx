/**
 * Search Engine Settings Tab — 搜索引擎 API Key 配置
 * v24.0: Brave / Serper / Tavily / Jina / SearXNG
 */
import { toast } from '../../stores/toast-store';

interface SearchTabProps {
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
}

const SEARCH_ENGINES = [
  {
    key: 'braveSearchApiKey' as const,
    label: 'Brave Search',
    desc: '免费 2000 次/月，质量高',
    link: 'https://brave.com/search/api/',
    placeholder: 'BSA-xxxxxxxx',
  },
  {
    key: 'serperApiKey' as const,
    label: 'Serper.dev (Google)',
    desc: '免费 2500 次/月，Google 搜索代理',
    link: 'https://serper.dev/',
    placeholder: 'xxxxxxxxxxxxxxxx',
  },
  {
    key: 'tavilyApiKey' as const,
    label: 'Tavily',
    desc: 'AI 优化搜索 + 自动摘要',
    link: 'https://tavily.com/',
    placeholder: 'tvly-xxxxxxxx',
  },
  {
    key: 'jinaApiKey' as const,
    label: 'Jina AI',
    desc: '搜索 + URL 内容抓取 (2025 起需 token)',
    link: 'https://jina.ai/',
    placeholder: 'jina_xxxxxxxx',
  },
] as const;

export function SearchTab({ settings, setSettings }: SearchTabProps) {
  const handleSave = async () => {
    try {
      await window.automater.settings.save(settings);
      toast.success('搜索引擎配置已保存');
    } catch {
      toast.error('保存失败');
    }
  };

  const configuredCount =
    SEARCH_ENGINES.filter(e => !!(settings as unknown as Record<string, unknown>)[e.key]).length +
    (settings.searxngUrl ? 1 : 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">搜索引擎配置</h3>
          <p className="text-sm text-slate-400 mt-1">
            配置 API Key 以获得更好的搜索质量。未配置任何引擎时，自动使用 DuckDuckGo 免费兜底。
          </p>
        </div>
        <span
          className={`px-2.5 py-1 rounded-full text-xs font-medium ${
            configuredCount > 0 ? 'bg-emerald-900/60 text-emerald-300' : 'bg-amber-900/60 text-amber-300'
          }`}
        >
          {configuredCount > 0 ? `${configuredCount} 个引擎已配置` : '使用免费兜底'}
        </span>
      </div>

      {/* API Key 引擎列表 */}
      <div className="space-y-4">
        {SEARCH_ENGINES.map(engine => (
          <div key={engine.key} className="bg-slate-900/60 border border-slate-800 rounded-lg p-4">
            <div className="flex items-start justify-between mb-2">
              <div>
                <span className="font-medium text-slate-200">{engine.label}</span>
                <span className="text-xs text-slate-500 ml-2">{engine.desc}</span>
              </div>
              <a
                href={engine.link}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-forge-400 hover:text-forge-300 underline"
              >
                获取 Key →
              </a>
            </div>
            <input
              type="password"
              value={((settings as unknown as Record<string, unknown>)[engine.key] as string) || ''}
              onChange={e => setSettings(prev => ({ ...prev, [engine.key]: e.target.value || undefined }))}
              placeholder={engine.placeholder}
              className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 placeholder-slate-600 font-mono focus:border-forge-500 focus:outline-none"
            />
          </div>
        ))}

        {/* SearXNG 自建实例 */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4">
          <div className="flex items-start justify-between mb-2">
            <div>
              <span className="font-medium text-slate-200">SearXNG (自建)</span>
              <span className="text-xs text-slate-500 ml-2">完全离线, LAN 友好, 无需 API Key</span>
            </div>
            <a
              href="https://docs.searxng.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-forge-400 hover:text-forge-300 underline"
            >
              部署文档 →
            </a>
          </div>
          <input
            type="text"
            value={settings.searxngUrl || ''}
            onChange={e => setSettings(prev => ({ ...prev, searxngUrl: e.target.value || undefined }))}
            placeholder="http://localhost:8888"
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 placeholder-slate-600 font-mono focus:border-forge-500 focus:outline-none"
          />
        </div>
      </div>

      {/* DuckDuckGo 兜底说明 */}
      <div className="bg-slate-800/40 border border-slate-700/60 rounded-lg p-3 text-xs text-slate-400">
        <span className="text-slate-300 font-medium">🦆 DuckDuckGo 免费兜底</span>
        <span className="ml-2">
          始终可用，零 API Key。当所有已配置引擎均失败时自动启用。建议至少配置一个付费引擎以获得最佳体验。
        </span>
      </div>

      {/* 优先级说明 */}
      <div className="text-xs text-slate-500">
        <span className="font-medium text-slate-400">Fallback 顺序：</span>
        Brave → SearXNG → Tavily → Serper → Jina → DuckDuckGo（仅尝试已配置的引擎）
      </div>

      <button
        onClick={handleSave}
        className="w-full py-2.5 rounded-lg bg-forge-600 hover:bg-forge-500 text-white font-medium transition-colors"
      >
        保存搜索配置
      </button>
    </div>
  );
}
