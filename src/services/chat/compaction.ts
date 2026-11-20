/**
 * Summarizing earlier turns to fit the context window, shared by the desktop
 * and the web server. Each app turns its own message shape into a plain-text
 * transcript; this reads it (in pieces when long) and returns the summary.
 *
 * `context-budget.ts` decides when and how much to fold (`planCompaction`)
 * and builds the message that carries the summary (`compactionMessage`).
 */
import type { IAPIProvider } from '../api/provider.interface';
import type { MessageUsage } from '../../types/statistics.types';

const SUMMARY_TIMEOUT_MS = 120_000;
/** The summary's own length cap (tokens). */
const SUMMARY_MAX_TOKENS = 1_500;
/** Longest tool argument or result kept in a transcript. */
export const TRANSCRIPT_TOOL_CHARS = 1_500;

export const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)} […]` : s);

/** Cut a transcript into pieces of at most `max` characters, at paragraph breaks where possible. */
export function chunkText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim()) out.push(rest);
  return out;
}

const INSTRUCTIONS =
  'You compress a conversation so it can continue without the original messages. ' +
  'Write a concise summary in the language of the conversation. Keep what the rest of the conversation needs: ' +
  "the user's goals and constraints, decisions made, facts and numbers given, names of files, code and tools used and what they returned, " +
  'open questions, and what the assistant promised to do next. Leave out pleasantries. ' +
  'Reply with the summary only, as short paragraphs or bullet points.';

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error('Summarizing the conversation timed out')), SUMMARY_TIMEOUT_MS);
    (t as { unref?: () => void }).unref?.();
  });
  return Promise.race([promise, timeout]);
}

function addUsage(a: MessageUsage, b: MessageUsage | undefined): MessageUsage {
  if (!b) return a;
  return {
    prompt_tokens: (a.prompt_tokens ?? 0) + (b.prompt_tokens ?? 0),
    completion_tokens: (a.completion_tokens ?? 0) + (b.completion_tokens ?? 0),
    total_tokens: (a.total_tokens ?? 0) + (b.total_tokens ?? 0),
    ...(a.cost !== undefined || b.cost !== undefined ? { cost: (a.cost ?? 0) + (b.cost ?? 0) } : {}),
  };
}

/**
 * Summarize `transcript` (what came after an earlier summary, if any). A
 * transcript longer than `chunkChars` is read in pieces, each folded into the
 * summary so far.
 */
export async function summarizeTranscript(
  provider: IAPIProvider,
  model: string,
  opts: {
    previous: string | null;
    transcript: string;
    chunkChars: number;
    signal?: AbortSignal;
    /** The chat's id: the request belongs to its conversation. */
    sessionId?: string;
  }
): Promise<{ summary: string; usage: MessageUsage }> {
  let summary = opts.previous;
  let usage: MessageUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const chunk of chunkText(opts.transcript, Math.max(2_000, opts.chunkChars))) {
    if (opts.signal?.aborted) throw new Error('Stopped.');
    const res = await withTimeout(
      provider.chatCompletion(
        {
          model,
          messages: [
            { role: 'system', content: INSTRUCTIONS },
            {
              role: 'user',
              content:
                (summary ? `Summary of the conversation so far:\n${summary}\n\nWhat came after it:\n` : 'The conversation:\n') +
                chunk +
                '\n\nWrite the updated summary.',
            },
          ],
          stream: false,
          max_tokens: SUMMARY_MAX_TOKENS,
          temperature: 0.2,
        },
        { sessionId: opts.sessionId }
      )
    );
    const content = res.choices[0]?.message?.content;
    const text = typeof content === 'string' ? content.trim() : '';
    if (!text) throw new Error('The model returned an empty summary.');
    summary = text;
    usage = addUsage(usage, res.usage);
  }
  if (!summary) throw new Error('There was nothing to summarize.');
  return { summary, usage };
}
