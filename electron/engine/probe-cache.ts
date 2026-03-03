/**
 * Probe Cache System — v7.0 Phase D
 *
 * Provides:
 * 1. Hash-based probe result caching — avoid re-probing unchanged file regions
 * 2. Git-diff-based incremental detection — identify which probes need re-running
 * 3. User feedback loop support — accept corrections to module-graph
 *
 * Cache format: .automater/analysis/probe-cache.json
 * Each probe result is keyed by (probeType + seedFiles) with a content hash
 * of the files examined. If file hashes haven't changed, the cached report is reused.
 *
 * @module probe-cache
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from './logger';
import type { ProbeReport, ProbeConfig, ModuleGraph, ModuleGraphNode } from './probe-types';
import { safeJsonParse } from './safe-json';

const log = createLogger('probe-cache');

const CACHE_FILE = '.automater/analysis/probe-cache.json';
const MODULE_GRAPH_FILE = '.automater/analysis/module-graph.json';
const CACHE_VERSION = 1;

// ═══════════════════════════════════════
// Cache Data Types
// ═══════════════════════════════════════

interface CachedProbe {
  probeId: string;
  type: string;
  /** Hash of the probe config (seeds + type + budget) */
  configHash: string;
  /** Hash of file contents this probe examined */
  contentHash: string;
  /** The cached report */
  report: ProbeReport;
  /** When this was cached */
  cachedAt: number;
  /** Files that were examined */
  files: string[];
}

interface ProbeCache {
  version: number;
  projectPath: string;
  cachedAt: number;
  probes: CachedProbe[];
  /** Accumulated user corrections */
  userCorrections: UserCorrection[];
}

export interface UserCorrection {
  timestamp: number;
  /** Which module was corrected */
  moduleId: string;
  /** What was changed */
  field: 'responsibility' | 'publicAPI' | 'keyTypes' | 'type' | 'issues' | 'merge' | 'split';
  /** Old value (for audit trail) */
  oldValue: string;
  /** New value */
  newValue: string;
}

// ═══════════════════════════════════════
// File Hashing
// ═══════════════════════════════════════

/** Compute SHA-256 hash of a file's content */
function hashFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch { /* silent: 文件hash计算失败 */
    return 'missing';
  }
}

/** Hash a set of files to create a composite content hash */
function hashFiles(workspacePath: string, files: string[]): string {
  const hashes = files
    .sort()
    .map(f => `${f}:${hashFile(path.join(workspacePath, f))}`)
    .join('|');
  return crypto.createHash('sha256').update(hashes).digest('hex').slice(0, 16);
}

/** Hash a probe config to detect config changes */
function hashProbeConfig(config: ProbeConfig): string {
  const key = `${config.type}:${config.seeds.sort().join(',')}:${config.maxRounds}:${config.tokenBudget}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

// ═══════════════════════════════════════
// Cache Read / Write
// ═══════════════════════════════════════

/** Load the probe cache for a workspace */
export function loadProbeCache(workspacePath: string): ProbeCache | null {
  const cachePath = path.join(workspacePath, CACHE_FILE);
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const cache: ProbeCache = JSON.parse(raw);
    if (cache.version !== CACHE_VERSION) {
      log.info('Cache version mismatch, invalidating', { have: cache.version, want: CACHE_VERSION });
      return null;
    }
    return cache;
  } catch { /* silent: 缓存加载失败,重新扫描 */
    return null;
  }
}

/** Save the probe cache */
export function saveProbeCache(workspacePath: string, cache: ProbeCache): void {
  const cachePath = path.join(workspacePath, CACHE_FILE);
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  log.info('Probe cache saved', { probes: cache.probes.length, corrections: cache.userCorrections.length });
}

// ═══════════════════════════════════════
// Cache Hit/Miss Detection
// ═══════════════════════════════════════

export interface CacheCheckResult {
  /** Probes that can be reused from cache */
  hits: Array<{ config: ProbeConfig; cachedReport: ProbeReport }>;
  /** Probes that need to run (cache miss or content changed) */
  misses: ProbeConfig[];
  /** Reason for each miss */
  missReasons: Map<string, 'no-cache' | 'config-changed' | 'content-changed' | 'files-missing'>;
}

/**
 * Check which probes can be served from cache and which need re-running.
 * A probe is a cache hit if:
 *   1. Same config hash (type + seeds + budget)
 *   2. Same content hash (all examined files unchanged)
 */
export function checkProbeCache(
  workspacePath: string,
  probeConfigs: ProbeConfig[],
): CacheCheckResult {
  const cache = loadProbeCache(workspacePath);
  const result: CacheCheckResult = {
    hits: [],
    misses: [],
    missReasons: new Map(),
  };

  if (!cache) {
    // No cache at all — everything is a miss
    for (const config of probeConfigs) {
      result.misses.push(config);
      result.missReasons.set(config.id, 'no-cache');
    }
    return result;
  }

  // Index cached probes by configHash
  const cacheIndex = new Map<string, CachedProbe>();
  for (const cp of cache.probes) {
    cacheIndex.set(cp.configHash, cp);
  }

  for (const config of probeConfigs) {
    const configHash = hashProbeConfig(config);
    const cached = cacheIndex.get(configHash);

    if (!cached) {
      result.misses.push(config);
      result.missReasons.set(config.id, 'no-cache');
      continue;
    }

    // Check if examined files have changed
    if (cached.files.length === 0) {
      // Probe didn't examine any files — re-run
      result.misses.push(config);
      result.missReasons.set(config.id, 'files-missing');
      continue;
    }

    const currentContentHash = hashFiles(workspacePath, cached.files);
    if (currentContentHash !== cached.contentHash) {
      result.misses.push(config);
      result.missReasons.set(config.id, 'content-changed');
      continue;
    }

    // Cache hit!
    result.hits.push({ config, cachedReport: cached.report });
  }

  log.info('Cache check result', {
    total: probeConfigs.length,
    hits: result.hits.length,
    misses: result.misses.length,
  });

  return result;
}

/**
 * Update the cache with new probe results.
 * Merges new results with existing cache, replacing stale entries.
 */
export function updateProbeCache(
  workspacePath: string,
  probeConfigs: ProbeConfig[],
  reports: ProbeReport[],
): void {
  const existing = loadProbeCache(workspacePath) || {
    version: CACHE_VERSION,
    projectPath: workspacePath,
    cachedAt: Date.now(),
    probes: [],
    userCorrections: [],
  };

  // Build a map of existing cached probes (keep entries not in current run)
  const existingMap = new Map<string, CachedProbe>();
  for (const cp of existing.probes) {
    existingMap.set(cp.configHash, cp);
  }

  // Add/replace with new results
  const configMap = new Map<string, ProbeConfig>();
  for (const config of probeConfigs) {
    configMap.set(config.id, config);
  }

  for (const report of reports) {
    const config = configMap.get(report.probeId);
    if (!config) continue;

    const configHash = hashProbeConfig(config);
    const contentHash = hashFiles(workspacePath, report.filesExamined);

    existingMap.set(configHash, {
      probeId: report.probeId,
      type: report.type,
      configHash,
      contentHash,
      report,
      cachedAt: Date.now(),
      files: report.filesExamined,
    });
  }

  existing.probes = Array.from(existingMap.values());
  existing.cachedAt = Date.now();

  saveProbeCache(workspacePath, existing);
}

// ═══════════════════════════════════════
// Git-Based Incremental Detection (D2)
// ═══════════════════════════════════════

export interface IncrementalResult {
  /** Files that changed since last probe */
  changedFiles: string[];
  /** Probe types that should be re-run based on changed files */
  affectedProbeTypes: Set<string>;
  /** Whether a full re-probe is needed */
  needsFullReprobe: boolean;
  /** Reason for decision */
  reason: string;
}

/**
 * Detect which files changed since last import analysis.
 * Uses `git diff --name-only` against the cached timestamp, or falls back
 * to file mtime comparison against the cache timestamp.
 */
export function detectIncrementalChanges(workspacePath: string): IncrementalResult {
  const cache = loadProbeCache(workspacePath);
  if (!cache) {
    return {
      changedFiles: [],
      affectedProbeTypes: new Set(),
      needsFullReprobe: true,
      reason: 'No cache found — full probe needed',
    };
  }

  const changedFiles: string[] = [];

  // Try git diff first
  try {
    const { execSync } = require('child_process'); // SYNC-OK: git diff <20ms, 缓存探测专用
    // Get the cache timestamp as ISO date for git
    const cacheDate = new Date(cache.cachedAt).toISOString();
    const gitOutput = execSync(
      `git diff --name-only --diff-filter=ACMR HEAD`,
      { cwd: workspacePath, encoding: 'utf-8', timeout: 10000 },
    ).trim();

    if (gitOutput) {
      changedFiles.push(...gitOutput.split('\n').filter(Boolean));
    }

    // Also check for untracked files
    const untrackedOutput = execSync(
      `git ls-files --others --exclude-standard`,
      { cwd: workspacePath, encoding: 'utf-8', timeout: 10000 },
    ).trim();
    if (untrackedOutput) {
      changedFiles.push(...untrackedOutput.split('\n').filter(Boolean));
    }
  } catch { /* silent: git untracked文件列表失败 */
    // Git not available — fall back to mtime comparison
    log.debug('Git not available, falling back to mtime check');
    for (const probe of cache.probes) {
      for (const file of probe.files) {
        try {
          const stat = fs.statSync(path.join(workspacePath, file));
          if (stat.mtimeMs > cache.cachedAt) {
            changedFiles.push(file);
          }
        } catch { /* silent: git diff解析失败 */
          // File deleted — counts as changed
          changedFiles.push(file);
        }
      }
    }
  }

  const uniqueChanged = [...new Set(changedFiles)];

  if (uniqueChanged.length === 0) {
    return {
      changedFiles: [],
      affectedProbeTypes: new Set(),
      needsFullReprobe: false,
      reason: 'No files changed since last probe',
    };
  }

  // Determine which probe types are affected
  const affectedProbeTypes = new Set<string>();
  const lowerChanged = uniqueChanged.map(f => f.toLowerCase());

  // Map file patterns to probe types
  for (const f of lowerChanged) {
    if (f.endsWith('.json') && (f.includes('config') || f.includes('package') || f.includes('tsconfig'))) {
      affectedProbeTypes.add('config-infra');
    }
    if (f.includes('route') || f.includes('api') || f.includes('controller') || f.includes('handler') || f.includes('endpoint')) {
      affectedProbeTypes.add('api-boundary');
    }
    if (f.includes('model') || f.includes('schema') || f.includes('entity') || f.includes('migration') || f.includes('types')) {
      affectedProbeTypes.add('data-model');
    }
    if (f.includes('index') || f.includes('main') || f.includes('app') || f.includes('entry')) {
      affectedProbeTypes.add('entry');
    }
    // Always re-run smell probe if any code changed
    if (f.match(/\.(ts|tsx|js|jsx|py|go|rs|java)$/)) {
      affectedProbeTypes.add('smell');
    }
    // Module probe for any significant code changes
    if (f.match(/\.(ts|tsx|js|jsx|py|go|rs|java)$/)) {
      affectedProbeTypes.add('module');
    }
  }

  // If more than 30% of probed files changed, do a full re-probe
  const totalProbedFiles = new Set(cache.probes.flatMap(p => p.files));
  const changeRatio = uniqueChanged.length / Math.max(1, totalProbedFiles.size);
  const needsFullReprobe = changeRatio > 0.3;

  return {
    changedFiles: uniqueChanged,
    affectedProbeTypes,
    needsFullReprobe,
    reason: needsFullReprobe
      ? `${uniqueChanged.length} files changed (${(changeRatio * 100).toFixed(0)}% of probed files) — full re-probe recommended`
      : `${uniqueChanged.length} files changed — incremental re-probe for: ${[...affectedProbeTypes].join(', ')}`,
  };
}

// ═══════════════════════════════════════
// User Feedback Loop (D3)
// ═══════════════════════════════════════

/**
 * Apply a user correction to the module graph and persist it.
 * Returns the updated module graph.
 */
export function applyUserCorrection(
  workspacePath: string,
  correction: Omit<UserCorrection, 'timestamp'>,
): ModuleGraph | null {
  // Load current module graph
  const graphPath = path.join(workspacePath, MODULE_GRAPH_FILE);
  let graph: ModuleGraph;
  try {
    graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
  } catch { /* silent: code-graph缓存读取失败 */
    log.warn('Cannot load module-graph for correction');
    return null;
  }

  const nodeIndex = graph.nodes.findIndex(n => n.id === correction.moduleId);
  if (nodeIndex === -1 && correction.field !== 'merge' && correction.field !== 'split') {
    log.warn('Module not found for correction', { moduleId: correction.moduleId });
    return null;
  }

  // Apply the correction
  switch (correction.field) {
    case 'responsibility':
      graph.nodes[nodeIndex].responsibility = correction.newValue;
      break;
    case 'publicAPI':
      graph.nodes[nodeIndex].publicAPI = safeJsonParse<string[]>(correction.newValue, []);
      break;
    case 'keyTypes':
      graph.nodes[nodeIndex].keyTypes = safeJsonParse<string[]>(correction.newValue, []);
      break;
    case 'type':
      graph.nodes[nodeIndex].type = correction.newValue as ModuleGraphNode['type'];
      break;
    case 'issues':
      graph.nodes[nodeIndex].issues = safeJsonParse<string[]>(correction.newValue, []);
      break;
    case 'merge': {
      // Merge two modules: correction.moduleId = source, correction.newValue = target
      const targetId = correction.newValue;
      const sourceNode = graph.nodes.find(n => n.id === correction.moduleId);
      const targetNode = graph.nodes.find(n => n.id === targetId);
      if (sourceNode && targetNode) {
        // Merge public API and types
        targetNode.publicAPI = [...new Set([...targetNode.publicAPI, ...sourceNode.publicAPI])];
        targetNode.keyTypes = [...new Set([...targetNode.keyTypes, ...sourceNode.keyTypes])];
        targetNode.issues = [...new Set([...targetNode.issues, ...sourceNode.issues])];
        targetNode.fileCount += sourceNode.fileCount;
        targetNode.loc += sourceNode.loc;
        // Redirect edges
        graph.edges = graph.edges.map(e => ({
          ...e,
          source: e.source === correction.moduleId ? targetId : e.source,
          target: e.target === correction.moduleId ? targetId : e.target,
        })).filter(e => e.source !== e.target); // Remove self-loops
        // Remove source node
        graph.nodes = graph.nodes.filter(n => n.id !== correction.moduleId);
      }
      break;
    }
    case 'split': {
      // Split a module: correction.newValue = JSON of new node definitions
      const newNodes: ModuleGraphNode[] = safeJsonParse<ModuleGraphNode[]>(correction.newValue, []);
      // Remove the original node
      graph.nodes = graph.nodes.filter(n => n.id !== correction.moduleId);
      // Add new nodes
      graph.nodes.push(...newNodes);
      break;
    }
  }

  // Save updated graph
  fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2), 'utf-8');

  // Record correction in cache
  const cache = loadProbeCache(workspacePath) || {
    version: CACHE_VERSION,
    projectPath: workspacePath,
    cachedAt: Date.now(),
    probes: [],
    userCorrections: [],
  };
  cache.userCorrections.push({ ...correction, timestamp: Date.now() });
  saveProbeCache(workspacePath, cache);

  log.info('Applied user correction', { moduleId: correction.moduleId, field: correction.field });
  return graph;
}

/**
 * Get all user corrections for a workspace
 */
export function getUserCorrections(workspacePath: string): UserCorrection[] {
  const cache = loadProbeCache(workspacePath);
  return cache?.userCorrections || [];
}
