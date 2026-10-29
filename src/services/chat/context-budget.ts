/**
 * Fit a request into the model's context window. Pure; shared by desktop and
 * the web server.
 *
 * Priority, highest first:
 *   1. system messages (global prompt, model prompt, skill)
 *   2. the current turn
 *   3. reserved room for the reply
 *   4. memory and documents (trimmed proportionally when short of room)
 *   5. history, newest turn first (oldest turns are dropped first, whole)
 *
 * Token counts are estimates (about 4 characters per token); the margin keeps
 * the estimate on the safe side.
 */
import type { ChatMessage, ContentPart } from '../../types/api.types';
import { getContextWindow } from '../../utils/modelContextLimits';

/** Used when the model's window is unknown. */
export const DEFAULT_CONTEXT_WINDOW = 32_768;
/** Room kept for the reply when the request doesn't set max_tokens. */
export const DEFAULT_OUTPUT_RESERVE = 4_096;
/** Share of the window kept free to absorb estimation error. */
const SAFETY_MARGIN = 0.05;
/** Rough cost of one image input. */
const IMAGE_TOKENS = 1_000;
/** Per-message framing overhead (role, separators). */
const MESSAGE_OVERHEAD = 4;
/** Below this, a trimmed document isn't worth keeping. */
const MIN_DOC_CHARS = 200;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function contentTokens(content: ChatMessage['content']): number {
  if (!content) return 0;
  if (typeof content === 'string') return estimateTextTokens(content);
  return content.reduce(
    (sum: number, part: ContentPart) => sum + (part.type === 'text' ? estimateTextTokens(part.text) : IMAGE_TOKENS),
    0
  );
}

export function estimateMessageTokens(msg: ChatMessage): number {
  let tokens = MESSAGE_OVERHEAD + contentTokens(msg.content);
  if (msg.reasoning_content) tokens += estimateTextTokens(msg.reasoning_content);
  for (const call of msg.tool_calls ?? []) {
    tokens += estimateTextTokens(call.function.name) + estimateTextTokens(call.function.arguments) + MESSAGE_OVERHEAD;
  }
  return tokens;
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/**
 * Split flat history into turns: each group starts at a user message and holds
 * everything up to the next one, so an assistant tool call is never separated
 * from its tool results.
 */
export function groupTurns(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (const msg of messages) {
    if (msg.role === 'user' || groups.length === 0) groups.push([msg]);
    else groups[groups.length - 1].push(msg);
  }
  return groups;
}

export interface ContextDocument {
  /** Shown in the block header, e.g. "[1] report.pdf". */
  title: string;
  text: string;
}

export interface BudgetInput {
  model: string;
  /** Overrides the lookup by model id. */
  contextWindow?: number | null;
  /** Per-model windows reported by the provider (e.g. OpenRouter). */
  modelContextLengths?: Record<string, number>;
  /** Tokens kept free for the reply (default: max_tokens or DEFAULT_OUTPUT_RESERVE). */
  outputReserve?: number;
  /** Always kept, in order. */
  system: ChatMessage[];
  /** Saved memories, sent as one system message. */
  memories?: string[];
  /** Retrieved or attached documents, sent as one system message. */
  documents?: ContextDocument[];
  /** Earlier messages, oldest first. */
  history: ChatMessage[];
  /** The turn being answered (usually the new user message). Always kept. */
  current: ChatMessage[];
}

export interface BudgetResult {
  messages: ChatMessage[];
  window: number;
  estimatedTokens: number;
  /** Whole turns left out of the history (oldest first). */
  droppedTurns: number;
  /** Documents or memories were shortened or left out. */
  trimmedContext: boolean;
  /** Even system + current turn don't fit; the provider will likely refuse. */
  overflow: boolean;
}

function memoryMessage(memories: string[]): ChatMessage | null {
  if (memories.length === 0) return null;
  return {
    role: 'system',
    content: `Things you remember about the user:\n${memories.map((m) => `- ${m}`).join('\n')}`,
  };
}

function documentsMessage(docs: ContextDocument[]): ChatMessage | null {
  if (docs.length === 0) return null;
  const body = docs.map((d) => `<source title="${d.title.replace(/"/g, "'")}">\n${d.text}\n</source>`).join('\n\n');
  return {
    role: 'system',
    content:
      'Use the following sources to answer. Cite them with their number in square brackets, like [1].\n\n' + body,
  };
}

/** Shorten every document by the same share so the set fits `budgetTokens`. */
function trimDocuments(docs: ContextDocument[], budgetTokens: number): { docs: ContextDocument[]; trimmed: boolean } {
  const full = documentsMessage(docs);
  if (!full || estimateMessageTokens(full) <= budgetTokens) return { docs, trimmed: false };

  const totalChars = docs.reduce((s, d) => s + d.text.length, 0);
  const overhead = estimateMessageTokens(documentsMessage(docs.map((d) => ({ ...d, text: '' })))!);
  const availableChars = Math.max(0, (budgetTokens - overhead) * 4);
  const ratio = totalChars > 0 ? Math.min(1, availableChars / totalChars) : 0;

  const out: ContextDocument[] = [];
  for (const d of docs) {
    const keep = Math.floor(d.text.length * ratio);
    if (keep >= d.text.length) out.push(d);
    // A few hundred characters of a document aren't worth sending
    else if (keep >= MIN_DOC_CHARS) out.push({ ...d, text: d.text.slice(0, keep) + '\n[…trimmed to fit the context window]' });
  }
  return { docs: out, trimmed: true };
}

/** The model's window and the tokens a prompt may use in it (after the margin and the reply's room). */
export function promptLimit(input: Pick<BudgetInput, 'model' | 'contextWindow' | 'modelContextLengths' | 'outputReserve'>): {
  window: number;
  limit: number;
} {
  const window =
    input.contextWindow ?? getContextWindow(input.model, input.modelContextLengths) ?? DEFAULT_CONTEXT_WINDOW;
  const reserve = Math.min(input.outputReserve ?? DEFAULT_OUTPUT_RESERVE, Math.floor(window / 2));
  return { window, limit: Math.floor(window * (1 - SAFETY_MARGIN)) - reserve };
}

export function fitToContext(input: BudgetInput): BudgetResult {
  const { window, limit } = promptLimit(input);

  const fixed = estimateMessagesTokens(input.system) + estimateMessagesTokens(input.current);
  let remaining = limit - fixed;
  const overflow = remaining < 0;
  remaining = Math.max(0, remaining);
  let trimmedContext = false;

  // Memory and documents may use at most half of what's left, so recent history survives
  const contextBudget = Math.floor(remaining / 2);
  let mem = memoryMessage(input.memories ?? []);
  if (mem && estimateMessageTokens(mem) > contextBudget) {
    mem = null;
    trimmedContext = true;
  }
  const memTokens = mem ? estimateMessageTokens(mem) : 0;

  const { docs, trimmed } = trimDocuments(input.documents ?? [], contextBudget - memTokens);
  trimmedContext ||= trimmed || docs.length < (input.documents?.length ?? 0);
  const docMsg = documentsMessage(docs);
  remaining -= memTokens + (docMsg ? estimateMessageTokens(docMsg) : 0);

  // History: keep the newest whole turns that fit
  const turns = groupTurns(input.history);
  const kept: ChatMessage[][] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = estimateMessagesTokens(turns[i]);
    if (cost > remaining) break;
    kept.unshift(turns[i]);
    remaining -= cost;
  }

  const messages = [
    ...input.system,
    ...(mem ? [mem] : []),
    ...(docMsg ? [docMsg] : []),
    ...kept.flat(),
    ...input.current,
  ];

  return {
    messages,
    window,
    estimatedTokens: estimateMessagesTokens(messages),
    droppedTurns: turns.length - kept.length,
    trimmedContext,
    overflow,
  };
}

/** Default share of the prompt limit above which earlier turns are summarized. */
export const DEFAULT_COMPACTION_THRESHOLD = 0.8;
/** Default number of most recent turns that are always sent word for word. */
export const DEFAULT_KEEP_RECENT_TURNS = 4;
/** After compacting, the prompt aims at this share of the limit, so the next sends don't compact again at once. */
const COMPACTION_TARGET = 0.5;
/** Room counted for the summary that replaces the folded turns. */
export const SUMMARY_TOKENS = 1_500;

export interface CompactionInput {
  /** The prompt limit, from `promptLimit`. */
  limit: number;
  /** Tokens that are always sent: system messages, an earlier summary, the current turn. */
  fixedTokens: number;
  /** Estimated tokens of each history turn (see `groupTurns`), oldest first. */
  turnTokens: number[];
  /** Share of the limit that starts a compaction (default 0.8). */
  threshold?: number;
  /** Most recent turns never folded into the summary (default 4). */
  keepRecentTurns?: number;
}

/**
 * How many of the oldest history turns to fold into a summary: none while the
 * prompt is under `threshold` of the limit; else enough for the rest to come
 * down to about half the limit, never touching the last `keepRecentTurns`.
 * Turns are whole, so a tool call always stays with its results.
 */
export function planCompaction(input: CompactionInput): number {
  const threshold = input.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
  const keep = Math.max(0, input.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS);
  const foldable = Math.max(0, input.turnTokens.length - keep);
  if (foldable === 0 || input.limit <= 0) return 0;

  let total = input.fixedTokens + input.turnTokens.reduce((s, t) => s + t, 0);
  if (total <= input.limit * threshold) return 0;

  const target = input.limit * COMPACTION_TARGET;
  total += SUMMARY_TOKENS;
  let fold = 0;
  while (fold < foldable && total > target) {
    total -= input.turnTokens[fold];
    fold++;
  }
  return fold;
}

/** The system message that stands in for the summarized turns. */
export function compactionMessage(summary: string): ChatMessage {
  return {
    role: 'system',
    content:
      'The earlier part of this conversation was summarized to fit the context window. ' +
      'The original messages are not shown; this is the summary:\n\n' +
      summary,
  };
}
