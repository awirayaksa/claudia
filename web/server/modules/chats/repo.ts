/**
 * Chats, folders and messages. Every read and write is scoped to the owner:
 * a chat id from another user behaves exactly like one that doesn't exist.
 */
import { and, asc, desc, eq, getTableColumns, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { chats, folders, messages, shares } from '../../db/schema';
import { notFound } from '../../lib/errors';
import type { MessageNode } from '../../../../src/types/turn.types';
import { SNIPPET_MARK_END, SNIPPET_MARK_START, type ChatSummary, type Folder, type ShareView } from '../../../shared/chats';

export type ChatRow = typeof chats.$inferSelect;
/** Message columns without the search index (large, and only the database reads it). */
const { search: _search, ...messageColumns } = getTableColumns(messages);
export type MessageRow = Omit<typeof messages.$inferSelect, 'search'>;
export type FolderRow = typeof folders.$inferSelect;
export type ShareRow = typeof shares.$inferSelect;

/** A temporary chat is deleted after this long without activity. */
export const TEMPORARY_CHAT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ChatListOptions {
  search?: string;
  folderId?: string;
  tag?: string;
  archived: boolean;
  limit: number;
  offset: number;
}

/**
 * The words of a search as a prefix query ("quick bro" → 'quick':* & 'bro':*),
 * or null when there are none. Only letters and digits reach to_tsquery.
 */
export function toPrefixQuery(search: string): string | null {
  const words = (search.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
  return words.length ? words.map((w) => `'${w}':*`).join(' & ') : null;
}

function likePattern(text: string): string {
  return `%${text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

export function toChatSummary(c: ChatRow): ChatSummary {
  return {
    id: c.id,
    title: c.title,
    folderId: c.folderId,
    modelIds: c.modelIds,
    pinned: c.pinned,
    archived: c.archived,
    temporary: c.temporary,
    tags: c.tags,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function toShareView(s: ShareRow): ShareView {
  return { token: s.token, title: s.title, createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString() };
}

export function toFolder(f: FolderRow): Folder {
  return {
    id: f.id,
    parentId: f.parentId,
    name: f.name,
    systemPrompt: f.systemPrompt,
    createdAt: f.createdAt.toISOString(),
  };
}

export function toNode(m: MessageRow): MessageNode {
  return {
    id: m.id,
    chatId: m.chatId,
    parentId: m.parentId,
    role: m.role,
    parts: m.parts,
    ...(m.modelId ? { modelId: m.modelId } : {}),
    ...(m.usage ? { usage: m.usage } : {}),
    ...(m.effort ? { effort: m.effort as MessageNode['effort'] } : {}),
    status: m.status,
    ...(m.error ? { error: m.error } : {}),
    ...(m.rating === 1 || m.rating === -1 ? { rating: m.rating } : {}),
    ...(m.feedback && (m.feedback.comment || m.feedback.reasons?.length)
      ? { feedback: { ...(m.feedback.comment ? { comment: m.feedback.comment } : {}), ...(m.feedback.reasons?.length ? { reasons: m.feedback.reasons } : {}) } }
      : {}),
    ...(m.meta?.models?.length ? { models: m.meta.models } : {}),
    ...(m.meta?.followUps?.length ? { followUps: m.meta.followUps } : {}),
    createdAt: m.createdAt.toISOString(),
  };
}

/** Root → leaf. Stops at a cycle or a missing parent instead of looping. */
export function pathTo<T extends { id: string; parentId: string | null }>(nodes: T[], leafId: string | null): T[] {
  if (!leafId) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const path: T[] = [];
  const seen = new Set<string>();
  let cur = byId.get(leafId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

export class ChatRepo {
  constructor(private readonly db: Database) {}

  async getOwned(userId: string, chatId: string): Promise<ChatRow> {
    const [row] = await this.db.select().from(chats).where(and(eq(chats.id, chatId), eq(chats.userId, userId)));
    if (!row) throw notFound('Chat');
    return row;
  }

  private listFilters(userId: string, q: ChatListOptions): SQL | undefined {
    return and(
      eq(chats.userId, userId),
      eq(chats.archived, q.archived),
      eq(chats.temporary, false),
      q.folderId ? eq(chats.folderId, q.folderId) : undefined,
      q.tag ? sql`${chats.tags} @> ${JSON.stringify([q.tag])}::jsonb` : undefined
    );
  }

  /**
   * The user's chats, pinned first. With a search: chats whose title
   * contains it, or with a message whose text matches every word (as a
   * prefix), each with a snippet of its best-matching message.
   */
  async list(userId: string, q: ChatListOptions): Promise<Array<ChatRow & { match?: ChatSummary['match'] }>> {
    const filters = this.listFilters(userId, q);
    const tsq = q.search ? toPrefixQuery(q.search) : null;
    if (!q.search) {
      return this.db
        .select()
        .from(chats)
        .where(filters)
        .orderBy(desc(chats.pinned), desc(chats.updatedAt))
        .limit(q.limit)
        .offset(q.offset);
    }

    const query = tsq ? sql`to_tsquery('simple', ${tsq})` : null;
    const hits = query
      ? this.db
          .selectDistinctOn([messages.chatId], { chatId: messages.chatId, messageId: messages.id })
          .from(messages)
          .innerJoin(chats, eq(chats.id, messages.chatId))
          .where(and(filters, sql`${messages.search} @@ ${query}`))
          .orderBy(messages.chatId, sql`ts_rank(${messages.search}, ${query}) desc`)
          .as('hits')
      : null;

    const titleMatch = ilike(chats.title, likePattern(q.search));
    const rows = hits
      ? await this.db
          .select({ chat: chats, messageId: hits.messageId })
          .from(chats)
          .leftJoin(hits, eq(hits.chatId, chats.id))
          .where(and(filters, or(titleMatch, sql`${hits.chatId} is not null`)))
          .orderBy(desc(chats.pinned), desc(chats.updatedAt))
          .limit(q.limit)
          .offset(q.offset)
      : (
          await this.db
            .select()
            .from(chats)
            .where(and(filters, titleMatch))
            .orderBy(desc(chats.pinned), desc(chats.updatedAt))
            .limit(q.limit)
            .offset(q.offset)
        ).map((chat) => ({ chat, messageId: null as string | null }));

    // Snippets only for the rows returned
    const ids = rows.flatMap((r) => (r.messageId ? [r.messageId] : []));
    const snippets = new Map<string, string>();
    if (ids.length && query) {
      const options = `StartSel=${SNIPPET_MARK_START}, StopSel=${SNIPPET_MARK_END}, MaxWords=24, MinWords=8, MaxFragments=1, FragmentDelimiter=" … "`;
      const found = await this.db
        .select({ id: messages.id, snippet: sql<string>`ts_headline('simple', claudia_parts_text(${messages.parts}), ${query}, ${options})` })
        .from(messages)
        .where(inArray(messages.id, ids));
      for (const f of found) snippets.set(f.id, f.snippet);
    }
    return rows.map((r) =>
      r.messageId && snippets.has(r.messageId)
        ? { ...r.chat, match: { messageId: r.messageId, snippet: snippets.get(r.messageId)! } }
        : r.chat
    );
  }

  /** Tags in use, with how many (non-temporary) chats carry each. */
  async tags(userId: string): Promise<Array<{ tag: string; count: number }>> {
    const rows = await this.db
      .select({ tag: sql<string>`t.tag`, count: sql<number>`count(*)::int` })
      .from(sql`${chats}, jsonb_array_elements_text(${chats.tags}) as t(tag)`)
      .where(and(eq(chats.userId, userId), eq(chats.temporary, false)))
      .groupBy(sql`t.tag`)
      .orderBy(sql`t.tag`);
    return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
  }

  async share(chatId: string): Promise<ShareRow | null> {
    const [row] = await this.db.select().from(shares).where(eq(shares.chatId, chatId));
    return row ?? null;
  }

  async messages(chatId: string): Promise<MessageRow[]> {
    return this.db
      .select(messageColumns)
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(asc(messages.createdAt), asc(messages.id));
  }

  async touch(chatId: string, patch: Partial<Pick<ChatRow, 'currentLeafId' | 'title' | 'titleSet' | 'modelIds'>> = {}) {
    await this.db.update(chats).set({ ...patch, updatedAt: new Date() }).where(eq(chats.id, chatId));
  }

  async folderOwned(userId: string, folderId: string): Promise<FolderRow> {
    const [row] = await this.db.select().from(folders).where(and(eq(folders.id, folderId), eq(folders.userId, userId)));
    if (!row) throw notFound('Folder');
    return row;
  }

  async folders(userId: string): Promise<FolderRow[]> {
    return this.db.select().from(folders).where(eq(folders.userId, userId)).orderBy(asc(folders.name));
  }

  /** The folder chain from the chat's folder up to the root (system prompts apply top-down). */
  async folderChain(userId: string, folderId: string | null): Promise<FolderRow[]> {
    const chain: FolderRow[] = [];
    const seen = new Set<string>();
    let id = folderId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const [row] = await this.db.select().from(folders).where(and(eq(folders.id, id), eq(folders.userId, userId)));
      if (!row) break;
      chain.unshift(row);
      id = row.parentId;
    }
    return chain;
  }

  async rootFolders(userId: string): Promise<FolderRow[]> {
    return this.db.select().from(folders).where(and(eq(folders.userId, userId), isNull(folders.parentId)));
  }

  /** Delete temporary chats not touched since `before`. */
  async purgeTemporary(before: Date): Promise<number> {
    const rows = await this.db
      .delete(chats)
      .where(and(eq(chats.temporary, true), sql`${chats.updatedAt} < ${before.toISOString()}::timestamptz`))
      .returning({ id: chats.id });
    return rows.length;
  }

  async countChats(userId: string): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(chats).where(eq(chats.userId, userId));
    return Number(row?.n ?? 0);
  }
}
