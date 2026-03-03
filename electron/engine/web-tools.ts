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
  type SearchProviderConfig,
} from './search-provider';

// ═══════════════════════════════════════
// Re-exports (方便外部直接配置)
// ═══════════════════════════════════════

export { configureSearch, getAvailableProviders, type SearchProviderConfig };

import { getResearchCache } from './research-cache';

// ═══════════════════════════════════════
// web_search — 委托给 search-provider (with cache)
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
  // v18.0: 缓存查询
  const cache = getResearchCache();
  const cached = cache.lookup(query);
  if (cached.hit && cached.entry) {
    return {
      success: true,
      content: `[缓存命中 ${cached.matchType}, 相似度 ${(cached.similarity ?? 1).toFixed(2)}]\n${cached.entry.result}`,
      results: [],
    };
  }

  const resp = await providerSearch(query, maxResults);

  const results: SearchResult[] = resp.results.map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet,
  }));

  // v18.0: 缓存成功结果
  if (resp.success && resp.content.length > 50) {
    cache.store(query, resp.content.slice(0, 12000), 'web_search');
  }

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

// ═══════════════════════════════════════
// download_file — 二进制文件下载（图片/文件等）
// ═══════════════════════════════════════

export interface DownloadFileOptions {
  url: string;
  savePath: string;
  filename?: string;
  timeout?: number;
  maxSize?: number;
}

export interface DownloadFileResult {
  success: boolean;
  filePath: string;
  size: number;
  mimeType: string;
  error?: string;
}

/**
 * 下载任意文件（二进制安全）到 workspace。
 */
export async function downloadFile(
  opts: DownloadFileOptions,
  workspacePath: string,
): Promise<DownloadFileResult> {
  const fs = await import('fs');
  const nodePath = await import('path');
  const { pipeline } = await import('stream/promises');
  const { Readable, Transform } = await import('stream');

  const timeout = Math.min(opts.timeout || 60000, 120000);
  const maxSize = Math.min(opts.maxSize || 50 * 1024 * 1024, 200 * 1024 * 1024);

  try {
    const res = await fetch(opts.url, {
      signal: AbortSignal.timeout(timeout),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
      },
    });

    if (!res.ok) {
      return { success: false, filePath: '', size: 0, mimeType: '', error: `HTTP ${res.status} ${res.statusText}` };
    }

    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (contentLength > maxSize) {
      return { success: false, filePath: '', size: 0, mimeType: '', error: `文件过大: ${(contentLength / 1024 / 1024).toFixed(1)}MB > ${(maxSize / 1024 / 1024).toFixed(0)}MB 限制` };
    }

    const mimeType = res.headers.get('content-type') || 'application/octet-stream';

    // Determine filename
    let filename = opts.filename || '';
    if (!filename) {
      const disposition = res.headers.get('content-disposition') || '';
      const fnMatch = disposition.match(/filename[*]?=["']?(?:UTF-8'')?([^"';\n]+)/i);
      if (fnMatch) {
        filename = decodeURIComponent(fnMatch[1].trim());
      } else {
        const urlPath = new URL(opts.url).pathname;
        filename = nodePath.basename(urlPath) || 'download';
        if (!nodePath.extname(filename) && mimeType !== 'application/octet-stream') {
          const extMap: Record<string, string> = {
            'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
            'image/webp': '.webp', 'image/svg+xml': '.svg',
            'application/pdf': '.pdf', 'application/zip': '.zip',
          };
          filename += extMap[mimeType.split(';')[0].trim()] || '';
        }
      }
    }
    filename = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 200);

    // Resolve save path
    let savePath = opts.savePath;
    if (!nodePath.isAbsolute(savePath)) {
      savePath = nodePath.join(workspacePath, savePath);
    }

    const hasTrailingSep = savePath.endsWith('/') || savePath.endsWith('\\');
    let resolvedDir: string;
    let resolvedPath: string;

    if (hasTrailingSep || (fs.existsSync(savePath) && fs.statSync(savePath).isDirectory())) {
      resolvedDir = savePath;
      resolvedPath = nodePath.join(savePath, filename);
    } else {
      resolvedDir = nodePath.dirname(savePath);
      resolvedPath = savePath;
    }

    if (!fs.existsSync(resolvedDir)) {
      fs.mkdirSync(resolvedDir, { recursive: true });
    }

    const body = res.body;
    if (!body) {
      return { success: false, filePath: '', size: 0, mimeType, error: '响应体为空' };
    }

    const writeStream = fs.createWriteStream(resolvedPath);
    let downloaded = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeReadable = Readable.fromWeb(body as any);
    const sizeChecker = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloaded += chunk.length;
        if (downloaded > maxSize) {
          callback(new Error(`下载超过大小限制: ${(maxSize / 1024 / 1024).toFixed(0)}MB`));
        } else {
          callback(null, chunk);
        }
      },
    });

    await pipeline(nodeReadable, sizeChecker, writeStream);

    return { success: true, filePath: resolvedPath, size: downloaded, mimeType: mimeType.split(';')[0].trim() };
  } catch (err: unknown) {
    return { success: false, filePath: '', size: 0, mimeType: '', error: (err instanceof Error ? err.message : String(err)) };
  }
}

// ═══════════════════════════════════════
// search_images — 网络图片搜索
// ═══════════════════════════════════════

export interface ImageSearchResult {
  url: string;
  thumbnailUrl: string;
  title: string;
  source: string;
  width?: number;
  height?: number;
}

export async function searchImages(
  query: string,
  count: number = 5,
): Promise<{ success: boolean; images: ImageSearchResult[]; error?: string }> {
  count = Math.min(Math.max(count, 1), 20);

  // Strategy 1: Brave Image Search
  try {
    const braveKey = process.env.BRAVE_SEARCH_API_KEY || '';
    if (braveKey) {
      const url = `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query)}&count=${count}&safesearch=moderate`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await res.json() as { results?: Array<{ url?: string; thumbnail?: { src?: string }; title?: string; source?: string; width?: number; height?: number }> };
        if (data.results?.length) {
          return {
            success: true,
            images: data.results.slice(0, count).map(r => ({
              url: r.url || '', thumbnailUrl: r.thumbnail?.src || r.url || '',
              title: r.title || '', source: r.source || '', width: r.width, height: r.height,
            })),
          };
        }
      }
    }
  } catch { /* fall through */ }

  // Strategy 2: SearXNG
  try {
    const searxngUrl = process.env.SEARXNG_URL || '';
    if (searxngUrl) {
      const url = `${searxngUrl.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&categories=images&format=json&number_of_results=${count}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json() as { results?: Array<{ url?: string; img_src?: string; title?: string; source?: string; thumbnail?: string }> };
        if (data.results?.length) {
          return {
            success: true,
            images: data.results.slice(0, count).map(r => ({
              url: r.img_src || r.url || '', thumbnailUrl: r.thumbnail || r.img_src || r.url || '',
              title: r.title || '', source: r.source || r.url || '',
            })),
          };
        }
      }
    }
  } catch { /* fall through */ }

  // Strategy 3: Serper Image Search
  try {
    const serperKey = process.env.SERPER_API_KEY || '';
    if (serperKey) {
      const res = await fetch('https://google.serper.dev/images', {
        method: 'POST',
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: count }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await res.json() as { images?: Array<{ imageUrl?: string; thumbnailUrl?: string; title?: string; source?: string; imageWidth?: number; imageHeight?: number }> };
        if (data.images?.length) {
          return {
            success: true,
            images: data.images.slice(0, count).map(r => ({
              url: r.imageUrl || '', thumbnailUrl: r.thumbnailUrl || r.imageUrl || '',
              title: r.title || '', source: r.source || '', width: r.imageWidth, height: r.imageHeight,
            })),
          };
        }
      }
    }
  } catch { /* fall through */ }

  // Strategy 4: Jina text search fallback
  try {
    const textResults = await webSearch(`${query} site:unsplash.com OR site:pexels.com OR site:pixabay.com`, count);
    if (textResults.success && textResults.results.length > 0) {
      const images: ImageSearchResult[] = textResults.results
        .filter(r => r.url && (r.url.includes('unsplash') || r.url.includes('pexels') || r.url.includes('pixabay')))
        .slice(0, count)
        .map(r => ({ url: r.url, thumbnailUrl: r.url, title: r.title || '', source: r.url }));
      if (images.length > 0) {
        return { success: true, images };
      }
    }
  } catch { /* fall through */ }

  return { success: false, images: [], error: '所有图片搜索引擎均失败。请配置 BRAVE_SEARCH_API_KEY / SEARXNG_URL / SERPER_API_KEY 中的至少一个。' };
}
