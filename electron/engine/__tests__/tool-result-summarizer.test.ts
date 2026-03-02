/**
 * tool-result-summarizer tests
 */
import { describe, it, expect } from 'vitest';
import { summarizeToolResult, summarizeHistoryToolOutputs } from '../tool-result-summarizer';

describe('summarizeToolResult', () => {
  it('returns short output unchanged', () => {
    const result = summarizeToolResult('read_file', 'short content');
    expect(result.wasSummarized).toBe(false);
    expect(result.text).toBe('short content');
    expect(result.compressionRatio).toBe(0);
  });

  it('summarizes long code search results', () => {
    const lines = Array.from({ length: 200 }, (_, i) =>
      `src/file${i % 10}.ts:${i}: const x${i} = something_very_long_that_repeats;`
    ).join('\n');
    const result = summarizeToolResult('code_search', lines);
    expect(result.wasSummarized).toBe(true);
    expect(result.compressionRatio).toBeGreaterThan(0.1);
    expect(result.text).toContain('匹配');
  });

  it('summarizes command output with errors first', () => {
    const output = [
      'Building...',
      ...Array.from({ length: 200 }, (_, i) => `Compiling module ${i} with dependency resolution and additional verbose information that makes each line much longer`),
      'ERROR: Cannot find module "express"',
      'ERROR: TypeScript error at line 42',
      'Build failed with 2 errors',
    ].join('\n');
    const result = summarizeToolResult('run_command', output, { success: false });
    expect(result.wasSummarized).toBe(true);
    expect(result.text).toContain('错误');
    expect(result.text).toContain('Cannot find module');
  });

  it('summarizes web search results with dedup', () => {
    const output = [
      '1. React Hooks Guide',
      'https://react.dev/hooks',
      'Learn about React Hooks and how to use them effectively in your React applications',
      '',
      '2. React Hooks Tutorial',
      'https://react.dev/hooks',
      'Another description of the same URL that should be deduplicated',
      '',
      '3. Different Resource',
      'https://example.com/react',
      'A different resource about React that has unique content and a different URL',
      '',
      ...Array.from({ length: 100 }, (_, i) => `${i + 4}. Article ${i}\nhttps://site${i}.com/article\nDescription for article ${i} with lots of detailed content and extra verbose text to ensure total length exceeds limit\n`),
    ].join('\n');
    const result = summarizeToolResult('web_search', output);
    expect(result.text).toContain('结果');
  });

  it('uses budget-aware limits', () => {
    const longContent = 'x'.repeat(20000);
    const normal = summarizeToolResult('read_file', longContent, { budgetStatus: 'normal' });
    const critical = summarizeToolResult('read_file', longContent, { budgetStatus: 'critical' });
    expect(critical.text.length).toBeLessThan(normal.text.length);
  });

  it('summarizes browser snapshot by extracting interactive elements', () => {
    const snapshot = [
      'heading "Welcome to the application"',
      ...Array.from({ length: 100 }, (_, i) => `paragraph "Content block ${i} with lots of text that needs to be long enough to exceed the character limit for browser snapshots and force summarization to trigger"`),
      'button "Submit Form"',
      'link "Home Page"',
      'textbox "Email Address"',
      'button "Cancel Action"',
    ].join('\n');
    const result = summarizeToolResult('browser_snapshot', snapshot);
    // browser_snapshot 基准限制 3000 chars, snapshot 超过后触发摘要
    expect(result.wasSummarized).toBe(true);
    expect(result.text).toContain('交互');
    expect(result.text).toContain('Submit');
  });
});

describe('summarizeHistoryToolOutputs', () => {
  it('summarizes long tool outputs in message history', () => {
    const messages = [
      { role: 'system', content: 'You are a helper' },
      { role: 'user', content: 'Fix the bug' },
      { role: 'tool', content: 'x'.repeat(10000), tool_call_id: 'tc1' },
      { role: 'tool', content: 'short', tool_call_id: 'tc2' },
    ];
    const { toolsSummarized, charsSaved } = summarizeHistoryToolOutputs(messages, 'warning');
    expect(toolsSummarized).toBe(1); // only the long one
    expect(charsSaved).toBeGreaterThan(0);
    expect((messages[2].content as string).length).toBeLessThan(10000);
  });

  it('skips non-tool messages', () => {
    const messages = [
      { role: 'user', content: 'x'.repeat(5000) },
    ];
    const { toolsSummarized } = summarizeHistoryToolOutputs(messages);
    expect(toolsSummarized).toBe(0);
  });
});
