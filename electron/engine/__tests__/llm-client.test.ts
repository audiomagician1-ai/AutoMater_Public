import { describe, it, expect } from 'vitest';
import { NonRetryableError, calcCost, MODEL_PRICING } from '../llm-client';

// ═══════════════════════════════════════
// NonRetryableError
// ═══════════════════════════════════════

describe('NonRetryableError', () => {
  it('is an instance of Error', () => {
    const err = new NonRetryableError('model not found', 404);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NonRetryableError);
  });

  it('preserves name, message, and statusCode', () => {
    const err = new NonRetryableError('Invalid API key', 401);
    expect(err.name).toBe('NonRetryableError');
    expect(err.message).toBe('Invalid API key');
    expect(err.statusCode).toBe(401);
  });

  it('can be caught by instanceof check', () => {
    let caught = false;
    try {
      throw new NonRetryableError('forbidden', 403);
    } catch (e) {
      if (e instanceof NonRetryableError) {
        caught = true;
        expect(e.statusCode).toBe(403);
      }
    }
    expect(caught).toBe(true);
  });
});

// ═══════════════════════════════════════
// calcCost — 定价计算
// ═══════════════════════════════════════

describe('calcCost', () => {
  it('uses built-in pricing for known models', () => {
    const pricing = MODEL_PRICING['gpt-4o'];
    const cost = calcCost('gpt-4o', 1000, 1000);
    const expected = (1000 / 1000) * pricing.input + (1000 / 1000) * pricing.output;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it('uses custom pricing when provided', () => {
    const custom = { 'my-model': { input: 0.001, output: 0.002 } };
    const cost = calcCost('my-model', 2000, 3000, custom);
    expect(cost).toBeCloseTo((2000 / 1000) * 0.001 + (3000 / 1000) * 0.002, 6);
  });

  it('custom pricing overrides built-in pricing', () => {
    const custom = { 'gpt-4o': { input: 0.05, output: 0.1 } };
    const cost = calcCost('gpt-4o', 1000, 1000, custom);
    expect(cost).toBeCloseTo(0.05 + 0.1, 6);
  });

  it('falls back to default pricing for unknown models', () => {
    const cost = calcCost('unknown-model-xyz', 1000, 1000);
    // FALLBACK_PRICING = { input: 0.002, output: 0.008 }
    expect(cost).toBeCloseTo(0.002 + 0.008, 6);
  });

  it('handles zero tokens', () => {
    expect(calcCost('gpt-4o', 0, 0)).toBe(0);
  });

  it('scales linearly with token count', () => {
    const cost1k = calcCost('gpt-4o-mini', 1000, 1000);
    const cost2k = calcCost('gpt-4o-mini', 2000, 2000);
    expect(cost2k).toBeCloseTo(cost1k * 2, 6);
  });
});

// ═══════════════════════════════════════
// MODEL_PRICING sanity checks
// ═══════════════════════════════════════

describe('MODEL_PRICING', () => {
  it('has entries for major models', () => {
    expect(MODEL_PRICING['gpt-4o']).toBeDefined();
    expect(MODEL_PRICING['gpt-4o-mini']).toBeDefined();
    expect(MODEL_PRICING['claude-sonnet-4-20250514']).toBeDefined();
    expect(MODEL_PRICING['deepseek-chat']).toBeDefined();
  });

  it('all pricing entries have positive input and output values', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.input, `${model} input`).toBeGreaterThan(0);
      expect(pricing.output, `${model} output`).toBeGreaterThan(0);
    }
  });

  it('output pricing >= input pricing for all models', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.output, `${model} output >= input`).toBeGreaterThanOrEqual(pricing.input);
    }
  });
});
