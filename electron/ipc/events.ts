/**
 * IPC Handlers — Event Stream + Mission + Knowledge (v2.0)
 */

import { ipcMain } from 'electron';
import { queryEvents, getFeatureTimeline, getRecentEvents, getProjectEventStats, exportEventsNDJSON } from '../engine/event-store';
import { getMissionStatus, getCheckpoints, generateProgressReport, detectResumableProjects } from '../engine/mission';
import { getKnowledgeStats, queryKnowledge } from '../engine/cross-project';

export function setupEventHandlers() {
  // ── Events ──
  ipcMain.handle('events:query', async (_e, projectId: string, options?: { featureId?: string; types?: string[]; limit?: number }) => {
    return queryEvents({
      projectId,
      featureId: options?.featureId,
      types: options?.types as import('../engine/event-store').EventType[] | undefined,
      limit: options?.limit ?? 100,
    });
  });

  ipcMain.handle('events:get-stats', async (_e, projectId: string) => {
    return getProjectEventStats(projectId);
  });

  ipcMain.handle('events:get-timeline', async (_e, projectId: string, featureId: string) => {
    return getFeatureTimeline(projectId, featureId);
  });

  ipcMain.handle('events:export-ndjson', async (_e, projectId: string) => {
    return exportEventsNDJSON(projectId);
  });

  // ── Mission ──
  ipcMain.handle('mission:get-status', async (_e, projectId: string) => {
    return getMissionStatus(projectId);
  });

  ipcMain.handle('mission:get-checkpoints', async (_e, projectId: string) => {
    return getCheckpoints(projectId);
  });

  ipcMain.handle('mission:get-progress-report', async (_e, projectId: string) => {
    return generateProgressReport(projectId);
  });

  ipcMain.handle('mission:detect-resumable', async () => {
    return detectResumableProjects();
  });

  // ── Knowledge ──
  ipcMain.handle('knowledge:get-stats', async () => {
    return getKnowledgeStats();
  });

  ipcMain.handle('knowledge:query', async (_e, tags: string[]) => {
    return queryKnowledge(tags);
  });
}
