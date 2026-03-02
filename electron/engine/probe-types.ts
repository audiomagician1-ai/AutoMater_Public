/**
 * Probe Types — v7.0 多探针导入系统的类型定义
 *
 * 包含: ProbeConfig, ProbeReport, Finding, ScanResult, FuseOutput 等
 * 所有探针模块和 probe-orchestrator 均从此文件 import 类型。
 *
 * @module probe-types
 */

import type { CodeGraph, CommunityInfo, HubFile, ProjectProfile } from './code-graph';
import type { ProjectSkeleton, ModuleSummary } from './project-importer';

// ═══════════════════════════════════════
// Probe Configuration
// ═══════════════════════════════════════

export type ProbeType =
  | 'entry'
  | 'module'
  | 'api-boundary'
  | 'data-model'
  | 'config-infra'
  | 'smell';

export interface ProbeConfig {
  /** Unique probe identifier, e.g. 'entry-main', 'module-engine' */
  id: string;
  type: ProbeType;
  /** Seed files or grep patterns for the probe to start from */
  seeds: string[];
  /** Max BFS hops for graph-following probes (Entry/Module) */
  graphHops?: number;
  /** Max files the probe may read */
  maxFilesToRead: number;
  /** Max exploration rounds (1-3) */
  maxRounds: number;
  /** Token budget: input + output combined */
  tokenBudget: number;
  /** Priority for scheduling (lower = higher priority) */
  priority: number;
  /** Human-readable description of what this probe explores */
  description: string;
}

// ═══════════════════════════════════════
// Probe Report (output of each probe)
// ═══════════════════════════════════════

export interface ProbeReport {
  probeId: string;
  type: ProbeType;
  /** Structured findings — fed into module-graph.json construction */
  findings: Finding[];
  /** Readable report for human review */
  markdown: string;
  /** Files actually read by this probe */
  filesExamined: string[];
  /** Discovered dependency relationships */
  dependencies: ProbeDepEdge[];
  /** Discovered issues */
  issues: ProbeIssue[];
  /** Self-assessed confidence (0-1) */
  confidence: number;
  /** Tokens consumed */
  tokensUsed: number;
  /** Wall-clock ms */
  durationMs: number;
  /** Actual exploration rounds executed */
  rounds: number;
}

export interface ProbeDepEdge {
  source: string;
  target: string;
  type: 'import' | 'dataflow' | 'event' | 'ipc' | 'config' | 'runtime';
}

export interface ProbeIssue {
  location: string;
  severity: 'critical' | 'warning' | 'info';
  description: string;
  category?: string;
}

// ═══════════════════════════════════════
// Finding (atomic unit of probe discovery)
// ═══════════════════════════════════════

export type FindingType =
  | 'module'
  | 'api-endpoint'
  | 'data-model'
  | 'pattern'
  | 'anti-pattern'
  | 'dependency'
  | 'config'
  | 'entry-flow';

export interface Finding {
  type: FindingType;
  /** Unique identifier within the probe */
  id: string;
  name: string;
  description: string;
  /** Files involved in this finding */
  files: string[];
  /** Public API / exports (Module Probe fills) */
  publicAPI?: string[];
  /** Key types / interfaces (Data Model Probe fills) */
  keyTypes?: string[];
  /** Relationships to other findings/modules */
  relationships: Array<{ target: string; type: string }>;
}

// ═══════════════════════════════════════
// Seed File (Phase 0 output)
// ═══════════════════════════════════════

export interface SeedFile {
  file: string;
  reason: 'entry' | 'hub' | 'config' | 'largest' | 'community-center';
  importCount: number;
  importedByCount: number;
}

// ═══════════════════════════════════════
// Exploration Plan (Phase 0 → Phase 1)
// ═══════════════════════════════════════

export interface ExplorationPlan {
  probes: ProbeConfig[];
  estimatedTotalTokens: number;
  estimatedDurationMs: number;
}

// ═══════════════════════════════════════
// Scan Result (Phase 0 complete output)
// ═══════════════════════════════════════

export interface ScanResult {
  /** Project snapshot from v6.0 collection */
  snapshot: {
    techStack: string[];
    packageFiles: string[];
    directoryTree: string;
    keyFileContents: string;
    repoMap: string;
    entryFileSnippets: string;
    fileCount: number;
    totalLOC: number;
    locByExtension: Record<string, number>;
  };
  /** File-level import dependency graph */
  graph: CodeGraph;
  /** Repo map (symbol index) */
  repoMap: string;
  /** Project characteristic profile */
  profile: ProjectProfile;
  /** Seed files for probes */
  seedFiles: SeedFile[];
  /** Exploration plan for Phase 1 */
  explorationPlan: ExplorationPlan;
  /** Community detection results */
  communities: CommunityInfo;
  /** Hub files */
  hubFiles: HubFile[];
  /** All code files discovered */
  allCodeFiles: string[];
  /** Workspace root path */
  workspacePath: string;
}

// ═══════════════════════════════════════
// Merged Findings (Orchestrator output)
// ═══════════════════════════════════════

export interface MergedFindings {
  findings: Finding[];
  conflicts: Array<{ findingA: string; findingB: string; resolution: string }>;
  coveragePercent: number;
}

// ═══════════════════════════════════════
// Module Graph (Phase 2 output, RPG-style)
// ═══════════════════════════════════════

export interface ModuleGraph {
  nodes: ModuleGraphNode[];
  edges: ModuleGraphEdge[];
}

export interface ModuleGraphNode {
  id: string;
  type: 'module' | 'entry-point' | 'api-layer' | 'data-layer' | 'config' | 'utility';
  path: string;
  responsibility: string;
  publicAPI: string[];
  keyTypes: string[];
  patterns: string[];
  issues: string[];
  fileCount: number;
  loc: number;
}

export interface ModuleGraphEdge {
  source: string;
  target: string;
  type: 'import' | 'dataflow' | 'event' | 'config' | 'ipc';
  weight: number;
}

// ═══════════════════════════════════════
// Fuse Output (Phase 2 complete output)
// ═══════════════════════════════════════

export interface FuseOutput {
  moduleGraph: ModuleGraph;
  architectureMd: string;
  knownIssuesMd: string;
  enrichedSkeleton: ProjectSkeleton;
  stats: ImportStats;
}

export interface ImportStats {
  totalProbes: number;
  totalFilesRead: number;
  totalTokensUsed: number;
  totalCostUsd: number;
  totalDurationMs: number;
  coveragePercent: number;
}

// ═══════════════════════════════════════
// Progress Callback (enhanced for v7.0)
// ═══════════════════════════════════════

export type ImportPhase = 'scan' | 'probe' | 'fuse';

export interface ProbeProgress {
  probeId: string;
  type: ProbeType;
  status: 'running' | 'completed' | 'failed' | 'queued';
  description: string;
  /** 0-1 */
  progress: number;
  round?: number;
  maxRounds?: number;
}

export interface ImportProgressEvent {
  phase: ImportPhase;
  step: string;
  /** 0-1 overall progress */
  progress: number;
  /** Per-probe status (Phase 1 only) */
  probes?: ProbeProgress[];
  /** Cost so far */
  costUsd?: number;
  /** Coverage so far */
  coveragePercent?: number;
  done?: boolean;
  error?: boolean;
}

export type ImportProgressCallbackV7 = (event: ImportProgressEvent) => void;
