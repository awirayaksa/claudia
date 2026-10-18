/**
 * The audit log. Sign-ins (and failed ones), sign-outs, sign-ups and API
 * keys are recorded where they happen; every successful change through
 * /api/admin is recorded by a hook, with the route, its parameters and the
 * request body minus anything secret. Recording never fails a request.
 * Entries older than `audit.retentionDays` are removed daily.
 */
import { and, desc, eq, gte, ilike, lt, lte, sql } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../db/client';
import { auditLog } from '../db/schema';
import { uuidv7 } from '../lib/ids';
import type { AppSettings } from '../modules/settings/app-settings';
import { AuditQuery, type AuditAction, type AuditEntry, type AuditPage } from '../../shared/admin';
import type { Webhooks } from './webhooks';

const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|apikey|authorization|auth[-_]?value|cipher|credential|private/i;
const MAX_STRING = 500;
const MAX_ITEMS = 50;
const MAX_DEPTH = 4;

/** A copy that is safe to keep: secrets replaced, long text cut, depth and size bounded. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Buffer.isBuffer(value)) return `[${value.length} bytes]`;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS)) {
      // An empty value means "unchanged" or "cleared": keep that visible
      out[k] = SECRET_KEY.test(k) && v !== '' && v !== null && v !== undefined ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface AuditInput {
  action: AuditAction;
  actor?: { id: string; email: string } | null;
  route?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
  status?: number | null;
  requestId?: string | null;
}

type AuditRow = typeof auditLog.$inferSelect;

const toEntry = (r: AuditRow): AuditEntry => ({
  id: r.id,
  createdAt: r.createdAt.toISOString(),
  actorId: r.actorId,
  actorEmail: r.actorEmail,
  action: r.action,
  route: r.route,
  targetType: r.targetType,
  targetId: r.targetId,
  details: r.details,
  ip: r.ip,
  status: r.status,
});

export class AuditLog {
  private sweeper: NodeJS.Timeout;

  constructor(
    private readonly deps: { db: Database; settings: AppSettings; log: FastifyBaseLogger; webhooks?: Webhooks }
  ) {
    this.sweeper = setInterval(() => void this.purge().catch(() => {}), 24 * 60 * 60 * 1000);
    this.sweeper.unref();
  }

  close(): void {
    clearInterval(this.sweeper);
  }

  async record(input: AuditInput): Promise<void> {
    try {
      const [row] = await this.deps.db
        .insert(auditLog)
        .values({
          id: uuidv7(),
          actorId: input.actor?.id ?? null,
          actorEmail: input.actor?.email ?? null,
          action: input.action,
          route: input.route ?? null,
          targetType: input.targetType ?? null,
          targetId: input.targetId ?? null,
          details: (redact(input.details ?? {}) as Record<string, unknown>) ?? {},
          ip: input.ip ?? null,
          status: input.status ?? null,
          requestId: input.requestId ?? null,
        })
        .returning();
      void this.deps.webhooks?.emit('audit.recorded', { entry: toEntry(row) });
    } catch (err) {
      this.deps.log.warn({ err: String(err), action: input.action }, 'writing the audit log failed');
    }
  }

  /** Record `action` for this request: its user (or `actor`), IP and request id. */
  fromRequest(req: FastifyRequest, action: AuditAction, extra: Omit<AuditInput, 'action' | 'ip' | 'requestId'> = {}): Promise<void> {
    const actor = extra.actor !== undefined ? extra.actor : req.user ? { id: req.user.id, email: req.user.email } : null;
    return this.record({ ...extra, action, actor, ip: req.ip, requestId: String(req.id) });
  }

  async list(raw: unknown): Promise<AuditPage> {
    const q = AuditQuery.parse(raw);
    const conds = [
      q.action ? (q.action.endsWith('*') ? ilike(auditLog.action, `${q.action.slice(0, -1)}%`) : eq(auditLog.action, q.action)) : undefined,
      q.actor ? ilike(auditLog.actorEmail, `%${q.actor.replace(/[%_\\]/g, (c) => `\\${c}`)}%`) : undefined,
      q.from ? gte(auditLog.createdAt, new Date(q.from)) : undefined,
      q.to ? lte(auditLog.createdAt, new Date(q.to)) : undefined,
      // uuidv7 ids sort by time
      q.before ? lt(auditLog.id, q.before) : undefined,
    ];
    const rows = await this.deps.db
      .select()
      .from(auditLog)
      .where(and(...conds))
      .orderBy(desc(auditLog.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return { entries: page.map(toEntry), next: rows.length > q.limit ? page.at(-1)!.id : null };
  }

  /** Remove entries past the retention period. */
  async purge(now = new Date()): Promise<number> {
    const { retentionDays } = await this.deps.settings.get('audit');
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const deleted = await this.deps.db.delete(auditLog).where(lt(auditLog.createdAt, cutoff)).returning({ id: auditLog.id });
    return deleted.length;
  }

  async count(): Promise<number> {
    const [row] = await this.deps.db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
    return Number(row?.n ?? 0);
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Every successful change through /api/admin goes in the log, by route:
 * "PATCH /api/admin/users/:id" with { params, body }.
 */
export function registerAdminAudit(app: FastifyInstance, audit: AuditLog): void {
  app.addHook('onResponse', async (req, reply) => {
    if (!MUTATING.has(req.method) || !req.url.startsWith('/api/admin/')) return;
    if (reply.statusCode >= 400 || !req.user) return;
    const route = `${req.method} ${req.routeOptions.url ?? req.url.split('?')[0]}`;
    const params = (req.params ?? {}) as Record<string, string>;
    // Uploads (multipart) aren't logged byte for byte
    const body = req.isMultipart() ? { upload: true } : req.body;
    const segment = (req.routeOptions.url ?? '').split('/')[3] ?? null;
    await audit.fromRequest(req, 'admin.request', {
      route,
      targetType: segment,
      targetId: params.id ?? params.key ?? null,
      details: { params, ...(body !== undefined ? { body } : {}) },
      status: reply.statusCode,
    });
  });
}
