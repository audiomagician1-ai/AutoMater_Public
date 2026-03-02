/**
 * Electron mock for vitest — 仅提供引擎测试所需的最小桩
 */
export const app = {
  getPath: (_name: string) => '/tmp/automater-test',
  getName: () => 'AutoMater Test',
  getVersion: () => '0.0.0-test',
};

export const ipcMain = {
  handle: (_channel: string, _handler: (...args: unknown[]) => unknown) => {},
  on: (_channel: string, _handler: (...args: unknown[]) => unknown) => {},
};

export const BrowserWindow = {
  getAllWindows: () => [],
  getFocusedWindow: () => null,
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
};

export default { app, ipcMain, BrowserWindow, dialog };
