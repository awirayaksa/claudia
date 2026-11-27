/**
 * Pictures in tool results (a browser screenshot), after message building.
 * Pure: shared by the web server and tests.
 *
 * `toOpenAIMessages` puts a tool's images in its tool message as multi-part
 * content. Anthropic takes them there (image blocks in tool_result); the
 * OpenAI chat format only allows text in tool messages, so for every other
 * provider `hoistToolImages` moves them to one user message after the round.
 */
import type { ChatMessage, ContentPart } from '../../types/api.types';

/** What the model reads where an older picture was left out. */
export const OMITTED_IMAGE = '[An earlier image from this tool was left out to save space.]';

function imageCount(m: ChatMessage): number {
  return Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').length : 0;
}

function textOf(content: ContentPart[]): string {
  return content.map((p) => (p.type === 'text' ? p.text : '')).filter(Boolean).join('\n');
}

/** Whether any tool message carries a picture. */
export function hasToolImages(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === 'tool' && imageCount(m) > 0);
}

/**
 * Keep only the newest `keep` tool images; older ones become a short note.
 * Each screenshot costs about a thousand tokens and only the latest show the
 * page as it is now.
 */
export function limitToolImages(messages: ChatMessage[], keep = 2): ChatMessage[] {
  let left = keep;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== 'tool' || !Array.isArray(m.content) || imageCount(m) === 0) continue;
    const parts: ContentPart[] = [];
    let dropped = false;
    // Newest last within a message too
    for (let j = m.content.length - 1; j >= 0; j--) {
      const p = m.content[j];
      if (p.type !== 'image_url') parts.unshift(p);
      else if (left > 0) {
        left--;
        parts.unshift(p);
      } else dropped = true;
    }
    if (!dropped) continue;
    const text = [textOf(parts), OMITTED_IMAGE].filter(Boolean).join('\n');
    const images = parts.filter((p) => p.type === 'image_url');
    out[i] = { ...m, content: images.length ? [{ type: 'text', text }, ...images] : text };
  }
  return out;
}

/** Every tool image replaced by `note` (a model that can't read images). */
export function stripToolImages(messages: ChatMessage[], note: string): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== 'tool' || !Array.isArray(m.content) || imageCount(m) === 0) return m;
    return { ...m, content: [textOf(m.content), note].filter(Boolean).join('\n') };
  });
}

/**
 * For OpenAI-style APIs: tool messages get text only, and each round's
 * pictures follow it in one user message (after the round's last tool
 * message, so the tool answers stay together as the API requires).
 */
export function hoistToolImages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let pending: ContentPart[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    const n = pending.length;
    out.push({
      role: 'user',
      content: [{ type: 'text', text: `(${n === 1 ? 'The image' : `The ${n} images`} returned by the tool call${n === 1 ? '' : 's'} above.)` }, ...pending],
    });
    pending = [];
  };
  for (const m of messages) {
    if (m.role !== 'tool') flush();
    if (m.role === 'tool' && Array.isArray(m.content) && imageCount(m) > 0) {
      const images = m.content.filter((p) => p.type === 'image_url');
      pending.push(...images);
      const note = `(${images.length === 1 ? 'An image follows' : `${images.length} images follow`} after the tool results.)`;
      out.push({ ...m, content: [textOf(m.content), note].filter(Boolean).join('\n') });
    } else {
      out.push(m);
    }
  }
  flush();
  return out;
}

/**
 * Shrink all but the newest `keep` results of the calls in `callIds` to
 * their first line (a browser result's first line says which page it was;
 * the old page text only fills the context).
 */
export function elideStaleResults(messages: ChatMessage[], callIds: Set<string>, keep = 2, note = '[Older page content left out; take a new snapshot to see the page.]'): ChatMessage[] {
  let left = keep;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== 'tool' || !m.tool_call_id || !callIds.has(m.tool_call_id)) continue;
    if (left > 0) {
      left--;
      continue;
    }
    const text = typeof m.content === 'string' ? m.content : textOf(m.content ?? []);
    const first = text.split('\n', 1)[0].slice(0, 300);
    out[i] = { ...m, content: [first, note].filter(Boolean).join('\n') };
  }
  return out;
}
