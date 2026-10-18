/**
 * Open WebUI chat exports (Settings → Chats → Export): an array of
 * `{ title, chat: { history: { messages, currentId }, models }, created_at,
 * updated_at, pinned, archived, meta: { tags } }`. Branches come along
 * (history.messages is a tree); older exports with only a flat
 * `chat.messages` list import as one line.
 */
import type { ExportedChat } from '../chats';
import { clip, cleanTitle, finishChat, toIso, toTags, type Message } from './common';

interface OwuiMessage {
  id?: string;
  parentId?: string | null;
  role?: string;
  content?: unknown;
  model?: string;
  models?: string[];
  timestamp?: number;
  files?: Array<{ name?: string; type?: string; file?: { meta?: { name?: string; content_type?: string; size?: number } } }>;
  error?: unknown;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  annotation?: { rating?: number };
}

interface OwuiChat {
  title?: string;
  created_at?: number;
  updated_at?: number;
  pinned?: boolean;
  archived?: boolean;
  meta?: { tags?: unknown[] };
  chat?: {
    title?: string;
    models?: string[];
    tags?: unknown[];
    timestamp?: number;
    history?: { messages?: Record<string, OwuiMessage>; currentId?: string | null };
    messages?: OwuiMessage[];
  };
}

export function isOpenWebUIChat(v: unknown): v is OwuiChat {
  const c = (v as OwuiChat)?.chat;
  return !!c && typeof c === 'object' && (!!c.history?.messages || Array.isArray(c.messages));
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  // Multimodal content: [{ type: 'text', text }, { type: 'image_url', ... }]
  if (Array.isArray(c)) return c.map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : '')).join('\n');
  return '';
}

function errorText(e: unknown): string | undefined {
  if (!e) return undefined;
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && e && 'content' in e) return String((e as { content: unknown }).content);
  return 'The reply failed.';
}

export function convertOpenWebUIChat(item: OwuiChat): ExportedChat {
  const now = new Date().toISOString();
  const chat = item.chat ?? {};
  let list: OwuiMessage[];
  let currentId: string | null | undefined;
  if (chat.history?.messages && Object.keys(chat.history.messages).length) {
    list = Object.entries(chat.history.messages).map(([id, m]) => ({ ...m, id: m.id ?? id }));
    currentId = chat.history.currentId;
  } else {
    // Flat list: chain them
    list = (chat.messages ?? []).map((m, i, all) => ({
      ...m,
      id: m.id ?? `m${i}`,
      parentId: i === 0 ? null : (all[i - 1].id ?? `m${i - 1}`),
    }));
    currentId = list.at(-1)?.id;
  }

  const updatedAt = toIso(item.updated_at ?? chat.timestamp, now);
  const messages: Message[] = list
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
    .map((m) => {
      const parts: Message['parts'] = [];
      const body = contentText(m.content);
      if (body) parts.push({ type: 'text', text: clip(body) });
      if (m.role === 'user') {
        for (const f of m.files ?? []) {
          const meta = f.file?.meta;
          parts.push({
            type: 'file',
            fileId: '',
            name: meta?.name ?? f.name ?? 'file',
            mime: meta?.content_type ?? (f.type === 'image' ? 'image/*' : 'application/octet-stream'),
            ...(meta?.size ? { size: meta.size } : {}),
          });
        }
      }
      const error = errorText(m.error);
      const rating = m.annotation?.rating;
      return {
        id: String(m.id),
        parentId: m.parentId ?? null,
        role: m.role as Message['role'],
        parts,
        ...(m.role === 'assistant' && m.model ? { modelId: m.model.slice(0, 500) } : {}),
        ...(m.role === 'user' && m.models && m.models.length > 1 ? { models: m.models.slice(0, 4) } : {}),
        ...(m.usage ? { usage: m.usage } : {}),
        status: error ? ('error' as const) : ('completed' as const),
        ...(error ? { error: error.slice(0, 10_000) } : {}),
        ...(rating === 1 || rating === -1 ? { rating } : {}),
        createdAt: toIso(m.timestamp, updatedAt),
      };
    });

  return finishChat({
    title: cleanTitle(item.title ?? chat.title),
    createdAt: toIso(item.created_at, updatedAt),
    updatedAt,
    modelIds: (chat.models ?? []).filter((m) => typeof m === 'string' && m).slice(0, 4),
    pinned: !!item.pinned,
    archived: !!item.archived,
    tags: toTags(item.meta?.tags ?? chat.tags),
    currentLeafId: currentId ?? null,
    messages,
  });
}
