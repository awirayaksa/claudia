import { ipcMain } from 'electron';
import { getConfig, setConfig } from '../services/store.service';

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
}
