/**
 * Context compaction: when a chat nears the model's context window, the
 * oldest turns are summarized and the summary is sent in their place.
 *
 * The summary is stored in the meta of the last node it covers, so every
 * later send down that path (and every branch from below it) reuses it. A
 * newer summary folds the older one in, so the deepest one on the path is
 * the only one sent.
 */
import type { IAPIProvider } from '../../../src/services/api/provider.interface';
import type { MessageNode } from '../../../src/types/turn.types';
import type { MessageUsage } from '../../../src/types/statistics.types';

const SUMMARY_TIMEOUT_MS = 120_000;
/** Longest tool argument or result kept in the transcript a summary is made from. */
const TOOL_CHARS = 1_500;
/** The summary's own length cap (tokens). */
const SUMMARY_MAX_TOKENS = 1_500;

/** Split a path into turns: each starts at a user node and holds the replies (and their tool rounds) after it. */
export function nodeTurns(path: MessageNode[]): MessageNode[][] {
  const turns: MessageNode[][] = [];
  for (const node of path) {
    if (node.role === 'user' || turns.length === 0) turns.push([node]);
    else turns[turns.length - 1].push(node);
  }
  return turns;
}

/** The deepest summary on a path, and the nodes after it. */
export function latestCompaction(path: MessageNode[]): { summary: string | null; rest: MessageNode[] } {
  for (let i = path.length - 1; i >= 0; i--) {
    const c = path[i].compaction;
    if (c?.summary) return { summary: c.summary, rest: path.slice(i + 1) };
  }
  return { summary: null, rest: path };
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)} […]` : s);

/** A plain-text transcript of nodes for the summarizer (reasoning left out, tool rounds shortened). */
export function transcriptOf(nodes: MessageNode[]): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const who = node.role === 'user' ? 'User' : node.role === 'assistant' ? 'Assistant' : 'System';
    const pieces: string[] = [];
    for (const p of node.parts) {
      if (p.type === 'text' && p.text.trim()) pieces.push(p.text.trim());
      else if (p.type === 'file') pieces.push(`[attached file: ${p.name}]`);
      else if (p.type === 'tool_call') pieces.push(`[called ${p.tool || p.alias}(${clip(p.args, TOOL_CHARS)})]`);
      else if (p.type === 'tool_result') pieces.push(`[${p.isError ? 'tool error' : 'tool result'}: ${clip(p.content, TOOL_CHARS)}]`);
    }
    if (pieces.length > 0) lines.push(`${who}: ${pieces.join('\n')}`);
  }
  return lines.join('\n\n');
}

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
    t.unref?.();
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
 * Summarize `nodes` (after an earlier summary, if any). A transcript longer
 * than `chunkChars` is read in pieces, each folded into the summary so far.
 */
export async function summarize(
  provider: IAPIProvider,
  model: string,
  opts: { previous: string | null; nodes: MessageNode[]; chunkChars: number; signal?: AbortSignal }
): Promise<{ summary: string; usage: MessageUsage }> {
  let summary = opts.previous;
  let usage: MessageUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const chunk of chunkText(transcriptOf(opts.nodes), Math.max(2_000, opts.chunkChars))) {
    if (opts.signal?.aborted) throw new Error('Stopped.');
    const res = await withTimeout(
      provider.chatCompletion({
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
      })
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
