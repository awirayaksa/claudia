import { ipcMain, BrowserWindow } from 'electron';
import { AutoUpdaterService, UpdateStatus } from '../services/auto-updater.service.js';
import { getConfig } from '../services/store.service.js';

export function registerUpdaterHandlers(
  getWindow: () => BrowserWindow | null,
  service: AutoUpdaterService
) {
  // Forward service events to renderer
  service.on('status-changed', (status: UpdateStatus) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('updater:status-changed', status);
    }
  });

  service.on('download-progress', (percent: number) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('updater:download-progress', percent);
    }
  });

  // Manual check trigger
  ipcMain.handle('updater:check', async () => {
    const config = getConfig();
    const url = config.preferences.updateCheckUrl;
    if (!url) return { error: 'No update check URL configured' };
    return service.checkForUpdate(url);
  });

  // Get current update status
  ipcMain.handle('updater:getStatus', () => {
    return service.getStatus();
  });

  // Apply downloaded update (replace + relaunch)
  ipcMain.handle('updater:relaunch', () => {
    service.applyUpdate();
  });

  // Restart periodic check when URL changes
  ipcMain.handle('updater:restartCheck', () => {
    const config = getConfig();
    const url = config.preferences.updateCheckUrl;
    if (url) {
      service.startPeriodicCheck(url, 30 * 60 * 1000);
    } else {
      service.stopPeriodicCheck();
    }
  });
}
