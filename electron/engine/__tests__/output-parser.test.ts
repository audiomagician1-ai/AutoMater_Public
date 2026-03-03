import { describe, it, expect } from 'vitest';
import {
  parseStructuredOutput,
  PM_FEATURE_SCHEMA,
  QA_VERDICT_SCHEMA,
  PLAN_STEPS_SCHEMA,
  PM_ACCEPTANCE_SCHEMA,
  } from '../output-parser';

// Helper types for test assertions
type FeatureItem = Record<string, unknown>;
type VerdictObj = Record<string, unknown>;
type StepItem = Record<string, unknown>;

// ═══════════════════════════════════════
// 策略 1: 直接 JSON parse
// ═══════════════════════════════════════

describe('parseStructuredOutput — direct parse', () => {
  it('parses clean JSON array directly', () => {
    const raw = JSON.stringify([{ id: 'F-1', title: 'Login', description: 'User login' }]);
    const result = parseStructuredOutput<FeatureItem[]>(raw, PM_FEATURE_SCHEMA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.strategy).toBe('direct');
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('F-1');
    }
  });

  it('parses clean JSON object directly', () => {
    const raw = JSON.stringify({ verdict: 'pass', score: 90, summary: 'Looks good' });
    const result = parseStructuredOutput<VerdictObj>(raw, QA_VERDICT_SCHEMA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.strategy).toBe('direct');
      expect(result.data.verdict).toBe('pass');
      expect(result.data.score).toBe(90);
    }
  });
});

// ═══════════════════════════════════════
// 策略 2: Markdown 代码块剥离
// ═══════════════════════════════════════

describe('parseStructuredOutput — markdown strip', () => {
  it('extracts JSON from ```json code block', () => {
    const raw = `Here is my analysis:

\`\`\`json
[{"id": "F-1", "title": "Auth", "description": "Authentication module"}]
\`\`\`

Let me know if you need more details.`;
    const result = parseStructuredOutput<FeatureItem[]>(raw, PM_FEATURE_SCHEMA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.strategy).toBe('markdown_strip');
      expect(result.data).toHaveLength(1);
    }
  });

  it('extracts from ``` block without language tag', () => {
    const raw = `\`\`\`
{"verdict": "fail", "score": 30, "summary": "Missing tests"}
\`\`\``;
    const result = parseStructuredOutput<VerdictObj>(raw, QA_VERDICT_SCHEMA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verdict).toBe('fail');
    }
  });
});

// ═══════════════════════════════════════
// 策略 3: 贪心括号匹配
// ═══════════════════════════════════════

describe('parseStructuredOutput — bracket match', () => {
  it('extracts JSON from surrounding text', () => {
    const raw = `I'll create these features:
[{"id": "F-1", "title": "Setup", "description": "Project setup"}]
That should cover the requirements.`;
    const result = parseStructuredOutput<FeatureItem[]>(raw, PM_FEATURE_SCHEMA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0].id).toBe('F-1');
    }
  });

  it('handles nested brackets correctly', () => {
    const raw = `Result: {"verdict": "pass", "score": 85, "summary": "Good with {minor} issues", "issues": ["a", "b"]}`;
    const result = parseStructuredOutput<VerdictObj>(raw, QA_VERDICT_SCHEMA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.score).toBe(85);
    }
  });
});

// ═══════════════════════════════════════
// Schema 校验 + 修复
// ═══════════════════════════════════════

describe('parseStructuredOutput — schema validation & repair', () => {
  it('wraps single object into array when array expected', () => {
    const raw = JSON.stringify({ id: 'F-1', title: 'Solo', description: 'Only feature' });
    const result = parseStructuredOutput<FeatureItem[]>(raw, PM_FEATURE_SCHEMA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.warnings).toContain('Wrapped single object into array');
    }
  });

  it('applies default values for missing optional fields', () => {
    const raw = JSON.stringify([{ id: 'F-1', title: 'Test', description: 'Desc' }]);
    const result = parseStructuredOutput<FeatureItem[]>(raw, PM_FEATURE_SCHEMA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0].category).toBe('core');
      expect(result.data[0].priority).toBe(1);
      expect(result.data[0].dependsOn).toEqual([]);
    }
  });

  it('coerces string to number', () => {
    const raw = JSON.stringify({ verdict: 'pass', score: '85', summary: 'OK' });
    const result = parseStructuredOutput<VerdictObj>(raw, QA_VERDICT_SCHEMA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.score).toBe(85);
      expect(typeof result.data.score).toBe('number');
    }
  });

  it('clamps number to min/max range', () => {
    const raw = JSON.stringify({ verdict: 'pass', score: 150, summary: 'Over 100' });
    const result = parseStructuredOutput<VerdictObj>(raw, QA_VERDICT_SCHEMA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.score).toBe(100);
    }
  });

  it('falls back to enum default for invalid values', () => {
    const raw = JSON.stringify({ verdict: 'maybe', score: 50, summary: 'Unsure' });
    const result = parseStructuredOutput<VerdictObj>(raw, QA_VERDICT_SCHEMA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verdict).toBe('fail'); // default
    }
  });

  it('truncates array exceeding maxItems', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      description: `Step ${i}`, tool: 'read_file',
    }));
    const raw = JSON.stringify(items);
    const result = parseStructuredOutput<StepItem[]>(raw, PLAN_STEPS_SCHEMA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.length).toBeLessThanOrEqual(15);
    }
  });
});

// ═══════════════════════════════════════
// 失败场景
// ═══════════════════════════════════════

describe('parseStructuredOutput — failure cases', () => {
  it('fails on completely non-JSON text', () => {
    const raw = 'I think we should build a login system first and then add the dashboard.';
    const result = parseStructuredOutput<FeatureItem[]>(raw, PM_FEATURE_SCHEMA);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.strategiesAttempted.length).toBe(4);
      expect(result.rawPreview).toBeTruthy();
    }
  });

  it('fails when array is empty and minItems > 0', () => {
    const raw = '[]';
    const result = parseStructuredOutput<FeatureItem[]>(raw, PM_FEATURE_SCHEMA);
    expect(result.ok).toBe(false);
  });

  it('fails when wrong top-level type', () => {
    const raw = '"just a string"';
    const result = parseStructuredOutput<FeatureItem[]>(raw, PM_FEATURE_SCHEMA);
    expect(result.ok).toBe(false);
  });
});

// ═══════════════════════════════════════
// PM Acceptance Schema
// ═══════════════════════════════════════

describe('PM_ACCEPTANCE_SCHEMA', () => {
  it('parses accept verdict', () => {
    const raw = JSON.stringify({
      verdict: 'accept', score: 92,
      summary: 'All criteria met',
      feedback: 'Well done',
    });
    const result = parseStructuredOutput<VerdictObj>(raw, PM_ACCEPTANCE_SCHEMA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verdict).toBe('accept');
    }
  });

  it('defaults invalid verdict to reject', () => {
    const raw = JSON.stringify({ verdict: 'dunno', score: 50, summary: 'Unclear' });
    const result = parseStructuredOutput<VerdictObj>(raw, PM_ACCEPTANCE_SCHEMA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verdict).toBe('reject');
    }
  });
});
