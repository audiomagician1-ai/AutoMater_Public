/**
 * Mission IPC handlers — 临时工作流管理接口 (v6.0)
 */

import { ipcMain, BrowserWindow } from 'electron';
import { toErrorMessage, createLogger } from '../engine/logger';
import { assertProjectId, assertNonEmptyString, assertOptionalString } from './ipc-validator';
import {
  createMission, getMission, listMissions, getMissionTasks,
  runMission, cancelMission, cleanupMission, deleteMission,
  getMissionPatches,
  type MissionType, type MissionConfig,
} from '../engine/mission-runner';

// v5.5: 运行中的 Mission AbortController 注册表
const runningMissions = new Map<string, AbortController>();
const log = createLogger('ipc:missions');

export function setupMissionHandlers() {
  // 创建并启动 mission
  ipcMain.handle('mission:create', async (_event, projectId: string, type: MissionType, config?: MissionConfig) => {
    assertProjectId('mission:create', projectId);
    try {
      const id = createMission(projectId, type, config);
      const win = BrowserWindow.getAllWindows()[0] ?? null;

      // v5.5: 创建 AbortController 用于取消
      const abortCtrl = new AbortController();
      runningMissions.set(id, abortCtrl);

      // 异步执行（不阻塞 IPC）
      runMission(id, win, abortCtrl.signal).catch(err => {
        if (err.message !== 'Cancelled') {
          log.error(`Mission ${id} error`, err);
        }
      }).finally(() => {
        runningMissions.delete(id);
      });

      return { success: true, missionId: id };
    } catch (err: unknown) {
      return { success: false, error: toErrorMessage(err) };
    }
  });

  // 获取单个 mission
  ipcMain.handle('mission:get', (_event, missionId: string) => {
    return getMission(missionId) || null;
  });

  // 列出项目的所有 missions
  ipcMain.handle('mission:list', (_event, projectId: string) => {
    return listMissions(projectId);
  });

  // 获取 mission 的任务列表
  ipcMain.handle('mission:get-tasks', (_event, missionId: string) => {
    return getMissionTasks(missionId);
  });

  // 取消 mission — v5.5: 同时 abort 运行中的 LLM 调用
  ipcMain.handle('mission:cancel', (_event, missionId: string) => {
    const ctrl = runningMissions.get(missionId);
    if (ctrl) {
      ctrl.abort();
      runningMissions.delete(missionId);
    }
    cancelMission(missionId);
    return { success: true };
  });

  // 清理 mission 中间数据
  ipcMain.handle('mission:cleanup', (_event, missionId: string) => {
    cleanupMission(missionId);
    return { success: true };
  });

  // 删除 mission
  ipcMain.handle('mission:delete', (_event, missionId: string) => {
    deleteMission(missionId);
    return { success: true };
  });

  // v6.0: 获取 mission 的修复建议 patches
  ipcMain.handle('mission:get-patches', (_event, missionId: string) => {
    return getMissionPatches(missionId);
  });
}
