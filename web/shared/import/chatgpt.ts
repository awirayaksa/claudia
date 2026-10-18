/**
 * ChatGPT data exports (`conversations.json`): an array of
 * `{ title, create_time, update_time, mapping: { id: { message, parent,
 * children } }, current_node }`. The mapping is a tree with hidden nodes
 * (the root, system and tool messages, browsing steps); those are skipped
 * and their children attached to the nearest kept ancestor. An assistant
 * message that only continues the one before it (after a tool step) is
 * merged into it, so each reply is one node.
 */
import type { ExportedChat } from '../chats';
import { clip, cleanTitle, finishChat, toIso, type Message } from './common';

interface GptContent {
  content_type?: string;
  parts?: unknown[];
  text?: string;
  language?: string;
  thoughts?: Array<{ summary?: string; content?: string }>;
}

interface GptNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: {
    id?: string;
    author?: { role?: string };
    create_time?: number | null;
    content?: GptContent;
    metadata?: { model_slug?: string; is_visually_hidden_from_conversation?: boolean };
  } | null;
}

interface GptConversation {
  title?: string;
  create_time?: number;
  update_time?: number;
  current_node?: string;
  mapping?: Record<string, GptNode>;
  default_model_slug?: string;
}

export function isChatGPTConversation(v: unknown): v is GptConversation {
  const m = (v as GptConversation)?.mapping;
  return !!m && typeof m === 'object' && !Array.isArray(m);
}

/** What one message contributes: visible text and/or reasoning. */
function readContent(c: GptContent | undefined): { text: string; reasoning: string } {
  if (!c) return { text: '', reasoning: '' };
  switch (c.content_type) {
    case 'text':
    case 'multimodal_text':
      return {
        text: (c.parts ?? []).filter((p): p is string => typeof p === 'string').join('\n'),
        reasoning: '',
      };
    case 'code':
      return { text: c.text ? `\`\`\`${c.language && c.language !== 'unknown' ? c.language : ''}\n${c.text}\n\`\`\`` : '', reasoning: '' };
    case 'thoughts':
      return { text: '', reasoning: (c.thoughts ?? []).map((t) => t.content ?? t.summary ?? '').filter(Boolean).join('\n\n') };
    default:
      return { text: '', reasoning: '' };
  }
}

export function convertChatGPTConversation(conv: GptConversation): ExportedChat {
  const now = new Date().toISOString();
  const updatedAt = toIso(conv.update_time, now);
  const mapping = conv.mapping ?? {};

  /** Node id → id of the kept node standing in for it (itself, or an ancestor; null at the top). */
  const keptAs = new Map<string, string | null>();
  const messages = new Map<string, Message>();
  /** Kept node id → number of kept children (an assistant with one may absorb it). */
  const childCount = new Map<string, number>();

  const visit = (id: string, parentKept: string | null): string[] => {
    const node = mapping[id];
    if (!node || keptAs.has(id)) return [];
    const msg = node.message;
    const role = msg?.author?.role;
    const hidden = !msg || msg.metadata?.is_visually_hidden_from_conversation;
    const { text, reasoning } = readContent(msg?.content);
    let kept: string | null = parentKept;

    if (!hidden && (role === 'user' || role === 'assistant') && (text || reasoning)) {
      const parent = parentKept ? messages.get(parentKept) : undefined;
      if (role === 'assistant' && parent?.role === 'assistant' && (childCount.get(parent.id) ?? 0) === 0 && (node.children ?? []).length <= 1) {
        // Continues the reply above (after a tool step or a thought): one node
        if (reasoning) parent.parts.push({ type: 'reasoning', text: clip(reasoning) });
        if (text) parent.parts.push({ type: 'text', text: clip(text) });
        if (!parent.modelId && msg?.metadata?.model_slug) parent.modelId = msg.metadata.model_slug;
      } else {
        const out: Message = {
          id,
          parentId: parentKept,
          role,
          parts: [
            ...(reasoning ? [{ type: 'reasoning' as const, text: clip(reasoning) }] : []),
            ...(text ? [{ type: 'text' as const, text: clip(text) }] : []),
          ],
          ...(role === 'assistant' && msg?.metadata?.model_slug ? { modelId: msg.metadata.model_slug } : {}),
          status: 'completed',
          createdAt: toIso(msg?.create_time, updatedAt),
        };
        messages.set(id, out);
        if (parentKept) childCount.set(parentKept, (childCount.get(parentKept) ?? 0) + 1);
        kept = id;
      }
    }
    keptAs.set(id, kept);
    return node.children ?? [];
  };

  const roots = Object.entries(mapping)
    .filter(([, n]) => !n.parent || !mapping[n.parent])
    .map(([id]) => id);
  // Depth first, without recursion (a long chat is a deep tree)
  const stack: Array<[string, string | null]> = roots.reverse().map((id) => [id, null]);
  while (stack.length) {
    const [id, parentKept] = stack.pop()!;
    const children = visit(id, parentKept);
    const kept = keptAs.get(id) ?? null;
    for (const child of [...children].reverse()) stack.push([child, kept]);
  }

  const current = conv.current_node ? keptAs.get(conv.current_node) ?? null : null;
  const models = [...new Set([...messages.values()].flatMap((m) => (m.modelId ? [m.modelId] : [])))];
  return finishChat({
    title: cleanTitle(conv.title),
    createdAt: toIso(conv.create_time, updatedAt),
    updatedAt,
    modelIds: (conv.default_model_slug ? [conv.default_model_slug] : models).slice(0, 1),
    currentLeafId: current,
    messages: [...messages.values()],
  });
}
