/**
 * Search Provider System — 可插拔多引擎搜索 + 自动 Fallback
 *
 * 零 Key 即可用的搜索引擎 (HTML 爬取):
 *   1. Google HTML       — 主力, 直接解析 google.com/search HTML
 *   2. Bing HTML         — 第二, 直接解析 bing.com/search HTML
 *   3. DuckDuckGo HTML   — 第三, html.duckduckgo.com
 *
 * 可选付费引擎 (需 API Key, 质量更高):
 *   4. Brave Search API  — 免费 2000 次/月
 *   5. SearXNG           — 自建, 完全离线
 *   6. Tavily            — AI 优化搜索
 *   7. Serper.dev        — Google API 代理
 *   8. Jina AI           — 搜索 + URL 抓取
 *
 * 设计原则:
 *   - 零配置即可用: Google → Bing → DDG 三重免费兜底
 *   - 付费引擎优先: 如果配了 Key 则优先走 API (更稳定)
 *   - 统一 SearchResult 输出格式
 *   - 并行搜索多引擎 + 结果去重合并 (boost 模式)
 *   - 速率限制友好: 自动退避 + 多引擎分散压力
 *
 * 零 npm 依赖 — 全部使用 Node.js 原生 fetch。
 *
 * @module search-provider
 * @since v8.0.0 / v24.1 — zero-key overhaul
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
  /** Jina AI API Key (免费额度: https://jina.ai/) — 2025 起需要 Bearer token */
  jinaApiKey?: string;
  /** 自定义 fallback 顺序 */
  fallbackOrder?: ProviderName[];
  /** 超时 ms (每个引擎) */
  timeout?: number;
}

export type ProviderName = 'google' | 'bing' | 'duckduckgo' | 'brave' | 'searxng' | 'tavily' | 'serper' | 'jina';

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

// 通用 User-Agent 池 — 轮换降低被封概率
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];
let _uaIndex = 0;
function rotateUA(): string {
  return USER_AGENTS[_uaIndex++ % USER_AGENTS.length];
}

/** 通用 HTML entity 解码 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// ─── Google HTML (零 Key, 主力) ───

const googleProvider: ISearchProvider = {
  name: 'google',
  isConfigured: () => true, // 始终可用
  async search(query, maxResults, cfg) {
    const start = Date.now();
    try {
      // Google 搜索 — hl=en 保证 HTML 结构一致性, num 控制结果数
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${Math.min(maxResults + 2, 20)}&hl=en`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': rotateUA(),
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
          'Accept-Encoding': 'identity',
        },
        signal: AbortSignal.timeout(cfg.timeout || 12000),
        redirect: 'follow',
      });

      if (!res.ok) {
        return {
          success: false,
          results: [],
          content: '',
          provider: 'google',
          durationMs: Date.now() - start,
          error: `Google HTTP ${res.status}`,
        };
      }

      const html = await res.text();
      const results = parseGoogleHtml(html, maxResults);

      if (results.length === 0) {
        // 可能被 CAPTCHA 拦截
        return {
          success: false,
          results: [],
          content: '',
          provider: 'google',
          durationMs: Date.now() - start,
          error: 'Google: no results (possible CAPTCHA)',
        };
      }

      const content = formatResultsToMarkdown(results, query, 'Google');
      return { success: true, results, content, provider: 'google', durationMs: Date.now() - start };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        results: [],
        content: '',
        provider: 'google',
        durationMs: Date.now() - start,
        error: `Google: ${msg}`,
      };
    }
  },
};

/** 解析 Google 搜索结果 HTML */
function parseGoogleHtml(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Google 结果在 <div class="g"> 块中 (有时嵌套)
  // 核心 pattern: <a href="/url?q=REAL_URL&..."><h3>TITLE</h3></a> ... <span>SNIPPET</span>
  // 也有直接 <a href="https://..."><h3>TITLE</h3></a> 的形式

  // 策略1: 匹配 <a href="..."><h3...>TITLE</h3></a>
  const linkH3Regex = /<a\s+href="([^"]*)"[^>]*><br\s*\/?>?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  // 策略2: 更宽松的 <a ... href><h3>
  const linkH3Regex2 = /<a\s[^>]*href="([^"]*)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;

  const seen = new Set<string>();

  for (const regex of [linkH3Regex, linkH3Regex2]) {
    let match;
    while ((match = regex.exec(html)) !== null && results.length < max) {
      let href = match[1];
      const title = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, '').trim());

      if (!title || title.length < 3) continue;

      // 解包 Google redirect
      const qMatch = href.match(/[?&]q=([^&]+)/);
      if (qMatch) {
        try {
          href = decodeURIComponent(qMatch[1]);
        } catch {
          /* keep */
        }
      }

      // 过滤无效 URL
      if (!href.startsWith('http') || href.includes('google.com/search') || href.includes('accounts.google')) continue;
      if (seen.has(href)) continue;
      seen.add(href);

      // 尝试从 href 附近找 snippet
      const afterMatch = html.slice(match.index + match[0].length, match.index + match[0].length + 2000);
      let snippet = '';

      // Google snippet 通常在后续的 <span> 或 <div class="..."> 中
      // 简单策略: 找第一段纯文本
      const spanSnippet = afterMatch.match(
        /<span[^>]*class="[^"]*(?:st|IsZvec|VwiC3b|hgKElc)[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
      );
      if (spanSnippet) {
        snippet = decodeHtmlEntities(spanSnippet[1].replace(/<[^>]+>/g, '').trim());
      }
      if (!snippet) {
        // fallback: <div class="VwiC3b ..."> or any data-sncf
        const divSnippet =
          afterMatch.match(/<(?:div|span)[^>]*data-sncf[^>]*>([\s\S]*?)<\/(?:div|span)>/i) ||
          afterMatch.match(/<div[^>]*class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        if (divSnippet) {
          snippet = decodeHtmlEntities((divSnippet[1] || '').replace(/<[^>]+>/g, '').trim());
        }
      }
      if (!snippet) {
        // ultra-fallback: 取 200 字符清洗后的文本
        snippet = decodeHtmlEntities(
          afterMatch
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
        ).slice(0, 200);
      }

      results.push({ title, url: href, snippet: snippet.slice(0, 500), source: 'google' });
    }
    if (results.length >= max) break;
  }

  return results;
}

// ─── Bing HTML (零 Key, 第二引擎) ───

const bingProvider: ISearchProvider = {
  name: 'bing',
  isConfigured: () => true, // 始终可用
  async search(query, maxResults, cfg) {
    const start = Date.now();
    try {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(maxResults + 2, 20)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': rotateUA(),
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity',
        },
        signal: AbortSignal.timeout(cfg.timeout || 12000),
        redirect: 'follow',
      });

      if (!res.ok) {
        return {
          success: false,
          results: [],
          content: '',
          provider: 'bing',
          durationMs: Date.now() - start,
          error: `Bing HTTP ${res.status}`,
        };
      }

      const html = await res.text();
      const results = parseBingHtml(html, maxResults);

      if (results.length === 0) {
        return {
          success: false,
          results: [],
          content: '',
          provider: 'bing',
          durationMs: Date.now() - start,
          error: 'Bing: no results parsed',
        };
      }

      const content = formatResultsToMarkdown(results, query, 'Bing');
      return { success: true, results, content, provider: 'bing', durationMs: Date.now() - start };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        results: [],
        content: '',
        provider: 'bing',
        durationMs: Date.now() - start,
        error: `Bing: ${msg}`,
      };
    }
  },
};

/** 解析 Bing 搜索结果 HTML */
function parseBingHtml(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Bing 结果在 <li class="b_algo"> 块中
  const blocks = html.split(/<li\s+class="b_algo"/gi);

  for (let i = 1; i < blocks.length && results.length < max; i++) {
    const block = blocks[i];

    // 提取标题和 URL: <a href="URL" ...><h2>TITLE</h2></a>
    // 或者 <h2><a href="URL">TITLE</a></h2>
    const linkMatch = block.match(/<a\s+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const href = linkMatch[1];
    // 标题可能在 <h2> 内, 也可能直接在 <a> 内
    let title = '';
    const h2Match = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (h2Match) {
      title = decodeHtmlEntities(h2Match[1].replace(/<[^>]+>/g, '').trim());
    }
    if (!title) {
      title = decodeHtmlEntities(linkMatch[2].replace(/<[^>]+>/g, '').trim());
    }
    if (!title || !href.startsWith('http')) continue;

    // 提取摘要: <p> 或 <div class="b_caption"><p>
    let snippet = '';
    const captionMatch = block.match(/<div\s+class="b_caption"[^>]*>([\s\S]*?)<\/div>/i);
    if (captionMatch) {
      const pMatch = captionMatch[1].match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (pMatch) {
        snippet = decodeHtmlEntities(pMatch[1].replace(/<[^>]+>/g, '').trim());
      }
    }
    if (!snippet) {
      // fallback: 找块内任意 <p>
      const pMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (pMatch) {
        snippet = decodeHtmlEntities(pMatch[1].replace(/<[^>]+>/g, '').trim());
      }
    }

    // 过滤 Bing 内部链接
    if (href.includes('bing.com') || href.includes('microsoft.com/bing')) continue;

    results.push({ title, url: href, snippet: snippet.slice(0, 500), source: 'bing' });
  }

  return results;
}

// ─── Brave Search ───

const braveProvider: ISearchProvider = {
  name: 'brave',
  isConfigured: cfg => !!cfg.braveApiKey,
  async search(query, maxResults, cfg) {
    const start = Date.now();
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': cfg.braveApiKey || '',
      },
      signal: AbortSignal.timeout(cfg.timeout || 15000),
    });

    if (!res.ok) {
      return {
        success: false,
        results: [],
        content: '',
        provider: 'brave',
        durationMs: Date.now() - start,
        error: `Brave HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as {
      web?: {
        results?: Array<{ title?: string; url?: string; description?: string; age?: string; page_age?: string }>;
      };
    };
    const results: SearchResult[] = (data.web?.results || []).slice(0, maxResults).map(r => ({
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
  isConfigured: cfg => !!cfg.searxngUrl,
  async search(query, maxResults, cfg) {
    const start = Date.now();
    const baseUrl = cfg.searxngUrl?.replace(/\/$/, '');
    const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&engines=google,duckduckgo,bing&safesearch=0&pageno=1`;

    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(cfg.timeout || 20000),
    });

    if (!res.ok) {
      return {
        success: false,
        results: [],
        content: '',
        provider: 'searxng',
        durationMs: Date.now() - start,
        error: `SearXNG HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string; engine?: string }>;
    };
    const results: SearchResult[] = (data.results || []).slice(0, maxResults).map(r => ({
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
  isConfigured: cfg => !!cfg.tavilyApiKey,
  async search(query, maxResults, cfg) {
    const start = Date.now();
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: cfg.tavilyApiKey,
        query,
        max_results: maxResults,
        include_answer: true,
        include_raw_content: false,
        search_depth: 'advanced',
      }),
      signal: AbortSignal.timeout(cfg.timeout || 20000),
    });

    if (!res.ok) {
      return {
        success: false,
        results: [],
        content: '',
        provider: 'tavily',
        durationMs: Date.now() - start,
        error: `Tavily HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
      answer?: string;
    };
    const results: SearchResult[] = (data.results || []).slice(0, maxResults).map(r => ({
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
  isConfigured: cfg => !!cfg.serperApiKey,
  async search(query, maxResults, cfg) {
    const start = Date.now();
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': cfg.serperApiKey || '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: maxResults }),
      signal: AbortSignal.timeout(cfg.timeout || 15000),
    });

    if (!res.ok) {
      return {
        success: false,
        results: [],
        content: '',
        provider: 'serper',
        durationMs: Date.now() - start,
        error: `Serper HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as {
      knowledgeGraph?: { title?: string; website?: string; description?: string };
      organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string }>;
    };
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

// ─── Jina AI (需要 API Key, 2025 起免费额度需 Bearer token) ───

const jinaProvider: ISearchProvider = {
  name: 'jina',
  isConfigured: cfg => !!cfg.jinaApiKey, // 2025 起需要 API Key
  async search(query, maxResults, cfg) {
    const start = Date.now();
    const url = `https://s.jina.ai/${encodeURIComponent(query)}`;
    const headers: Record<string, string> = {
      Accept: 'text/plain',
      'User-Agent': 'automater/8.0',
      'X-Retain-Images': 'none',
    };
    if (cfg.jinaApiKey) {
      headers['Authorization'] = `Bearer ${cfg.jinaApiKey}`;
    }
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(cfg.timeout || 20000),
    });

    if (!res.ok) {
      return {
        success: false,
        results: [],
        content: '',
        provider: 'jina',
        durationMs: Date.now() - start,
        error: `Jina HTTP ${res.status}`,
      };
    }

    const text = await res.text();
    const results = parseJinaResults(text, maxResults);
    const content = text.length > 12000 ? text.slice(0, 12000) + '\n\n... [截断]' : text;

    return { success: true, results, content, provider: 'jina', durationMs: Date.now() - start };
  },
};

// ─── DuckDuckGo HTML (免费零 Key 兜底) ───

const duckduckgoProvider: ISearchProvider = {
  name: 'duckduckgo',
  isConfigured: () => true, // 始终可用, 零 key
  async search(query, maxResults, cfg) {
    const start = Date.now();
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(cfg.timeout || 15000),
      });

      if (!res.ok) {
        return {
          success: false,
          results: [],
          content: '',
          provider: 'duckduckgo',
          durationMs: Date.now() - start,
          error: `DDG HTTP ${res.status}`,
        };
      }

      const html = await res.text();
      const results = parseDuckDuckGoHtml(html, maxResults);

      if (results.length === 0) {
        return {
          success: false,
          results: [],
          content: '',
          provider: 'duckduckgo',
          durationMs: Date.now() - start,
          error: 'DDG: no results parsed',
        };
      }

      const content = formatResultsToMarkdown(results, query, 'DuckDuckGo');
      return { success: true, results, content, provider: 'duckduckgo', durationMs: Date.now() - start };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        results: [],
        content: '',
        provider: 'duckduckgo',
        durationMs: Date.now() - start,
        error: `DDG: ${msg}`,
      };
    }
  },
};

/** 解析 DuckDuckGo HTML 搜索结果页 */
function parseDuckDuckGoHtml(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DDG HTML 结果格式: <a rel="nofollow" class="result__a" href="...">title</a>
  // 与 <a class="result__snippet">snippet</a>
  const resultBlocks = html.split(/class="result\s/g);

  for (let i = 1; i < resultBlocks.length && results.length < max; i++) {
    const block = resultBlocks[i];

    // 提取 URL
    const urlMatch = block.match(/class="result__a"\s+href="([^"]+)"/);
    if (!urlMatch) continue;
    let url = urlMatch[1];
    // DDG 有时包装 redirect URL
    const uddgMatch = url.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      try {
        url = decodeURIComponent(uddgMatch[1]);
      } catch {
        /* keep original */
      }
    }

    // 提取标题
    const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
    const title = titleMatch ? titleMatch[1].trim() : url;

    // 提取摘要
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)(?:<\/a>|<\/td>)/);
    let snippet = '';
    if (snippetMatch) {
      snippet = snippetMatch[1]
        .replace(/<[^>]+>/g, '') // strip HTML tags
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    }

    // 过滤 DDG 广告和无效结果
    if (url.includes('duckduckgo.com') || !url.startsWith('http')) continue;

    results.push({ title, url, snippet, source: 'duckduckgo' });
  }

  return results;
}

function parseJinaResults(text: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = text.split(/\n---\n|\n\n(?=Title:)/);
  for (const block of blocks) {
    if (results.length >= max) break;
    const titleMatch = block.match(/Title:\s*(.+)/);
    const urlMatch = block.match(/URL Source:\s*(.+)/);
    const contentLines = block
      .split('\n')
      .filter(l => !l.startsWith('Title:') && !l.startsWith('URL Source:') && l.trim());
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
  // 零 Key 免费引擎 (HTML 爬取)
  googleProvider,
  bingProvider,
  duckduckgoProvider,
  // 付费 API 引擎 (需 Key, 更稳定)
  braveProvider,
  searxngProvider,
  tavilyProvider,
  serperProvider,
  jinaProvider,
];

// 默认 fallback 顺序: 付费优先(如果配了) → 免费兜底
// search() 函数会自动过滤未配置的引擎, 所以实际零配置时走 google → bing → ddg
const DEFAULT_FALLBACK_ORDER: ProviderName[] = [
  'brave',
  'searxng',
  'tavily',
  'serper',
  'jina', // 付费 (有 key 才会尝试)
  'google',
  'bing',
  'duckduckgo', // 免费兜底 (始终可用)
];

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
 * 按优先级依次尝试已配置的引擎。第一个成功的返回结果。
 * 零配置时自动走: Google → Bing → DuckDuckGo (全免费)
 * 配了 API Key 时: 付费引擎优先 → 免费兜底
 */
export async function search(
  query: string,
  maxResults: number = 10,
  preferProvider?: ProviderName,
): Promise<SearchResponse> {
  const order = _config.fallbackOrder || DEFAULT_FALLBACK_ORDER;

  // 如果指定了优先引擎，放到最前
  const sorted = preferProvider ? [preferProvider, ...order.filter(n => n !== preferProvider)] : order;

  const configuredOrder = sorted.filter(name => {
    const p = ALL_PROVIDERS.find(pp => pp.name === name);
    return p && p.isConfigured(_config);
  });

  // 确保免费引擎兜底 (零 key, 始终可用)
  for (const freeEngine of ['google', 'bing', 'duckduckgo'] as ProviderName[]) {
    if (!configuredOrder.includes(freeEngine)) configuredOrder.push(freeEngine);
  }

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
export async function searchBoost(query: string, maxResults: number = 15): Promise<SearchResponse> {
  const start = Date.now();

  const configured = ALL_PROVIDERS.filter(p => p.isConfigured(_config));
  if (configured.length === 0) {
    return search(query, maxResults); // fallback to normal
  }

  // 并行搜索所有引擎 (最多 4 个)
  const selected = configured.slice(0, 4);
  const promises = selected.map(p =>
    p.search(query, maxResults, _config).catch(
      (err: unknown): SearchResponse => ({
        success: false,
        results: [],
        content: '',
        provider: p.name,
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      }),
    ),
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
      source: entry.engines.length > 1 ? `[${entry.engines.join('+')}]` : entry.result.source,
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
 * 策略优先级:
 *   1. 原生 fetch + 智能 HTML 清洗 (零依赖, 始终可用)
 *   2. Jina Reader (如果配了 API Key, 质量更高, 擅长 JS 渲染页面)
 *
 * 自动截断超长内容。
 */
export async function readUrl(url: string, maxLength: number = 20000): Promise<ReadUrlResponse> {
  // 策略 1: 原生 fetch + HTML 清洗 (零依赖, 优先)
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': rotateUA(),
        Accept: 'text/html,application/xhtml+xml,text/plain,application/json',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
        'Accept-Encoding': 'identity',
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });

    if (res.ok) {
      const contentType = res.headers.get('content-type') || '';
      let text = await res.text();

      // JSON → 直接返回
      if (contentType.includes('json')) {
        const truncated = text.length > maxLength ? text.slice(0, maxLength) + '\n...[截断]' : text;
        return { success: true, content: truncated, title: url, length: text.length };
      }

      // 先提取 title (在 HTML 清洗之前)
      const titleMatch = text.match(/<title>([^<]*)<\/title>/i);
      const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';

      // HTML → 清洗
      if (contentType.includes('html') || text.trimStart().startsWith('<')) {
        text = stripHtml(text);
      }

      // 如果清洗后内容足够丰富, 直接返回
      if (text.length > 200) {
        const content =
          text.length > maxLength ? text.slice(0, maxLength) + `\n\n... [截断: 总长 ${text.length} 字符]` : text;
        return { success: true, content, title, length: text.length };
      }
      // 内容太短 (可能是 JS 渲染页面), 尝试 Jina fallback
    }
  } catch {
    /* silent: 原生 fetch 失败, 尝试 Jina */
  }

  // 策略 2: Jina Reader (如果配了 Key, 擅长处理 JS 渲染页面)
  if (_config.jinaApiKey) {
    try {
      const jinaUrl = `https://r.jina.ai/${url}`;
      const res = await fetch(jinaUrl, {
        method: 'GET',
        headers: {
          Accept: 'text/plain',
          'User-Agent': 'automater/8.0',
          'X-Retain-Images': 'none',
          'X-Timeout': '15',
          Authorization: `Bearer ${_config.jinaApiKey}`,
        },
        signal: AbortSignal.timeout(20000),
      });

      if (res.ok) {
        const text = await res.text();
        const titleMatch = text.match(/^Title:\s*(.+)/m);
        const title = titleMatch ? titleMatch[1].trim() : '';
        const content =
          text.length > maxLength ? text.slice(0, maxLength) + `\n\n... [截断: 总长 ${text.length} 字符]` : text;
        return { success: true, content, title, length: text.length };
      }
    } catch {
      /* Jina 也失败 */
    }
  }

  return { success: false, content: '', title: '', length: 0, error: `无法抓取: ${url}` };
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
