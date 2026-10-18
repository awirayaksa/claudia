/** Helpers shared by the import converters. */
import { TAG, type ExportedChat, type ExportedMessage } from '../chats';

/** Seconds, milliseconds or nanoseconds since the epoch, or a date string → ISO. */
export function toIso(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (value.trim() !== '' && Number.isFinite(asNumber)) return toIso(asNumber, fallback);
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  const ms = value > 1e17 ? value / 1e6 : value > 1e14 ? value / 1e3 : value > 1e11 ? value : value * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

/** Labels → valid tags (lower case, no spaces or commas), duplicates and junk dropped. */
export function toTags(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out = new Set<string>();
  for (const v of values) {
    const raw = typeof v === 'string' ? v : v && typeof v === 'object' && 'name' in v ? String((v as { name: unknown }).name) : '';
    const parsed = TAG.safeParse(raw.trim().replace(/[\s,]+/g, '-'));
    if (parsed.success) out.add(parsed.data);
    if (out.size === 20) break;
  }
  return [...out];
}

export function cleanTitle(value: unknown): string {
  const t = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return (t || 'Imported chat').slice(0, 200);
}

const MAX_TEXT = 1_000_000;
export const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);

/** A chat in the import format, with the leaf defaulting to the newest message without replies. */
export function finishChat(
  chat: Omit<ExportedChat, 'currentLeafId' | 'params' | 'archived' | 'pinned' | 'tags' | 'folder' | 'modelIds'> &
    Partial<Pick<ExportedChat, 'currentLeafId' | 'archived' | 'pinned' | 'tags' | 'folder' | 'modelIds'>>
): ExportedChat {
  const ids = new Set(chat.messages.map((m) => m.id));
  let leaf = chat.currentLeafId && ids.has(chat.currentLeafId) ? chat.currentLeafId : null;
  if (!leaf) {
    const parents = new Set(chat.messages.map((m) => m.parentId));
    const leaves = chat.messages.filter((m) => !parents.has(m.id));
    leaf = leaves.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)?.id ?? null;
  }
  return {
    params: {},
    archived: false,
    pinned: false,
    tags: [],
    folder: null,
    modelIds: [],
    ...chat,
    currentLeafId: leaf,
  };
}

export type Message = ExportedMessage;
