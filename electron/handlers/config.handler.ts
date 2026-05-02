import { ipcMain } from 'electron';
import { getConfig, setConfig } from '../services/store.service';
import {
  listProfiles,
  getActiveProfileId,
  switchProfile,
  createProfile,
  renameProfile,
  duplicateProfile,
  deleteProfile,
} from '../services/profile.service';

export function registerConfigHandlers() {
  // Get configuration
  ipcMain.handle('config:get', async () => {
    return getConfig();
  });

  // Set configuration
  ipcMain.handle('config:set', async (_, config) => {
    setConfig(config);
  });

  // Get specific config value
  ipcMain.handle('config:getValue', async (_, key: string) => {
    const config = getConfig();
    const keys = key.split('.');
    let value: any = config;

    for (const k of keys) {
      value = value?.[k];
    }

    return value;
  });

  // Set specific config value
  ipcMain.handle('config:setValue', async (_, key: string, value: any) => {
    // Reject writes to apiKey paths to prevent accidental re-encryption under wrong profile
    if (/^api\..*\.apiKey$/.test(key)) {
      throw new Error('Direct apiKey writes via setValue are not allowed. Use config:set with the full api object.');
    }
    const config = getConfig();
    const keys = key.split('.');
    const lastKey = keys.pop()!;

    let target: any = config;
    for (const k of keys) {
      if (!target[k]) target[k] = {};
      target = target[k];
    }

    target[lastKey] = value;
    setConfig(config);
  });

  // Profile handlers
  ipcMain.handle('profile:list', async () => {
    return {
      profiles: listProfiles(),
      currentProfileId: getActiveProfileId(),
    };
  });

  ipcMain.handle('profile:switch', async (_, id: string) => {
    switchProfile(id);
    return getConfig();
  });

  ipcMain.handle('profile:create', async (_, payload: { name: string; cloneCurrent: boolean }) => {
    return createProfile(payload);
  });

  ipcMain.handle('profile:rename', async (_, id: string, name: string) => {
    renameProfile(id, name);
  });

  ipcMain.handle('profile:duplicate', async (_, id: string, newName: string) => {
    return duplicateProfile(id, newName);
  });

  ipcMain.handle('profile:delete', async (_, id: string) => {
    deleteProfile(id);
  });
}
