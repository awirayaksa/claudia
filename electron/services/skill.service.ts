import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { Skill, SkillWritePayload } from '../../src/types/skill.types';

// ─── Built-in skill definitions ────────────────────────────────────────────────

const BUILTIN_SKILLS: Array<Omit<Skill, 'filePath'>> = [
  {
    id: 'summarize',
    name: 'Summarize',
    description: 'Summarize the conversation or provided text concisely',
    body: `Please provide a concise summary of the following, highlighting the key points, decisions, and action items:

{{args}}`,
    builtin: true,
  },
  {
    id: 'translate',
    name: 'Translate',
    description: 'Translate text to another language',
    body: `Please translate the following text. If a target language is specified, translate to that language; otherwise translate to English:

{{args}}`,
    builtin: true,
  },
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'Review code for quality, bugs, and improvements',
    body: `Please perform a thorough code review of the following code. Focus on:
- Correctness and potential bugs
- Performance concerns
- Security issues
- Code clarity and maintainability
- Adherence to best practices

{{args}}`,
    builtin: true,
  },
  {
    id: 'simplify',
    name: 'Simplify',
    description: 'Simplify and clean up code or text for clarity',
    body: `Please simplify the following, removing unnecessary complexity while preserving all important meaning and functionality:

{{args}}`,
    builtin: true,
  },
  {
    id: 'explain',
    name: 'Explain',
    description: 'Explain a concept, code, or error in plain language',
    body: `Please explain the following clearly and concisely, as if explaining to someone unfamiliar with the topic. Include examples where helpful:

{{args}}`,
    builtin: true,
  },
];

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

// ─── Frontmatter parser ────────────────────────────────────────────────────────

interface Frontmatter {
  name?: string;
  description?: string;
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const frontmatter: Frontmatter = {};
  let body = content;

  // Detect frontmatter block delimited by ---
  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3);
    if (endIdx !== -1) {
      const fmBlock = content.slice(3, endIdx).trim();
      body = content.slice(endIdx + 3).trim();

      // Parse simple key: value pairs (no nested YAML)
      for (const line of fmBlock.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (key === 'name') frontmatter.name = value;
        else if (key === 'description') frontmatter.description = value;
      }
    }
  }

  return { frontmatter, body };
}

// ─── Skill file → Skill record ─────────────────────────────────────────────────

function parseSkillFile(content: string, filePath: string): Skill {
  const { frontmatter, body } = parseFrontmatter(content);
  const id = path.basename(filePath, '.md');

  return {
    id,
    name: frontmatter.name || id,
    description: frontmatter.description || '',
    body: body.trim(),
    builtin: false,
    filePath,
  };
}

// ─── Skill record → file content ──────────────────────────────────────────────

function serializeSkill(payload: SkillWritePayload): string {
  return `---\nname: ${payload.name}\ndescription: ${payload.description}\n---\n\n${payload.body}\n`;
}

// ─── Load skills ───────────────────────────────────────────────────────────────

export function loadBuiltinSkills(): Skill[] {
  return BUILTIN_SKILLS.map((s) => ({ ...s, filePath: null }));
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

const VALID_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function validateSkillId(id: string): void {
  if (!VALID_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid skill id "${id}". Must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.`
    );
  }
}

export async function writeSkill(payload: SkillWritePayload): Promise<Skill> {
  validateSkillId(payload.id);

  // Reject IDs that conflict with built-ins
  const builtinIds = BUILTIN_SKILLS.map((s) => s.id);
  if (builtinIds.includes(payload.id)) {
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
  const builtinIds = BUILTIN_SKILLS.map((s) => s.id);
  if (builtinIds.includes(id)) {
    throw new Error(`Cannot delete built-in skill "${id}".`);
  }

  const filePath = path.join(getSkillsDir(), `${id}.md`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Skill "${id}" not found.`);
  }

  fs.unlinkSync(filePath);
}

// ─── Skill invocation helpers ──────────────────────────────────────────────────

/**
 * Resolve a skill body with user-provided arguments.
 * Replaces {{args}} placeholder if present, otherwise appends args after a blank line.
 */
export function resolveSkillInvocation(body: string, args: string): string {
  if (!args) return body.trim();
  if (body.includes('{{args}}')) {
    return body.replace('{{args}}', args).trim();
  }
  return `${body.trim()}\n\n${args}`;
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
