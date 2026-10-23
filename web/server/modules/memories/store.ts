/**
 * A user's memories: what the settings page edits, what the model saves
 * with its memory tools, what is learned from chats and imported, and the
 * system message they become.
 *
 * Changes the model makes (`record`) are logged in memory_changes and
 * listed on the reply they belong to, so the user can see and undo them.
 */
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { memories, memoryChanges, messages, type MemorySnapshot } from '../../db/schema';
import { badRequest, notFound } from '../../lib/errors';
import { uuidv7 } from '../../lib/ids';
import {
  MAX_MEMORIES,
  MAX_MEMORY_CHARS,
  type MemoryChangeView,
  type MemorySource,
  type MemoryTopic,
  type MemoryView,
} from '../../../shared/workspace';

/** At most this much memory text goes into a request (newest first). */
const MEMORY_PROMPT_CHARS = 6000;

export type MemoryRow = typeof memories.$inferSelect;

export const toMemoryView = (m: MemoryRow): MemoryView => ({
  id: m.id,
  content: m.content,
  topic: m.topic,
  source: m.source,
  folderId: m.folderId,
  chatId: m.chatId,
  createdAt: m.createdAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
});

const TOPIC_TITLES: Record<MemoryTopic, string> = {
  about: 'About them',
  work: 'Work',
  preferences: 'Preferences',
  projects: 'Projects',
  people: 'People',
  other: 'Other',
};

const snapshot = (m: MemoryRow): MemorySnapshot => ({
  content: m.content,
  topic: m.topic,
  source: m.source,
  folderId: m.folderId,
  chatId: m.chatId,
});

/** Where a change by the model came from: the reply its chip goes under. */
export interface ChangeOrigin {
  messageId: string;
}

export class MemoryStore {
  constructor(
    private readonly db: Database,
    /** Called after a memory's text changes (to embed it again). */
    private readonly onChanged: (memoryId: string) => Promise<void> = async () => {}
  ) {}

  async list(userId: string): Promise<MemoryRow[]> {
    return this.db.select().from(memories).where(eq(memories.userId, userId)).orderBy(desc(memories.updatedAt));
  }

  /** The memories a chat in these folders sees: the global ones and the folders' own. */
  async forChat(userId: string, folderIds: string[]): Promise<MemoryRow[]> {
    const scope = folderIds.length ? or(isNull(memories.folderId), inArray(memories.folderId, folderIds)) : isNull(memories.folderId);
    return this.db
      .select()
      .from(memories)
      .where(and(eq(memories.userId, userId), scope))
      .orderBy(desc(memories.updatedAt))
      .limit(MAX_MEMORIES);
  }

  async get(userId: string, id: string): Promise<MemoryRow> {
    const [row] = await this.db.select().from(memories).where(and(eq(memories.id, id), eq(memories.userId, userId)));
    if (!row) throw notFound('Memory');
    return row;
  }

  async add(
    userId: string,
    input: { content: string; topic?: MemoryTopic; source?: MemorySource; folderId?: string | null; chatId?: string | null },
    record?: ChangeOrigin
  ): Promise<{ memory: MemoryRow; change: MemoryChangeView | null }> {
    const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(memories).where(eq(memories.userId, userId));
    if (Number(n) >= MAX_MEMORIES) throw badRequest(`You can keep at most ${MAX_MEMORIES} memories.`, 'too_many_memories');
    const [memory] = await this.db
      .insert(memories)
      .values({
        id: uuidv7(),
        userId,
        content: input.content.trim().slice(0, MAX_MEMORY_CHARS),
        topic: input.topic ?? 'other',
        source: input.source ?? 'user',
        folderId: input.folderId ?? null,
        chatId: input.chatId ?? null,
      })
      .returning();
    await this.onChanged(memory.id);
    const change = record ? await this.log(userId, 'add', memory.id, null, snapshot(memory), record) : null;
    return { memory, change };
  }

  async update(
    userId: string,
    id: string,
    patch: { content?: string; topic?: MemoryTopic; folderId?: string | null },
    record?: ChangeOrigin
  ): Promise<{ memory: MemoryRow; change: MemoryChangeView | null }> {
    const before = await this.get(userId, id);
    const [memory] = await this.db
      .update(memories)
      .set({
        ...(patch.content !== undefined ? { content: patch.content.trim().slice(0, MAX_MEMORY_CHARS) } : {}),
        ...(patch.topic ? { topic: patch.topic } : {}),
        ...(patch.folderId !== undefined ? { folderId: patch.folderId } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(memories.id, id), eq(memories.userId, userId)))
      .returning();
    if (patch.content !== undefined && patch.content !== before.content) await this.onChanged(memory.id);
    const change = record ? await this.log(userId, 'update', id, snapshot(before), snapshot(memory), record) : null;
    return { memory, change };
  }

  async remove(userId: string, id: string, record?: ChangeOrigin): Promise<{ change: MemoryChangeView | null }> {
    const before = await this.get(userId, id);
    await this.db.delete(memories).where(and(eq(memories.id, id), eq(memories.userId, userId)));
    const change = record ? await this.log(userId, 'delete', id, snapshot(before), null, record) : null;
    return { change };
  }

  async clear(userId: string): Promise<void> {
    await this.db.delete(memories).where(eq(memories.userId, userId));
  }

  /** Put a memory back as it was before a change the model made. */
  async undo(userId: string, changeId: string): Promise<MemoryChangeView> {
    const [change] = await this.db
      .select()
      .from(memoryChanges)
      .where(and(eq(memoryChanges.id, changeId), eq(memoryChanges.userId, userId)));
    if (!change) throw notFound('Memory change');
    if (change.undoneAt) return this.changeView(change, true);

    const [current] = await this.db.select().from(memories).where(and(eq(memories.id, change.memoryId), eq(memories.userId, userId)));
    if (change.action === 'add') {
      if (current) await this.db.delete(memories).where(eq(memories.id, current.id));
    } else if (change.before) {
      if (current) {
        await this.db
          .update(memories)
          .set({ content: change.before.content, topic: change.before.topic, folderId: change.before.folderId, updatedAt: new Date() })
          .where(eq(memories.id, current.id));
      } else {
        await this.db.insert(memories).values({ id: change.memoryId, userId, ...change.before });
      }
      await this.onChanged(change.memoryId);
    }
    await this.db.update(memoryChanges).set({ undoneAt: new Date() }).where(eq(memoryChanges.id, change.id));
    if (change.messageId) await this.markUndone(change.messageId, change.id);
    return this.changeView(change, true);
  }

  /**
   * The system message with the memories a chat sees, grouped by topic, or
   * null when there are none. `pick` may narrow them down (the ones closest
   * to the message, when there are many); null keeps all, newest first.
   * `withIds` lists their ids, for the memory tools.
   */
  async prompt(
    userId: string,
    opts: { folderIds?: string[]; pick?: (totalChars: number) => Promise<string[] | null>; withIds?: boolean } = {}
  ): Promise<string | null> {
    let rows = await this.forChat(userId, opts.folderIds ?? []);
    const picked = rows.length > 0 && opts.pick ? await opts.pick(rows.reduce((n, r) => n + r.content.length, 0)) : null;
    if (picked) {
      // The search covers all the user's memories; keep the ones this chat may see
      const wanted = new Set(picked);
      const kept = rows.filter((r) => wanted.has(r.content));
      if (kept.length > 0) rows = kept;
    }
    const byTopic = new Map<MemoryTopic, string[]>();
    let used = 0;
    for (const r of rows) {
      if (used + r.content.length > MEMORY_PROMPT_CHARS) break;
      const line = `- ${opts.withIds ? `[${r.id}] ` : ''}${r.content.replace(/\s+/g, ' ')}${r.folderId ? ' (this project)' : ''}`;
      byTopic.set(r.topic, [...(byTopic.get(r.topic) ?? []), line]);
      used += r.content.length;
    }
    if (byTopic.size === 0) return null;
    const sections = (Object.keys(TOPIC_TITLES) as MemoryTopic[])
      .filter((t) => byTopic.has(t))
      .map((t) => `${TOPIC_TITLES[t]}:\n${byTopic.get(t)!.join('\n')}`);
    return (
      "What you remember about the user from earlier chats. Use it when relevant; don't mention this list unless asked.\n\n" +
      sections.join('\n\n')
    );
  }

  private async log(
    userId: string,
    action: 'add' | 'update' | 'delete',
    memoryId: string,
    before: MemorySnapshot | null,
    after: MemorySnapshot | null,
    origin: ChangeOrigin
  ): Promise<MemoryChangeView> {
    const [row] = await this.db
      .insert(memoryChanges)
      .values({ id: uuidv7(), userId, memoryId, action, before, after, messageId: origin.messageId })
      .returning();
    const view = this.changeView(row, false);
    await this.db
      .update(messages)
      .set({
        meta: sql`jsonb_set(${messages.meta}, '{memoryChanges}', coalesce(${messages.meta}->'memoryChanges', '[]'::jsonb) || ${JSON.stringify([view])}::jsonb)`,
      })
      .where(eq(messages.id, origin.messageId));
    return view;
  }

  private changeView(row: typeof memoryChanges.$inferSelect, undone: boolean): MemoryChangeView {
    const shown = row.after ?? row.before!;
    return { id: row.id, action: row.action, memoryId: row.memoryId, topic: shown.topic, content: shown.content, undone };
  }

  private async markUndone(messageId: string, changeId: string): Promise<void> {
    const [row] = await this.db.select({ meta: messages.meta }).from(messages).where(eq(messages.id, messageId));
    if (!row?.meta.memoryChanges) return;
    const memoryChanges = row.meta.memoryChanges.map((c) => (c.id === changeId ? { ...c, undone: true } : c));
    await this.db
      .update(messages)
      .set({ meta: sql`${messages.meta} || ${JSON.stringify({ memoryChanges })}::jsonb` })
      .where(eq(messages.id, messageId));
  }
}
