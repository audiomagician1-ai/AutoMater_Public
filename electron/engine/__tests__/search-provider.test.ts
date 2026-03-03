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
  it('returns free engines when nothing configured', () => {
    // Google, Bing, DuckDuckGo need no API key — always "configured"
    const providers = getAvailableProviders();
    expect(providers).toContain('google');
    expect(providers).toContain('bing');
    expect(providers).toContain('duckduckgo');
    // Paid engines should NOT appear without keys
    expect(providers).not.toContain('brave');
    expect(providers).not.toContain('jina');
    expect(providers).not.toContain('serper');
    expect(providers).not.toContain('tavily');
  });

  it('includes brave when API key set', () => {
    configureSearch({ braveApiKey: 'test-key-123' });
    const providers = getAvailableProviders();
    expect(providers).toContain('brave');
    expect(providers).toContain('google'); // free engines still present
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
    // 3 free + 5 paid = 8
    expect(providers.length).toBe(8);
    for (const name of [
      'google',
      'bing',
      'duckduckgo',
      'brave',
      'searxng',
      'tavily',
      'serper',
      'jina',
    ] as ProviderName[]) {
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

  it('free engines always available regardless of config', () => {
    const providers = getAvailableProviders();
    expect(providers).toContain('google');
    expect(providers).toContain('bing');
    expect(providers).toContain('duckduckgo');
    expect(providers.filter(p => ['google', 'bing', 'duckduckgo'].includes(p)).length).toBe(3);
  });
});
