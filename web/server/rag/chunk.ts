/**
 * Token-aware recursive splitting: markdown headings first (each chunk
 * knows its heading path), then paragraphs, lines, sentences and words.
 * Pieces are packed up to `size` tokens; a new chunk starts with up to
 * `overlap` tokens of the end of the previous one.
 */
import { countTokens } from 'gpt-tokenizer';

/** A stretch of a document with what we know about where it came from. */
export interface Segment {
  text: string;
  page?: number;
  heading?: string;
}

export interface Chunk {
  text: string;
  tokens: number;
  page: number | null;
  heading: string | null;
}

export interface ChunkOptions {
  size: number;
  overlap: number;
}

const SEPARATORS: Array<RegExp> = [/\n{2,}/, /\n/, /(?<=[.!?。])\s+/, /\s+/];

/** Split markdown into sections at headings, tracking the heading path. */
export function sections(segment: Segment): Segment[] {
  const out: Segment[] = [];
  const path: string[] = [];
  let current: string[] = [];
  let heading = segment.heading;
  let inFence = false;
  const flush = () => {
    const text = current.join('\n').trim();
    if (text) out.push({ text, ...(segment.page !== undefined ? { page: segment.page } : {}), ...(heading ? { heading } : {}) });
    current = [];
  };
  for (const line of segment.text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      path.length = level - 1;
      path[level - 1] = m[2].trim();
      heading = [segment.heading, ...path.filter(Boolean)].filter(Boolean).join(' › ');
      current.push(line);
    } else {
      current.push(line);
    }
  }
  flush();
  return out;
}

/** Break text into pieces of at most `max` tokens, at the coarsest separator that works. */
function split(text: string, max: number, level = 0): string[] {
  if (countTokens(text) <= max) return [text];
  const sep = SEPARATORS[level];
  if (!sep) {
    // No separator left: cut by characters (very long words, base64, ...)
    const out: string[] = [];
    const step = Math.max(1, max * 3);
    for (let i = 0; i < text.length; i += step) out.push(text.slice(i, i + step));
    return out;
  }
  const parts = text.split(sep).filter((p) => p.trim());
  if (parts.length <= 1) return split(text, max, level + 1);
  return parts.flatMap((p) => split(p, max, level + 1));
}

const JOINER = '\n\n';

export function chunkSegments(segments: Segment[], opts: ChunkOptions): Chunk[] {
  const size = Math.max(50, opts.size);
  const overlap = Math.max(0, Math.min(opts.overlap, Math.floor(size / 2)));
  const out: Chunk[] = [];
  for (const section of segments.flatMap(sections)) {
    const pieces = split(section.text, size).map((t) => ({ text: t.trim(), tokens: countTokens(t) }));
    let current: typeof pieces = [];
    let tokens = 0;
    const emit = () => {
      if (current.length === 0) return;
      const text = current.map((p) => p.text).join(JOINER);
      out.push({ text, tokens: countTokens(text), page: section.page ?? null, heading: section.heading ?? null });
      // Carry the tail into the next chunk
      const carry: typeof pieces = [];
      let carried = 0;
      for (let i = current.length - 1; i >= 0 && carried + current[i].tokens <= overlap; i--) {
        carry.unshift(current[i]);
        carried += current[i].tokens;
      }
      current = carry.length < current.length ? carry : [];
      tokens = current.reduce((n, p) => n + p.tokens, 0);
    };
    for (const piece of pieces) {
      if (!piece.text) continue;
      if (tokens + piece.tokens > size && current.length > 0) emit();
      current.push(piece);
      tokens += piece.tokens;
    }
    // The last chunk, unless it would only repeat the previous one's tail
    if (current.length > 0 && !(out.length > 0 && out[out.length - 1].text.endsWith(current.map((p) => p.text).join(JOINER)))) {
      const text = current.map((p) => p.text).join(JOINER);
      out.push({ text, tokens: countTokens(text), page: section.page ?? null, heading: section.heading ?? null });
    }
  }
  return out;
}

export { countTokens };
