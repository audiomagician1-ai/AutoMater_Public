/**
 * Evolution Mutator — LLM 驱动的自我进化变异生成器
 *
 * 职责:
 *  1. 分析当前代码库 + 适应度结果 + 进化记忆
 *  2. 选择变异目标 (文件/模块)
 *  3. 调用 LLM 生成代码修改提案
 *  4. 输出结构化的 FileChange[] 供 SelfEvolutionEngine 执行
 *
 * 安全:
 *  - 只能提议修改 allowed scope 内的文件
 *  - 不能修改 immutable / 核心 protected 文件
 *  - 每次变异范围限制 (最多 N 个文件，M 行变更)
 *
 * @module evolution-mutator
 * @version 0.1.0
 */

import fs from 'fs';
import path from 'path';
import { callLLM, getSettings, type LLMResult } from './llm-client';
import { createLogger } from './logger';
import { checkEvolutionPaths } from './guards';
import type { FitnessResult, EvolutionMemoryEntry, EvolutionEntry } from './self-evolution-engine';

const log = createLogger('evolution-mutator');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface FileChange {
  path: string;
  content: string;
  action: 'write' | 'delete';
}

export interface MutationProposal {
  /** 变异描述 (human-readable) */
  description: string;
  /** 变异类型 */
  strategy: MutationStrategy;
  /** 目标文件变更列表 */
  fileChanges: FileChange[];
  /** 变异理由 (LLM 给出) */
  rationale: string;
  /** LLM token 消耗 */
  tokenUsage: { input: number; output: number };
}

export type MutationStrategy =
  | 'prompt_improvement' // 优化 system prompt / 指令
  | 'error_handling' // 改进错误处理逻辑
  | 'performance' // 性能优化
  | 'code_quality' // 代码质量提升 (重构、去重、简化)
  | 'test_coverage' // 增加测试覆盖
  | 'bug_fix' // 基于失败测试/日志修复 bug
  | 'feature_enhancement'; // 小功能增强

export interface MutationContext {
  /** 源码根目录 */
  sourceRoot: string;
  /** 当前适应度 */
  fitness: FitnessResult;
  /** 进化记忆 (最近的成功/失败模式) */
  memories: EvolutionMemoryEntry[];
  /** 进化历史 (最近的) */
  archive: EvolutionEntry[];
  /** 允许修改的文件范围 (glob patterns) */
  allowedScope: string[];
  /** 变异策略偏好 (空 = 自动选择) */
  preferredStrategy?: MutationStrategy;
  /** 最大变更文件数 */
  maxFiles: number;
  /** 使用的模型 (默认用 settings.strongModel) */
  model?: string;
}

// ═══════════════════════════════════════
// Default Scopes
// ═══════════════════════════════════════

/**
 * 进化范围等级:
 *  Level 1 (conservative): 只允许修改 prompts + constants
 *  Level 2 (moderate): + tool definitions + error messages + UI text
 *  Level 3 (aggressive): + engine logic + tool implementations
 */
export const EVOLUTION_SCOPES = {
  conservative: ['electron/engine/prompts.ts', 'electron/engine/constants.ts'],
  moderate: [
    'electron/engine/prompts.ts',
    'electron/engine/constants.ts',
    'electron/engine/tool-defs/*.ts',
    'electron/engine/error-messages.ts',
    'src/pages/GuidePage.tsx',
  ],
  aggressive: [
    'electron/engine/prompts.ts',
    'electron/engine/constants.ts',
    'electron/engine/tool-defs/*.ts',
    'electron/engine/react-loop.ts',
    'electron/engine/orchestrator.ts',
    'electron/engine/tool-executor.ts',
    'electron/engine/context-manager.ts',
    'electron/engine/decision-log.ts',
    'src/components/*.tsx',
    'src/pages/*.tsx',
  ],
} as const;

export type EvolutionScopeLevel = keyof typeof EVOLUTION_SCOPES;

// ═══════════════════════════════════════
// Mutator Class
// ═══════════════════════════════════════

export class EvolutionMutator {
  private readonly sourceRoot: string;

  constructor(sourceRoot: string) {
    this.sourceRoot = sourceRoot;
  }

  /**
   * 生成变异提案
   *
   * 流程:
   *  1. 收集上下文 (适应度、记忆、目标文件内容)
   *  2. 构建 mutation prompt
   *  3. 调用 LLM 生成修改提案
   *  4. 解析 + 安全检查
   */
  async generateMutation(ctx: MutationContext): Promise<MutationProposal> {
    const settings = getSettings();
    if (!settings || !settings.apiKey) {
      throw new Error('LLM settings not configured — cannot generate mutation');
    }

    const model = ctx.model || settings.strongModel || settings.workerModel;
    if (!model) {
      throw new Error('No LLM model configured for evolution');
    }

    // Step 1: Resolve target files from scope
    const targetFiles = this.resolveTargetFiles(ctx.allowedScope);
    if (targetFiles.length === 0) {
      throw new Error('No modifiable files found in allowed scope');
    }

    log.info(`Mutation targets: ${targetFiles.length} files in scope`, {
      scope: ctx.allowedScope,
      files: targetFiles.slice(0, 10),
    });

    // Step 2: Read target file contents (truncated for context efficiency)
    const fileContents = this.readTargetFiles(targetFiles, 500); // max 500 lines per file

    // Step 3: Build mutation prompt
    const strategy = ctx.preferredStrategy || this.selectStrategy(ctx.fitness, ctx.memories);
    const prompt = this.buildMutationPrompt(ctx, strategy, fileContents);

    // Step 4: Call LLM
    log.info(`Generating mutation: strategy=${strategy}, model=${model}`);
    let result: LLMResult;
    try {
      result = await callLLM(
        settings,
        model,
        [
          { role: 'system', content: MUTATION_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        undefined, // no abort signal
        16384, // generous max tokens for code generation
        1, // 1 retry
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`LLM call failed for mutation generation: ${msg}`);
    }

    // Step 5: Parse proposal
    const proposal = this.parseProposal(result.content, strategy);
    proposal.tokenUsage = { input: result.inputTokens, output: result.outputTokens };

    // Step 6: Safety check
    this.validateProposal(proposal, ctx.maxFiles);

    log.info(`Mutation proposal: "${proposal.description}" — ${proposal.fileChanges.length} file changes`, {
      strategy: proposal.strategy,
    });

    return proposal;
  }

  // ── Target Resolution ──

  /** 解析 glob patterns 到具体文件列表 */
  resolveTargetFiles(patterns: string[]): string[] {
    const files: Set<string> = new Set();

    for (const pattern of patterns) {
      if (pattern.includes('*')) {
        // Simple glob: dir/*.ext
        const dir = path.dirname(pattern);
        const ext = path.extname(pattern);
        const absDir = path.resolve(this.sourceRoot, dir);
        if (fs.existsSync(absDir)) {
          try {
            for (const f of fs.readdirSync(absDir)) {
              if (!ext || f.endsWith(ext)) {
                const rel = path.join(dir, f).replace(/\\/g, '/');
                files.add(rel);
              }
            }
          } catch {
            // Directory not readable
          }
        }
      } else {
        // Exact file
        const absPath = path.resolve(this.sourceRoot, pattern);
        if (fs.existsSync(absPath)) {
          files.add(pattern.replace(/\\/g, '/'));
        }
      }
    }

    return [...files];
  }

  /** 读取目标文件内容 (带行数限制) */
  readTargetFiles(files: string[], maxLinesPerFile: number): Map<string, string> {
    const contents = new Map<string, string>();

    for (const file of files) {
      const absPath = path.resolve(this.sourceRoot, file);
      try {
        const content = fs.readFileSync(absPath, 'utf-8');
        const lines = content.split('\n');
        if (lines.length > maxLinesPerFile) {
          // Truncate with indicator
          contents.set(
            file,
            lines.slice(0, maxLinesPerFile).join('\n') +
              `\n// ... (${lines.length - maxLinesPerFile} more lines truncated)`,
          );
        } else {
          contents.set(file, content);
        }
      } catch {
        log.warn(`Cannot read target file: ${file}`);
      }
    }

    return contents;
  }

  // ── Strategy Selection ──

  /** 基于当前适应度和记忆自动选择变异策略 */
  selectStrategy(fitness: FitnessResult, memories: EvolutionMemoryEntry[]): MutationStrategy {
    // Priority 1: If tests are failing, focus on bug fixing
    if (fitness.failedTests > 0) return 'bug_fix';

    // Priority 2: If tsc fails, something is broken
    if (!fitness.tscPassed) return 'bug_fix';

    // Priority 3: Low coverage → add tests
    if (fitness.statementCoverage < 35) return 'test_coverage';

    // Priority 4: Check memory for patterns
    const recentFailures = memories.filter(m => m.outcome === 'failure').slice(-5);
    const recentSuccesses = memories.filter(m => m.outcome === 'success').slice(-5);

    // If recent prompt improvements succeeded, try more
    if (recentSuccesses.some(m => m.description.includes('prompt'))) {
      return 'prompt_improvement';
    }

    // If many recent failures, go conservative with code quality
    if (recentFailures.length >= 3) {
      return 'code_quality';
    }

    // Rotate through strategies based on generation count
    const strategies: MutationStrategy[] = [
      'prompt_improvement',
      'error_handling',
      'code_quality',
      'performance',
      'prompt_improvement',
      'test_coverage',
    ];
    const idx = memories.length % strategies.length;
    return strategies[idx];
  }

  // ── Prompt Building ──

  /** 构建变异 prompt */
  buildMutationPrompt(ctx: MutationContext, strategy: MutationStrategy, fileContents: Map<string, string>): string {
    const sections: string[] = [];

    // 1. Context
    sections.push(`## Evolution Context

- **Strategy**: ${strategy} (${STRATEGY_DESCRIPTIONS[strategy]})
- **Current Fitness**: ${ctx.fitness.score.toFixed(4)}
  - tsc: ${ctx.fitness.tscPassed ? 'PASS' : `FAIL (${ctx.fitness.tscErrors} errors)`}
  - Tests: ${ctx.fitness.passedTests}/${ctx.fitness.totalTests} (${(ctx.fitness.testPassRate * 100).toFixed(1)}%)
  - Coverage: ${ctx.fitness.statementCoverage.toFixed(1)}%
- **Max files to change**: ${ctx.maxFiles}
- **Source root**: AutoMater (Electron + React + TypeScript desktop app)`);

    // 2. Evolution memory
    if (ctx.memories.length > 0) {
      sections.push(`## Evolution Memory (recent patterns)\n`);
      const recent = ctx.memories.slice(-10);
      for (const mem of recent) {
        const icon = mem.outcome === 'success' ? '✅' : '❌';
        sections.push(
          `${icon} [${mem.fitnessImpact > 0 ? '+' : ''}${mem.fitnessImpact.toFixed(3)}] ${mem.description} (module: ${mem.module})`,
        );
      }
    }

    // 3. Recent archive
    if (ctx.archive.length > 0) {
      sections.push(`\n## Recent Evolution History\n`);
      for (const entry of ctx.archive.slice(-5)) {
        const icon = entry.status === 'accepted' ? '✅' : '❌';
        sections.push(
          `${icon} Gen ${entry.generation}: ${entry.description} — fitness ${entry.fitnessScore.toFixed(4)}`,
        );
      }
    }

    // 4. Target files
    sections.push(`\n## Target Files (you may modify these)\n`);
    for (const [file, content] of fileContents) {
      const lineCount = content.split('\n').length;
      sections.push(`### ${file} (${lineCount} lines)\n\`\`\`typescript\n${content}\n\`\`\``);
    }

    // 5. Strategy-specific guidance
    sections.push(`\n## Your Task\n\n${STRATEGY_GUIDANCE[strategy]}`);

    return sections.join('\n\n');
  }

  // ── Response Parsing ──

  /** 解析 LLM 返回的变异提案 */
  parseProposal(llmOutput: string, strategy: MutationStrategy): MutationProposal {
    // Try JSON parse first (structured output)
    const jsonMatch = llmOutput.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        return this.normalizeProposal(parsed, strategy);
      } catch {
        log.warn('JSON parse of mutation proposal failed, falling back to text extraction');
      }
    }

    // Fallback: extract from markdown code blocks
    const fileChanges: FileChange[] = [];
    // Pattern: `### file: path/to/file.ts` followed by ```typescript ... ```
    const fileBlockRegex =
      /###\s*(?:file:\s*)?([^\n]+\.(?:ts|tsx|js|json))\s*\n```(?:typescript|tsx|javascript|json)?\s*\n([\s\S]*?)\n```/g;
    let match;
    while ((match = fileBlockRegex.exec(llmOutput)) !== null) {
      fileChanges.push({
        path: match[1].trim(),
        content: match[2],
        action: 'write',
      });
    }

    // Extract description
    const descMatch = llmOutput.match(/##\s*Description\s*\n+(.+)/i) || llmOutput.match(/##\s*变异描述\s*\n+(.+)/i);
    const description = descMatch ? descMatch[1].trim() : `${strategy}: auto-generated mutation`;

    // Extract rationale
    const ratMatch =
      llmOutput.match(/##\s*Rationale\s*\n+([\s\S]*?)(?=\n##|\n```|$)/i) ||
      llmOutput.match(/##\s*理由\s*\n+([\s\S]*?)(?=\n##|\n```|$)/i);
    const rationale = ratMatch ? ratMatch[1].trim() : '';

    return {
      description,
      strategy,
      fileChanges,
      rationale,
      tokenUsage: { input: 0, output: 0 },
    };
  }

  /** 规范化 JSON 格式的 proposal */
  private normalizeProposal(parsed: Record<string, unknown>, strategy: MutationStrategy): MutationProposal {
    const rawChanges = (parsed.fileChanges || parsed.file_changes || parsed.changes || []) as Array<{
      path?: string;
      file?: string;
      content?: string;
      action?: string;
    }>;

    const fileChanges: FileChange[] = rawChanges
      .map(c => ({
        path: (c.path || c.file || '').replace(/\\/g, '/'),
        content: c.content || '',
        action: (c.action === 'delete' ? 'delete' : 'write') as 'write' | 'delete',
      }))
      .filter(c => c.path);

    return {
      description: String(parsed.description || parsed.desc || `${strategy} mutation`),
      strategy: (parsed.strategy as MutationStrategy) || strategy,
      fileChanges,
      rationale: String(parsed.rationale || parsed.reason || ''),
      tokenUsage: { input: 0, output: 0 },
    };
  }

  // ── Validation ──

  /** 安全检查变异提案 */
  validateProposal(proposal: MutationProposal, maxFiles: number): void {
    if (proposal.fileChanges.length === 0) {
      throw new Error('Mutation proposal has no file changes — LLM may have failed to generate code');
    }

    if (proposal.fileChanges.length > maxFiles) {
      throw new Error(`Mutation proposal changes ${proposal.fileChanges.length} files, exceeding limit of ${maxFiles}`);
    }

    // Check against immutable/protected files
    const paths = proposal.fileChanges.map(c => c.path);
    const pathCheck = checkEvolutionPaths(paths);
    if (!pathCheck.ok) {
      throw new Error(`Mutation proposal attempts to modify immutable files: ${pathCheck.immutable.join(', ')}`);
    }

    // Warn about protected files
    if (pathCheck.protected_.length > 0) {
      log.warn(`Mutation proposal touches protected files: ${pathCheck.protected_.join(', ')}`);
    }

    // Content sanity checks
    for (const change of proposal.fileChanges) {
      if (change.action === 'write' && !change.content.trim()) {
        throw new Error(`Mutation proposal has empty content for file: ${change.path}`);
      }
    }
  }
}

// ═══════════════════════════════════════
// Constants
// ═══════════════════════════════════════

const STRATEGY_DESCRIPTIONS: Record<MutationStrategy, string> = {
  prompt_improvement: '优化 Agent system prompts 以提升任务完成质量',
  error_handling: '改进错误处理逻辑，增加健壮性',
  performance: '优化性能热点，减少不必要的计算',
  code_quality: '代码质量提升 — 重构、去重、简化、清理',
  test_coverage: '增加单元测试覆盖率',
  bug_fix: '基于测试失败或已知问题修复 bug',
  feature_enhancement: '小功能增强或改进用户体验',
};

const STRATEGY_GUIDANCE: Record<MutationStrategy, string> = {
  prompt_improvement: `Improve one or more agent system prompts to be clearer, more specific, and more effective.
Focus on:
- Adding missing guidance for common failure modes
- Making instructions more precise and actionable
- Adding examples where helpful
- Removing ambiguous or contradictory instructions
- Improving tool usage guidance

Output the COMPLETE modified file content (not just the diff).`,

  error_handling: `Improve error handling in the target files:
- Add try-catch blocks where errors could propagate uncaught
- Improve error messages to be more diagnostic
- Add graceful degradation for non-critical failures
- Ensure resources are properly cleaned up in error paths
- Add input validation where missing

Output the COMPLETE modified file content.`,

  performance: `Identify and fix performance issues:
- Eliminate redundant computations or I/O
- Add caching for expensive operations
- Reduce unnecessary memory allocations
- Optimize hot paths (loops, frequent calls)
- Use more efficient data structures

Output the COMPLETE modified file content.`,

  code_quality: `Improve code quality without changing behavior:
- Extract duplicated code into shared functions
- Simplify complex conditional logic
- Improve variable/function naming
- Add missing type annotations
- Remove dead code or unused imports
- Break up functions longer than 50 lines

Output the COMPLETE modified file content.`,

  test_coverage: `Add unit tests to improve coverage:
- Target uncovered branches and edge cases
- Test error paths and boundary conditions
- Add tests for recently added/modified functions
- Use describe/it/expect pattern consistent with existing tests
- Mock external dependencies (LLM, filesystem, DB)

Create new test files or add to existing ones. Output the COMPLETE file content.`,

  bug_fix: `Fix bugs based on test failures or known issues:
- Analyze the test output and error messages
- Identify the root cause (not just the symptom)
- Apply the minimal fix that resolves the issue
- Ensure the fix doesn't introduce regressions
- Add a test case for the fixed bug if possible

Output the COMPLETE modified file content.`,

  feature_enhancement: `Make a small, targeted improvement:
- Add a helpful utility function
- Improve a user-facing message or UI element
- Add a missing validation or safety check
- Enhance logging for better debuggability
- Improve an existing feature's edge case handling

Output the COMPLETE modified file content.`,
};

const MUTATION_SYSTEM_PROMPT = `You are an AI evolution agent tasked with improving the AutoMater codebase.

AutoMater is an Electron + React + TypeScript desktop application that coordinates AI agent teams for software development.

## Your Role
You analyze the current codebase, fitness metrics, and evolution memory to propose specific, targeted code modifications that will improve the system.

## Output Format
Respond with a structured mutation proposal in this exact format:

## Description
[One-line description of what this mutation does]

## Rationale
[2-3 sentences explaining WHY this change will improve the system, referencing specific fitness metrics or patterns from evolution memory]

### file: [relative/path/to/file.ts]
\`\`\`typescript
[COMPLETE file content after modification]
\`\`\`

## Rules
1. **COMPLETE files only** — output the entire modified file, not diffs or patches
2. **Minimal scope** — change as few files as possible (ideally 1-2)
3. **Backward compatible** — don't break existing APIs or exports
4. **Type safe** — all code must pass \`tsc --noEmit\`
5. **Test compatible** — don't break existing tests
6. **No placeholder code** — no \`// TODO\`, \`// ...\`, or stub implementations
7. **Respect evolution memory** — avoid patterns that previously failed, build on patterns that succeeded
8. **Measurable impact** — the change should improve fitness score (tests pass rate, coverage, or code quality)

## NEVER modify these files (they are immutable):
- vitest.config.ts
- tsconfig.json
- scripts/quality-gate.js
- scripts/evaluate-fitness.js
- electron/engine/self-evolution-engine.ts
- electron/engine/__tests__/self-evolution-engine.test.ts`;
