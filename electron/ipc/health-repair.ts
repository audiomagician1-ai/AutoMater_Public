/**
 * Health & Repair IPC Handlers — 健康诊断与自动修复 IPC 接口 (v34.0)
 *
 * 提供 Electron IPC 接口让渲染进程 (管家 UI / 健康面板) 查询和触发修复。
 *
 * Handlers:
 *   health:diagnostics     — 执行健康诊断
 *   health:anomaly-summary — 获取异常摘要 (给 UI 展示)
 *   repair:history         — 获取修复历史
 *   repair:stats           — 获取修复统计
 *   repair:run-l1          — 手动执行 L1 修复
 *   repair:trigger-l3      — 手动触发 L3 深度自修复
 */

import { ipcMain, BrowserWindow } from 'electron';
import { createLogger } from '../engine/logger';
import {
  runDiagnostics,
  runProjectDiagnostics,
  formatAnomalySummary,
  type AnomalyReport,
  type DiagnosticThresholds,
} from '../engine/health-diagnostics';
import {
  handleAnomalies,
  getRemediationHistory,
  getRemediationStats,
  ensureRemediationTable,
  type RemediationRecord,
} from '../engine/auto-remediation';
import {
  SelfRepairEngine,
  type RepairResult,
} from '../engine/self-repair-engine';

const log = createLogger('ipc:health-repair');

// ═══════════════════════════════════════
// Helper: resolve source root
// ═══════════════════════════════════════

import path from 'path';
import fs from 'fs';

function resolveSourceRoot(): string {
  if (process.env.AUTOMATER_SOURCE_ROOT) {
    return process.env.AUTOMATER_SOURCE_ROOT;
  }
  const knownPaths = [
    path.resolve(__dirname, '..', '..'),
    path.resolve(__dirname, '..'),
  ];
  for (const p of knownPaths) {
    if (fs.existsSync(path.join(p, 'electron', 'engine'))) {
      return p;
    }
  }
  return knownPaths[0];
}

// ═══════════════════════════════════════
// Register Handlers
// ═══════════════════════════════════════

export function registerHealthRepairHandlers(): void {
  log.info('Registering health & repair IPC handlers');

  // ── health:diagnostics ──
  ipcMain.handle(
    'health:diagnostics',
    async (
      _event,
      params: { projectId?: string; thresholds?: Partial<DiagnosticThresholds>; autoFix?: boolean },
    ): Promise<{
      anomalies: AnomalyReport[];
      summary: string;
      remediations?: RemediationRecord[];
    }> => {
      try {
        const anomalies = params.projectId
          ? runProjectDiagnostics(params.projectId, params.thresholds)
          : runDiagnostics(params.thresholds);

        const summary = formatAnomalySummary(anomalies);
        let remediations: RemediationRecord[] | undefined;

        if (params.autoFix && anomalies.length > 0) {
          const win = BrowserWindow.getAllWindows()[0] ?? null;
          remediations = await handleAnomalies(anomalies, win);
        }

        return { anomalies, summary, remediations };
      } catch (err) {
        log.error('health:diagnostics failed', err);
        throw err;
      }
    },
  );

  // ── health:anomaly-summary ──
  ipcMain.handle('health:anomaly-summary', async (): Promise<string> => {
    try {
      const anomalies = runDiagnostics();
      return formatAnomalySummary(anomalies);
    } catch (err) {
      log.error('health:anomaly-summary failed', err);
      return '⚠️ 健康检查失败';
    }
  });

  // ── repair:history ──
  ipcMain.handle(
    'repair:history',
    async (_event, params: { projectId: string; limit?: number }): Promise<RemediationRecord[]> => {
      try {
        ensureRemediationTable();
        return getRemediationHistory(params.projectId, params.limit);
      } catch (err) {
        log.error('repair:history failed', err);
        return [];
      }
    },
  );

  // ── repair:stats ──
  ipcMain.handle(
    'repair:stats',
    async (
      _event,
      params: { projectId?: string },
    ): Promise<{
      total: number;
      success: number;
      failed: number;
      byLevel: Record<number, number>;
      byPattern: Record<string, number>;
    }> => {
      try {
        ensureRemediationTable();
        return getRemediationStats(params.projectId);
      } catch (err) {
        log.error('repair:stats failed', err);
        return { total: 0, success: 0, failed: 0, byLevel: {}, byPattern: {} };
      }
    },
  );

  // ── repair:run-l1 ──
  ipcMain.handle(
    'repair:run-l1',
    async (
      _event,
      params: {
        action: string;
        projectId: string;
        featureId?: string;
        reason?: string;
      },
    ): Promise<{ success: boolean; detail: string }> => {
      try {
        ensureRemediationTable();
        const win = BrowserWindow.getAllWindows()[0] ?? null;

        // 构造一个 synthetic anomaly 来触发 L1 修复
        const anomaly: AnomalyReport = {
          pattern: 'zombie_feature', // 通用
          severity: 'warning',
          projectId: params.projectId,
          featureId: params.featureId,
          description: `Manual L1 action: ${params.action}`,
          evidence: { manual: true, reason: params.reason },
          suggestedLevel: 1,
          suggestedAction: {
            type: params.action as import('../engine/health-diagnostics').L1ActionType,
            params: {
              projectId: params.projectId,
              featureId: params.featureId,
              reason: params.reason ?? 'manual',
            },
          },
          detectedAt: new Date().toISOString(),
        };

        const results = await handleAnomalies([anomaly], win);
        const result = results[0];

        return {
          success: result?.status === 'success',
          detail: result?.detail ?? 'No action taken',
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('repair:run-l1 failed', err);
        return { success: false, detail: msg };
      }
    },
  );

  // ── repair:trigger-l3 ──
  ipcMain.handle(
    'repair:trigger-l3',
    async (
      _event,
      params: {
        projectId: string;
        anomalyPattern: string;
        detail: string;
      },
    ): Promise<RepairResult> => {
      try {
        const sourceRoot = resolveSourceRoot();
        const engine = new SelfRepairEngine({ sourceRoot });

        const record: RemediationRecord = {
          anomalyPattern: params.anomalyPattern as import('../engine/health-diagnostics').AnomalyPattern,
          level: 3,
          projectId: params.projectId,
          action: 'self_repair',
          status: 'pending',
          detail: params.detail,
          tokensUsed: 0,
          costUsd: 0,
        };

        const result = await engine.repair(record);

        // 推送结果到 UI
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) {
          win.webContents.send('repair:l3-result', result);
        }

        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('repair:trigger-l3 failed', err);
        return {
          success: false,
          repairId: 'error',
          branch: '',
          modifiedFiles: [],
          merged: false,
          rolledBack: false,
          logs: [msg],
          tokensUsed: 0,
          costUsd: 0,
          error: msg,
        };
      }
    },
  );

  log.info('Health & repair IPC handlers registered');
}
