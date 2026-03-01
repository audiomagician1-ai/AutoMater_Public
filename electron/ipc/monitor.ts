/**
 * IPC Handlers — System Monitor + Activity Timeseries + Model Pricing (v6.0)
 */

import { ipcMain } from 'electron';
import { getSystemMetrics, getActivityTimeseries, getBuiltinModelPricing } from '../engine/system-monitor';

export function setupMonitorHandlers() {
  // ── 系统性能快照 ──
  ipcMain.handle('monitor:system-metrics', async () => {
    return getSystemMetrics();
  });

  // ── 活动时序数据 ──
  ipcMain.handle('monitor:activity-timeseries', async (_e, projectId: string, minutes?: number) => {
    return getActivityTimeseries(projectId, minutes ?? 30);
  });

  // ── 内置模型价格表 (供设置界面参考) ──
  ipcMain.handle('monitor:builtin-pricing', async () => {
    return getBuiltinModelPricing();
  });
}
