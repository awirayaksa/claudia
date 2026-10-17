/**
 * Share links. A share is a snapshot of the chat's visible path at the time
 * it was (re)shared, readable by anyone with the token. The snapshot keeps
 * only what a reader needs: no internal ids, no file ids, no ratings, and no
 * MCP-UI resources (interactive tool UIs only work for their owner).
 */
import crypto from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { shares, users } from '../../db/schema';
import { notFound } from '../../lib/errors';
import { uuidv7 } from '../../lib/ids';
import type { MessageNode, MessagePart } from '../../../../src/types/turn.types';
import type { SharedChat } from '../../../shared/chats';
import { ChatRepo, pathTo, toNode, type ChatRow, type ShareRow } from '../chats/repo';

function cleanPart(p: MessagePart): MessagePart {
  if (p.type === 'file') return { type: 'file', fileId: '', name: p.name, mime: p.mime, ...(p.size !== undefined ? { size: p.size } : {}) };
  if (p.type === 'tool_result' && p.uiResource) {
    const { uiResource: _ui, ...rest } = p;
    return rest;
  }
  // Citations keep what they show (title, page, link, snippet), not file or chat ids
  if (p.type === 'citation' && p.source.kind !== 'url') {
    const { id: _id, ...source } = p.source;
    return { ...p, source };
  }
  return p;
}

/** The visible path, finished nodes only, renumbered (n1, n2, ...). */
export function snapshotOf(nodes: MessageNode[], leafId: string | null): MessageNode[] {
  const path = pathTo(nodes, leafId).filter((n) => n.status !== 'streaming');
  const ids = new Map(path.map((n, i) => [n.id, `n${i + 1}`]));
  return path.map((n) => ({
    id: ids.get(n.id)!,
    chatId: '',
    parentId: n.parentId ? (ids.get(n.parentId) ?? null) : null,
    role: n.role,
    parts: n.parts.map(cleanPart),
    ...(n.modelId ? { modelId: n.modelId } : {}),
    ...(n.usage ? { usage: n.usage } : {}),
    ...(n.effort ? { effort: n.effort } : {}),
    status: n.status,
    ...(n.error ? { error: n.error } : {}),
    createdAt: n.createdAt,
  }));
}

export class ShareService {
  private readonly repo: ChatRepo;

  constructor(private readonly db: Database) {
    this.repo = new ChatRepo(db);
  }

  async upsert(userId: string, chat: ChatRow): Promise<ShareRow> {
    const nodes = (await this.repo.messages(chat.id)).map(toNode);
    const snapshot = snapshotOf(nodes, chat.currentLeafId);
    const existing = await this.repo.share(chat.id);
    if (existing) {
      const [row] = await this.db
        .update(shares)
        .set({ snapshot, title: chat.title, updatedAt: new Date() })
        .where(eq(shares.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await this.db
      .insert(shares)
      .values({
        id: uuidv7(),
        // 192 bits: the token is the only thing protecting the snapshot
        token: crypto.randomBytes(24).toString('base64url'),
        chatId: chat.id,
        userId,
        title: chat.title,
        snapshot,
      })
      .returning();
    return row;
  }

  async revokeForChat(chatId: string): Promise<void> {
    await this.db.delete(shares).where(eq(shares.chatId, chatId));
  }

  async revoke(userId: string, token: string): Promise<void> {
    const rows = await this.db
      .delete(shares)
      .where(and(eq(shares.token, token), eq(shares.userId, userId)))
      .returning({ id: shares.id });
    if (!rows.length) throw notFound('Share link');
  }

  async listOwned(userId: string): Promise<ShareRow[]> {
    return this.db.select().from(shares).where(eq(shares.userId, userId)).orderBy(desc(shares.updatedAt));
  }

  async read(token: string): Promise<SharedChat | null> {
    const [row] = await this.db
      .select({ share: shares, sharedBy: users.name })
      .from(shares)
      .innerJoin(users, eq(users.id, shares.userId))
      .where(eq(shares.token, token));
    if (!row) return null;
    return {
      title: row.share.title,
      sharedBy: row.sharedBy,
      sharedAt: row.share.updatedAt.toISOString(),
      messages: row.share.snapshot,
    };
  }
}
