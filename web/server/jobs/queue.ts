/**
 * Background jobs in the `jobs` table. A worker claims one with
 * FOR UPDATE SKIP LOCKED, so several app instances can share the queue.
 * Enqueueing wakes the workers at once (on PostgreSQL every instance's, by
 * NOTIFY); otherwise they poll.
 * Failed jobs are retried with backoff, then marked failed. Jobs left
 * "running" by a crash are picked up again after STALE_MS.
 */
import { and, eq, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database, DbHandle } from '../db/client';
import { jobs } from '../db/schema';
import { uuidv7 } from '../lib/ids';
import { rowsOf } from '../rag/vector-store';
import { withSpan } from '../telemetry';

export type JobHandler = (payload: Record<string, unknown>, job: { id: string; attempts: number }) => Promise<void>;

const POLL_MS = 2000;
const STALE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3;
const CHANNEL = 'claudia_jobs';

export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = 0;
  private stopped = true;
  private unlisten: (() => Promise<void>) | null = null;

  constructor(
    private readonly deps: {
      db: Database;
      log: FastifyBaseLogger;
      concurrency?: number;
      /** LISTEN/NOTIFY, to wake the other instances' workers. */
      notifier?: Pick<DbHandle, 'listen' | 'notify'>;
    }
  ) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  async enqueue(type: string, payload: Record<string, unknown>, opts: { delayMs?: number } = {}): Promise<string> {
    const id = uuidv7();
    await this.deps.db.insert(jobs).values({
      id,
      type,
      payload,
      ...(opts.delayMs ? { runAfter: new Date(Date.now() + opts.delayMs) } : {}),
    });
    this.wake();
    void this.deps.notifier?.notify?.(CHANNEL).catch(() => {});
    return id;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Jobs a crashed process left running
    void this.deps.db
      .update(jobs)
      .set({ status: 'queued', lockedAt: null })
      .where(and(eq(jobs.status, 'running'), lt(jobs.lockedAt, new Date(Date.now() - STALE_MS))))
      .catch(() => {});
    this.schedule(0);
    void this.deps.notifier
      ?.listen?.(CHANNEL, () => this.wake())
      .then((unlisten) => {
        if (this.stopped) void unlisten().catch(() => {});
        else this.unlisten = unlisten;
      })
      .catch((err) => this.deps.log.warn({ err: String(err) }, 'listening for new jobs failed; polling only'));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.unlisten?.().catch(() => {});
    this.unlisten = null;
    while (this.running > 0) await new Promise((r) => setTimeout(r, 20));
  }

  /** Resolves once nothing is queued or running (tests). */
  async idle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = rowsOf<{ n: number }>(
        await this.deps.db.execute(sql`select count(*)::int as n from ${jobs} where status in ('queued', 'running') and run_after <= now()`)
      );
      if (Number(row?.n ?? 0) === 0 && this.running === 0) return;
      if (Date.now() > deadline) throw new Error('Jobs did not finish in time.');
      this.wake();
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private wake(): void {
    if (!this.stopped) this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    this.timer = null;
    const max = this.deps.concurrency ?? 2;
    while (!this.stopped && this.running < max) {
      const job = await this.claim().catch((err) => {
        this.deps.log.warn({ err: String(err) }, 'claiming a job failed');
        return null;
      });
      if (!job) break;
      this.running++;
      void this.execute(job).finally(() => {
        this.running--;
        this.wake();
      });
    }
    this.schedule(POLL_MS);
  }

  private async claim(): Promise<{ id: string; type: string; payload: Record<string, unknown>; attempts: number } | null> {
    const rows = rowsOf<{ id: string; type: string; payload: Record<string, unknown>; attempts: number }>(
      await this.deps.db.execute(sql`
        update ${jobs} set status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
        where id = (
          select id from ${jobs}
          where status = 'queued' and run_after <= now()
          order by run_after, created_at
          for update skip locked
          limit 1
        )
        returning id, type, payload, attempts`)
    );
    return rows[0] ?? null;
  }

  private async execute(job: { id: string; type: string; payload: Record<string, unknown>; attempts: number }): Promise<void> {
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler for job type "${job.type}"`);
      await withSpan(`job ${job.type}`, { 'claudia.job_id': job.id, 'claudia.job_type': job.type, 'claudia.job_attempt': job.attempts }, () =>
        handler(job.payload, job)
      );
      await this.deps.db.update(jobs).set({ status: 'done', error: null, updatedAt: new Date() }).where(eq(jobs.id, job.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retry = job.attempts < MAX_ATTEMPTS && !(err as { permanent?: boolean }).permanent;
      this.deps.log.warn({ jobId: job.id, type: job.type, attempts: job.attempts, err: message }, retry ? 'job failed; retrying' : 'job failed');
      await this.deps.db
        .update(jobs)
        .set({
          status: retry ? 'queued' : 'failed',
          error: message.slice(0, 2000),
          runAfter: new Date(Date.now() + (retry ? 2000 * 4 ** (job.attempts - 1) : 0)),
          lockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, job.id));
    }
  }
}
