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
  ImportLogCallback,
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

/** Default per-probe token budgets by scale (output maxTokens for callLLM) */
const SCALE_BUDGETS: Record<string, { entry: number; module: number; api: number; data: number; config: number; smell: number }> = {
  medium:  { entry: 12000, module: 10000, api: 10000, data: 10000, config: 8000, smell: 8000 },
  large:   { entry: 16000, module: 12000, api: 12000, data: 12000, config: 10000, smell: 10000 },
  massive: { entry: 20000, module: 16000, api: 16000, data: 16000, config: 12000, smell: 12000 },
};

/** Default per-probe maxFilesToRead by scale */
const SCALE_MAX_FILES: Record<string, { entry: number; module: number; api: number; data: number; config: number; smell: number }> = {
  medium:  { entry: 15, module: 10, api: 12, data: 12, config: 10, smell: 12 },
  large:   { entry: 20, module: 14, api: 16, data: 16, config: 12, smell: 16 },
  massive: { entry: 25, module: 18, api: 20, data: 20, config: 16, smell: 20 },
};

/** Default maxRounds by scale */
const SCALE_MAX_ROUNDS: Record<string, { entry: number; module: number; other: number }> = {
  medium:  { entry: 2, module: 2, other: 1 },
  large:   { entry: 3, module: 2, other: 2 },
  massive: { entry: 3, module: 3, other: 2 },
};

/**
 * Generate exploration plan based on Phase 0 scan results.
 * All budgets/limits scale dynamically with project size.
 * Probe count: medium ~6-8, large ~10-15, massive ~15-25.
 */
export function planProbes(scan: ScanResult): ExplorationPlan {
  const probes: ProbeConfig[] = [];
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${++idCounter}`;

  const { profile, hubFiles, communities, snapshot } = scan;
  const scale = profile.scale;

  const budgets = SCALE_BUDGETS[scale] || SCALE_BUDGETS.medium;
  const maxFiles = SCALE_MAX_FILES[scale] || SCALE_MAX_FILES.medium;
  const maxRounds = SCALE_MAX_ROUNDS[scale] || SCALE_MAX_ROUNDS.medium;

  // ── Entry Probes (priority 1) ──
  const entryFiles = scan.seedFiles
    .filter(s => s.reason === 'entry')
    .map(s => s.file);

  if (entryFiles.length > 0) {
    probes.push({
      id: nextId('entry'),
      type: 'entry',
      seeds: entryFiles.slice(0, 3),
      graphHops: scale === 'massive' ? 5 : 4,
      maxFilesToRead: maxFiles.entry,
      maxRounds: maxRounds.entry,
      tokenBudget: budgets.entry,
      priority: 1,
      description: `入口追踪: ${entryFiles.slice(0, 3).join(', ')}`,
    });
  }

  // ── Module Probes (priority 2) ──
  const moduleSeeds = selectModuleSeeds(hubFiles, communities, scale);
  for (const group of moduleSeeds) {
    probes.push({
      id: nextId('module'),
      type: 'module',
      seeds: group.seeds,
      graphHops: 3,
      maxFilesToRead: maxFiles.module,
      maxRounds: maxRounds.module,
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
    maxFilesToRead: maxFiles.api,
    maxRounds: maxRounds.other,
    tokenBudget: budgets.api,
    priority: 3,
    description: 'API 边界: 路由/handler/IPC 端点',
  });

  // ── Data Model Probe (priority 3) ──
  probes.push({
    id: nextId('data'),
    type: 'data-model',
    seeds: findDataModelSeeds(scan),
    maxFilesToRead: maxFiles.data,
    maxRounds: maxRounds.other,
    tokenBudget: budgets.data,
    priority: 3,
    description: '数据模型: 类型/Schema/ORM 定义',
  });

  // ── Config/Infra Probe (priority 4) ──
  probes.push({
    id: nextId('config'),
    type: 'config-infra',
    seeds: findConfigSeeds(scan),
    maxFilesToRead: maxFiles.config,
    maxRounds: maxRounds.other,
    tokenBudget: budgets.config,
    priority: 4,
    description: '配置/基础设施: 构建/部署/环境',
  });

  // ── Smell Probe (priority 5) ──
  probes.push({
    id: nextId('smell'),
    type: 'smell',
    seeds: [],
    maxFilesToRead: maxFiles.smell,
    maxRounds: maxRounds.other,
    tokenBudget: budgets.smell,
    priority: 5,
    description: '异常检测: TODO/HACK/大文件/循环依赖',
  });

  // Sort by priority
  probes.sort((a, b) => a.priority - b.priority);

  // Estimate totals
  const estimatedTotalTokens = probes.reduce((s, p) => s + p.tokenBudget, 0);
  const avgProbeMs = 15000; // ~15s per probe with fast model
  const estimatedDurationMs = Math.ceil(probes.length / 3) * avgProbeMs;

  log.info(`Exploration plan: ${probes.length} probes, ~${estimatedTotalTokens} tokens, ~${Math.round(estimatedDurationMs / 1000)}s`, {
    scale,
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
  /** Detailed log callback for probe LLM output, file reads, etc. */
  onLog?: ImportLogCallback;
  /** Per-probe timeout in ms (default: 300000 = 5min) */
  probeTimeoutMs?: number;
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
    onLog,
    probeTimeoutMs = 300_000,
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
      onLog,
      timeoutMs: probeTimeoutMs,
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
