/**
 * Prompt templates: `{{name}}` and `{{name:default}}` are asked for in a form
 * before the text goes into the message box; a few upper-case names are
 * filled in automatically (also in system prompts of custom models).
 */

export const SYSTEM_VARIABLES = [
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_DATETIME',
  'CURRENT_WEEKDAY',
  'USER_NAME',
  'USER_LANGUAGE',
] as const;
export type SystemVariable = (typeof SYSTEM_VARIABLES)[number];

const SYSTEM = new Set<string>(SYSTEM_VARIABLES);

/** {{ name }} or {{ name : default }}; names are letters, digits, _, - and spaces. */
const PLACEHOLDER = /\{\{\s*([\p{L}\p{N}_][\p{L}\p{N}_ -]{0,63}?)\s*(?::([^}]*))?\}\}/gu;

export interface TemplateVariable {
  name: string;
  default: string;
}

/** The variables a user fills in, in order of first use (system ones excluded). */
export function templateVariables(body: string): TemplateVariable[] {
  const out = new Map<string, TemplateVariable>();
  for (const m of body.matchAll(PLACEHOLDER)) {
    const name = m[1].trim();
    if (SYSTEM.has(name)) continue;
    const existing = out.get(name);
    if (!existing) out.set(name, { name, default: m[2]?.trim() ?? '' });
    else if (!existing.default && m[2]) existing.default = m[2].trim();
  }
  return [...out.values()];
}

export interface SystemValues {
  userName?: string;
  /** BCP 47, e.g. "en-US". */
  language?: string;
  now?: Date;
  timeZone?: string;
}

export function systemValue(name: SystemVariable, v: SystemValues): string {
  const now = v.now ?? new Date();
  const locale = v.language || 'en-US';
  const tz = v.timeZone ? { timeZone: v.timeZone } : {};
  switch (name) {
    case 'CURRENT_DATE':
      return now.toLocaleDateString('en-CA', tz); // YYYY-MM-DD
    case 'CURRENT_TIME':
      return now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', ...tz });
    case 'CURRENT_DATETIME':
      return `${now.toLocaleDateString('en-CA', tz)} ${now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', ...tz })}`;
    case 'CURRENT_WEEKDAY':
      return now.toLocaleDateString(locale, { weekday: 'long', ...tz });
    case 'USER_NAME':
      return v.userName ?? '';
    case 'USER_LANGUAGE':
      return v.language ?? '';
  }
}

/**
 * Replace placeholders: system names from `system`, others from `values`
 * (falling back to their default). Unknown upper-case-looking names that
 * aren't system ones are user variables like any other.
 */
export function fillTemplate(body: string, values: Record<string, string>, system: SystemValues = {}): string {
  return body.replace(PLACEHOLDER, (_match, rawName: string, def?: string) => {
    const name = rawName.trim();
    if (SYSTEM.has(name)) return systemValue(name as SystemVariable, system);
    return values[name] ?? def?.trim() ?? '';
  });
}

/** Only the system placeholders (system prompts: other {{…}} text stays as written). */
export function fillSystemVariables(text: string, system: SystemValues): string {
  return text.replace(PLACEHOLDER, (match, rawName: string) => {
    const name = rawName.trim();
    return SYSTEM.has(name) ? systemValue(name as SystemVariable, system) : match;
  });
}
