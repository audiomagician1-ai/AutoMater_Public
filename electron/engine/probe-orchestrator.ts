/**
 * Probe Orchestrator — v7.0 多探针调度器
 *
 * 职责:
 * 1. planProbes(): 根据 Phase 0 的 ScanResult 生成探针组合计划
 * 2. executeProbes(): 并行/串行执行探针，带限流+进度+预算控制
 * 3. mergeFindings(): 去重 + 冲突检测 + 置信度加权
 *
 * @module probe-orchestrator
 */

import path from 'path';
import type {
  ProbeConfig,
  ProbeReport,
  ProbeType,
  ScanResult,
  ExplorationPlan,
  MergedFindings,
  Finding,
  ProbeProgress,
} from './probe-types';
import type { CommunityInfo, HubFile } from './code-graph';
import { EntryProbe, ModuleProbe, APIBoundaryProbe, DataModelProbe, ConfigInfraProbe, SmellProbe } from './probes';
import type { BaseProbe, ProbeContext } from './probes/base-probe';
import type { AppSettings } from './types';
import { createLogger } from './logger';

const log = createLogger('probe-orchestrator');

// ═══════════════════════════════════════
// Probe Planning
// ═══════════════════════════════════════

/**
 * Generate exploration plan based on Phase 0 scan results.
 * Probe count scales with project size (medium: 8-12, large: 15-25, massive: 25-40).
 */
export function planProbes(scan: ScanResult): ExplorationPlan {
  const probes: ProbeConfig[] = [];
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${++idCounter}`;

  const { profile, hubFiles, communities, snapshot } = scan;
  const scale = profile.scale;

  // Token budgets per probe type
  const budgets = {
    entry: 8000,
    module: 6000,
    'api-boundary': 6000,
    'data-model': 6000,
    'config-infra': 5000,
    smell: 5000,
  };

  // ── Entry Probes (priority 1) ──
  // One probe per entry file
  const entryFiles = scan.seedFiles
    .filter(s => s.reason === 'entry')
    .map(s => s.file);

  if (entryFiles.length > 0) {
    probes.push({
      id: nextId('entry'),
      type: 'entry',
      seeds: entryFiles.slice(0, 3),
      graphHops: 4,
      maxFilesToRead: 12,
      maxRounds: 2,
      tokenBudget: budgets.entry,
      priority: 1,
      description: `入口追踪: ${entryFiles.slice(0, 3).join(', ')}`,
    });
  }

  // ── Module Probes (priority 2) ──
  // One probe per community center or hub file
  const moduleSeeds = selectModuleSeeds(hubFiles, communities, scale);
  for (const group of moduleSeeds) {
    probes.push({
      id: nextId('module'),
      type: 'module',
      seeds: group.seeds,
      graphHops: 2,
      maxFilesToRead: 8,
      maxRounds: 1,
      tokenBudget: budgets.module,
      priority: 2,
      description: `模块纵深: ${group.label}`,
    });
  }

  // ── API Boundary Probe (priority 3) ──
  probes.push({
    id: nextId('api'),
    type: 'api-boundary',
    seeds: scan.seedFiles.filter(s => s.reason === 'hub').map(s => s.file).slice(0, 5),
    maxFilesToRead: 10,
    maxRounds: 1,
    tokenBudget: budgets['api-boundary'],
    priority: 3,
    description: 'API 边界: 路由/handler/IPC 端点',
  });

  // ── Data Model Probe (priority 3) ──
  probes.push({
    id: nextId('data'),
    type: 'data-model',
    seeds: findDataModelSeeds(scan),
    maxFilesToRead: 10,
    maxRounds: 1,
    tokenBudget: budgets['data-model'],
    priority: 3,
    description: '数据模型: 类型/Schema/ORM 定义',
  });

  // ── Config/Infra Probe (priority 4) ──
  probes.push({
    id: nextId('config'),
    type: 'config-infra',
    seeds: findConfigSeeds(scan),
    maxFilesToRead: 8,
    maxRounds: 1,
    tokenBudget: budgets['config-infra'],
    priority: 4,
    description: '配置/基础设施: 构建/部署/环境',
  });

  // ── Smell Probe (priority 5) ──
  probes.push({
    id: nextId('smell'),
    type: 'smell',
    seeds: [],
    maxFilesToRead: 10,
    maxRounds: 1,
    tokenBudget: budgets.smell,
    priority: 5,
    description: '异常检测: TODO/HACK/大文件/循环依赖',
  });

  // Sort by priority
  probes.sort((a, b) => a.priority - b.priority);

  // Estimate totals
  const estimatedTotalTokens = probes.reduce((s, p) => s + p.tokenBudget, 0);
  const avgProbeMs = 15000; // ~15s per probe with fast model
  const estimatedDurationMs = Math.ceil(probes.length / 3) * avgProbeMs; // assuming concurrency=3

  log.info(`Exploration plan: ${probes.length} probes, ~${estimatedTotalTokens} tokens, ~${Math.round(estimatedDurationMs / 1000)}s`, {
    types: probes.map(p => p.type).join(', '),
  });

  return { probes, estimatedTotalTokens, estimatedDurationMs };
}

/**
 * Select module seeds: pick community centers and hub files.
 */
function selectModuleSeeds(
  hubFiles: HubFile[],
  communities: CommunityInfo,
  scale: 'medium' | 'large' | 'massive',
): Array<{ label: string; seeds: string[] }> {
  const results: Array<{ label: string; seeds: string[] }> = [];
  const covered = new Set<string>();

  // Number of module probes by scale
  const maxModuleProbes = scale === 'massive' ? 8 : scale === 'large' ? 5 : 3;

  // Strategy 1: Top hub files, one per community
  for (const hub of hubFiles) {
    if (results.length >= maxModuleProbes) break;
    const community = hub.community || '_unknown';
    if (covered.has(community)) continue;
    covered.add(community);
    results.push({ label: community, seeds: [hub.file] });
  }

  // Strategy 2: Largest communities not yet covered
  const commsBySize = [...communities.communities.entries()]
    .sort((a, b) => b[1].length - a[1].length);
  for (const [label, files] of commsBySize) {
    if (results.length >= maxModuleProbes) break;
    if (covered.has(label)) continue;
    covered.add(label);
    // Pick the hub within this community, or the first file
    const communityHub = hubFiles.find(h => h.community === label);
    results.push({ label, seeds: [communityHub?.file || files[0]] });
  }

  return results;
}

/**
 * Find seed files for data model probe.
 */
function findDataModelSeeds(scan: ScanResult): string[] {
  const candidates: string[] = [];
  const typePatterns = [
    /types?\.\w+$/i,
    /model[s]?\.\w+$/i,
    /schema\.\w+$/i,
    /entity\.\w+$/i,
    /db\.\w+$/i,
    /migration/i,
  ];

  for (const file of scan.allCodeFiles) {
    for (const pat of typePatterns) {
      if (pat.test(file)) {
        candidates.push(file);
        break;
      }
    }
  }

  return candidates.slice(0, 5);
}

/**
 * Find seed files for config/infra probe.
 */
function findConfigSeeds(scan: ScanResult): string[] {
  const candidates: string[] = [];
  const configPatterns = [
    /config\//i,
    /\.config\.\w+$/i,
    /middleware/i,
    /plugin/i,
    /\.env/,
    /docker/i,
    /ci\//i,
    /\.github\//i,
  ];

  for (const file of scan.allCodeFiles) {
    for (const pat of configPatterns) {
      if (pat.test(file)) {
        candidates.push(file);
        break;
      }
    }
  }

  return candidates.slice(0, 5);
}

// ═══════════════════════════════════════
// Probe Execution
// ═══════════════════════════════════════

export interface ExecuteProbesOptions {
  /** Max concurrent probes (default: 3) */
  concurrency?: number;
  signal?: AbortSignal;
  /** Budget in USD (default: $1.00) */
  budgetUsd?: number;
  /** Called when a probe completes */
  onProbeComplete?: (report: ProbeReport) => void;
  /** Called on probe status change */
  onProgress?: (probeId: string, status: string, progress: number) => void;
  /** Settings override */
  settings: AppSettings;
}

/**
 * Execute all probes with concurrency control and budget tracking.
 */
export async function executeProbes(
  scan: ScanResult,
  plan: ExplorationPlan,
  options: ExecuteProbesOptions,
): Promise<ProbeReport[]> {
  const {
    concurrency = 3,
    signal,
    budgetUsd = 1.0,
    onProbeComplete,
    onProgress,
    settings,
  } = options;

  const reports: ProbeReport[] = [];
  const queue = [...plan.probes];
  let totalCost = 0;
  const running = new Map<string, Promise<void>>();

  async function runProbe(config: ProbeConfig): Promise<void> {
    if (signal?.aborted) return;

    onProgress?.(config.id, 'running', 0);

    const ctx: ProbeContext = {
      config,
      scan,
      settings,
      signal,
      onProgress: (status, progress) => onProgress?.(config.id, status, progress),
    };

    const probe = createProbe(config.type, ctx);

    try {
      const report = await probe.execute();
      reports.push(report);

      // Estimate cost (rough: $0.15/1M input tokens for fast model)
      const costEstimate = (report.tokensUsed / 1_000_000) * 0.15;
      totalCost += costEstimate;

      onProbeComplete?.(report);
      onProgress?.(config.id, 'completed', 1.0);

      log.info(`Probe ${config.id} completed`, {
        findings: report.findings.length,
        files: report.filesExamined.length,
        tokens: report.tokensUsed,
        cost: `$${costEstimate.toFixed(4)}`,
      });
    } catch (err) {
      log.error(`Probe ${config.id} failed`, err);
      onProgress?.(config.id, 'failed', 0);

      // Still add a minimal report for failed probes
      reports.push({
        probeId: config.id,
        type: config.type,
        findings: [],
        markdown: `## 探针失败: ${config.id}\n\n${err instanceof Error ? err.message : String(err)}`,
        filesExamined: [],
        dependencies: [],
        issues: [],
        confidence: 0,
        tokensUsed: 0,
        durationMs: 0,
        rounds: 0,
      });
    }
  }

  // Process queue with concurrency limit
  while (queue.length > 0 || running.size > 0) {
    if (signal?.aborted) break;

    // Check budget
    if (totalCost >= budgetUsd && queue.length > 0) {
      log.warn(`Budget limit reached ($${totalCost.toFixed(2)} / $${budgetUsd}), skipping ${queue.length} remaining probes`);
      break;
    }

    // Fill up to concurrency limit
    while (queue.length > 0 && running.size < concurrency) {
      const config = queue.shift()!;
      const id = config.id;
      const promise = runProbe(config).then(() => { running.delete(id); });
      running.set(id, promise);
    }

    // Wait for at least one to finish
    if (running.size > 0) {
      await Promise.race(running.values());
    }
  }

  return reports;
}

/**
 * Create a probe instance by type.
 */
function createProbe(type: ProbeType, ctx: ProbeContext): BaseProbe {
  switch (type) {
    case 'entry': return new EntryProbe(ctx);
    case 'module': return new ModuleProbe(ctx);
    case 'api-boundary': return new APIBoundaryProbe(ctx);
    case 'data-model': return new DataModelProbe(ctx);
    case 'config-infra': return new ConfigInfraProbe(ctx);
    case 'smell': return new SmellProbe(ctx);
    default: throw new Error(`Unknown probe type: ${type}`);
  }
}

// ═══════════════════════════════════════
// Finding Merge
// ═══════════════════════════════════════

/**
 * Merge findings from all probe reports:
 * - Deduplicate by file overlap
 * - Detect conflicts
 * - Calculate coverage
 */
export function mergeFindings(
  reports: ProbeReport[],
  totalFiles: number,
): MergedFindings {
  const allFindings: Finding[] = [];
  const seenIds = new Set<string>();
  const conflicts: MergedFindings['conflicts'] = [];

  // Collect all files examined
  const allFilesExamined = new Set<string>();

  for (const report of reports) {
    for (const file of report.filesExamined) {
      allFilesExamined.add(file);
    }

    for (const finding of report.findings) {
      // Check for duplicates
      if (seenIds.has(finding.id)) {
        // Find the existing finding and check for conflict
        const existing = allFindings.find(f => f.id === finding.id);
        if (existing && existing.description !== finding.description) {
          conflicts.push({
            findingA: `${report.probeId}:${finding.id}`,
            findingB: `existing:${finding.id}`,
            resolution: `Keeping higher-confidence version`,
          });
        }
        continue;
      }

      // Check file overlap with existing findings
      let merged = false;
      for (const existing of allFindings) {
        if (existing.type === finding.type) {
          const overlapFiles = finding.files.filter(f => existing.files.includes(f));
          if (overlapFiles.length > 0 && overlapFiles.length >= finding.files.length * 0.5) {
            // Merge: combine information
            existing.publicAPI = [...new Set([...(existing.publicAPI || []), ...(finding.publicAPI || [])])];
            existing.keyTypes = [...new Set([...(existing.keyTypes || []), ...(finding.keyTypes || [])])];
            existing.relationships = [...existing.relationships, ...finding.relationships];
            existing.files = [...new Set([...existing.files, ...finding.files])];
            if (finding.description.length > existing.description.length) {
              existing.description = finding.description;
            }
            merged = true;
            break;
          }
        }
      }

      if (!merged) {
        seenIds.add(finding.id);
        allFindings.push({ ...finding });
      }
    }
  }

  const coveragePercent = totalFiles > 0
    ? Math.round((allFilesExamined.size / totalFiles) * 100)
    : 0;

  log.info(`Merge: ${allFindings.length} findings, ${conflicts.length} conflicts, ${coveragePercent}% coverage`);

  return { findings: allFindings, conflicts, coveragePercent };
}
