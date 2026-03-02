/**
 * Research Cache — 搜索+研究结果缓存
 *
 * 避免在同一项目或跨项目中重复搜索相同/相似的问题。
 * 使用 LRU + TTL 缓存策略，支持模糊匹配 (编辑距离 + TF-IDF 关键词)。
 *
 * 缓存层次:
 *   L1: 精确查询匹配 (HashMap, O(1))
 *   L2: 关键词相似匹配 (Jaccard similarity ≥ 0.6)
 *
 * v1.0 — 2026-03-02
 */

import { createLogger } from './logger';

const log = createLogger('research-cache');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface CacheEntry {
  /** 原始查询 */
  query: string;
  /** 查询关键词 (预处理) */
  keywords: Set<string>;
  /** 缓存的结果 */
  result: string;
  /** 结果来源工具 */
  source: 'web_search' | 'web_search_boost' | 'deep_research' | 'fetch_url' | string;
  /** 创建时间 */
  createdAt: number;
  /** 最后访问时间 */
  lastAccessedAt: number;
  /** 命中次数 */
  hitCount: number;
  /** 结果质量评分 (0-1, 由调用者标记) */
  quality: number;
}

export interface CacheStats {
  totalEntries: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  totalCharsSaved: number;
  avgQuality: number;
}

export interface CacheLookupResult {
  hit: boolean;
  entry?: CacheEntry;
  similarity?: number;
  matchType?: 'exact' | 'keyword';
}

// ═══════════════════════════════════════
// Configuration
// ═══════════════════════════════════════

interface CacheConfig {
  /** 最大缓存条目数 */
  maxEntries: number;
  /** 缓存 TTL (毫秒), 默认 1 小时 */
  ttlMs: number;
  /** 关键词相似度阈值 (0-1) */
  similarityThreshold: number;
  /** 是否启用 L2 模糊匹配 */
  fuzzyMatch: boolean;
}

const DEFAULT_CONFIG: CacheConfig = {
  maxEntries: 200,
  ttlMs: 60 * 60 * 1000, // 1 hour
  similarityThreshold: 0.6,
  fuzzyMatch: true,
};

// ═══════════════════════════════════════
// Text Processing
// ═══════════════════════════════════════

/** 停用词 (中英文) */
const STOP_WORDS = new Set([
  // English
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'but',
  'and', 'or', 'not', 'no', 'if', 'then', 'than', 'that', 'this',
  'what', 'how', 'when', 'where', 'which', 'who', 'whom', 'why',
  'it', 'its', 'he', 'she', 'they', 'we', 'you', 'i', 'me', 'my',
  // Chinese
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一',
  '个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有',
  '看', '好', '自己', '这', '他', '她', '吗', '什么', '怎么', '如何',
]);

/**
 * 从查询文本提取关键词
 */
function extractKeywords(text: string): Set<string> {
  // 分词: 英文按空格/标点，中文按字符(简化)
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));

  return new Set(tokens);
}

/**
 * Jaccard 相似度
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * 规范化查询 (用于精确匹配)
 */
function normalizeQuery(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, ' ');
}

// ═══════════════════════════════════════
// Cache Implementation
// ═══════════════════════════════════════

export class ResearchCache {
  private entries: Map<string, CacheEntry> = new Map();
  private config: CacheConfig;
  private stats = { hitCount: 0, missCount: 0, charsSaved: 0 };

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 查询缓存
   */
  lookup(query: string): CacheLookupResult {
    const normalized = normalizeQuery(query);

    // L1: 精确匹配
    const exactEntry = this.entries.get(normalized);
    if (exactEntry && !this.isExpired(exactEntry)) {
      exactEntry.lastAccessedAt = Date.now();
      exactEntry.hitCount++;
      this.stats.hitCount++;
      this.stats.charsSaved += exactEntry.result.length;
      log.debug('Cache HIT (exact)', { query: normalized.slice(0, 50), hits: exactEntry.hitCount });
      return { hit: true, entry: exactEntry, similarity: 1.0, matchType: 'exact' };
    }

    // L2: 关键词模糊匹配
    if (this.config.fuzzyMatch) {
      const queryKeywords = extractKeywords(query);
      let bestEntry: CacheEntry | null = null;
      let bestSimilarity = 0;

      for (const entry of this.entries.values()) {
        if (this.isExpired(entry)) continue;

        const sim = jaccardSimilarity(queryKeywords, entry.keywords);
        if (sim >= this.config.similarityThreshold && sim > bestSimilarity) {
          bestSimilarity = sim;
          bestEntry = entry;
        }
      }

      if (bestEntry) {
        bestEntry.lastAccessedAt = Date.now();
        bestEntry.hitCount++;
        this.stats.hitCount++;
        this.stats.charsSaved += bestEntry.result.length;
        log.debug('Cache HIT (fuzzy)', {
          query: normalized.slice(0, 50),
          matchedQuery: bestEntry.query.slice(0, 50),
          similarity: bestSimilarity.toFixed(2),
        });
        return { hit: true, entry: bestEntry, similarity: bestSimilarity, matchType: 'keyword' };
      }
    }

    this.stats.missCount++;
    return { hit: false };
  }

  /**
   * 存入缓存
   */
  store(query: string, result: string, source: string, quality: number = 0.5): void {
    // 不缓存空结果或失败结果
    if (!result || result.length < 50) return;

    const normalized = normalizeQuery(query);
    const keywords = extractKeywords(query);

    // LRU 淘汰
    if (this.entries.size >= this.config.maxEntries) {
      this.evictOldest();
    }

    const entry: CacheEntry = {
      query: normalized,
      keywords,
      result,
      source,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      hitCount: 0,
      quality,
    };

    this.entries.set(normalized, entry);
    log.debug('Cache STORE', { query: normalized.slice(0, 50), source, size: result.length });
  }

  /**
   * 标记结果质量 (Agent 使用后反馈)
   */
  markQuality(query: string, quality: number): void {
    const normalized = normalizeQuery(query);
    const entry = this.entries.get(normalized);
    if (entry) {
      entry.quality = quality;
    }
  }

  /**
   * 获取缓存统计
   */
  getStats(): CacheStats {
    const total = this.stats.hitCount + this.stats.missCount;
    const qualities = [...this.entries.values()].map(e => e.quality);
    return {
      totalEntries: this.entries.size,
      hitCount: this.stats.hitCount,
      missCount: this.stats.missCount,
      hitRate: total > 0 ? this.stats.hitCount / total : 0,
      totalCharsSaved: this.stats.charsSaved,
      avgQuality: qualities.length > 0 ? qualities.reduce((a, b) => a + b, 0) / qualities.length : 0,
    };
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.entries.clear();
    this.stats = { hitCount: 0, missCount: 0, charsSaved: 0 };
  }

  /**
   * 清理过期条目
   */
  cleanup(): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry)) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  // ── Internal ──

  private isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.createdAt > this.config.ttlMs;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.entries) {
      // 优先淘汰: 过期 > 低质量 > 最旧访问
      if (this.isExpired(entry)) {
        this.entries.delete(key);
        return;
      }
      const score = entry.lastAccessedAt + entry.hitCount * 60000 + entry.quality * 300000;
      if (score < oldestTime) {
        oldestTime = score;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.entries.delete(oldestKey);
    }
  }
}

// ═══════════════════════════════════════
// Global instance
// ═══════════════════════════════════════

let _globalCache: ResearchCache | null = null;

/**
 * 获取全局研究缓存实例
 */
export function getResearchCache(): ResearchCache {
  if (!_globalCache) {
    _globalCache = new ResearchCache();
  }
  return _globalCache;
}

/**
 * 重置全局缓存 (用于测试)
 */
export function resetResearchCache(): void {
  _globalCache = null;
}
