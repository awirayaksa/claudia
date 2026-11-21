/**
 * The history the desktop sends with a message, fitted to the model's
 * context window.
 *
 * Near the limit, the oldest exchanges are summarized (with the chat's model)
 * and the summary goes in their place. It is stored on the last message it
 * covers, so later sends reuse it; a newer summary folds the older one in.
 * The most recent exchanges stay word for word, and exchanges are whole, so a
 * tool call always stays with its results. If summarizing fails, or there is
 * still too much, the oldest exchanges are left out (`fitToContext`).
 *
 * Nothing is changed for a model whose context window is unknown.
 */
import type { ChatMessage } from '../../types/api.types';
import type { Message, ToolResult } from '../../types/message.types';
import type { IAPIProvider } from '../api/provider.interface';
import { getContextWindow } from '../../utils/modelContextLimits';
import { buildAPIMessage } from './message-builder';
import {
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_KEEP_RECENT_TURNS,
  compactionMessage,
  estimateMessagesTokens,
  fitToContext,
  planCompaction,
  promptLimit,
} from './context-budget';
import { TRANSCRIPT_TOOL_CHARS, clip, summarizeTranscript } from './compaction';

/** Split messages into exchanges: each starts at a user message and holds the replies and tool rounds after it. */
export function messageTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = [];
  for (const msg of messages) {
    if (msg.role === 'user' || turns.length === 0) turns.push([msg]);
    else turns[turns.length - 1].push(msg);
  }
  return turns;
}

/** The latest summary in a chat, how many exchanges it covers, and the messages after it. */
export function latestMessageCompaction(messages: Message[]): { summary: string | null; turns: number; rest: Message[] } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].compaction;
    if (c?.summary) return { summary: c.summary, turns: c.turns, rest: messages.slice(i + 1) };
  }
  return { summary: null, turns: 0, rest: messages };
}

function toolResultText(result: ToolResult): string {
  return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
}

/** A plain-text transcript for the summarizer (reasoning left out, tool rounds shortened). */
export function messagesTranscript(messages: Message[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const pieces: string[] = [];
    if (msg.role === 'tool') {
      // A tool result is stored both as this message and on the assistant's call; one is enough
      const text = msg.content || (msg.toolResults?.[0] ? toolResultText(msg.toolResults[0]) : '');
      const isError = msg.toolResults?.[0]?.isError;
      if (text.trim()) lines.push(`Assistant: [${isError ? 'tool error' : 'tool result'}: ${clip(text.trim(), TRANSCRIPT_TOOL_CHARS)}]`);
      continue;
    }
    if (msg.content.trim()) pieces.push(msg.content.trim());
    for (const a of msg.attachments ?? []) pieces.push(`[attached file: ${a.name}]`);
    for (const call of msg.toolCalls ?? []) pieces.push(`[called ${call.function.name}(${clip(call.function.arguments, TRANSCRIPT_TOOL_CHARS)})]`);
    if (pieces.length === 0) continue;
    const who = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System';
    lines.push(`${who}: ${pieces.join('\n')}`);
  }
  return lines.join('\n\n');
}

export interface CompactionSettings {
  enabled: boolean;
  /** Share of the prompt limit that starts a summary (default 0.8). */
  threshold?: number;
  /** Most recent exchanges never summarized (default 4). */
  keepRecentTurns?: number;
}

export interface PrepareHistoryInput {
  /** The chat so far, oldest first (without the message being sent). */
  history: Message[];
  /** System prompts, in order. */
  system: ChatMessage[];
  /** The message being sent. */
  current: ChatMessage[];
  model: string;
  modelContextLengths?: Record<string, number>;
  compaction: CompactionSettings;
  provider: IAPIProvider;
  signal?: AbortSignal;
  sessionId?: string;
  /** Called just before earlier messages are summarized (it takes a model call). */
  onSummarizing?: () => void;
}

export interface PreparedHistory {
  /** System prompts, the summary (if any), the history that fits, and the current message. */
  messages: ChatMessage[];
  /** A new summary to store on the message `messageId`. */
  compaction?: { messageId: string; summary: string; turns: number };
  /** Exchanges left out because they still didn't fit. */
  droppedTurns: number;
}

export async function prepareHistory(input: PrepareHistoryInput): Promise<PreparedHistory> {
  const window = getContextWindow(input.model, input.modelContextLengths);
  if (window == null) {
    // Unknown window: send everything, as before
    return { messages: [...input.system, ...input.history.map(buildAPIMessage), ...input.current], droppedTurns: 0 };
  }

  let summary: string | null = null;
  let rest = input.history;
  let compaction: PreparedHistory['compaction'];

  if (input.compaction.enabled) {
    const latest = latestMessageCompaction(input.history);
    summary = latest.summary;
    rest = latest.rest;

    const turns = messageTurns(rest);
    const { limit } = promptLimit({ model: input.model, contextWindow: window });
    const fold = planCompaction({
      limit,
      fixedTokens:
        estimateMessagesTokens(input.system) +
        estimateMessagesTokens(input.current) +
        (summary ? estimateMessagesTokens([compactionMessage(summary)]) : 0),
      turnTokens: turns.map((turn) => estimateMessagesTokens(turn.map(buildAPIMessage))),
      threshold: input.compaction.threshold ?? DEFAULT_COMPACTION_THRESHOLD,
      keepRecentTurns: input.compaction.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS,
    });

    if (fold > 0) {
      const folded = turns.slice(0, fold).flat();
      try {
        input.onSummarizing?.();
        const result = await summarizeTranscript(input.provider, input.model, {
          previous: summary,
          transcript: messagesTranscript(folded),
          // About half the model's window per call, in characters
          chunkChars: Math.floor(limit / 2) * 4,
          signal: input.signal,
          sessionId: input.sessionId,
        });
        summary = result.summary;
        rest = rest.slice(folded.length);
        compaction = { messageId: folded[folded.length - 1].id, summary, turns: latest.turns + fold };
      } catch (err) {
        if (input.signal?.aborted) throw err;
        console.warn('[compaction] Summarizing failed; leaving out the oldest messages instead:', err);
      }
    }
  }

  const fitted = fitToContext({
    model: input.model,
    contextWindow: window,
    system: [...input.system, ...(summary ? [compactionMessage(summary)] : [])],
    history: rest.map(buildAPIMessage),
    current: input.current,
  });
  return { messages: fitted.messages, compaction, droppedTurns: fitted.droppedTurns };
}
