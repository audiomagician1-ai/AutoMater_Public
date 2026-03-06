/**
 * Self-Repair Engine — L3 深度自修复引擎 (v34.0)
 *
 * 复用 SelfEvolutionEngine 的安全基础设施 (SafeGitOps + ImmutableGuard + FitnessEvaluator)
 * 但目标从 "进化优化" 变为 "故障修复"。
 *
 * 流程:
 *   1. 接收 L3 修复请求 (来自 auto-remediation 的 pending 记录)
 *   2. 创建 repair/ 分支 (基于当前 HEAD)
 *   3. LLM 分析错误日志 + 源代码 → 生成 FileChange[]
 *   4. 应用修改 + 提交
 *   5. FitnessEvaluator 质量门 (tsc + vitest)
 *   6. 通过 → 自动合并到主分支; 失败 → 回滚
 *
 * 安全限制:
 *   - 仅允许修改 engine/ 目录下的文件
 *   - 不可变文件保护 (SHA256 校验)
 *   - 单次修复最多 5 个文件、200 行变更
 *   - 修复分支自动清理
 *
 * @module self-repair-engine
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { callLLM, getSettings } from './llm-client';
import {
  SafeGitOps,
  ImmutableGuard,
  FitnessEvaluator,
  DEFAULT_IMMUTABLE_FILES,
  DEFAULT_PROTECTED_FILES,
  type FitnessResult,
  type FitnessWeights,
} from './self-evolution-engine';
import type { FileChange } from './evolution-mutator';
import {
  type RemediationRecord,
  getPendingL3Repairs,
} from './auto-remediation';
import { getDb } from '../db';

const log = createLogger('self-repair');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface RepairConfig {
  /** AutoMater 源码根目录 */
  sourceRoot: string;
  /** 修复分支前缀 (默认 'repair/') */
  branchPrefix: string;
  /** 最大修改文件数 (默认 5) */
  maxFiles: number;
  /** 最大变更行数 (默认 200) */
  maxLines: number;
  /** 允许修改的目录 (默认 ['electron/engine/']) */
  allowedDirs: string[];
  /** 适应度权重 (偏重稳定性) */
  fitnessWeights: FitnessWeights;
  /** 超时 (ms) */
  timeouts: {
    tsc: number;
    vitest: number;
    build: number;
  };
  /** 质量门最低分数 (默认 0.7) */
  minFitnessScore: number;
}

export interface RepairResult {
  success: boolean;
  repairId: string;
  branch: string;
  /** 修改的文件 */
  modifiedFiles: string[];
  /** 适应度结果 */
  fitness?: FitnessResult;
  /** 是否合并 */
  merged: boolean;
  /** 是否回滚 */
  rolledBack: boolean;
  /** 详细日志 */
  logs: string[];
  /** LLM token 消耗 */
  tokensUsed: number;
  /** 成本 */
  costUsd: number;
  /** 错误信息 (失败时) */
  error?: string;
}

export type RepairStatus =
  | 'idle'
  | 'analyzing'
  | 'generating'
  | 'applying'
  | 'evaluating'
  | 'merging'
  | 'rolling_back'
  | 'completed'
  | 'failed';

// ═══════════════════════════════════════
// Defaults
// ═══════════════════════════════════════

const DEFAULT_REPAIR_CONFIG: RepairConfig = {
  sourceRoot: '',
  branchPrefix: 'repair/',
  maxFiles: 5,
  maxLines: 200,
  allowedDirs: ['electron/engine/'],
  fitnessWeights: {
    testPassRate: 0.5, // 修复模式更重视测试通过
    coverageDelta: 0.1,
    tscClean: 0.3,
    regressionPenalty: 0.1,
  },
  timeouts: {
    tsc: 120_000,
    vitest: 300_000,
    build: 300_000,
  },
  minFitnessScore: 0.7,
};

// 自修复引擎本身也是不可变的
const REPAIR_IMMUTABLE_FILES = [
  ...DEFAULT_IMMUTABLE_FILES,
  'electron/engine/self-repair-engine.ts',
  'electron/engine/health-diagnostics.ts',
  'electron/engine/auto-remediation.ts',
];

// ═══════════════════════════════════════
// Self-Repair Engine
// ═══════════════════════════════════════

export class SelfRepairEngine {
  private config: RepairConfig;
  private gitOps: SafeGitOps;
  private guard: ImmutableGuard;
  private evaluator: FitnessEvaluator;
  private status: RepairStatus = 'idle';
  private logs: string[] = [];
  private aborted = false;

  constructor(config: Partial<RepairConfig> & { sourceRoot: string }) {
    this.config = { ...DEFAULT_REPAIR_CONFIG, ...config };
    this.gitOps = new SafeGitOps(this.config.sourceRoot);
    this.guard = new ImmutableGuard(this.config.sourceRoot, REPAIR_IMMUTABLE_FILES);
    this.evaluator = new FitnessEvaluator(
      this.config.sourceRoot,
      this.config.fitnessWeights,
      this.config.timeouts,
    );
  }

  // ── Status ──

  getStatus(): RepairStatus {
    return this.status;
  }

  getLogs(): string[] {
    return [...this.logs];
  }

  abort(): void {
    this.aborted = true;
    this.log('Abort signal received');
  }

  private log(msg: string): void {
    const ts = new Date().toISOString().slice(11, 19);
    const entry = `[${ts}] ${msg}`;
    this.logs.push(entry);
    if (this.logs.length > 200) {
      this.logs = this.logs.slice(-100);
    }
    log.info(msg);
  }

  // ═══════════════════════════════════════
  // Main Repair Flow
  // ═══════════════════════════════════════

  /**
   * 执行一次 L3 修复
   *
   * @param record - 来自 auto-remediation 的 pending L3 记录
   * @returns RepairResult
   */
  async repair(record: RemediationRecord): Promise<RepairResult> {
    const repairId = `repair-${Date.now()}`;
    const branchName = `${this.config.branchPrefix}${repairId}`;
    let originalBranch = '';
    let snapshotTag = '';
    let merged = false;
    let rolledBack = false;
    let tokensUsed = 0;
    let costUsd = 0;
    const modifiedFiles: string[] = [];

    this.logs = [];
    this.aborted = false;

    try {
      // ── Phase 1: Preflight ──
      this.status = 'analyzing';
      this.log(`Starting L3 repair: ${record.anomalyPattern} (project: ${record.projectId})`);

      // 保存当前分支
      originalBranch = this.gitOps.getCurrentBranch();
      this.log(`Current branch: ${originalBranch}`);

      // 确保工作区干净
      if (!this.gitOps.isClean()) {
        this.log('Working directory not clean — stashing changes');
        try {
          // 尝试 stash
          this.gitOps['git']('stash push -m "pre-repair-stash"');
        } catch {
          this.log('Stash failed — aborting');
          return this.failResult(repairId, branchName, 'Working directory not clean and stash failed');
        }
      }

      // 捕获不可变文件基线
      this.guard.captureBaseline();
      this.log('Immutable guard baseline captured');

      // 创建安全快照
      snapshotTag = `snapshot-${repairId}`;
      this.gitOps.createSnapshot(snapshotTag);
      this.log(`Safety snapshot: ${snapshotTag}`);

      // ── Phase 2: 创建修复分支 ──
      this.gitOps.createBranch(branchName, originalBranch);
      this.log(`Created repair branch: ${branchName}`);

      // ── Phase 3: LLM 生成修复代码 ──
      if (this.aborted) throw new Error('Aborted');
      this.status = 'generating';

      const settings = getSettings();
      if (!settings) {
        throw new Error('No LLM settings available');
      }

      const errorContext = buildRepairContext(record, this.config.sourceRoot);
      const prompt = buildRepairPrompt(record, errorContext, this.config);

      this.log('Calling LLM for repair code generation...');
      const llmResult = await callLLM(
        settings,
        settings.strongModel,
        [
          { role: 'system', content: REPAIR_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        undefined,
        16384, // 较大的 token budget 用于代码生成
        1,
      );

      tokensUsed = (llmResult.inputTokens ?? 0) + (llmResult.outputTokens ?? 0);
      costUsd = 0; // cost tracked externally

      const changes = parseRepairResponse(llmResult.content ?? '');
      this.log(`LLM proposed ${changes.length} file changes`);

      if (changes.length === 0) {
        this.log('No changes proposed — repair skipped');
        this.cleanup(branchName, originalBranch, snapshotTag);
        return this.skipResult(repairId, branchName, 'LLM proposed no changes');
      }

      // ── Phase 4: 验证并应用修改 ──
      if (this.aborted) throw new Error('Aborted');
      this.status = 'applying';

      // 安全检查: 文件数量
      if (changes.length > this.config.maxFiles) {
        throw new Error(
          `Too many files: ${changes.length} > ${this.config.maxFiles}`,
        );
      }

      // 安全检查: 行数
      const totalLines = changes.reduce(
        (sum, c) => sum + (c.content?.split('\n').length ?? 0),
        0,
      );
      if (totalLines > this.config.maxLines) {
        throw new Error(
          `Too many lines: ${totalLines} > ${this.config.maxLines}`,
        );
      }

      // 安全检查: 不可变文件
      const pathCheck = this.guard.checkPaths(changes.map(c => c.path));
      if (!pathCheck.ok) {
        throw new Error(
          `Immutable file violation: ${pathCheck.blockedFiles.join(', ')}`,
        );
      }

      // 安全检查: 目录限制
      for (const change of changes) {
        const normalizedPath = change.path.replace(/\\/g, '/');
        const isAllowed = this.config.allowedDirs.some(dir =>
          normalizedPath.startsWith(dir),
        );
        if (!isAllowed) {
          throw new Error(
            `File outside allowed scope: ${change.path} (allowed: ${this.config.allowedDirs.join(', ')})`,
          );
        }
      }

      // 应用修改
      for (const change of changes) {
        const absPath = path.resolve(this.config.sourceRoot, change.path);
        if (change.action === 'delete') {
          if (fs.existsSync(absPath)) {
            fs.unlinkSync(absPath);
            this.log(`Deleted: ${change.path}`);
          }
        } else {
          // 确保目录存在
          const dir = path.dirname(absPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(absPath, change.content, 'utf-8');
          this.log(`Written: ${change.path}`);
        }
        modifiedFiles.push(change.path);
      }

      // 提交
      const commitMsg = `[auto-repair] ${record.anomalyPattern}: ${record.detail?.slice(0, 80) ?? 'auto-fix'}`;
      this.gitOps.commitAll(commitMsg);
      this.log(`Committed: ${commitMsg}`);

      // ── Phase 5: 质量门 ──
      if (this.aborted) throw new Error('Aborted');
      this.status = 'evaluating';
      this.log('Running quality gate (tsc + vitest)...');

      const fitness = this.evaluator.evaluate();
      this.log(`Fitness: score=${fitness.score.toFixed(4)}, tsc=${fitness.tscPassed}, tests=${fitness.passedTests}/${fitness.totalTests}`);

      // 不可变文件验证
      const guardCheck = this.guard.verify();
      if (!guardCheck.ok) {
        throw new Error(
          `Immutable guard violation after repair: ${guardCheck.violations.join('; ')}`,
        );
      }

      // 质量门判定
      if (fitness.score < this.config.minFitnessScore || !fitness.tscPassed) {
        this.log(`Quality gate FAILED (score=${fitness.score.toFixed(4)} < ${this.config.minFitnessScore} or tsc failed)`);
        this.status = 'rolling_back';

        // 回滚
        this.gitOps.checkout(originalBranch);
        this.gitOps.rollbackToSnapshot(snapshotTag);
        rolledBack = true;
        this.log('Rolled back to snapshot');
        this.cleanup(branchName, originalBranch, snapshotTag);

        return {
          success: false,
          repairId,
          branch: branchName,
          modifiedFiles,
          fitness,
          merged: false,
          rolledBack: true,
          logs: [...this.logs],
          tokensUsed,
          costUsd,
          error: `Quality gate failed: score=${fitness.score.toFixed(4)}`,
        };
      }

      // ── Phase 6: 合并 ──
      this.status = 'merging';
      this.log('Quality gate PASSED — merging to main branch');

      this.gitOps.checkout(originalBranch);
      merged = this.gitOps.mergeFastForward(branchName);

      if (!merged) {
        // 尝试 no-ff merge
        merged = this.gitOps.merge(branchName, `Merge ${branchName}: auto-repair ${record.anomalyPattern}`);
      }

      if (!merged) {
        this.log('Merge failed — rolling back');
        this.status = 'rolling_back';
        this.gitOps.rollbackToSnapshot(snapshotTag);
        rolledBack = true;
        this.cleanup(branchName, originalBranch, snapshotTag);

        return {
          success: false,
          repairId,
          branch: branchName,
          modifiedFiles,
          fitness,
          merged: false,
          rolledBack: true,
          logs: [...this.logs],
          tokensUsed,
          costUsd,
          error: 'Merge conflict',
        };
      }

      // 成功合并
      this.log('✅ Repair merged successfully');
      this.cleanup(branchName, originalBranch, snapshotTag);
      this.status = 'completed';

      // 更新 remediation_log
      updateRepairRecord(record, 'success', `Repair merged: ${modifiedFiles.join(', ')}`);

      return {
        success: true,
        repairId,
        branch: branchName,
        modifiedFiles,
        fitness,
        merged: true,
        rolledBack: false,
        logs: [...this.logs],
        tokensUsed,
        costUsd,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log(`❌ Repair failed: ${errMsg}`);
      this.status = 'failed';

      // 尝试回滚
      if (snapshotTag && originalBranch) {
        try {
          this.gitOps.checkout(originalBranch);
          this.gitOps.rollbackToSnapshot(snapshotTag);
          rolledBack = true;
          this.log('Emergency rollback successful');
        } catch (rollbackErr) {
          this.log(`Emergency rollback FAILED: ${rollbackErr}`);
        }
        this.cleanup(branchName, originalBranch, snapshotTag);
      }

      updateRepairRecord(record, 'failed', errMsg);

      return {
        success: false,
        repairId,
        branch: branchName,
        modifiedFiles,
        merged: false,
        rolledBack,
        logs: [...this.logs],
        tokensUsed,
        costUsd,
        error: errMsg,
      };
    }
  }

  // ── Helpers ──

  private cleanup(branch: string, originalBranch: string, tag: string): void {
    try {
      // 确保在原始分支上
      const current = this.gitOps.getCurrentBranch();
      if (current !== originalBranch) {
        this.gitOps.checkout(originalBranch);
      }
      // 删除修复分支
      this.gitOps.deleteBranch(branch);
      // 删除快照 tag
      this.gitOps.deleteTag(tag);
    } catch (err) {
      this.log(`Cleanup warning: ${err}`);
    }
  }

  private failResult(repairId: string, branch: string, error: string): RepairResult {
    return {
      success: false,
      repairId,
      branch,
      modifiedFiles: [],
      merged: false,
      rolledBack: false,
      logs: [...this.logs],
      tokensUsed: 0,
      costUsd: 0,
      error,
    };
  }

  private skipResult(repairId: string, branch: string, reason: string): RepairResult {
    return {
      success: false,
      repairId,
      branch,
      modifiedFiles: [],
      merged: false,
      rolledBack: false,
      logs: [...this.logs],
      tokensUsed: 0,
      costUsd: 0,
      error: reason,
    };
  }
}

// ═══════════════════════════════════════
// Repair Context Builder
// ═══════════════════════════════════════

interface RepairContext {
  errorLogs: string;
  relatedSourceFiles: Array<{ path: string; content: string }>;
  recentEvents: string;
}

function buildRepairContext(record: RemediationRecord, sourceRoot: string): RepairContext {
  // 收集错误日志
  let errorLogs = record.detail ?? '';

  // 从 DB 获取相关错误事件
  try {
    const db = getDb();
    const events = db
      .prepare(
        `
        SELECT type, data, created_at FROM events
        WHERE project_id = ?
          AND type IN ('feature:failed', 'react:complete', 'tool:result')
          AND created_at >= datetime('now', '-60 minutes')
        ORDER BY created_at DESC LIMIT 10
      `,
      )
      .all(record.projectId) as Array<{ type: string; data: string; created_at: string }>;

    const recentEvents = events
      .map(e => `[${e.created_at}] ${e.type}: ${(e.data ?? '').slice(0, 200)}`)
      .join('\n');

    errorLogs += '\n\n--- Recent Events ---\n' + recentEvents;
  } catch {
    /* non-critical */
  }

  // 尝试识别相关源文件
  const relatedSourceFiles: Array<{ path: string; content: string }> = [];
  const MAX_FILE_CONTENT = 3000; // 限制每个文件内容长度

  // 从错误信息中提取文件路径
  const filePatterns = errorLogs.match(/engine\/[\w-]+\.ts/g) ?? [];
  const uniqueFiles = [...new Set(filePatterns)].slice(0, 3);

  for (const relPath of uniqueFiles) {
    try {
      const absPath = path.resolve(sourceRoot, 'electron', relPath.startsWith('engine/') ? relPath : `engine/${relPath}`);
      if (fs.existsSync(absPath)) {
        const content = fs.readFileSync(absPath, 'utf-8');
        relatedSourceFiles.push({
          path: relPath,
          content: content.slice(0, MAX_FILE_CONTENT),
        });
      }
    } catch {
      /* skip */
    }
  }

  return { errorLogs, relatedSourceFiles, recentEvents: '' };
}

// ═══════════════════════════════════════
// Repair Prompt
// ═══════════════════════════════════════

const REPAIR_SYSTEM_PROMPT = `你是 AutoMater 的自动修复引擎。你的任务是分析错误日志和相关源代码，生成修复代码。

输出格式 — 严格 JSON:
{
  "analysis": "根因分析 (1-2句)",
  "changes": [
    {
      "path": "electron/engine/xxx.ts",
      "action": "write",
      "content": "完整的文件内容 (不是 diff)"
    }
  ],
  "rationale": "修复理由"
}

规则:
1. 只能修改 electron/engine/ 目录下的文件
2. 最多修改 5 个文件
3. 每个文件提供完整内容 (不是 patch/diff)
4. 保持代码风格一致
5. 不要修改不相关的代码
6. 优先最小化修改范围
7. 确保类型安全 (TypeScript)
8. 只输出 JSON，不要其他文字`;

function buildRepairPrompt(
  record: RemediationRecord,
  context: RepairContext,
  config: RepairConfig,
): string {
  const parts: string[] = [
    `## 修复请求`,
    `异常模式: ${record.anomalyPattern}`,
    `项目: ${record.projectId}`,
    `Feature: ${record.featureId ?? 'N/A'}`,
    `详情: ${record.detail?.slice(0, 500) ?? 'N/A'}`,
    '',
    `## 错误日志`,
    context.errorLogs.slice(0, 3000),
    '',
  ];

  if (context.relatedSourceFiles.length > 0) {
    parts.push('## 相关源文件');
    for (const file of context.relatedSourceFiles) {
      parts.push(`### ${file.path}`);
      parts.push('```typescript');
      parts.push(file.content);
      parts.push('```');
      parts.push('');
    }
  }

  parts.push(`## 限制`);
  parts.push(`- 最多修改 ${config.maxFiles} 个文件`);
  parts.push(`- 最多 ${config.maxLines} 行变更`);
  parts.push(`- 仅允许修改: ${config.allowedDirs.join(', ')}`);

  return parts.join('\n');
}

// ═══════════════════════════════════════
// Response Parser
// ═══════════════════════════════════════

function parseRepairResponse(text: string): FileChange[] {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    const changes: FileChange[] = [];

    for (const c of parsed.changes ?? []) {
      if (!c.path || !c.content) continue;
      const action = c.action === 'delete' ? 'delete' : 'write';
      changes.push({
        path: c.path,
        content: c.content,
        action,
      });
    }

    return changes;
  } catch (err) {
    log.debug('Failed to parse repair response', { error: String(err) });
    return [];
  }
}

// ═══════════════════════════════════════
// DB Helpers
// ═══════════════════════════════════════

function updateRepairRecord(
  record: RemediationRecord,
  status: 'success' | 'failed',
  detail: string,
): void {
  try {
    if (!record.id) return;
    const db = getDb();
    db.prepare(
      `
      UPDATE remediation_log
      SET status = ?, detail = ?, completed_at = datetime('now')
      WHERE id = ?
    `,
    ).run(status, detail, record.id);
  } catch (err) {
    log.error('Failed to update repair record', err);
  }
}

// ═══════════════════════════════════════
// Process Pending L3 Repairs
// ═══════════════════════════════════════

/**
 * 处理所有待处理的 L3 修复请求
 *
 * 由 daemon 定期调用。逐个处理 pending 的 L3 记录。
 */
export async function processPendingRepairs(sourceRoot: string): Promise<RepairResult[]> {
  const pending = getPendingL3Repairs();
  if (pending.length === 0) return [];

  log.info(`Processing ${pending.length} pending L3 repairs`);

  const engine = new SelfRepairEngine({ sourceRoot });
  const results: RepairResult[] = [];

  for (const record of pending) {
    try {
      const result = await engine.repair(record);
      results.push(result);

      if (result.success) {
        log.info('L3 repair succeeded', {
          repairId: result.repairId,
          files: result.modifiedFiles,
        });
      } else {
        log.warn('L3 repair failed', {
          repairId: result.repairId,
          error: result.error,
        });
      }
    } catch (err) {
      log.error('L3 repair processing error', err);
    }
  }

  return results;
}
