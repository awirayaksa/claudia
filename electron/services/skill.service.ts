import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { Skill, SkillWritePayload } from '../../src/types/skill.types';
import {
  builtinSkills,
  isBuiltinSkillId,
  parseSkillMarkdown,
  serializeSkill,
  validateSkillId,
} from './skill-core';

export { resolveSkillInvocation } from './skill-core';

// ─── Skill directory helpers ───────────────────────────────────────────────────

export function getSkillsDir(): string {
  return path.join(app.getPath('home'), '.claudia', 'skills');
}

export function ensureSkillsDir(): void {
  const dir = getSkillsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── Skill file → Skill record ─────────────────────────────────────────────────

function parseSkillFile(content: string, filePath: string): Skill {
  return parseSkillMarkdown(content, path.basename(filePath, '.md'), filePath);
}

// ─── Load skills ───────────────────────────────────────────────────────────────

export function loadBuiltinSkills(): Skill[] {
  return builtinSkills();
}

export async function loadUserSkills(): Promise<Skill[]> {
  ensureSkillsDir();
  const dir = getSkillsDir();

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const skills: Skill[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const filePath = path.join(dir, entry.name);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        skills.push(parseSkillFile(content, filePath));
      } catch {
        // Skip unreadable files
      }
    }

    return skills;
  } catch {
    return [];
  }
}

export async function loadAllSkills(): Promise<Skill[]> {
  const builtins = loadBuiltinSkills();
  const userSkills = await loadUserSkills();
  return [...builtins, ...userSkills];
}

// ─── Write / delete skills ─────────────────────────────────────────────────────

export async function writeSkill(payload: SkillWritePayload): Promise<Skill> {
  validateSkillId(payload.id);

  // Reject IDs that conflict with built-ins
  if (isBuiltinSkillId(payload.id)) {
    throw new Error(`Cannot create user skill with id "${payload.id}": conflicts with a built-in skill.`);
  }

  ensureSkillsDir();
  const filePath = path.join(getSkillsDir(), `${payload.id}.md`);
  fs.writeFileSync(filePath, serializeSkill(payload), 'utf-8');

  return {
    id: payload.id,
    name: payload.name,
    description: payload.description,
    body: payload.body,
    builtin: false,
    filePath,
  };
}

export async function deleteSkill(id: string): Promise<void> {
  if (isBuiltinSkillId(id)) {
    throw new Error(`Cannot delete built-in skill "${id}".`);
  }

  const filePath = path.join(getSkillsDir(), `${id}.md`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Skill "${id}" not found.`);
  }

  fs.unlinkSync(filePath);
}

// ─── File watcher ──────────────────────────────────────────────────────────────

let watcherTimer: ReturnType<typeof setTimeout> | null = null;
let fsWatcher: ReturnType<typeof fs.watch> | null = null;

export function watchSkillsDir(onChange: () => void): void {
  ensureSkillsDir();
  const dir = getSkillsDir();

  if (fsWatcher) {
    try { fsWatcher.close(); } catch { /* ignore */ }
  }

  try {
    fsWatcher = fs.watch(dir, () => {
      // Debounce — wait 300 ms after last change
      if (watcherTimer) clearTimeout(watcherTimer);
      watcherTimer = setTimeout(onChange, 300);
    });
  } catch {
    // Watching not available on all platforms — gracefully degrade
  }
}

export function stopSkillsWatcher(): void {
  if (watcherTimer) { clearTimeout(watcherTimer); watcherTimer = null; }
  if (fsWatcher) {
    try { fsWatcher.close(); } catch { /* ignore */ }
    fsWatcher = null;
  }
}
