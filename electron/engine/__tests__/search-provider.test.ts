/**
 * Tests for search-provider.ts — 搜索配置 + 引擎可用性
 *
 * Only tests pure state functions (configureSearch, getAvailableProviders).
 * Actual search calls are async+network and not tested here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { configureSearch, getAvailableProviders, type ProviderName } from '../search-provider';

// Reset config before each test
beforeEach(() => {
  configureSearch({
    braveApiKey: undefined,
    searxngUrl: undefined,
    tavilyApiKey: undefined,
    serperApiKey: undefined,
    jinaApiKey: undefined,
  } as any);
});

describe('getAvailableProviders', () => {
  it('returns only duckduckgo when nothing configured', () => {
    // DuckDuckGo needs no API key, so it's always "configured"
    const providers = getAvailableProviders();
    expect(providers).toContain('duckduckgo');
    // Jina now requires API key, so should NOT appear
    expect(providers).not.toContain('jina');
  });

  it('includes brave when API key set', () => {
    configureSearch({ braveApiKey: 'test-key-123' });
    const providers = getAvailableProviders();
    expect(providers).toContain('brave');
    expect(providers).toContain('duckduckgo');
  });

  it('includes searxng when URL set', () => {
    configureSearch({ searxngUrl: 'http://localhost:8888' });
    const providers = getAvailableProviders();
    expect(providers).toContain('searxng');
  });

  it('includes serper when API key set', () => {
    configureSearch({ serperApiKey: 'serper-key' });
    expect(getAvailableProviders()).toContain('serper');
  });

  it('includes tavily when API key set', () => {
    configureSearch({ tavilyApiKey: 'tavily-key' });
    expect(getAvailableProviders()).toContain('tavily');
  });

  it('includes jina when API key set', () => {
    configureSearch({ jinaApiKey: 'jina-test' });
    expect(getAvailableProviders()).toContain('jina');
  });

  it('includes all providers when fully configured', () => {
    configureSearch({
      braveApiKey: 'b',
      searxngUrl: 'http://sx',
      tavilyApiKey: 't',
      serperApiKey: 's',
      jinaApiKey: 'j',
    });
    const providers = getAvailableProviders();
    expect(providers.length).toBe(6);
    for (const name of ['brave', 'searxng', 'tavily', 'serper', 'jina', 'duckduckgo'] as ProviderName[]) {
      expect(providers).toContain(name);
    }
  });
});

describe('configureSearch', () => {
  it('merges config incrementally', () => {
    configureSearch({ braveApiKey: 'key1' });
    expect(getAvailableProviders()).toContain('brave');
    expect(getAvailableProviders()).not.toContain('serper');

    configureSearch({ serperApiKey: 'key2' });
    // Both should now be available
    expect(getAvailableProviders()).toContain('brave');
    expect(getAvailableProviders()).toContain('serper');
  });
});
