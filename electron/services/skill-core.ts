/**
 * Skills without Electron: built-ins, the `.md` frontmatter format and
 * invocation. Shared by the desktop main process, the desktop renderer and
 * the web server (which stores skills in the database).
 */
import type { Skill, SkillWritePayload } from '../../src/types/skill.types';

// ─── Built-in skill definitions ────────────────────────────────────────────────

export const BUILTIN_SKILLS: ReadonlyArray<Omit<Skill, 'filePath'>> = [
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

export function builtinSkills(): Skill[] {
  return BUILTIN_SKILLS.map((s) => ({ ...s, filePath: null }));
}

export function isBuiltinSkillId(id: string): boolean {
  return BUILTIN_SKILLS.some((s) => s.id === id);
}

// ─── Ids ───────────────────────────────────────────────────────────────────────

export const SKILL_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export function validateSkillId(id: string): void {
  if (!SKILL_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid skill id "${id}". Must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.`
    );
  }
}

// ─── Frontmatter ───────────────────────────────────────────────────────────────

export interface SkillFrontmatter {
  name?: string;
  description?: string;
}

/** Parse a `---` frontmatter block of simple `key: value` pairs (no nested YAML). */
export function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const frontmatter: SkillFrontmatter = {};
  let body = content;

  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3);
    if (endIdx !== -1) {
      const fmBlock = content.slice(3, endIdx).trim();
      body = content.slice(endIdx + 3).trim();

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

/** A skill from the contents of its `.md` file. */
export function parseSkillMarkdown(content: string, id: string, filePath: string | null = null): Skill {
  const { frontmatter, body } = parseFrontmatter(content);
  return {
    id,
    name: frontmatter.name || id,
    description: frontmatter.description || '',
    body: body.trim(),
    builtin: false,
    filePath,
  };
}

/** Frontmatter values are single-line. */
function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ').trim();
}

/** The `.md` file contents for a skill. */
export function serializeSkill(payload: Pick<SkillWritePayload, 'name' | 'description' | 'body'>): string {
  return `---\nname: ${oneLine(payload.name)}\ndescription: ${oneLine(payload.description)}\n---\n\n${payload.body}\n`;
}

// ─── Invocation ────────────────────────────────────────────────────────────────

/**
 * Resolve a skill body with user-provided arguments. `{{args}}` is replaced
 * (with nothing when there are no args); without the placeholder, args are
 * appended after a blank line.
 */
export function resolveSkillInvocation(body: string, args: string): string {
  if (body.includes('{{args}}')) {
    return body.replace('{{args}}', args).trim();
  }
  return args ? `${body.trim()}\n\n${args}` : body.trim();
}

export interface SkillCommandResult {
  /** The skill's resolved prompt body (injected as a system message) */
  skillPrompt: string;
  /** The user-visible content to store in chat history */
  userContent: string;
  skillId: string;
}

/**
 * Parse `/skill-id [args]`. Returns null when the message isn't a skill
 * command or no such skill exists (send the message normally).
 */
export function resolveSkillCommand(content: string, skills: Skill[]): SkillCommandResult | null {
  const match = content.match(/^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;

  const skillId = match[1];
  const args = (match[2] ?? '').trim();

  const skill = skills.find((s) => s.id === skillId);
  if (!skill) return null;

  return {
    skillPrompt: resolveSkillInvocation(skill.body, args),
    // Show the args if provided, otherwise the invocation itself
    userContent: args || `Invoked /${skill.id}`,
    skillId: skill.id,
  };
}
