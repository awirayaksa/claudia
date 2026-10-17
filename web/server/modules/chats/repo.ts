/**
 * Chats, folders and messages. Every read and write is scoped to the owner:
 * a chat id from another user behaves exactly like one that doesn't exist.
 */
import { and, asc, desc, eq, ilike, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { chats, folders, messages } from '../../db/schema';
import { notFound } from '../../lib/errors';
import type { MessageNode } from '../../../../src/types/turn.types';
import type { ChatSummary, Folder } from '../../../shared/chats';

export type ChatRow = typeof chats.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type FolderRow = typeof folders.$inferSelect;

export function toChatSummary(c: ChatRow): ChatSummary {
  return {
    id: c.id,
    title: c.title,
    folderId: c.folderId,
    modelIds: c.modelIds,
    pinned: c.pinned,
    archived: c.archived,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
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

  async list(
    userId: string,
    q: { search?: string; folderId?: string; archived: boolean; limit: number; offset: number }
  ): Promise<ChatRow[]> {
    return this.db
      .select()
      .from(chats)
      .where(
        and(
          eq(chats.userId, userId),
          eq(chats.archived, q.archived),
          eq(chats.temporary, false),
          q.folderId ? eq(chats.folderId, q.folderId) : undefined,
          q.search ? ilike(chats.title, `%${q.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`) : undefined
        )
      )
      .orderBy(desc(chats.pinned), desc(chats.updatedAt))
      .limit(q.limit)
      .offset(q.offset);
  }

  async messages(chatId: string): Promise<MessageRow[]> {
    return this.db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(asc(messages.createdAt), asc(messages.id));
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

  async countChats(userId: string): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(chats).where(eq(chats.userId, userId));
    return Number(row?.n ?? 0);
  }
}
