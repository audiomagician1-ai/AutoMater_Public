/// <reference types="vitest" />
/**
 * Unit tests for EvolutionMutator
 *
 * Tests cover:
 *  1. Target file resolution (glob patterns)
 *  2. File reading with truncation
 *  3. Strategy selection based on fitness/memory
 *  4. Proposal parsing (JSON + markdown formats)
 *  5. Proposal validation (immutable file protection, max files, empty content)
 *  6. Mutation prompt building
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EvolutionMutator, EVOLUTION_SCOPES, type MutationProposal, type MutationStrategy } from '../evolution-mutator';
import type { FitnessResult, EvolutionMemoryEntry } from '../self-evolution-engine';

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

let tmpDir: string;

function createTestDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutator-test-'));
  // Create directory structure
  fs.mkdirSync(path.join(dir, 'electron', 'engine', 'tool-defs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'components'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });

  // Create files
  fs.writeFileSync(path.join(dir, 'electron', 'engine', 'prompts.ts'), 'export const PM_PROMPT = "You are a PM";\n');
  fs.writeFileSync(path.join(dir, 'electron', 'engine', 'constants.ts'), 'export const MAX_ITER = 50;\n');
  fs.writeFileSync(path.join(dir, 'electron', 'engine', 'tool-defs', 'dev-tools.ts'), 'export const DEV_TOOLS = [];\n');
  fs.writeFileSync(path.join(dir, 'electron', 'engine', 'tool-defs', 'qa-tools.ts'), 'export const QA_TOOLS = [];\n');
  fs.writeFileSync(path.join(dir, 'src', 'components', 'App.tsx'), 'export function App() { return <div/>; }\n');
  fs.writeFileSync(path.join(dir, 'vitest.config.ts'), 'export default {};\n');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'quality-gate.js'), '// gate\n');

  return dir;
}

function cleanup(): void {
  if (tmpDir && fs.existsSync(tmpDir)) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
}

function mockFitness(overrides: Partial<FitnessResult> = {}): FitnessResult {
  return {
    score: 0.7,
    tscPassed: true,
    tscErrors: 0,
    testPassRate: 1.0,
    totalTests: 100,
    passedTests: 100,
    failedTests: 0,
    statementCoverage: 30,
    baselineCoverage: 25,
    durations: { tsc: 1000, vitest: 2000, total: 3000 },
    details: 'mock',
    ...overrides,
  };
}

// ═══════════════════════════════════════
// 1. Target File Resolution
// ═══════════════════════════════════════

describe('EvolutionMutator.resolveTargetFiles', () => {
  beforeEach(() => {
    tmpDir = createTestDir();
  });
  afterEach(cleanup);

  it('should resolve exact file paths', () => {
    const mutator = new EvolutionMutator(tmpDir);
    const files = mutator.resolveTargetFiles(['electron/engine/prompts.ts']);
    expect(files).toContain('electron/engine/prompts.ts');
  });

  it('should resolve glob patterns (*.ts)', () => {
    const mutator = new EvolutionMutator(tmpDir);
    const files = mutator.resolveTargetFiles(['electron/engine/tool-defs/*.ts']);
    expect(files).toContain('electron/engine/tool-defs/dev-tools.ts');
    expect(files).toContain('electron/engine/tool-defs/qa-tools.ts');
  });

  it('should skip non-existent files', () => {
    const mutator = new EvolutionMutator(tmpDir);
    const files = mutator.resolveTargetFiles(['nonexistent.ts']);
    expect(files).toHaveLength(0);
  });

  it('should resolve conservative scope', () => {
    const mutator = new EvolutionMutator(tmpDir);
    const files = mutator.resolveTargetFiles([...EVOLUTION_SCOPES.conservative]);
    expect(files).toContain('electron/engine/prompts.ts');
    expect(files).toContain('electron/engine/constants.ts');
    expect(files).not.toContain('vitest.config.ts');
  });

  it('should resolve moderate scope with globs', () => {
    const mutator = new EvolutionMutator(tmpDir);
    const files = mutator.resolveTargetFiles([...EVOLUTION_SCOPES.moderate]);
    expect(files).toContain('electron/engine/prompts.ts');
    expect(files).toContain('electron/engine/tool-defs/dev-tools.ts');
  });

  it('should deduplicate files from overlapping patterns', () => {
    const mutator = new EvolutionMutator(tmpDir);
    const files = mutator.resolveTargetFiles([
      'electron/engine/prompts.ts',
      'electron/engine/prompts.ts', // duplicate
    ]);
    expect(files.filter(f => f === 'electron/engine/prompts.ts')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════
// 2. File Reading
// ═══════════════════════════════════════

describe('EvolutionMutator.readTargetFiles', () => {
  beforeEach(() => {
    tmpDir = createTestDir();
  });
  afterEach(cleanup);

  it('should read file contents', () => {
    const mutator = new EvolutionMutator(tmpDir);
    const contents = mutator.readTargetFiles(['electron/engine/prompts.ts'], 100);
    expect(contents.has('electron/engine/prompts.ts')).toBe(true);
    expect(contents.get('electron/engine/prompts.ts')).toContain('PM_PROMPT');
  });

  it('should truncate long files', () => {
    const mutator = new EvolutionMutator(tmpDir);
    // Create a long file
    const longContent = Array(200).fill('// line\n').join('');
    fs.writeFileSync(path.join(tmpDir, 'electron', 'engine', 'prompts.ts'), longContent);

    const contents = mutator.readTargetFiles(['electron/engine/prompts.ts'], 10);
    const content = contents.get('electron/engine/prompts.ts')!;
    expect(content).toContain('truncated');
    expect(content.split('\n').length).toBeLessThan(20);
  });

  it('should handle missing files gracefully', () => {
    const mutator = new EvolutionMutator(tmpDir);
    const contents = mutator.readTargetFiles(['nonexistent.ts'], 100);
    expect(contents.has('nonexistent.ts')).toBe(false);
  });
});

// ═══════════════════════════════════════
// 3. Strategy Selection
// ═══════════════════════════════════════

describe('EvolutionMutator.selectStrategy', () => {
  let mutator: EvolutionMutator;

  beforeEach(() => {
    tmpDir = createTestDir();
    mutator = new EvolutionMutator(tmpDir);
  });
  afterEach(cleanup);

  it('should prioritize bug_fix when tests fail', () => {
    const strategy = mutator.selectStrategy(mockFitness({ failedTests: 5, testPassRate: 0.95 }), []);
    expect(strategy).toBe('bug_fix');
  });

  it('should prioritize bug_fix when tsc fails', () => {
    const strategy = mutator.selectStrategy(mockFitness({ tscPassed: false }), []);
    expect(strategy).toBe('bug_fix');
  });

  it('should suggest test_coverage when coverage is low', () => {
    const strategy = mutator.selectStrategy(mockFitness({ statementCoverage: 20 }), []);
    expect(strategy).toBe('test_coverage');
  });

  it('should try prompt_improvement after successful prompt changes', () => {
    const strategy = mutator.selectStrategy(mockFitness({ statementCoverage: 40 }), [
      {
        pattern: 'accepted',
        outcome: 'success',
        module: 'prompts.ts',
        description: 'improved prompt clarity',
        fitnessImpact: 0.01,
        timestamp: Date.now(),
      },
    ]);
    expect(strategy).toBe('prompt_improvement');
  });

  it('should go conservative after many failures', () => {
    const failures: EvolutionMemoryEntry[] = Array(4)
      .fill(null)
      .map((_, i) => ({
        pattern: 'rejected',
        outcome: 'failure' as const,
        module: 'some.ts',
        description: `failed attempt ${i}`,
        fitnessImpact: -0.05,
        timestamp: Date.now() - i * 1000,
      }));
    const strategy = mutator.selectStrategy(mockFitness({ statementCoverage: 40 }), failures);
    expect(strategy).toBe('code_quality');
  });
});

// ═══════════════════════════════════════
// 4. Proposal Parsing
// ═══════════════════════════════════════

describe('EvolutionMutator.parseProposal', () => {
  let mutator: EvolutionMutator;

  beforeEach(() => {
    tmpDir = createTestDir();
    mutator = new EvolutionMutator(tmpDir);
  });
  afterEach(cleanup);

  it('should parse JSON format proposals', () => {
    const llmOutput = `Here is my proposal:

\`\`\`json
{
  "description": "Improve PM prompt clarity",
  "rationale": "The current PM prompt lacks specificity about output format",
  "fileChanges": [
    {
      "path": "electron/engine/prompts.ts",
      "content": "export const PM_PROMPT = 'You are an expert PM';\\n",
      "action": "write"
    }
  ]
}
\`\`\``;

    const proposal = mutator.parseProposal(llmOutput, 'prompt_improvement');
    expect(proposal.description).toBe('Improve PM prompt clarity');
    expect(proposal.rationale).toContain('specificity');
    expect(proposal.fileChanges).toHaveLength(1);
    expect(proposal.fileChanges[0].path).toBe('electron/engine/prompts.ts');
    expect(proposal.fileChanges[0].action).toBe('write');
  });

  it('should parse markdown format proposals', () => {
    const llmOutput = `## Description
Add error boundary to PM system prompt

## Rationale
Missing guidance for when PM encounters ambiguous requirements

### file: electron/engine/prompts.ts
\`\`\`typescript
export const PM_PROMPT = "You are an expert PM with error handling";
\`\`\`

### file: electron/engine/constants.ts
\`\`\`typescript
export const MAX_ITER = 100;
\`\`\``;

    const proposal = mutator.parseProposal(llmOutput, 'error_handling');
    expect(proposal.description).toBe('Add error boundary to PM system prompt');
    expect(proposal.fileChanges).toHaveLength(2);
    expect(proposal.fileChanges[0].path).toBe('electron/engine/prompts.ts');
    expect(proposal.fileChanges[1].path).toBe('electron/engine/constants.ts');
  });

  it('should fallback to strategy name when description missing', () => {
    const proposal = mutator.parseProposal('Some code here but no structure', 'performance');
    expect(proposal.description).toContain('performance');
  });
});

// ═══════════════════════════════════════
// 5. Proposal Validation
// ═══════════════════════════════════════

describe('EvolutionMutator.validateProposal', () => {
  let mutator: EvolutionMutator;

  beforeEach(() => {
    tmpDir = createTestDir();
    mutator = new EvolutionMutator(tmpDir);
  });
  afterEach(cleanup);

  it('should reject proposals with no file changes', () => {
    const proposal: MutationProposal = {
      description: 'Empty',
      strategy: 'code_quality',
      fileChanges: [],
      rationale: '',
      tokenUsage: { input: 0, output: 0 },
    };
    expect(() => mutator.validateProposal(proposal, 3)).toThrow('no file changes');
  });

  it('should reject proposals exceeding max files', () => {
    const proposal: MutationProposal = {
      description: 'Too many files',
      strategy: 'code_quality',
      fileChanges: [
        { path: 'a.ts', content: 'a', action: 'write' },
        { path: 'b.ts', content: 'b', action: 'write' },
        { path: 'c.ts', content: 'c', action: 'write' },
      ],
      rationale: '',
      tokenUsage: { input: 0, output: 0 },
    };
    expect(() => mutator.validateProposal(proposal, 2)).toThrow('exceeding limit');
  });

  it('should reject proposals modifying immutable files', () => {
    const proposal: MutationProposal = {
      description: 'Hack vitest config',
      strategy: 'code_quality',
      fileChanges: [{ path: 'vitest.config.ts', content: 'hacked', action: 'write' }],
      rationale: '',
      tokenUsage: { input: 0, output: 0 },
    };
    expect(() => mutator.validateProposal(proposal, 3)).toThrow('immutable');
  });

  it('should reject proposals with empty content', () => {
    const proposal: MutationProposal = {
      description: 'Empty content',
      strategy: 'code_quality',
      fileChanges: [{ path: 'src/foo.ts', content: '   ', action: 'write' }],
      rationale: '',
      tokenUsage: { input: 0, output: 0 },
    };
    expect(() => mutator.validateProposal(proposal, 3)).toThrow('empty content');
  });

  it('should accept valid proposals', () => {
    const proposal: MutationProposal = {
      description: 'Valid change',
      strategy: 'prompt_improvement',
      fileChanges: [{ path: 'electron/engine/prompts.ts', content: 'export const X = 1;\n', action: 'write' }],
      rationale: 'Improve PM prompt',
      tokenUsage: { input: 100, output: 200 },
    };
    expect(() => mutator.validateProposal(proposal, 3)).not.toThrow();
  });
});

// ═══════════════════════════════════════
// 6. Prompt Building
// ═══════════════════════════════════════

describe('EvolutionMutator.buildMutationPrompt', () => {
  let mutator: EvolutionMutator;

  beforeEach(() => {
    tmpDir = createTestDir();
    mutator = new EvolutionMutator(tmpDir);
  });
  afterEach(cleanup);

  it('should include fitness metrics in prompt', () => {
    const fileContents = new Map([['electron/engine/prompts.ts', 'export const X = 1;']]);
    const prompt = mutator.buildMutationPrompt(
      {
        sourceRoot: tmpDir,
        fitness: mockFitness(),
        memories: [],
        archive: [],
        allowedScope: ['electron/engine/prompts.ts'],
        maxFiles: 2,
      },
      'prompt_improvement',
      fileContents,
    );

    expect(prompt).toContain('prompt_improvement');
    expect(prompt).toContain('0.7000'); // fitness score
    expect(prompt).toContain('100/100'); // tests
    expect(prompt).toContain('30.0%'); // coverage
    expect(prompt).toContain('Target Files');
    expect(prompt).toContain('export const X = 1');
  });

  it('should include evolution memory when available', () => {
    const fileContents = new Map<string, string>();
    const prompt = mutator.buildMutationPrompt(
      {
        sourceRoot: tmpDir,
        fitness: mockFitness(),
        memories: [
          {
            pattern: 'accepted',
            outcome: 'success',
            module: 'prompts.ts',
            description: 'improved PM prompt',
            fitnessImpact: 0.02,
            timestamp: Date.now(),
          },
          {
            pattern: 'rejected',
            outcome: 'failure',
            module: 'constants.ts',
            description: 'broke MAX_ITER',
            fitnessImpact: -0.1,
            timestamp: Date.now(),
          },
        ],
        archive: [],
        allowedScope: [],
        maxFiles: 2,
      },
      'prompt_improvement',
      fileContents,
    );

    expect(prompt).toContain('Evolution Memory');
    expect(prompt).toContain('improved PM prompt');
    expect(prompt).toContain('broke MAX_ITER');
  });

  it('should include strategy-specific guidance', () => {
    const fileContents = new Map<string, string>();
    const prompt = mutator.buildMutationPrompt(
      {
        sourceRoot: tmpDir,
        fitness: mockFitness(),
        memories: [],
        archive: [],
        allowedScope: [],
        maxFiles: 2,
      },
      'test_coverage',
      fileContents,
    );

    expect(prompt).toContain('test_coverage');
    expect(prompt).toContain('Add unit tests');
  });
});

// ═══════════════════════════════════════
// 7. Evolution Scopes
// ═══════════════════════════════════════

describe('EVOLUTION_SCOPES', () => {
  it('should have conservative as smallest scope', () => {
    expect(EVOLUTION_SCOPES.conservative.length).toBeLessThan(EVOLUTION_SCOPES.moderate.length);
    expect(EVOLUTION_SCOPES.moderate.length).toBeLessThan(EVOLUTION_SCOPES.aggressive.length);
  });

  it('should not include immutable files in any scope', () => {
    const allScopes = [...EVOLUTION_SCOPES.conservative, ...EVOLUTION_SCOPES.moderate, ...EVOLUTION_SCOPES.aggressive];
    expect(allScopes).not.toContain('vitest.config.ts');
    expect(allScopes).not.toContain('tsconfig.json');
    expect(allScopes).not.toContain('scripts/quality-gate.js');
    expect(allScopes).not.toContain('scripts/evaluate-fitness.js');
  });

  it('conservative should only contain prompts and constants', () => {
    expect(EVOLUTION_SCOPES.conservative).toEqual(['electron/engine/prompts.ts', 'electron/engine/constants.ts']);
  });
});
