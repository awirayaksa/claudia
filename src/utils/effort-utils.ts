/**
 * Reasoning effort selection.
 *
 * Users pick how hard the model should think directly from the chat input, e.g.
 *   "--effort high  refactor this module"
 *   "/effort low"            (on its own: sets the effort for the whole session)
 *   "/effort default"        (on its own: clears the session override)
 *
 * Precedence when a message is sent:
 *   one-shot directive  >  session override  >  Preferences default  >  provider default
 */

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** Every tier, ordered from cheapest to most thorough. */
export const EFFORT_LEVELS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];

/** Tiers offered by models with no entry in MODEL_EFFORT_LEVELS (the OpenAI set). */
const DEFAULT_EFFORT_LEVELS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

interface ModelEffortEntry {
  pattern: RegExp;
  levels: ReasoningEffort[];
}

/**
 * Models whose reasoning tiers differ from the OpenAI set.
 * Ordered most-specific-first; matched against the lowercased model id with any
 * provider prefix removed (e.g. "qwen/Qwen3.8-27B:free" → "qwen3.8-27b:free").
 */
const MODEL_EFFORT_LEVELS: ModelEffortEntry[] = [
  // Qwen3.8 family (e.g. Qwen3.8-27B): low | medium | xhigh — no minimal, no high
  { pattern: /qwen3\.8/, levels: ['low', 'medium', 'xhigh'] },
];

const EFFORT_ALIASES: Record<string, ReasoningEffort | 'clear'> = {
  minimal: 'minimal',
  min: 'minimal',
  none: 'minimal',
  low: 'low',
  lo: 'low',
  medium: 'medium',
  med: 'medium',
  mid: 'medium',
  normal: 'medium',
  high: 'high',
  hi: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
  ultra: 'xhigh',
  // Aliases that remove an active override
  off: 'clear',
  default: 'clear',
  auto: 'clear',
  reset: 'clear',
};

/**
 * Matches a standalone effort directive anywhere in the message:
 * `/effort high`, `--effort=high`, `--effort: max`, ...
 */
const EFFORT_DIRECTIVE_REGEX = /(^|\s)(?:\/effort|--effort)(?:\s*[=:]\s*|\s+)([a-z]+)\b[ \t]*/gi;

export interface ParsedEffortPrompt {
  /** The message with the effort directive removed. */
  content: string;
  /**
   * `undefined` — no directive was present.
   * `null`      — the directive asked to clear the override (`/effort default`).
   * otherwise   — the requested level.
   */
  effort: ReasoningEffort | null | undefined;
  /** True when the message contained nothing but the directive. */
  directiveOnly: boolean;
}

/**
 * Extract an effort directive from a typed message and strip it from the text.
 * Unknown values (e.g. "--effort tomorrow") are left untouched so ordinary prose
 * is never mangled.
 */
export function parseEffortDirective(raw: string): ParsedEffortPrompt {
  let effort: ReasoningEffort | null | undefined;

  const content = raw
    .replace(EFFORT_DIRECTIVE_REGEX, (match, lead: string, value: string) => {
      const resolved = EFFORT_ALIASES[value.toLowerCase()];
      if (!resolved) return match; // not an effort level — leave the text as typed
      effort = resolved === 'clear' ? null : resolved;
      // Keep the leading separator so the surrounding words stay apart
      return lead;
    })
    .trim();

  return {
    content,
    effort,
    directiveOnly: effort !== undefined && content.length === 0,
  };
}

/**
 * Pick the effort that applies to a request, honouring the precedence order.
 * A `null` one-shot value means the message explicitly opted out (`--effort default`),
 * so it wins over the session and preference values. Returns undefined when nothing
 * applies and the provider default should be used.
 */
export function resolveEffort(
  oneShot?: ReasoningEffort | null,
  session?: ReasoningEffort | null,
  preference?: ReasoningEffort | null
): ReasoningEffort | undefined {
  if (oneShot !== undefined) return oneShot ?? undefined;
  return session ?? preference ?? undefined;
}

/** Human-readable label, e.g. "High", "X-High". */
export function formatEffort(effort: ReasoningEffort): string {
  if (effort === 'xhigh') return 'X-High';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/**
 * Anthropic's `output_config.effort` tops out at "high" and has no "minimal" tier.
 */
export function toAnthropicEffort(effort: ReasoningEffort): 'low' | 'medium' | 'high' {
  if (effort === 'minimal') return 'low';
  if (effort === 'xhigh') return 'high';
  return effort;
}

/** Strip a provider prefix so "qwen/Qwen3.8-27B" and "Qwen3.8-27B" match alike. */
function normalizeModelId(modelId: string): string {
  const lower = modelId.toLowerCase();
  const lastSlash = lower.lastIndexOf('/');
  return lastSlash === -1 ? lower : lower.slice(lastSlash + 1);
}

/**
 * The reasoning tiers a model actually accepts. Without a model id this returns
 * every tier, which is what the global Preferences default needs.
 */
export function getEffortLevels(modelId?: string | null): ReasoningEffort[] {
  if (!modelId) return EFFORT_LEVELS;

  const normalized = normalizeModelId(modelId);
  for (const entry of MODEL_EFFORT_LEVELS) {
    if (entry.pattern.test(normalized)) return entry.levels;
  }
  return DEFAULT_EFFORT_LEVELS;
}

/**
 * Map an effort onto the closest tier the model supports, so a session or
 * Preferences value stays usable after switching models. Ties round up — asking
 * for more thinking should never quietly get you less.
 */
export function coerceEffort(
  effort: ReasoningEffort | undefined,
  modelId?: string | null
): ReasoningEffort | undefined {
  if (!effort) return undefined;

  const supported = getEffortLevels(modelId);
  if (supported.includes(effort)) return effort;

  const target = EFFORT_LEVELS.indexOf(effort);
  let closest = supported[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const level of supported) {
    const distance = Math.abs(EFFORT_LEVELS.indexOf(level) - target);
    // `<=` walks upward on a tie, since `supported` is ordered cheapest-first
    if (distance <= bestDistance) {
      bestDistance = distance;
      closest = level;
    }
  }

  return closest;
}
