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
// Architecture Tree (Phase 2 output — hierarchical)
// ═══════════════════════════════════════

/**
 * 层级架构树 — 导入阶段的核心产物。
 *
 * 三层结构: domain → module → component
 *   - domain:    架构域 (如 "渲染层", "数据层", "基础设施")
 *   - module:    模块 (如 "路由系统", "状态管理", "ORM")
 *   - component: 组件 (如 "AuthGuard", "UserStore", "MigrationRunner")
 *
 * 每个叶子节点在导入完成后自动写入 features 表 (status='arch_node'),
 * 作为后续开发的逻辑索引——PM 在此基础上补充开发任务,
 * Developer 通过 affected_files 精准定位上下文。
 */
export interface ArchTree {
  /** 所有节点 (扁平存储, 用 parentId 形成树) */
  nodes: ArchNode[];
  /** 跨节点依赖边 (仅 module/component 层级之间) */
  edges: ArchEdge[];
}

export type ArchNodeLevel = 'domain' | 'module' | 'component';

export interface ArchNode {
  /** 唯一标识, 格式: D01, D01-M01, D01-M01-C01 */
  id: string;
  /** 父节点 ID (domain 的 parentId 为 null) */
  parentId: string | null;
  /** 层级 */
  level: ArchNodeLevel;
  /** 人类可读名称 */
  name: string;
  /** 一句话职责描述 */
  responsibility: string;
  /** 架构类型标签 */
  type: 'entry-point' | 'api-layer' | 'data-layer' | 'business-logic' | 'config' | 'utility' | 'ui' | 'infrastructure';
  /** 涉及的文件列表 (相对路径, domain/module 为聚合值, component 为精确值) */
  files: string[];
  /** 公开 API / 导出接口 */
  publicAPI: string[];
  /** 关键类型 / 接口 */
  keyTypes: string[];
  /** 使用的设计模式 */
  patterns: string[];
  /** 已知问题 / 技术债 */
  issues: string[];
  /** 代码行数 (估算) */
  loc: number;
  /** 文件数 */
  fileCount: number;
}

export interface ArchEdge {
  /** 源节点 ID */
  source: string;
  /** 目标节点 ID */
  target: string;
  /** 依赖类型 */
  type: 'import' | 'dataflow' | 'event' | 'config' | 'ipc';
  /** 依赖权重 (越大越关键) */
  weight: number;
  /** 人类可读说明 (可选) */
  label?: string;
}

// ═══════════════════════════════════════
// Fuse Output (Phase 2 complete output)
// ═══════════════════════════════════════

export interface FuseOutput {
  moduleGraph: ModuleGraph;
  /** v10.0: 层级架构树 — 导入阶段核心产物 */
  archTree: ArchTree;
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

/**
 * Detailed log callback for import process.
 * Sends granular logs (probe thinking, file reads, LLM content) to the UI.
 */
export type ImportLogCallback = (entry: ImportLogEntry) => void;

export interface ImportLogEntry {
  /** Which agent/probe is producing this log */
  agentId: string;
  /** Log content */
  content: string;
  /** Log type: info=normal, stream=LLM streaming chunk, thinking=reasoning */
  type: 'info' | 'stream' | 'thinking' | 'error';
  /** Optional probe details */
  probeId?: string;
  probeType?: ProbeType;
  round?: number;
}
