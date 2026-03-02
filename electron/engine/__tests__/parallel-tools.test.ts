/**
 * parallel-tools tests
 */
import { describe, it, expect } from 'vitest';
import { buildExecutionPlan, canParallelize, estimateToolDuration } from '../parallel-tools';

describe('buildExecutionPlan', () => {
  it('returns single batch for single tool', () => {
    const plan = buildExecutionPlan([{ id: '1', name: 'read_file', arguments: { path: 'a.ts' } }]);
    expect(plan.batches.length).toBe(1);
    expect(plan.hasParallelism).toBe(false);
  });

  it('parallelizes multiple read-only tools', () => {
    const plan = buildExecutionPlan([
      { id: '1', name: 'read_file', arguments: { path: 'a.ts' } },
      { id: '2', name: 'search_files', arguments: { pattern: 'TODO' } },
      { id: '3', name: 'list_files', arguments: { path: '.' } },
    ]);
    expect(plan.batches.length).toBe(1); // all in one parallel batch
    expect(plan.batches[0].length).toBe(3);
    expect(plan.hasParallelism).toBe(true);
    expect(plan.estimatedTimeSavedMs).toBeGreaterThan(0);
  });

  it('serializes write tools', () => {
    const plan = buildExecutionPlan([
      { id: '1', name: 'read_file', arguments: { path: 'a.ts' } },
      { id: '2', name: 'write_file', arguments: { path: 'b.ts', content: 'x' } },
      { id: '3', name: 'read_file', arguments: { path: 'c.ts' } },
    ]);
    // read_file(a.ts) is parallel-eligible but write_file forces serial
    expect(plan.batches.length).toBeGreaterThanOrEqual(2);
  });

  it('detects dependency: write then read same file', () => {
    const plan = buildExecutionPlan([
      { id: '1', name: 'write_file', arguments: { path: 'src/app.ts', content: 'new code' } },
      { id: '2', name: 'read_file', arguments: { path: 'src/app.ts' } },
    ]);
    expect(plan.batches.length).toBe(2); // serial because of dependency
  });

  it('parallelizes multiple web searches', () => {
    const plan = buildExecutionPlan([
      { id: '1', name: 'web_search', arguments: { query: 'react' } },
      { id: '2', name: 'web_search', arguments: { query: 'vue' } },
      { id: '3', name: 'web_search', arguments: { query: 'angular' } },
    ]);
    expect(plan.batches.length).toBe(1);
    expect(plan.batches[0].length).toBe(3);
    expect(plan.hasParallelism).toBe(true);
  });

  it('handles mixed read + write correctly', () => {
    const plan = buildExecutionPlan([
      { id: '1', name: 'search_files', arguments: { pattern: 'import' } },
      { id: '2', name: 'read_file', arguments: { path: 'a.ts' } },
      { id: '3', name: 'edit_file', arguments: { path: 'b.ts', old_string: 'x', new_string: 'y' } },
      { id: '4', name: 'read_file', arguments: { path: 'c.ts' } },
    ]);
    // First 2 reads parallel, then edit serial, then read parallel
    expect(plan.batches[0].length).toBe(2); // search_files + read_file
  });
});

describe('canParallelize', () => {
  it('returns false for single tool', () => {
    expect(canParallelize([{ id: '1', name: 'read_file', arguments: {} }])).toBe(false);
  });

  it('returns true for multiple read-only tools', () => {
    expect(canParallelize([
      { id: '1', name: 'read_file', arguments: {} },
      { id: '2', name: 'search_files', arguments: {} },
    ])).toBe(true);
  });

  it('returns false for all write tools', () => {
    expect(canParallelize([
      { id: '1', name: 'write_file', arguments: {} },
      { id: '2', name: 'edit_file', arguments: {} },
    ])).toBe(false);
  });
});

describe('estimateToolDuration', () => {
  it('returns known estimates', () => {
    expect(estimateToolDuration('read_file')).toBe(50);
    expect(estimateToolDuration('web_search')).toBe(2000);
    expect(estimateToolDuration('run_test')).toBe(10000);
  });

  it('returns default for unknown tools', () => {
    expect(estimateToolDuration('custom_tool')).toBe(1000);
  });
});
