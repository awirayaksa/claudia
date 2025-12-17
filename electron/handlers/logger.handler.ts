/**
 * Logger IPC Handlers
 *
 * Handles IPC communication for logging between renderer and main processes.
 */

import { ipcMain, shell } from 'electron';
import * as path from 'path';
import { LoggerService, LogEntry } from '../services/logger.service';

/**
 * Register all logger-related IPC handlers
 */
export function registerLoggerHandlers(): void {
  // Write log entry from renderer
  ipcMain.handle('logger:write', async (_event, entry: LogEntry) => {
    try {
      LoggerService.writeFromRenderer(entry);
    } catch (error) {
      console.error('Failed to write log from renderer:', error);
    }
  });

  // Open logs folder in file explorer
  ipcMain.handle('logger:openLogsFolder', async () => {
    try {
      const logDirectory = LoggerService.getLogDirectory();
      if (logDirectory) {
        await shell.openPath(logDirectory);
      } else {
        throw new Error('Log directory not initialized');
      }
    } catch (error) {
      console.error('Failed to open logs folder:', error);
      throw error;
    }
  });

  // Get log directory path
  ipcMain.handle('logger:getLogDirectory', async () => {
    try {
      return LoggerService.getLogDirectory();
    } catch (error) {
      console.error('Failed to get log directory:', error);
      return null;
    }
  });
}
