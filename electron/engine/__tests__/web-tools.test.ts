/**
 * web-tools.ts tests — webSearch, webSearchBoost, fetchUrl, httpRequest
 *
 * All external I/O is mocked via search-provider mock + fetch mock
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock search-provider — vi.mock is hoisted, so we use vi.hoisted() for shared mocks
const { mockSearch, mockSearchBoost, mockReadUrl } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockSearchBoost: vi.fn(),
  mockReadUrl: vi.fn(),
}));

vi.mock('../search-provider', () => ({
  search: mockSearch,
  searchBoost: mockSearchBoost,
  readUrl: mockReadUrl,
  configureSearch: vi.fn(),
  getAvailableProviders: vi.fn(() => ['brave', 'searxng']),
}));

// Mock research-cache to prevent cache interference in tests
vi.mock('../research-cache', () => ({
  getResearchCache: () => ({
    lookup: () => ({ hit: false }),
    store: vi.fn(),
  }),
}));

import { webSearch, webSearchBoost, fetchUrl, httpRequest, configureSearch, getAvailableProviders } from '../web-tools';

describe('webSearch', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns search results from provider', async () => {
    mockSearch.mockResolvedValueOnce({
      success: true,
      content: 'result markdown',
      results: [{ title: 'Test', url: 'https://example.com', snippet: 'A snippet' }],
    });

    const result = await webSearch('test query');
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe('Test');
    expect(result.content).toBe('result markdown');
    expect(mockSearch).toHaveBeenCalledWith('test query', 8);
  });

  it('passes custom maxResults', async () => {
    mockSearch.mockResolvedValueOnce({ success: true, content: '', results: [] });
    await webSearch('query', 5);
    expect(mockSearch).toHaveBeenCalledWith('query', 5);
  });

  it('truncates content to 12000 chars', async () => {
    const longContent = 'a'.repeat(20000);
    mockSearch.mockResolvedValueOnce({ success: true, content: longContent, results: [] });
    const result = await webSearch('query');
    expect(result.content.length).toBe(12000);
  });

  it('forwards errors from provider', async () => {
    mockSearch.mockResolvedValueOnce({
      success: false, content: '', results: [], error: 'API key invalid',
    });
    const result = await webSearch('query');
    expect(result.success).toBe(false);
    expect(result.error).toBe('API key invalid');
  });
});

describe('webSearchBoost', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns merged results with provider info', async () => {
    mockSearchBoost.mockResolvedValueOnce({
      success: true,
      content: 'boosted results',
      results: [
        { title: 'R1', url: 'https://r1.com', snippet: 's1' },
        { title: 'R2', url: 'https://r2.com', snippet: 's2' },
      ],
      provider: 'brave+searxng',
    });

    const result = await webSearchBoost('important query');
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.provider).toBe('brave+searxng');
    expect(mockSearchBoost).toHaveBeenCalledWith('important query', 15);
  });

  it('truncates content to 15000 chars', async () => {
    const longContent = 'b'.repeat(25000);
    mockSearchBoost.mockResolvedValueOnce({ success: true, content: longContent, results: [], provider: 'test' });
    const result = await webSearchBoost('query');
    expect(result.content.length).toBe(15000);
  });
});

describe('fetchUrl', () => {
  afterEach(() => vi.clearAllMocks());

  it('delegates to readUrl from search-provider', async () => {
    mockReadUrl.mockResolvedValueOnce({
      success: true, content: '# Page Title\nContent here', title: 'Page Title', length: 26,
    });
    const result = await fetchUrl('https://example.com');
    expect(result.success).toBe(true);
    expect(result.title).toBe('Page Title');
    expect(mockReadUrl).toHaveBeenCalledWith('https://example.com', 15000);
  });

  it('passes custom maxLength', async () => {
    mockReadUrl.mockResolvedValueOnce({ success: true, content: '', title: '', length: 0 });
    await fetchUrl('https://example.com', 5000);
    expect(mockReadUrl).toHaveBeenCalledWith('https://example.com', 5000);
  });
});

describe('httpRequest', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('makes GET request by default', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '{"data": "test"}',
      headers: new Map([['content-type', 'application/json']]),
    });

    const result = await httpRequest({ url: 'https://api.example.com/test' });
    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toContain('data');
  });

  it('makes POST request with body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => '{"id": 1}',
      headers: new Map([['content-type', 'application/json']]),
    });

    const result = await httpRequest({
      url: 'https://api.example.com/items',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name": "test"}',
    });
    expect(result.success).toBe(true);
    expect(result.status).toBe(201);

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].method).toBe('POST');
    expect(fetchCall[1].body).toBe('{"name": "test"}');
  });

  it('does not include body for GET requests', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, text: async () => '', headers: new Map(),
    });

    await httpRequest({ url: 'https://api.example.com', method: 'GET', body: 'should-be-ignored' });
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].body).toBeUndefined();
  });

  it('truncates response body over 10000 chars', async () => {
    const longBody = 'x'.repeat(15000);
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, text: async () => longBody, headers: new Map(),
    });

    const result = await httpRequest({ url: 'https://api.example.com' });
    expect(result.body.length).toBeLessThan(15000);
    expect(result.body).toContain('截断');
  });

  it('returns error on fetch failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await httpRequest({ url: 'https://unreachable.com' });
    expect(result.success).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('caps timeout to 60000ms', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, text: async () => 'ok', headers: new Map(),
    });

    await httpRequest({ url: 'https://api.example.com', timeout: 999999 });
    // Should not throw — timeout is capped internally
    expect((globalThis.fetch as any).mock.calls.length).toBe(1);
  });

  it('handles non-ok status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false, status: 404, text: async () => 'Not Found', headers: new Map(),
    });

    const result = await httpRequest({ url: 'https://api.example.com/missing' });
    expect(result.success).toBe(false);
    expect(result.status).toBe(404);
    expect(result.body).toBe('Not Found');
  });
});

describe('re-exports', () => {
  it('re-exports configureSearch', () => {
    expect(typeof configureSearch).toBe('function');
  });

  it('re-exports getAvailableProviders', () => {
    expect(typeof getAvailableProviders).toBe('function');
  });
});
