/**
 * Search Provider System — 可插拔多引擎搜索 + 自动 Fallback
 *
 * 支持的搜索引擎:
 *   1. Brave Search API  — 免费 2000 次/月, 质量高, 结构化结果
 *   2. SearXNG           — 自建, 完全离线, LAN 友好
 *   3. Tavily            — 专门为 AI 优化的搜索 API
 *   4. Serper.dev        — Google 搜索 API 代理, 2500 次/月免费
 *   5. Jina AI           — 零 API Key, 免费 fallback
 *
 * 设计原则:
 *   - 自动 fallback chain: Brave → SearXNG → Serper → Jina
 *   - 每个 Provider 独立配置 API key
 *   - 统一 SearchResult 输出格式
 *   - 并行搜索多引擎 + 结果去重合并 (boost 模式)
 *   - 速率限制友好: 自动退避
 *
 * 零 npm 依赖 — 全部使用 Node.js 原生 fetch。
 *
 * @module search-provider
 * @since v8.0.0
 */

import { createLogger } from './logger';

const log = createLogger('search-provider');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 发布日期 (如果可获取) */
  date?: string;
  /** 结果来源引擎 */
  source?: string;
}

export interface SearchResponse {
  success: boolean;
  results: SearchResult[];
  /** 原始文本内容 (Markdown 格式, 供 LLM 直接消费) */
  content: string;
  /** 使用了哪个引擎 */
  provider: string;
  /** 搜索耗时 ms */
  durationMs: number;
  error?: string;
}

export interface SearchProviderConfig {
  /** Brave Search API Key (免费: https://brave.com/search/api/) */
  braveApiKey?: string;
  /** SearXNG 实例 URL (如 http://localhost:8888) */
  searxngUrl?: string;
  /** Tavily API Key */
  tavilyApiKey?: string;
  /** Serper.dev API Key (免费: https://serper.dev/) */
  serperApiKey?: string;
  /** 自定义 fallback 顺序 */
  fallbackOrder?: ProviderName[];
  /** 超时 ms (每个引擎) */
  timeout?: number;
}

export type ProviderName = 'brave' | 'searxng' | 'tavily' | 'serper' | 'jina';

// ═══════════════════════════════════════
// Provider Interface
// ═══════════════════════════════════════

interface ISearchProvider {
  name: ProviderName;
  isConfigured(config: SearchProviderConfig): boolean;
  search(query: string, maxResults: number, config: SearchProviderConfig): Promise<SearchResponse>;
}

// ═══════════════════════════════════════
// Provider Implementations
// ═══════════════════════════════════════

// ─── Brave Search ───

const braveProvider: ISearchProvider = {
  name: 'brave',
  isConfigured: (cfg) => !!cfg.braveApiKey,
  async search(query, maxResults, cfg) {
    const start = Date.now();
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': cfg.braveApiKey!,
      },
      signal: AbortSignal.timeout(cfg.timeout || 15000),
    });

    if (!res.ok) {
      return { success: false, results: [], content: '', provider: 'brave', durationMs: Date.now() - start, error: `Brave HTTP ${res.status}` };
    }

    const data = await res.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string; page_age?: string }> } };
    const results: SearchResult[] = (data.web?.results || []).slice(0, maxResults).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.description || '',
      date: r.age || r.page_age || undefined,
      source: 'brave',
    }));

    const content = formatResultsToMarkdown(results, query, 'Brave Search');
    return { success: true, results, content, provider: 'brave', durationMs: Date.now() - start };
  },
};

// ─── SearXNG (Self-hosted) ───

const searxngProvider: ISearchProvider = {
  name: 'searxng',
  isConfigured: (cfg) => !!cfg.searxngUrl,
  async search(query, maxResults, cfg) {
    const start = Date.now();
    const baseUrl = cfg.searxngUrl!.replace(/\/$/, '');
    const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&engines=google,duckduckgo,bing&safesearch=0&pageno=1`;

    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(cfg.timeout || 20000),
    });

    if (!res.ok) {
      return { success: false, results: [], content: '', provider: 'searxng', durationMs: Date.now() - start, error: `SearXNG HTTP ${res.status}` };
    }

    const data = await res.json() as { results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string; engine?: string }> };
    const results: SearchResult[] = (data.results || []).slice(0, maxResults).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.content || '',
      date: r.publishedDate || undefined,
      source: `searxng:${r.engine || 'unknown'}`,
    }));

    const content = formatResultsToMarkdown(results, query, 'SearXNG');
    return { success: true, results, content, provider: 'searxng', durationMs: Date.now() - start };
  },
};

// ─── Tavily (AI-optimized search) ───

const tavilyProvider: ISearchProvider = {
  name: 'tavily',
  isConfigured: (cfg) => !!cfg.tavilyApiKey,
  async search(query, maxResults, cfg) {
    const start = Date.now();
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: cfg.tavilyApiKey!,
        query,
        max_results: maxResults,
        include_answer: true,
        include_raw_content: false,
        search_depth: 'advanced',
      }),
      signal: AbortSignal.timeout(cfg.timeout || 20000),
    });

    if (!res.ok) {
      return { success: false, results: [], content: '', provider: 'tavily', durationMs: Date.now() - start, error: `Tavily HTTP ${res.status}` };
    }

    const data = await res.json() as { results?: Array<{ title?: string; url?: string; content?: string }>; answer?: string };
    const results: SearchResult[] = (data.results || []).slice(0, maxResults).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.content || '',
      source: 'tavily',
    }));

    // Tavily 有 AI 摘要
    let content = '';
    if (data.answer) {
      content = `## AI 摘要\n${data.answer}\n\n`;
    }
    content += formatResultsToMarkdown(results, query, 'Tavily');
    return { success: true, results, content, provider: 'tavily', durationMs: Date.now() - start };
  },
};

// ─── Serper.dev (Google API proxy) ───

const serperProvider: ISearchProvider = {
  name: 'serper',
  isConfigured: (cfg) => !!cfg.serperApiKey,
  async search(query, maxResults, cfg) {
    const start = Date.now();
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': cfg.serperApiKey!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: maxResults }),
      signal: AbortSignal.timeout(cfg.timeout || 15000),
    });

    if (!res.ok) {
      return { success: false, results: [], content: '', provider: 'serper', durationMs: Date.now() - start, error: `Serper HTTP ${res.status}` };
    }

    const data = await res.json() as any;
    const results: SearchResult[] = [];

    // Knowledge Graph
    if (data.knowledgeGraph) {
      const kg = data.knowledgeGraph;
      results.push({
        title: `[Knowledge Graph] ${kg.title || ''}`,
        url: kg.website || '',
        snippet: kg.description || '',
        source: 'serper:kg',
      });
    }

    // Organic results
    for (const r of (data.organic || []).slice(0, maxResults)) {
      results.push({
        title: r.title || '',
        url: r.link || '',
        snippet: r.snippet || '',
        date: r.date || undefined,
        source: 'serper:organic',
      });
    }

    const content = formatResultsToMarkdown(results, query, 'Serper (Google)');
    return { success: true, results, content, provider: 'serper', durationMs: Date.now() - start };
  },
};

// ─── Jina AI (Free, zero API key) ───

const jinaProvider: ISearchProvider = {
  name: 'jina',
  isConfigured: () => true, // 始终可用
  async search(query, maxResults, cfg) {
    const start = Date.now();
    const url = `https://s.jina.ai/${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'text/plain',
        'User-Agent': 'agentforge/8.0',
        'X-Retain-Images': 'none',
      },
      signal: AbortSignal.timeout(cfg.timeout || 20000),
    });

    if (!res.ok) {
      return { success: false, results: [], content: '', provider: 'jina', durationMs: Date.now() - start, error: `Jina HTTP ${res.status}` };
    }

    const text = await res.text();
    const results = parseJinaResults(text, maxResults);
    const content = text.length > 12000 ? text.slice(0, 12000) + '\n\n... [截断]' : text;

    return { success: true, results, content, provider: 'jina', durationMs: Date.now() - start };
  },
};

function parseJinaResults(text: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = text.split(/\n---\n|\n\n(?=Title:)/);
  for (const block of blocks) {
    if (results.length >= max) break;
    const titleMatch = block.match(/Title:\s*(.+)/);
    const urlMatch = block.match(/URL Source:\s*(.+)/);
    const contentLines = block.split('\n').filter(
      l => !l.startsWith('Title:') && !l.startsWith('URL Source:') && l.trim()
    );
    if (titleMatch && urlMatch) {
      results.push({
        title: titleMatch[1].trim(),
        url: urlMatch[1].trim(),
        snippet: contentLines.slice(0, 3).join(' ').slice(0, 300),
        source: 'jina',
      });
    }
  }
  return results;
}

// ═══════════════════════════════════════
// Provider Registry
// ═══════════════════════════════════════

const ALL_PROVIDERS: ISearchProvider[] = [
  braveProvider,
  searxngProvider,
  tavilyProvider,
  serperProvider,
  jinaProvider,
];

const DEFAULT_FALLBACK_ORDER: ProviderName[] = ['brave', 'searxng', 'tavily', 'serper', 'jina'];

// ═══════════════════════════════════════
// Search Manager (singleton)
// ═══════════════════════════════════════

let _config: SearchProviderConfig = {};

/** 更新搜索引擎配置 */
export function configureSearch(config: SearchProviderConfig): void {
  _config = { ..._config, ...config };
  const available = ALL_PROVIDERS.filter(p => p.isConfigured(_config)).map(p => p.name);
  log.info(`Search providers configured. Available: [${available.join(', ')}]`);
}

/** 获取当前配置的可用引擎列表 */
export function getAvailableProviders(): ProviderName[] {
  return ALL_PROVIDERS.filter(p => p.isConfigured(_config)).map(p => p.name);
}

/**
 * 搜索 — Fallback Chain
 *
 * 按优先级依次尝试配置的引擎。第一个成功的返回结果。
 * Jina 作为最后 fallback 始终可用。
 */
export async function search(
  query: string,
  maxResults: number = 10,
  preferProvider?: ProviderName,
): Promise<SearchResponse> {
  const order = _config.fallbackOrder || DEFAULT_FALLBACK_ORDER;

  // 如果指定了优先引擎，放到最前
  const sorted = preferProvider
    ? [preferProvider, ...order.filter(n => n !== preferProvider)]
    : order;

  const configuredOrder = sorted.filter(name => {
    const p = ALL_PROVIDERS.find(pp => pp.name === name);
    return p && p.isConfigured(_config);
  });

  // 确保 Jina 兜底
  if (!configuredOrder.includes('jina')) configuredOrder.push('jina');

  const errors: string[] = [];

  for (const providerName of configuredOrder) {
    const provider = ALL_PROVIDERS.find(p => p.name === providerName);
    if (!provider) continue;

    try {
      log.info(`Searching with ${providerName}: "${query.slice(0, 60)}"`);
      const result = await provider.search(query, maxResults, _config);
      if (result.success && result.results.length > 0) {
        log.info(`Search success via ${providerName}: ${result.results.length} results in ${result.durationMs}ms`);
        return result;
      }
      errors.push(`${providerName}: ${result.error || 'no results'}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${providerName}: ${msg}`);
      log.warn(`Search provider ${providerName} failed: ${msg}`);
    }
  }

  return {
    success: false,
    results: [],
    content: '',
    provider: 'none',
    durationMs: 0,
    error: `所有搜索引擎均失败:\n${errors.join('\n')}`,
  };
}

/**
 * 并行搜索多个引擎 + 去重合并 (Boost 模式)
 *
 * 用于重要查询: 同时请求多个引擎，合并去重，按出现频次排序。
 * 出现在多个引擎结果中的 URL 权重更高。
 */
export async function searchBoost(
  query: string,
  maxResults: number = 15,
): Promise<SearchResponse> {
  const start = Date.now();

  const configured = ALL_PROVIDERS.filter(p => p.isConfigured(_config));
  if (configured.length === 0) {
    return search(query, maxResults); // fallback to normal
  }

  // 并行搜索所有引擎 (最多 4 个)
  const selected = configured.slice(0, 4);
  const promises = selected.map(p =>
    p.search(query, maxResults, _config).catch((err: unknown): SearchResponse => ({
      success: false, results: [], content: '', provider: p.name,
      durationMs: 0, error: err instanceof Error ? err.message : String(err),
    }))
  );

  const responses = await Promise.allSettled(promises);

  // 收集所有结果
  const urlScores = new Map<string, { result: SearchResult; score: number; engines: string[] }>();
  const providers: string[] = [];

  for (const settled of responses) {
    if (settled.status !== 'fulfilled') continue;
    const resp = settled.value;
    if (!resp.success) continue;
    providers.push(resp.provider);

    for (let i = 0; i < resp.results.length; i++) {
      const r = resp.results[i];
      const existing = urlScores.get(r.url);
      const positionScore = maxResults - i; // 排名靠前分数更高
      if (existing) {
        existing.score += positionScore;
        existing.engines.push(resp.provider);
        // 用更长的 snippet
        if (r.snippet.length > existing.result.snippet.length) {
          existing.result.snippet = r.snippet;
        }
      } else {
        urlScores.set(r.url, {
          result: { ...r, source: resp.provider },
          score: positionScore,
          engines: [resp.provider],
        });
      }
    }
  }

  // 按分数排序, 多引擎出现的优先
  const merged = [...urlScores.values()]
    .sort((a, b) => {
      // 多引擎出现 > 少引擎, 同引擎数量时按分数
      if (a.engines.length !== b.engines.length) return b.engines.length - a.engines.length;
      return b.score - a.score;
    })
    .slice(0, maxResults)
    .map(entry => ({
      ...entry.result,
      source: entry.engines.length > 1
        ? `[${entry.engines.join('+')}]`
        : entry.result.source,
    }));

  const content = formatResultsToMarkdown(merged, query, `Boost (${providers.join(', ')})`);

  return {
    success: merged.length > 0,
    results: merged,
    content,
    provider: `boost:${providers.join('+')}`,
    durationMs: Date.now() - start,
  };
}

// ═══════════════════════════════════════
// URL Reader — 增强版 (支持多策略)
// ═══════════════════════════════════════

export interface ReadUrlResponse {
  success: boolean;
  content: string;
  title: string;
  length: number;
  error?: string;
}

/**
 * 抓取 URL 内容 (增强版)
 *
 * 策略: Jina Reader → 原生 fetch + 简易 HTML 清洗
 * 自动截断超长内容。
 */
export async function readUrl(
  url: string,
  maxLength: number = 20000,
): Promise<ReadUrlResponse> {
  // 策略 1: Jina Reader
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const res = await fetch(jinaUrl, {
      method: 'GET',
      headers: { 'Accept': 'text/plain', 'User-Agent': 'agentforge/8.0', 'X-Retain-Images': 'none', 'X-Timeout': '15' },
      signal: AbortSignal.timeout(20000),
    });

    if (res.ok) {
      const text = await res.text();
      const titleMatch = text.match(/^Title:\s*(.+)/m);
      const title = titleMatch ? titleMatch[1].trim() : '';
      const content = text.length > maxLength
        ? text.slice(0, maxLength) + `\n\n... [截断: 总长 ${text.length} 字符]`
        : text;
      return { success: true, content, title, length: text.length };
    }
  } catch {
    // Jina 失败, 继续 fallback
  }

  // 策略 2: 原生 fetch + HTML 清洗
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AgentForge/8.0',
        'Accept': 'text/html,application/xhtml+xml,text/plain,application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return { success: false, content: '', title: '', length: 0, error: `HTTP ${res.status}` };
    }

    const contentType = res.headers.get('content-type') || '';
    let text = await res.text();

    // JSON → 直接返回
    if (contentType.includes('json')) {
      const truncated = text.length > maxLength ? text.slice(0, maxLength) + '\n...[截断]' : text;
      return { success: true, content: truncated, title: url, length: text.length };
    }

    // HTML → 简易清洗
    if (contentType.includes('html')) {
      text = stripHtml(text);
    }

    const titleMatch = text.match(/<title>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    const content = text.length > maxLength ? text.slice(0, maxLength) + '\n...[截断]' : text;
    return { success: true, content, title, length: text.length };

  } catch (err: unknown) {
    return { success: false, content: '', title: '', length: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 简易 HTML → 文本清洗 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, '\n\n')
    .trim();
}

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

function formatResultsToMarkdown(results: SearchResult[], query: string, engine: string): string {
  if (results.length === 0) return `搜索 "${query}" — 无结果 (${engine})`;

  const lines: string[] = [`## 搜索结果: "${query}" (${engine}, ${results.length} 条)\n`];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`### ${i + 1}. ${r.title}`);
    lines.push(`URL: ${r.url}`);
    if (r.date) lines.push(`日期: ${r.date}`);
    lines.push(`${r.snippet}`);
    lines.push('');
  }

  return lines.join('\n');
}
