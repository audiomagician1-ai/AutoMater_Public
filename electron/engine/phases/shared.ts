/**
 * Shared imports and utilities for all phase modules.
 * Centralizes dependencies to avoid duplication across phase files.
 *
 * @module phases/shared
 */

export { BrowserWindow } from 'electron';
export { exec as execCb, execSync } from 'child_process';
export { promisify } from 'util';
export { default as fs } from 'fs';
export { default as path } from 'path';

import { exec as _execCb } from 'child_process';
import { promisify as _promisify } from 'util';
/** Promisified exec for async shell commands */
export const execAsync = _promisify(_execCb);
export { getDb } from '../../db';
export { createLogger, toErrorMessage } from '../logger';
import { createLogger as _createLogger } from '../logger';
const log = _createLogger('phase:shared');

// ── Engine modules ──
export { callLLM, calcCost, getSettings, sleep, validateModel, NonRetryableError } from '../llm-client';
export { sendToUI, addLog, notify, createStreamCallback } from '../ui-bridge';
export {
  spawnAgent,
  updateAgentStats,
  checkBudget,
  lockNextFeature,
  getTeamPrompt,
  getTeamMemberLLMConfig,
  getTeamMemberMaxIterations,
  stopOrchestrator,
} from '../agent-manager';
export { reactDeveloperLoop, reactAgentLoop } from '../react-loop';
export type { GenericReactResult } from '../react-loop';
export { runQAReview, generateTestSkeleton } from '../qa-loop';

// ── Types ──
export type {
  AppSettings,
  ProjectRow,
  FeatureRow,
  CountResult,
  ParsedFeature,
  EnrichedFeature,
  WorkflowStageId,
  PhaseResult,
  PhaseStatus,
  PMPhaseResult,
  TeamMemberRow,
} from '../types';
export { makePhaseResult } from '../types';
export {
  PM_SYSTEM_PROMPT,
  ARCHITECT_SYSTEM_PROMPT,
  PM_DESIGN_DOC_PROMPT,
  PM_SPLIT_REQS_PROMPT,
  QA_TEST_SPEC_PROMPT,
  PM_ACCEPTANCE_PROMPT,
  resolvePrompt,
  getStatusGuidance,
} from '../prompts';
export { parseFileBlocks, writeFileBlocks } from '../file-writer';
export { parseStructuredOutput, PM_FEATURE_SCHEMA, PM_ACCEPTANCE_SCHEMA } from '../output-parser';
export { gatePMToArchitect, gateArchitectToDeveloper } from '../guards';
export { commitWorkspace } from '../workspace-git';
export {
  ensureGlobalMemory,
  ensureProjectMemory,
  appendProjectMemory,
  buildLessonExtractionPrompt,
} from '../memory-system';
export { selectModelTier, resolveModel } from '../model-selector';
export { emitEvent } from '../event-store';
export { emitScheduleEvent } from '../scheduler-bus';
export { createCheckpoint } from '../mission';
export { extractFromProjectMemory } from '../cross-project';
export { harvestPostFeature, harvestPostSession, extractRecentFeatureLessons } from '../experience-harvester';
export { writeDoc, readDoc, buildDesignContext, buildFeatureDocContext, checkConsistency } from '../doc-manager';
export { detectImplicitChanges, runChangeRequest, type WishTriageResult } from '../change-manager';
export {
  claimFiles,
  releaseFiles,
  getClaimsSummary,
  predictAffectedFiles,
  cleanupDecisionLog,
  broadcastFilesCreated,
  getRecentBroadcasts,
  formatBroadcastContext,
} from '../decision-log';
export { releaseFeatureLocks, cleanExpiredLocks } from '../file-lock';
export { incrementalUpdate, scanProjectSkeleton, type ProjectSkeleton } from '../project-importer';
export { getWorkflowConfig, getWorkflowHooks, ensureWorkflowFile } from '../workflow-config';
export {
  workpadDevStart,
  workpadDevDone,
  workpadQAResult,
  workpadPaused,
  workpadResumed,
  formatWorkpadForPrompt,
  buildContinuationDirective,
} from '../feature-workpad';
export {
  backupConversation,
  linkFeatureSession,
  completeFeatureSessionLink,
  getOrCreateSession,
  type WorkType,
} from '../conversation-backup';
export type { GitProviderConfig } from '../git-provider';

import type { AppSettings as _AppSettings } from '../types';
import { getTeamMemberLLMConfig as _getTeamMemberLLMConfig } from '../agent-manager';

/** 模块级成员模型解析器 */
export function resolveMemberModel(
  projectId: string,
  role: string,
  settings: _AppSettings,
  agentIndex: number = 0,
): string {
  return _getTeamMemberLLMConfig(projectId, role, agentIndex, settings).model;
}

/** Safe JSON parse with fallback */
export function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch (err) {
    log.debug('Catch at shared.ts:118', { error: String(err) });
    return fallback;
  }
}
