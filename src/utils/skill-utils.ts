import type { Skill } from '../types/skill.types';

export interface SkillCommandResult {
  /** The skill's resolved prompt body (to be injected as system message) */
  skillPrompt: string;
  /** The user-visible content to store in chat history */
  userContent: string;
}

/**
 * Parse and resolve a skill invocation from message content.
 *
 * If the content matches `/skill-id [args]` and a matching skill exists,
 * returns the resolved skill prompt and the user-visible content.
 * Returns null if no skill matches (message should be sent normally).
 */
export function resolveSkillCommand(
  content: string,
  skills: Skill[]
): SkillCommandResult | null {
  // Match /command-name optionally followed by args
  const match = content.match(/^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;

  const skillId = match[1];
  const args = (match[2] ?? '').trim();

  const skill = skills.find((s) => s.id === skillId);
  if (!skill) return null;

  // Resolve the skill body with args substitution
  let skillPrompt: string;
  if (skill.body.includes('{{args}}')) {
    skillPrompt = skill.body.replace('{{args}}', args).trim();
  } else if (args) {
    skillPrompt = `${skill.body.trim()}\n\n${args}`;
  } else {
    skillPrompt = skill.body.trim();
  }

  // User-visible content: show the args if provided, otherwise show the invocation
  const userContent = args || `Invoked /${skill.id}`;

  return { skillPrompt, userContent };
}
