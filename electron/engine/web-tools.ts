/**
 * Web Tools — 网络搜索 + URL 抓取 (v2.1)
 * 
 * 使用 Jina AI 免费 API（开源、零依赖、返回 Markdown）：
 * - web_search: Jina Search  → https://s.jina.ai/{query}
 * - fetch_url:  Jina Reader  → https://r.jina.ai/{url}
 */

const JINA_TIMEOUT = 20_000;

const JINA_HEADERS = {
  'Accept': 'text/plain',
  'User-Agent': 'AgentForge/2.1',
};

// ═══════════════════════════════════════
// web_search — Jina Search API
// ═══════════════════════════════════════

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * 使用 Jina Search API 搜索互联网
 * 返回 Markdown 格式的搜索结果
 */
export async function webSearch(
  query: string,
  maxResults: number = 8,
): Promise<{ success: boolean; content: string; results: SearchResult[]; error?: string }> {
  try {
    const url = `https://s.jina.ai/${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        ...JINA_HEADERS,
        'X-Retain-Images': 'none',
      },
      signal: AbortSignal.timeout(JINA_TIMEOUT),
    });

    if (!res.ok) {
      return { success: false, content: '', results: [], error: `Jina Search HTTP ${res.status}` };
    }

    const text = await res.text();

    // 解析 Jina 返回的 Markdown 格式结果
    const results = parseJinaSearchResults(text, maxResults);

    // 截断过长内容
    const trimmed = text.length > 8000 ? text.slice(0, 8000) + '\n\n... [截断]' : text;

    return { success: true, content: trimmed, results };
  } catch (err: any) {
    return { success: false, content: '', results: [], error: err.message };
  }
}

function parseJinaSearchResults(text: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Jina 返回格式通常是:
  // Title: ...
  // URL Source: ...
  // Markdown Content
  // ---
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
        snippet: contentLines.slice(0, 3).join(' ').slice(0, 200),
      });
    }
  }
  return results;
}

// ═══════════════════════════════════════
// fetch_url — Jina Reader API
// ═══════════════════════════════════════

/**
 * 使用 Jina Reader API 抓取 URL 内容
 * 自动将 HTML 转为 LLM 友好的 Markdown
 */
export async function fetchUrl(
  url: string,
  maxLength: number = 15000,
): Promise<{ success: boolean; content: string; title: string; length: number; error?: string }> {
  try {
    // Jina Reader: 前缀 r.jina.ai/ 即可
    const jinaUrl = `https://r.jina.ai/${url}`;
    const res = await fetch(jinaUrl, {
      method: 'GET',
      headers: {
        ...JINA_HEADERS,
        'X-Retain-Images': 'none',
        'X-Timeout': '15',
      },
      signal: AbortSignal.timeout(JINA_TIMEOUT),
    });

    if (!res.ok) {
      return { success: false, content: '', title: '', length: 0, error: `Jina Reader HTTP ${res.status}` };
    }

    const text = await res.text();

    // 提取标题 (Jina 返回的第一行通常是 Title: ...)
    const titleMatch = text.match(/^Title:\s*(.+)/m);
    const title = titleMatch ? titleMatch[1].trim() : '';

    // 截断
    const content = text.length > maxLength
      ? text.slice(0, maxLength) + `\n\n... [截断: 总长 ${text.length} 字符]`
      : text;

    return { success: true, content, title, length: text.length };
  } catch (err: any) {
    return { success: false, content: '', title: '', length: 0, error: err.message };
  }
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
  } catch (err: any) {
    return { success: false, status: 0, headers: {}, body: '', error: err.message };
  }
}
