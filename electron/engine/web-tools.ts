/**
 * Web Tools — 网络搜索 + URL 抓取 (v8.0)
 *
 * v8.0 重构: 底层委托给 search-provider.ts (多引擎 fallback chain)
 * 对外 API 保持不变: webSearch / fetchUrl / httpRequest
 *
 * 配置搜索引擎:
 *   import { configureSearch } from './search-provider';
 *   configureSearch({ braveApiKey: '...', searxngUrl: 'http://...' });
 */

import {
  search as providerSearch,
  searchBoost,
  readUrl,
  configureSearch,
  getAvailableProviders,
  type SearchResult as ProviderSearchResult,
  type SearchProviderConfig,
} from './search-provider';

// ═══════════════════════════════════════
// Re-exports (方便外部直接配置)
// ═══════════════════════════════════════

export { configureSearch, getAvailableProviders, type SearchProviderConfig };

// ═══════════════════════════════════════
// web_search — 委托给 search-provider
// ═══════════════════════════════════════

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * 搜索互联网 — 自动使用最优搜索引擎 (fallback chain)
 * 返回 Markdown 格式的搜索结果
 */
export async function webSearch(
  query: string,
  maxResults: number = 8,
): Promise<{ success: boolean; content: string; results: SearchResult[]; error?: string }> {
  const resp = await providerSearch(query, maxResults);

  const results: SearchResult[] = resp.results.map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet,
  }));

  return {
    success: resp.success,
    content: resp.content.slice(0, 12000),
    results,
    error: resp.error,
  };
}

/**
 * 增强搜索 — 并行多引擎 + 结果去重合并
 * 用于重要查询
 */
export async function webSearchBoost(
  query: string,
  maxResults: number = 15,
): Promise<{ success: boolean; content: string; results: SearchResult[]; provider: string; error?: string }> {
  const resp = await searchBoost(query, maxResults);

  const results: SearchResult[] = resp.results.map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet,
  }));

  return {
    success: resp.success,
    content: resp.content.slice(0, 15000),
    results,
    provider: resp.provider,
    error: resp.error,
  };
}

// ═══════════════════════════════════════
// fetch_url — 委托给 search-provider readUrl
// ═══════════════════════════════════════

/**
 * 抓取 URL 内容 — Jina Reader + 原生 fetch fallback
 * 自动将 HTML 转为 LLM 友好的 Markdown
 */
export async function fetchUrl(
  url: string,
  maxLength: number = 15000,
): Promise<{ success: boolean; content: string; title: string; length: number; error?: string }> {
  return readUrl(url, maxLength);
}

// ═══════════════════════════════════════
// http_request — 通用 HTTP 客户端
// ═══════════════════════════════════════

export interface HttpRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}

/**
 * 发送任意 HTTP 请求（API 测试、webhook 等）
 */
export async function httpRequest(
  opts: HttpRequestOptions,
): Promise<{ success: boolean; status: number; headers: Record<string, string>; body: string; error?: string }> {
  try {
    const method = (opts.method || 'GET').toUpperCase();
    const timeout = Math.min(opts.timeout || 30000, 60000);

    const fetchOpts: RequestInit = {
      method,
      headers: opts.headers || {},
      signal: AbortSignal.timeout(timeout),
    };

    if (opts.body && method !== 'GET' && method !== 'HEAD') {
      fetchOpts.body = opts.body;
    }

    const res = await fetch(opts.url, fetchOpts);
    const bodyText = await res.text();

    // 收集响应头
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      respHeaders[key] = value;
    });

    // 截断过长响应
    const body = bodyText.length > 10000
      ? bodyText.slice(0, 10000) + `\n... [截断: ${bodyText.length} 字符]`
      : bodyText;

    return { success: res.ok, status: res.status, headers: respHeaders, body };
  } catch (err: unknown) {
    return { success: false, status: 0, headers: {}, body: '', error: (err instanceof Error ? err.message : String(err)) };
  }
}
