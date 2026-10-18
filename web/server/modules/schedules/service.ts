/**
 * Scheduled prompts: a prompt sent to a model on a cron schedule in the
 * user's time zone, as if they had typed it; the reply lands in a new chat
 * (or the next turn of one chat). Every instance checks for due schedules
 * each 30 s and claims them with FOR UPDATE SKIP LOCKED, moving
 * next_run_at forward in the same transaction, so each run happens once.
 * A run is skipped (and reported) when the owner can no longer use the
 * feature, the model or the app.
 */
import { Cron } from 'croner';
import { and, asc, eq, lte } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { ServerContext } from '../../context';
import { chats, schedules, users } from '../../db/schema';
import { badRequest } from '../../lib/errors';
import { uuidv7 } from '../../lib/ids';
import type { AuthUser } from '../../auth/sessions';
import { CompletionRequest } from '../../../shared/chats';
import { MIN_SCHEDULE_INTERVAL_MS, type ScheduleView } from '../../../shared/schedules';

type ScheduleRow = typeof schedules.$inferSelect;

const TICK_MS = 30_000;
const BATCH = 10;

/** When `cron` next fires after `from` in `timezone`; throws a 400 for a bad schedule. */
export function nextRun(cron: string, timezone: string, from = new Date()): Date | null {
  if (cron.trim().split(/\s+/).length !== 5) throw badRequest('Use five fields: minute hour day-of-month month day-of-week.', 'invalid_cron');
  let job: Cron;
  try {
    job = new Cron(cron, { timezone, paused: true });
  } catch (err) {
    throw badRequest(`That schedule isn't valid: ${err instanceof Error ? err.message : String(err)}`, 'invalid_cron');
  }
  return job.nextRun(from);
}

/** Refuse schedules that fire more often than MIN_SCHEDULE_INTERVAL_MS. */
export function checkInterval(cron: string, timezone: string, from = new Date()): void {
  const runs = new Cron(cron, { timezone, paused: true }).nextRuns(6, from);
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].getTime() - runs[i - 1].getTime() < MIN_SCHEDULE_INTERVAL_MS) {
      throw badRequest(`A schedule can run at most every ${MIN_SCHEDULE_INTERVAL_MS / 60_000} minutes.`, 'cron_too_often');
    }
  }
}

export function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function toScheduleView(r: ScheduleRow): ScheduleView {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    modelId: r.modelId,
    cron: r.cron,
    timezone: r.timezone,
    chatMode: r.chatMode,
    toolIds: r.toolIds,
    webSearch: r.webSearch,
    enabled: r.enabled,
    nextRunAt: r.nextRunAt?.toISOString() ?? null,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    lastStatus: r.lastStatus,
    lastError: r.lastError,
    lastChatId: r.lastChatId,
  };
}

export class ScheduleRunner {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly ctx: ServerContext, private readonly log: FastifyBaseLogger) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run every due schedule once (also used by tests). */
  async tick(now = new Date()): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const due = await this.claim(now);
      for (const row of due) await this.runOne(row).catch((err) => this.log.warn({ err: String(err), scheduleId: row.id }, 'scheduled prompt failed'));
      return due.length;
    } finally {
      this.busy = false;
    }
  }

  /** Due schedules, with next_run_at already moved on (several instances never take the same one). */
  private async claim(now: Date): Promise<ScheduleRow[]> {
    return this.ctx.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schedules)
        .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, now)))
        .orderBy(asc(schedules.nextRunAt))
        .limit(BATCH)
        .for('update', { skipLocked: true });
      for (const r of rows) {
        let next: Date | null = null;
        try {
          next = nextRun(r.cron, r.timezone, now);
        } catch {
          next = null;
        }
        await tx.update(schedules).set({ nextRunAt: next, lastRunAt: now, updatedAt: now }).where(eq(schedules.id, r.id));
      }
      return rows;
    });
  }

  /** Send the prompt as its owner; records how it went. */
  async runOne(row: ScheduleRow): Promise<{ chatId: string; runId: string } | null> {
    const { ctx } = this;
    const record = (patch: Partial<typeof schedules.$inferInsert>) =>
      ctx.db.update(schedules).set({ ...patch, updatedAt: new Date() }).where(eq(schedules.id, row.id));

    const [owner] = await ctx.db.select().from(users).where(eq(users.id, row.ownerId));
    const skip = async (why: string) => {
      await record({ lastRunAt: new Date(), lastStatus: 'skipped', lastError: why });
      return null;
    };
    if (!owner || owner.deactivatedAt || owner.role === 'pending') return skip('The account is not active.');
    if (!(await ctx.access.can(owner, 'features.schedules'))) return skip('Scheduled prompts are not allowed for this account.');
    const user: AuthUser = { id: owner.id, email: owner.email, name: owner.name, role: owner.role, sessionId: `schedule:${row.id}`, hasPassword: !!owner.passwordHash };

    // Where the reply goes
    let chatId = row.chatMode === 'same' ? row.chatId : null;
    let parentId: string | null = null;
    if (chatId) {
      const [chat] = await ctx.db.select().from(chats).where(and(eq(chats.id, chatId), eq(chats.userId, owner.id)));
      if (chat) parentId = chat.currentLeafId;
      else chatId = null;
    }
    if (!chatId) {
      const stamp = new Intl.DateTimeFormat('en-GB', { timeZone: row.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
      const [chat] = await ctx.db
        .insert(chats)
        .values({ id: uuidv7(), userId: owner.id, title: row.chatMode === 'same' ? row.name : `${row.name} · ${stamp}`, titleSet: true, modelIds: [row.modelId] })
        .returning();
      chatId = chat.id;
      if (row.chatMode === 'same') await record({ chatId });
    }

    try {
      const req = CompletionRequest.parse({
        parentId,
        content: row.prompt,
        modelIds: [row.modelId],
        toolIds: row.toolIds,
        features: row.webSearch ? { webSearch: true } : {},
      });
      const { runId } = await ctx.orchestrator.start(user, chatId, req);
      await record({ lastRunAt: new Date(), lastStatus: 'started', lastError: null, lastChatId: chatId });
      // The outcome, when the reply is done
      const unsubscribe = await ctx.runs.subscribe({ id: runId }, 0, (e) => {
        if (e.event.type !== 'run.completed') return;
        void record({ lastStatus: e.event.status, ...(e.event.status === 'error' ? { lastError: 'The model reply failed.' } : {}) }).catch(() => {});
        queueMicrotask(() => unsubscribe());
      });
      return { chatId, runId };
    } catch (err) {
      await record({ lastStatus: 'error', lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500), lastChatId: chatId });
      return null;
    }
  }
}

