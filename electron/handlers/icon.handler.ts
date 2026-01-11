import { ipcMain, dialog, nativeImage, app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Register IPC handlers for icon customization
 * @param getMainWindow - Function to get the main window instance
 */
export function registerIconHandlers(getMainWindow: () => BrowserWindow | null) {
  // Open file dialog to select icon
  ipcMain.handle('icon:select', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Icons', extensions: ['png', 'ico'] },
      ],
      title: 'Select Application Icon',
    });

    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    const filePath = result.filePaths[0];
    const stats = fs.statSync(filePath);

    // Validate file size (max 1MB)
    if (stats.size > 1024 * 1024) {
      throw new Error('Icon file must be less than 1MB');
    }

    return filePath;
  });

  // Copy icon to AppData and return new path
  ipcMain.handle('icon:upload', async (_, sourcePath: string) => {
    const userDataPath = app.getPath('userData');
    const iconsDir = path.join(userDataPath, 'custom-icons');

    // Create directory if it doesn't exist
    if (!fs.existsSync(iconsDir)) {
      fs.mkdirSync(iconsDir, { recursive: true });
    }

    const ext = path.extname(sourcePath);
    const destPath = path.join(iconsDir, `app-icon${ext}`);

    // Copy file to AppData
    fs.copyFileSync(sourcePath, destPath);

    return destPath;
  });

  // Apply icon to window (may not work on all platforms)
  ipcMain.handle('icon:apply', async (_, iconPath: string) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) {
      return { success: false, requiresRestart: true };
    }

    try {
      if (fs.existsSync(iconPath)) {
        const icon = nativeImage.createFromPath(iconPath);
        mainWindow.setIcon(icon);
        return { success: true, requiresRestart: false };
      }
      return { success: false, requiresRestart: true };
    } catch (error) {
      console.error('Failed to apply icon:', error);
      return { success: false, requiresRestart: true };
    }
  });

  // Reset to default icon
  ipcMain.handle('icon:reset', async () => {
    const mainWindow = getMainWindow();
    const defaultIconPath = path.join(__dirname, '..', 'build', 'icon.ico');

    if (mainWindow && fs.existsSync(defaultIconPath)) {
      try {
        const icon = nativeImage.createFromPath(defaultIconPath);
        mainWindow.setIcon(icon);
      } catch (error) {
        console.error('Failed to reset icon:', error);
      }
    }
  });

  // Get icon as base64 for preview
  ipcMain.handle('icon:getPreview', async (_, iconPath: string) => {
    try {
      if (fs.existsSync(iconPath)) {
        const buffer = fs.readFileSync(iconPath);
        const base64 = buffer.toString('base64');
        const ext = path.extname(iconPath).toLowerCase();
        const mimeType = ext === '.png' ? 'image/png' : 'image/x-icon';
        return `data:${mimeType};base64,${base64}`;
      }
      return null;
    } catch (error) {
      console.error('Failed to get icon preview:', error);
      return null;
    }
  });
}
