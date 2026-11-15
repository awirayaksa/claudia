/**
 * Replies left `streaming` by a run that no longer exists (the instance that
 * ran it restarted or died) are marked as failed, so the chat stops showing
 * them as in progress and they can be regenerated. Long agent tasks make
 * this likely. A reply is only touched when no live run is left for its chat
 * on any instance (the run hub knows them through Redis), and it has not
 * been written for a while.
 */
import { and, eq, inArray, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client';
import { messages } from '../db/schema';
import type { RunHub } from './run-hub';

const SWEEP_MS = 5 * 60_000;
/** A reply untouched this long, with no live run for its chat, is stale. */
export const STALE_AFTER_MS = 10 * 60_000;
export const STALE_MESSAGE = 'This reply stopped when the server restarted. Regenerate it, or ask to carry on.';

export class StaleReplySweep {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: { db: Database; runs: RunHub; log: FastifyBaseLogger }) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep().catch((err) => this.deps.log.warn({ err: String(err) }, 'stale reply sweep failed')), SWEEP_MS);
    this.timer.unref();
    // Once at startup too: this instance may be the one that restarted
    void this.sweep().catch((err) => this.deps.log.warn({ err: String(err) }, 'stale reply sweep failed'));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Mark stale replies as failed; returns how many. */
  async sweep(now = new Date()): Promise<number> {
    const { db, runs } = this.deps;
    const rows = await db
      .select({ id: messages.id, chatId: messages.chatId })
      .from(messages)
      .where(and(eq(messages.status, 'streaming'), lt(messages.updatedAt, new Date(now.getTime() - STALE_AFTER_MS))))
      .limit(500);
    if (rows.length === 0) return 0;
    const live = new Map<string, boolean>();
    const stale: string[] = [];
    for (const r of rows) {
      if (!live.has(r.chatId)) live.set(r.chatId, (await runs.activeForChat(r.chatId)).length > 0);
      if (!live.get(r.chatId)) stale.push(r.id);
    }
    if (stale.length === 0) return 0;
    await db
      .update(messages)
      .set({ status: 'error', error: STALE_MESSAGE, updatedAt: now })
      .where(and(inArray(messages.id, stale), eq(messages.status, 'streaming')));
    this.deps.log.info({ count: stale.length }, 'marked stale replies as failed');
    return stale.length;
  }
}
