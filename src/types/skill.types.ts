/** Runtime representation of a skill loaded from disk or built-in */
export interface Skill {
  /** Unique identifier derived from the filename (e.g., "summarize" from "summarize.md") */
  id: string;
  /** Display name from frontmatter `name:` field, falls back to id */
  name: string;
  /** Short description from frontmatter `description:` field */
  description: string;
  /** The raw markdown body (everything after the frontmatter block) */
  body: string;
  /** Whether this is a built-in skill (non-deletable) */
  builtin: boolean;
  /** Absolute path to the .md file on disk (null for built-ins stored in memory) */
  filePath: string | null;
}

/** Argument passed to create/update skill */
export interface SkillWritePayload {
  /** Command id — lowercase alphanumeric + hyphens (e.g. "code-review") */
  id: string;
  name: string;
  description: string;
  body: string;
}

/** Result returned from IPC skill operations */
export interface SkillOperationResult {
  success: boolean;
  error?: string;
  skill?: Skill;
  skills?: Skill[];
  dir?: string;
}
