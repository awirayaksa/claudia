import { ipcMain, BrowserWindow, shell } from 'electron';
import {
  loadAllSkills,
  loadBuiltinSkills,
  writeSkill,
  deleteSkill,
  getSkillsDir,
  watchSkillsDir,
  stopSkillsWatcher,
} from '../services/skill.service';
import type { SkillWritePayload } from '../../src/types/skill.types';

let mainWindow: BrowserWindow | null = null;

export function setSkillMainWindow(window: BrowserWindow): void {
  mainWindow = window;
}

async function pushSkillsChanged(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const skills = await loadAllSkills();
    mainWindow.webContents.send('skill:changed', skills);
  } catch {
    // ignore
  }
}

export function initSkillWatcher(): void {
  watchSkillsDir(() => {
    pushSkillsChanged();
  });
}

export function registerSkillHandlers(): void {
  // ── List all skills (built-in + user) ─────────────────────────────────────
  ipcMain.handle('skill:list', async () => {
    try {
      const skills = await loadAllSkills();
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: String(error), skills: [] };
    }
  });

  // ── Get a single skill by id ───────────────────────────────────────────────
  ipcMain.handle('skill:get', async (_event, id: string) => {
    try {
      const skills = await loadAllSkills();
      const skill = skills.find((s) => s.id === id);
      if (!skill) return { success: false, error: `Skill "${id}" not found.` };
      return { success: true, skill };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // ── Create a user skill ────────────────────────────────────────────────────
  ipcMain.handle('skill:create', async (_event, payload: SkillWritePayload) => {
    try {
      const skill = await writeSkill(payload);
      return { success: true, skill };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // ── Update (overwrite) a user skill ───────────────────────────────────────
  ipcMain.handle('skill:update', async (_event, payload: SkillWritePayload) => {
    try {
      // Reject updating built-ins
      const builtins = loadBuiltinSkills();
      if (builtins.some((s) => s.id === payload.id)) {
        return { success: false, error: `Cannot update built-in skill "${payload.id}".` };
      }
      const skill = await writeSkill(payload);
      return { success: true, skill };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // ── Delete a user skill ────────────────────────────────────────────────────
  ipcMain.handle('skill:delete', async (_event, id: string) => {
    try {
      await deleteSkill(id);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // ── Get skills directory path ──────────────────────────────────────────────
  ipcMain.handle('skill:getDir', async () => {
    try {
      const dir = getSkillsDir();
      return { success: true, dir };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // ── Open skills directory in file explorer ─────────────────────────────────
  ipcMain.handle('skill:openDir', async () => {
    try {
      const dir = getSkillsDir();
      await shell.openPath(dir);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}

export function cleanupSkillWatcher(): void {
  stopSkillsWatcher();
}
