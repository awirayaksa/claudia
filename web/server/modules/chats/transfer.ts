/**
 * Copying chats in and out: export (Claudia JSON), import (the client turns
 * desktop, Open WebUI and ChatGPT exports into the same format first), and
 * forks. Imported and forked nodes get new ids; the tree is rebuilt from
 * parent links, and nodes whose parent is missing (or that form a loop) are
 * left out with their descendants.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { chats, folders, messages, type ChatParams, type MessageMeta } from '../../db/schema';
import { uuidv7 } from '../../lib/ids';
import type { MessageNode, MessagePart } from '../../../../src/types/turn.types';
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  type ClaudiaExport,
  type ExportedChat,
  type ExportedMessage,
  type ImportResponse,
} from '../../../shared/chats';
import { ChatRepo, maskArena, pathTo, toNode, type ChatRow, type FolderRow } from './repo';

type MessageInsert = typeof messages.$inferInsert;

function date(value: string | undefined, fallback: Date): Date {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d : fallback;
}

/** Folder names from the top down to `folderId`. */
function folderPath(byId: Map<string, FolderRow>, folderId: string | null): string[] | null {
  const names: string[] = [];
  const seen = new Set<string>();
  let id = folderId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const f = byId.get(id);
    if (!f) break;
    names.unshift(f.name);
    id = f.parentId;
  }
  return names.length ? names : null;
}

function toExportedMessage(n: MessageNode): ExportedMessage {
  return {
    id: n.id,
    parentId: n.parentId,
    role: n.role,
    parts: n.parts as ExportedMessage['parts'],
    ...(n.modelId ? { modelId: n.modelId } : {}),
    ...(n.usage ? { usage: n.usage as ExportedMessage['usage'] } : {}),
    ...(n.effort ? { effort: n.effort } : {}),
    status: n.status,
    ...(n.error ? { error: n.error } : {}),
    ...(n.rating ? { rating: n.rating } : {}),
    ...(n.models?.length ? { models: n.models } : {}),
    createdAt: n.createdAt,
  };
}

/**
 * Keep only nodes that reach a root through parents in the set, and order
 * them parents first.
 */
export function orderTree<T extends { id: string; parentId: string | null }>(nodes: T[]): { ordered: T[]; skipped: number } {
  const byId = new Map<string, T>();
  for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);
  const children = new Map<string | null, T[]>();
  for (const n of byId.values()) {
    const key = n.parentId && byId.has(n.parentId) ? n.parentId : n.parentId ? `missing:${n.parentId}` : null;
    const list = children.get(key) ?? [];
    list.push(n);
    children.set(key, list);
  }
  const ordered: T[] = [];
  const stack = [...(children.get(null) ?? [])].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    ordered.push(n);
    for (const c of [...(children.get(n.id) ?? [])].reverse()) stack.push(c);
  }
  return { ordered, skipped: nodes.length - ordered.length };
}

export class ChatTransfer {
  private readonly repo: ChatRepo;

  constructor(private readonly db: Database) {
    this.repo = new ChatRepo(db);
  }

  async exportChats(userId: string, chatIds?: string[]): Promise<ClaudiaExport> {
    const rows = chatIds
      ? await Promise.all(chatIds.map((id) => this.repo.getOwned(userId, id)))
      : await this.db
          .select()
          .from(chats)
          .where(and(eq(chats.userId, userId), eq(chats.temporary, false)));
    const folderById = new Map((await this.repo.folders(userId)).map((f) => [f.id, f]));
    const out: ExportedChat[] = [];
    for (const chat of rows) {
      const nodes = maskArena((await this.repo.messages(chat.id)).map(toNode));
      out.push({
        title: chat.title,
        createdAt: chat.createdAt.toISOString(),
        updatedAt: chat.updatedAt.toISOString(),
        modelIds: chat.modelIds,
        params: chat.params,
        tags: chat.tags,
        pinned: chat.pinned,
        archived: chat.archived,
        folder: folderPath(folderById, chat.folderId),
        currentLeafId: chat.currentLeafId,
        messages: nodes.map(toExportedMessage),
      });
    }
    return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date().toISOString(), chats: out };
  }

  /** Find or create the folder chain by name, top down. */
  private async ensureFolder(userId: string, names: string[], cache: Map<string, string>): Promise<string> {
    let parentId: string | null = null;
    let key = '';
    for (const name of names) {
      key += `/${name}`;
      const cached = cache.get(key);
      if (cached) {
        parentId = cached;
        continue;
      }
      const [existing] = await this.db
        .select()
        .from(folders)
        .where(and(eq(folders.userId, userId), eq(folders.name, name), parentId ? eq(folders.parentId, parentId) : isNull(folders.parentId)));
      const id: string = existing?.id ?? uuidv7();
      if (!existing) await this.db.insert(folders).values({ id, userId, name, parentId });
      cache.set(key, id);
      parentId = id;
    }
    return parentId!;
  }

  async importChats(userId: string, input: ExportedChat[]): Promise<ImportResponse> {
    const folderCache = new Map<string, string>();
    const chatIds: string[] = [];
    let skippedMessages = 0;
    const now = new Date();

    for (const chat of input) {
      const { ordered, skipped } = orderTree(chat.messages);
      skippedMessages += skipped;
      const ids = new Map(ordered.map((m) => [m.id, uuidv7()]));
      const folderId = chat.folder?.length ? await this.ensureFolder(userId, chat.folder, folderCache) : null;

      const rows: MessageInsert[] = [];
      const chatId = uuidv7();
      for (const m of ordered) {
        const meta: MessageMeta = m.models?.length ? { models: m.models } : {};
        const created = date(m.createdAt, now);
        rows.push({
          id: ids.get(m.id)!,
          chatId,
          parentId: m.parentId ? ids.get(m.parentId)! : null,
          role: m.role,
          parts: m.parts as MessagePart[],
          modelId: m.modelId ?? null,
          usage: (m.usage as MessageInsert['usage']) ?? null,
          effort: m.effort ?? null,
          // A reply that was still being written when exported is cut off there
          status: m.status === 'streaming' ? 'stopped' : m.status,
          error: m.error ?? null,
          rating: m.rating ?? null,
          meta,
          createdAt: created,
          updatedAt: created,
        });
      }
      const leaf = chat.currentLeafId && ids.has(chat.currentLeafId) ? ids.get(chat.currentLeafId)! : latestLeaf(rows);

      await this.db.transaction(async (tx) => {
        await tx.insert(chats).values({
          id: chatId,
          userId,
          folderId,
          title: chat.title,
          titleSet: true,
          modelIds: chat.modelIds,
          currentLeafId: leaf,
          params: dropNulls(chat.params),
          pinned: chat.pinned,
          archived: chat.archived,
          tags: [...new Set(chat.tags)],
          createdAt: date(chat.createdAt, now),
          updatedAt: date(chat.updatedAt, now),
        });
        // Parents first, in chunks (one statement per few hundred rows)
        for (let i = 0; i < rows.length; i += 200) await tx.insert(messages).values(rows.slice(i, i + 200));
      });
      chatIds.push(chatId);
    }
    return { imported: chatIds.length, chatIds, skippedMessages };
  }

  /** A new chat holding a copy of the path from the first message to `messageId`. */
  async fork(userId: string, source: ChatRow, messageId: string): Promise<ChatRow> {
    const rows = await this.repo.messages(source.id);
    const path = pathTo(rows, messageId);
    const ids = new Map(path.map((n) => [n.id, uuidv7()]));
    const chatId = uuidv7();

    return this.db.transaction(async (tx) => {
      const [chat] = await tx
        .insert(chats)
        .values({
          id: chatId,
          userId,
          folderId: source.folderId,
          title: `${source.title} (fork)`.slice(0, 200),
          titleSet: true,
          modelIds: source.modelIds,
          currentLeafId: ids.get(messageId)!,
          params: source.params,
          tags: source.tags,
        })
        .returning();
      for (const r of path) {
        await tx.insert(messages).values({
          ...r,
          id: ids.get(r.id)!,
          chatId,
          parentId: r.parentId ? ids.get(r.parentId)! : null,
          status: r.status === 'streaming' ? 'stopped' : r.status,
          // Feedback stays with the original
          rating: null,
          feedback: null,
        } as MessageInsert);
      }
      return chat;
    });
  }
}

function dropNulls(params: Record<string, unknown>): ChatParams {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== undefined)) as ChatParams;
}

/** The most recently created node without children. */
function latestLeaf(rows: MessageInsert[]): string | null {
  const parents = new Set(rows.map((r) => r.parentId));
  const leaves = rows.filter((r) => !parents.has(r.id));
  leaves.sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
  return leaves[leaves.length - 1]?.id ?? null;
}

export { dropNulls };
