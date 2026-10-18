/**
 * Admin webhooks. `emit` queues one delivery job per subscribed webhook, so
 * a slow receiver never holds up a request and failures are retried by the
 * jobs queue (three attempts with backoff; a 4xx other than 408/429 is not
 * retried). Each delivery is a JSON POST signed like this:
 *
 *   X-Claudia-Timestamp: <unix seconds>
 *   X-Claudia-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
 *
 * Receivers recompute the HMAC over the raw body, compare in constant time
 * and reject timestamps more than five minutes away (replays).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db/client';
import { webhooks } from '../db/schema';
import type { SecretBox } from '../crypto/secrets';
import type { JobQueue } from '../jobs/queue';
import { uuidv7 } from '../lib/ids';
import { WEBHOOK_HEADERS, type WebhookEvent, type WebhookPayload, type WebhookTestResult, type WebhookView } from '../../shared/admin';

export const WEBHOOK_TIMEOUT_MS = 10_000;
/** Receivers should refuse deliveries signed longer ago than this. */
export const SIGNATURE_TOLERANCE_S = 300;

type WebhookRow = typeof webhooks.$inferSelect;

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/**
 * Check a delivery the way a receiver should: the signature over the raw
 * body, and a timestamp within `toleranceS` of `now`.
 */
export function verifyWebhook(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  opts: { toleranceS?: number; now?: number } = {}
): boolean {
  const header = (name: string) => {
    const v = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const timestamp = Number(header(WEBHOOK_HEADERS.timestamp));
  const signature = header(WEBHOOK_HEADERS.signature) ?? '';
  if (!Number.isInteger(timestamp)) return false;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(now - timestamp) > (opts.toleranceS ?? SIGNATURE_TOLERANCE_S)) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody));
  // Several signatures may be sent (e.g. while a secret rotates): any may match
  return signature
    .split(',')
    .map((s) => Buffer.from(s.trim()))
    .some((given) => given.length === expected.length && timingSafeEqual(given, expected));
}

export function toWebhookView(row: WebhookRow): WebhookView {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: row.events,
    enabled: row.enabled,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const DeliveryJob = z.object({ webhookId: z.uuid(), body: z.string(), event: z.string(), deliveryId: z.string() });

class DeliveryError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean
  ) {
    super(message);
  }
}

export class Webhooks {
  constructor(
    private readonly deps: {
      db: Database;
      secrets: SecretBox;
      jobs: JobQueue;
      log: FastifyBaseLogger;
      /** Test hook: the clock, in ms. */
      now?: () => number;
    }
  ) {
    deps.jobs.register('webhook.deliver', (p) => this.deliverJob(p));
  }

  async list(): Promise<WebhookView[]> {
    return (await this.deps.db.select().from(webhooks).orderBy(desc(webhooks.createdAt))).map(toWebhookView);
  }

  /** Queue `event` for every enabled webhook that wants it. Never throws. */
  async emit(event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
    try {
      const rows = await this.deps.db.select().from(webhooks).where(eq(webhooks.enabled, true));
      const targets = rows.filter((w) => w.events.includes('*') || w.events.includes(event));
      for (const w of targets) {
        const payload = this.payload(event, data);
        await this.deps.jobs.enqueue('webhook.deliver', { webhookId: w.id, event, deliveryId: payload.id, body: JSON.stringify(payload) });
      }
    } catch (err) {
      this.deps.log.warn({ err: String(err), event }, 'queueing webhooks failed');
    }
  }

  /** Deliver a test event now and report how it went. */
  async test(id: string): Promise<WebhookTestResult> {
    const [row] = await this.deps.db.select().from(webhooks).where(eq(webhooks.id, id));
    if (!row) throw new Error('No such webhook');
    const payload = this.payload('webhook.test', { webhookId: id, message: 'This is a test delivery from Claudia.' });
    const started = Date.now();
    try {
      const status = await this.send(row, 'webhook.test', payload.id, JSON.stringify(payload));
      return { ok: true, status, error: null, durationMs: Date.now() - started };
    } catch (err) {
      const status = Number((err as { status?: number }).status) || null;
      return { ok: false, status, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started };
    }
  }

  private payload(event: WebhookEvent, data: Record<string, unknown>): WebhookPayload {
    return { id: uuidv7(), event, createdAt: new Date(this.now()).toISOString(), data };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async deliverJob(raw: Record<string, unknown>): Promise<void> {
    const job = DeliveryJob.parse(raw);
    const [row] = await this.deps.db.select().from(webhooks).where(eq(webhooks.id, job.webhookId));
    // Deleted or turned off since: drop it
    if (!row || !row.enabled) return;
    await this.send(row, job.event, job.deliveryId, job.body);
  }

  /** POST one signed delivery; records the outcome on the webhook. Throws on failure. */
  private async send(row: WebhookRow, event: string, deliveryId: string, body: string): Promise<number> {
    const secret = this.deps.secrets.decrypt(row.secretCipher);
    const timestamp = Math.floor(this.now() / 1000);
    let status: number | null = null;
    try {
      const res = await fetch(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Claudia-Webhooks/1',
          [WEBHOOK_HEADERS.event]: event,
          [WEBHOOK_HEADERS.delivery]: deliveryId,
          [WEBHOOK_HEADERS.timestamp]: String(timestamp),
          [WEBHOOK_HEADERS.signature]: signWebhook(secret, timestamp, body),
        },
        body,
        // A redirect would resend the signed body somewhere else
        redirect: 'manual',
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      status = res.status;
      await res.body?.cancel().catch(() => {});
      if (res.status < 200 || res.status >= 300) {
        const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
        throw Object.assign(new DeliveryError(`The receiver answered ${res.status}.`, !retryable), { status: res.status });
      }
      await this.record(row.id, status, null);
      return status;
    } catch (err) {
      const message =
        err instanceof DeliveryError
          ? err.message
          : (err as Error).name === 'TimeoutError'
            ? `No answer within ${WEBHOOK_TIMEOUT_MS / 1000} s.`
            : `Could not reach the receiver: ${err instanceof Error ? err.message : String(err)}`;
      await this.record(row.id, status, message);
      throw err instanceof DeliveryError ? err : Object.assign(new Error(message), { status });
    }
  }

  private async record(id: string, status: number | null, error: string | null): Promise<void> {
    await this.deps.db
      .update(webhooks)
      .set({ lastStatus: status, lastError: error, lastDeliveryAt: new Date(this.now()) })
      .where(eq(webhooks.id, id))
      .catch(() => {});
  }
}
