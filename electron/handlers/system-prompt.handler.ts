import { ipcMain, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export function registerSystemPromptHandlers(): void {
  ipcMain.handle('systemPrompt:selectFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Text Files', extensions: ['txt', 'md'] }],
      title: 'Select System Prompt File',
    });

    if (result.canceled || !result.filePaths[0]) return null;

    const filePath = result.filePaths[0];
    const stats = fs.statSync(filePath);

    if (stats.size > 1024 * 1024) {
      throw new Error('File must be less than 1MB');
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    return { content, fileName: path.basename(filePath) };
  });
}
