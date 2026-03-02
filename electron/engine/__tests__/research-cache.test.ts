/**
 * research-cache tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ResearchCache, getResearchCache, resetResearchCache } from '../research-cache';

describe('ResearchCache', () => {
  let cache: ResearchCache;

  beforeEach(() => {
    cache = new ResearchCache({ maxEntries: 10, ttlMs: 5000 });
  });

  it('stores and retrieves exact matches', () => {
    cache.store('react hooks tutorial', 'A comprehensive guide to React hooks that covers useState, useEffect, useContext and custom hooks with examples', 'web_search');
    const result = cache.lookup('react hooks tutorial');
    expect(result.hit).toBe(true);
    expect(result.matchType).toBe('exact');
    expect(result.entry?.result).toContain('guide');
  });

  it('normalizes queries (case insensitive, whitespace)', () => {
    cache.store('React Hooks  Tutorial', 'A comprehensive guide to React hooks that covers useState useEffect and more with many examples', 'web_search');
    const result = cache.lookup('react hooks tutorial');
    expect(result.hit).toBe(true);
  });

  it('finds fuzzy keyword matches', () => {
    cache.store('how to use react hooks with typescript', 'A very long and detailed guide about using React hooks with TypeScript for type-safe development', 'web_search');
    const result = cache.lookup('react hooks typescript guide');
    expect(result.hit).toBe(true);
    expect(result.matchType).toBe('keyword');
    expect(result.similarity).toBeGreaterThanOrEqual(0.4);
  });

  it('returns miss for unrelated queries', () => {
    cache.store('python machine learning', 'A comprehensive guide to Python machine learning using scikit-learn, tensorflow, and pytorch frameworks', 'web_search');
    const result = cache.lookup('react hooks tutorial');
    expect(result.hit).toBe(false);
  });

  it('tracks hit count and stats', () => {
    cache.store('query1', 'This is a sufficiently long result that passes the minimum length check for caching in the research cache system', 'web_search');
    cache.lookup('query1');
    cache.lookup('query1');
    cache.lookup('query1');
    cache.lookup('missing query');

    const stats = cache.getStats();
    expect(stats.hitCount).toBe(3);
    expect(stats.missCount).toBe(1);
    expect(stats.hitRate).toBe(0.75);
    expect(stats.totalEntries).toBe(1);
  });

  it('evicts when max entries reached', () => {
    for (let i = 0; i < 15; i++) {
      cache.store(`query ${i}`, `result ${i} padding text for minimum length requirement`, 'web_search');
    }
    expect(cache.getStats().totalEntries).toBeLessThanOrEqual(10);
  });

  it('does not cache short/empty results', () => {
    cache.store('query', 'short', 'web_search');
    expect(cache.getStats().totalEntries).toBe(0);
  });

  it('clears all entries', () => {
    cache.store('q1', 'result1 with enough content to pass length check minimum requirement', 'web_search');
    cache.store('q2', 'result2 with enough content to pass length check minimum requirement', 'web_search');
    cache.clear();
    expect(cache.getStats().totalEntries).toBe(0);
    expect(cache.getStats().hitCount).toBe(0);
  });

  it('marks quality and reflects in stats', () => {
    cache.store('q1', 'result with enough content to pass the length check threshold here', 'web_search', 0.5);
    cache.markQuality('q1', 0.9);
    const stats = cache.getStats();
    expect(stats.avgQuality).toBe(0.9);
  });
});

describe('getResearchCache / resetResearchCache', () => {
  it('returns singleton', () => {
    resetResearchCache();
    const a = getResearchCache();
    const b = getResearchCache();
    expect(a).toBe(b);
  });

  it('reset creates new instance', () => {
    const a = getResearchCache();
    resetResearchCache();
    const b = getResearchCache();
    expect(a).not.toBe(b);
  });
});
