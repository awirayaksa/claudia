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
import { TRANSCRIPT_TOOL_CHARS, chunkText, clip, summarizeTranscript } from '../../../src/services/chat/compaction';

export { chunkText };

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

/** A plain-text transcript of nodes for the summarizer (reasoning left out, tool rounds shortened). */
export function transcriptOf(nodes: MessageNode[]): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const who = node.role === 'user' ? 'User' : node.role === 'assistant' ? 'Assistant' : 'System';
    const pieces: string[] = [];
    for (const p of node.parts) {
      if (p.type === 'text' && p.text.trim()) pieces.push(p.text.trim());
      else if (p.type === 'file') pieces.push(`[attached file: ${p.name}]`);
      else if (p.type === 'tool_call') pieces.push(`[called ${p.tool || p.alias}(${clip(p.args, TRANSCRIPT_TOOL_CHARS)})]`);
      else if (p.type === 'tool_result') pieces.push(`[${p.isError ? 'tool error' : 'tool result'}: ${clip(p.content, TRANSCRIPT_TOOL_CHARS)}]`);
    }
    if (pieces.length > 0) lines.push(`${who}: ${pieces.join('\n')}`);
  }
  return lines.join('\n\n');
}

/**
 * Summarize `nodes` (after an earlier summary, if any). A transcript longer
 * than `chunkChars` is read in pieces, each folded into the summary so far.
 */
export function summarize(
  provider: IAPIProvider,
  model: string,
  opts: {
    previous: string | null;
    nodes: MessageNode[];
    chunkChars: number;
    signal?: AbortSignal;
    /** The chat's id: the request belongs to its conversation. */
    sessionId?: string;
  }
): Promise<{ summary: string; usage: MessageUsage }> {
  const { nodes, ...rest } = opts;
  return summarizeTranscript(provider, model, { ...rest, transcript: transcriptOf(nodes) });
}
