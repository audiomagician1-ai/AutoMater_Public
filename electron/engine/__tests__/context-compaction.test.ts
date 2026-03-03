/**
 * Tests for context-compaction.ts — 对话压缩 + 工具结果裁剪
 */
import { describe, it, expect } from 'vitest';
import { needsCompaction, compactMessages, trimToolResult, compressFileContent } from '../context-compaction';

// ═══════════════════════════════════════
// needsCompaction
// ═══════════════════════════════════════

describe('needsCompaction', () => {
  const mkMsg = (len: number) => ({ role: 'user', content: 'x'.repeat(len) });

  it('returns false when total tokens below threshold', () => {
    // 150 chars ÷ 1.5 = 100 tokens; budget=1000, threshold=0.75 → 750
    expect(needsCompaction([mkMsg(150)], 1000)).toBe(false);
  });

  it('returns true when total tokens exceed threshold', () => {
    // 1200 chars ÷ 1.5 = 800 tokens > 1000*0.75=750
    expect(needsCompaction([mkMsg(1200)], 1000)).toBe(true);
  });

  it('sums across multiple messages', () => {
    const msgs = Array.from({ length: 10 }, () => mkMsg(120)); // 10*120=1200 chars → 800 tok
    expect(needsCompaction(msgs, 1000)).toBe(true);
  });

  it('respects custom threshold', () => {
    // 600 chars → 400 tok; budget=1000, threshold=0.3 → 300; 400>300 → true
    expect(needsCompaction([mkMsg(600)], 1000, 0.3)).toBe(true);
    expect(needsCompaction([mkMsg(600)], 1000, 0.5)).toBe(false);
  });

  it('returns false for empty messages', () => {
    expect(needsCompaction([], 1000)).toBe(false);
  });
});

// ═══════════════════════════════════════
// compactMessages
// ═══════════════════════════════════════

describe('compactMessages', () => {
  it('returns messages unchanged when within budget', async () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const result = await compactMessages(msgs, 100000);
    expect(result.messages).toEqual(msgs);
    expect(result.ratio).toBe(1.0);
    expect(result.usedLLM).toBe(false);
  });

  it('compresses middle messages when over budget', async () => {
    const msgs = [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: `Step ${i}: ${'x'.repeat(200)}\nAction: doing stuff\n${'detail line\n'.repeat(10)}`,
      })),
    ];
    // Small budget to force compaction
    const result = await compactMessages(msgs, 100, 4);
    expect(result.messages.length).toBeLessThan(msgs.length);
    expect(result.messages[0].role).toBe('system');
    expect(result.tokensAfter).toBeLessThanOrEqual(result.tokensBefore);
    expect(result.usedLLM).toBe(false);
  });

  it('preserves system message and recent messages', async () => {
    const msgs = [
      { role: 'system', content: 'sys prompt' },
      ...Array.from({ length: 12 }, (_, i) => ({
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: 'x'.repeat(500),
      })),
    ];
    const keepRecent = 4;
    const result = await compactMessages(msgs, 100, keepRecent);
    // System + compaction summary + keepRecent messages
    expect(result.messages[0].content).toBe('sys prompt');
    expect(result.messages[1].content).toContain('[Compaction Summary');
    // Last N messages preserved
    const last4Original = msgs.slice(-keepRecent);
    const last4Result = result.messages.slice(-keepRecent);
    expect(last4Result).toEqual(last4Original);
  });

  it('uses LLM summarizer when provided and middle text is large', async () => {
    // Each message has many key lines (## titles, Action:, Error, Step) to ensure
    // the compressed middleText exceeds 2000 tokens (3000 chars).
    const msgs = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 60 }, (_, i) => ({
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: Array.from({ length: 15 }, (_, j) =>
          `## Section ${i}-${j}\nAction: doing step ${i}-${j}\nStep ${j} completed\nError in line ${j}\nwrite_file path/file${j}.ts`
        ).join('\n'),
      })),
    ];
    let llmCalled = false;
    const mockSummarize = async (_text: string) => {
      llmCalled = true;
      return 'LLM summary';
    };
    const result = await compactMessages(msgs, 100, 4, mockSummarize);
    expect(llmCalled).toBe(true);
    expect(result.usedLLM).toBe(true);
    expect(result.messages.some(m => m.content.includes('LLM summary'))).toBe(true);
  });

  it('falls back to deterministic when LLM throws', async () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 60 }, (_, i) => ({
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: Array.from({ length: 15 }, (_, j) =>
          `## Section ${i}-${j}\nAction: step ${j}\nStep ${j} done\nError at ${j}`
        ).join('\n'),
      })),
    ];
    const failSummarize = async () => { throw new Error('LLM down'); };
    const result = await compactMessages(msgs, 100, 4, failSummarize);
    expect(result.usedLLM).toBe(false);
  });

  it('handles no middle section (all recent)', async () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'x'.repeat(3000) },
      { role: 'assistant', content: 'y'.repeat(3000) },
    ];
    const result = await compactMessages(msgs, 100, 6);
    // keepRecent=6 >= non-system count → no middle → no compression
    expect(result.ratio).toBe(1.0);
  });
});

// ═══════════════════════════════════════
// trimToolResult
// ═══════════════════════════════════════

describe('trimToolResult', () => {
  it('returns short content unchanged', () => {
    const short = 'Hello world';
    expect(trimToolResult(short)).toBe(short);
  });

  it('returns content unchanged when within maxTokens', () => {
    const content = 'x'.repeat(4500); // 3000 * 1.5 = 4500 chars
    expect(trimToolResult(content, 3000)).toBe(content);
  });

  it('trims content exceeding maxTokens', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}: ${'data'.repeat(10)}`);
    const content = lines.join('\n');
    const result = trimToolResult(content, 500); // 500*1.5=750 char limit
    expect(result.length).toBeLessThanOrEqual(content.length);
    expect(result).toContain('省略');
  });

  it('preserves error lines in trimmed output', () => {
    // Use enough data to exceed charLimit (200*1.5=300 chars)
    // and place error lines in the middle section that would be trimmed
    const lines = [
      ...Array.from({ length: 100 }, (_, i) => `line ${i}: normal output data padding extra text here`),
      'CRITICAL Error: something broke badly',
      'warning: deprecated API used',
      ...Array.from({ length: 100 }, (_, i) => `tail ${i}: more output data padding extra text here`),
    ];
    const content = lines.join('\n');
    const result = trimToolResult(content, 3000);
    // With 3000 token budget (4500 chars), content is ~7000 chars, so trimming happens
    // Error lines should be preserved in the error section
    expect(result).toContain('Error: something broke');
    expect(result).toContain('关键错误/警告');
  });

  it('enforces hard character limit on trimmed output', () => {
    // Very large content, very small budget
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}: ${'data'.repeat(50)}`);
    const content = lines.join('\n');
    const result = trimToolResult(content, 100);
    expect(result.length).toBeLessThanOrEqual(100 * 1.5 + 50); // charLimit + overflow
  });
});

// ═══════════════════════════════════════
// compressFileContent
// ═══════════════════════════════════════

describe('compressFileContent', () => {
  it('returns short content unchanged', () => {
    const content = 'import foo from "bar";\nexport const x = 1;';
    expect(compressFileContent(content, 50)).toBe(content);
  });

  it('extracts structural lines from TypeScript', () => {
    const lines = [
      'import fs from "fs";',
      'import path from "path";',
      '',
      '/**',
      ' * Main function',
      ' */',
      'export function doStuff(): void {',
      '  const x = 1;',
      '  const y = 2;',
      '  if (x > y) {',
      '    console.log("hello");',
      '  }',
      '  for (let i = 0; i < 10; i++) {',
      '    doSomething(i);',
      '  }',
      '}',
      '',
      'export const CONFIG = {',
      '  key: "value",',
      '};',
      '',
      'interface MyInterface {',
      '  field: string;',
      '}',
      '',
      'class MyClass {',
      '  constructor() {}',
      '}',
      '',
      'type MyType = string | number;',
      '',
      // Extra lines to exceed maxLines
      ...Array.from({ length: 40 }, (_, i) => `  // internal line ${i}`),
    ];
    const content = lines.join('\n');
    const result = compressFileContent(content, 15);
    expect(result).toContain('import fs');
    expect(result).toContain('export function doStuff');
    expect(result).toContain('export const CONFIG');
    expect(result).toContain('interface MyInterface');
    expect(result).toContain('class MyClass');
    expect(result).toContain('type MyType');
    expect(result).toContain('已压缩');
  });

  it('falls back to head+tail when no structural lines', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `  random_data_${i} = ${i * 42}`);
    const content = lines.join('\n');
    const result = compressFileContent(content, 10);
    expect(result).toContain('random_data_0');
    expect(result).toContain('已压缩');
  });

  it('respects maxLines limit', () => {
    const lines = [
      ...Array.from({ length: 100 }, (_, i) => `import mod${i} from "mod${i}";`),
      ...Array.from({ length: 100 }, (_, i) => `  body line ${i}`),
    ];
    const content = lines.join('\n');
    const result = compressFileContent(content, 20);
    // Should have at most ~20 structural lines + the compression note
    const resultLines = result.split('\n').filter(l => l.trim().length > 0);
    expect(resultLines.length).toBeLessThanOrEqual(25);
  });
});
