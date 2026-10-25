/**
 * Searching past chats as tools the model calls ("what did we decide about
 * the API last week?"): conversation_search finds the user's chats whose
 * messages match any of the words, best first, with snippets; recent_chats
 * lists them by time. Only the user's own chats, never temporary ones nor
 * the chat being answered; inside a folder, only that folder's chats.
 */
import { and, desc, eq, gte, inArray, isNull, lte, ne, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { chats, messages } from '../../db/schema';
import type { ToolCall } from '../../../../src/types/message.types';
import type { CitationSource } from '../../../../src/types/turn.types';

export const CHAT_SEARCH_TOOL_NAMES = new Set(['conversation_search', 'recent_chats']);

export const CHAT_SEARCH_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'conversation_search',
      description:
        "Search the user's earlier conversations with you for what was said about something (decisions, facts, code, plans). " +
        'Use it when the user refers to a past conversation or to something you discussed before. Give the key words, not a question.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Key words to look for, e.g. "API pagination decision".' },
          limit: { type: 'number', description: 'How many chats (1-10, default 5).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'recent_chats',
      description: "List the user's recent conversations with you, newest first, optionally within a time range (e.g. \"what did we talk about yesterday?\").",
      parameters: {
        type: 'object',
        properties: {
          n: { type: 'number', description: 'How many (1-20, default 10).' },
          after: { type: 'string', description: 'Only chats active after this ISO date or time.' },
          before: { type: 'string', description: 'Only chats active before this ISO date or time.' },
        },
      },
    },
  },
];

export interface FoundChat {
  id: string;
  title: string;
  /** Last activity. */
  date: string;
  snippets: string[];
}

export interface ChatSearchScope {
  userId: string;
  /** The chat being answered (left out). */
  excludeChatId: string;
  /** Inside a folder: only chats in these folders. */
  folderIds: string[] | null;
}

const words = (q: string) => [...new Set((q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1))].slice(0, 12);

export class ChatSearch {
  constructor(private readonly db: Database) {}

  private scope(s: ChatSearchScope): SQL | undefined {
    return and(
      eq(chats.userId, s.userId),
      eq(chats.temporary, false),
      ne(chats.id, s.excludeChatId),
      s.folderIds ? (s.folderIds.length ? inArray(chats.folderId, s.folderIds) : isNull(chats.folderId)) : undefined
    );
  }

  /** Chats whose messages (or title) match any of the words, best first. */
  async search(s: ChatSearchScope, query: string, limit = 5): Promise<FoundChat[]> {
    const ws = words(query);
    if (ws.length === 0) return [];
    const tsq = sql`to_tsquery('simple', ${ws.map((w) => `'${w}':*`).join(' | ')})`;
    const hits = await this.db
      .select({ messageId: messages.id, chatId: messages.chatId, rank: sql<number>`ts_rank(${messages.search}, ${tsq})` })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .where(and(this.scope(s), sql`${messages.search} @@ ${tsq}`))
      .orderBy(sql`ts_rank(${messages.search}, ${tsq}) desc`)
      .limit(100);
    // A title that names the subject counts too
    const titled = await this.db
      .select({ id: chats.id })
      .from(chats)
      .where(and(this.scope(s), sql`(${sql.join(ws.filter((w) => w.length > 2).map((w) => sql`${chats.title} ilike ${`%${w}%`}`), sql` or `)} or false)`))
      .limit(50);

    const byChat = new Map<string, { score: number; messageIds: string[] }>();
    for (const h of hits) {
      const c = byChat.get(h.chatId) ?? { score: 0, messageIds: [] };
      c.score = Math.max(c.score, Number(h.rank));
      if (c.messageIds.length < 2) c.messageIds.push(h.messageId);
      byChat.set(h.chatId, c);
    }
    for (const t of titled) {
      const c = byChat.get(t.id) ?? { score: 0, messageIds: [] };
      c.score += 0.05;
      byChat.set(t.id, c);
    }
    const top = [...byChat.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, Math.min(10, Math.max(1, limit)));
    if (top.length === 0) return [];

    const rows = await this.db.select({ id: chats.id, title: chats.title, updatedAt: chats.updatedAt }).from(chats).where(inArray(chats.id, top.map(([id]) => id)));
    const info = new Map(rows.map((r) => [r.id, r]));
    const ids = top.flatMap(([, c]) => c.messageIds);
    const options = 'StartSel=**, StopSel=**, MaxWords=45, MinWords=15, MaxFragments=2, FragmentDelimiter=" … "';
    const snippets = new Map<string, string>();
    if (ids.length) {
      const found = await this.db
        .select({ id: messages.id, role: messages.role, text: sql<string>`ts_headline('simple', claudia_parts_text(${messages.parts}), ${tsq}, ${options})` })
        .from(messages)
        .where(inArray(messages.id, ids));
      for (const f of found) snippets.set(f.id, `${f.role === 'user' ? 'User' : 'Assistant'}: ${f.text}`);
    }
    return top.flatMap(([id, c]) => {
      const chat = info.get(id);
      return chat ? [{ id, title: chat.title, date: chat.updatedAt.toISOString(), snippets: c.messageIds.flatMap((m) => (snippets.has(m) ? [snippets.get(m)!] : [])) }] : [];
    });
  }

  /** The newest chats, within a time range if given, each with how it began. */
  async recent(s: ChatSearchScope, opts: { n?: number; before?: Date; after?: Date } = {}): Promise<FoundChat[]> {
    const rows = await this.db
      .select({ id: chats.id, title: chats.title, updatedAt: chats.updatedAt })
      .from(chats)
      .where(and(this.scope(s), opts.before ? lte(chats.updatedAt, opts.before) : undefined, opts.after ? gte(chats.updatedAt, opts.after) : undefined))
      .orderBy(desc(chats.updatedAt))
      .limit(Math.min(20, Math.max(1, opts.n ?? 10)));
    if (rows.length === 0) return [];
    const firsts = await this.db
      .select({ chatId: messages.chatId, text: sql<string>`left(claudia_parts_text(${messages.parts}), 200)` })
      .from(messages)
      .where(and(inArray(messages.chatId, rows.map((r) => r.id)), isNull(messages.parentId), eq(messages.role, 'user')));
    const first = new Map(firsts.map((f) => [f.chatId, f.text]));
    return rows.map((r) => ({ id: r.id, title: r.title, date: r.updatedAt.toISOString(), snippets: first.has(r.id) ? [`User: ${first.get(r.id)}`] : [] }));
  }
}

/** Run a chat-search tool call; found chats come back numbered, to cite and to show as sources. */
export async function runChatSearchTool(
  search: ChatSearch,
  scope: ChatSearchScope,
  call: ToolCall,
  firstIndex: number
): Promise<{ content: string; isError: boolean; sources: Array<{ index: number; source: CitationSource }> }> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return { content: JSON.stringify({ error: 'Invalid arguments: expected JSON.' }), isError: true, sources: [] };
  }
  const date = (v: unknown) => {
    const d = typeof v === 'string' && v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : undefined;
  };
  let found: FoundChat[];
  if (call.function.name === 'conversation_search') {
    if (typeof args.query !== 'string' || !args.query.trim()) return { content: JSON.stringify({ error: 'Give the words to look for as "query".' }), isError: true, sources: [] };
    found = await search.search(scope, args.query, typeof args.limit === 'number' ? args.limit : 5);
  } else {
    found = await search.recent(scope, { n: typeof args.n === 'number' ? args.n : undefined, before: date(args.before), after: date(args.after) });
  }
  const sources = found.map((c, i) => ({
    index: firstIndex + i,
    source: { kind: 'chat' as const, id: c.id, title: c.title, snippet: c.snippets[0]?.replace(/\*\*/g, '').slice(0, 300) },
  }));
  return {
    content: JSON.stringify({
      chats: found.map((c, i) => ({ cite: firstIndex + i, title: c.title, lastActive: c.date.slice(0, 16).replace('T', ' '), snippets: c.snippets })),
      ...(found.length
        ? { note: 'Cite a chat you use with its number in square brackets, like [3]; the user can open it from there.' }
        : { note: 'No earlier chat matched. Say so if it matters; try other words if it may help.' }),
    }),
    isError: false,
    sources,
  };
}
