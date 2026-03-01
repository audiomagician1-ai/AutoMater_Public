/**
 * Mission IPC handlers — 临时工作流管理接口 (v5.5)
 */

import { ipcMain, BrowserWindow } from 'electron';
import {
  createMission, getMission, listMissions, getMissionTasks,
  runMission, cancelMission, cleanupMission, deleteMission,
  type MissionType, type MissionConfig,
} from '../engine/mission-runner';

export function setupMissionHandlers() {
  // 创建并启动 mission
  ipcMain.handle('mission:create', async (_event, projectId: string, type: MissionType, config?: MissionConfig) => {
    try {
      const id = createMission(projectId, type, config);
      const win = BrowserWindow.getAllWindows()[0] ?? null;
      // 异步执行（不阻塞 IPC）
      runMission(id, win).catch(err => {
        console.error(`[Mission ${id}] Error:`, err);
      });
      return { success: true, missionId: id };
    } catch (err: any) {
      return { success: false, error: err.message };
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

  // 取消 mission
  ipcMain.handle('mission:cancel', (_event, missionId: string) => {
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
}
