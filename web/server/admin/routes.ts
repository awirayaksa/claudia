import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireAdmin, requireUser } from '../auth/rbac';
import { webhooks } from '../db/schema';
import { notFound } from '../lib/errors';
import { uuidv7 } from '../lib/ids';
import { parsePatch } from '../lib/validation';
import { AnalyticsQuery, WebhookInput, activeBanners, type AuditEntry, type WebhookWithSecret } from '../../shared/admin';
import { newWebhookSecret, toWebhookView } from './webhooks';
import { usageAnalytics } from './analytics';

const IdParams = z.object({ id: z.uuid() });

/** RFC 4180 field, and no spreadsheet formulas from user-controlled text. */
function csvField(value: unknown): string {
  let s = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCsv = (header: string[], rows: unknown[][]) =>
  [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';

/** /api/admin/audit, /api/admin/analytics, /api/admin/webhooks */
export async function adminOpsRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  // ─── Audit log ─────────────────────────────────────────────────────────────
  app.get('/audit', async (req) => ctx.audit.list(req.query));

  app.get('/audit/export.csv', async (req, reply) => {
    const rows: AuditEntry[] = [];
    let before: string | undefined;
    // At most 50,000 entries per export
    for (let i = 0; i < 100; i++) {
      const page = await ctx.audit.list({ ...(req.query as object), limit: 500, ...(before ? { before } : {}) });
      rows.push(...page.entries);
      if (!page.next) break;
      before = page.next;
    }
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="claudia-audit.csv"');
    return toCsv(
      ['time', 'actor', 'action', 'route', 'target_type', 'target_id', 'status', 'ip', 'details'],
      rows.map((e) => [e.createdAt, e.actorEmail, e.action, e.route, e.targetType, e.targetId, e.status, e.ip, e.details])
    );
  });

  // ─── Analytics ─────────────────────────────────────────────────────────────
  app.get('/analytics', async (req) => usageAnalytics(ctx.db, AnalyticsQuery.parse(req.query).days));

  app.get('/analytics/export.csv', async (req, reply) => {
    const data = await usageAnalytics(ctx.db, AnalyticsQuery.parse(req.query).days);
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="claudia-usage.csv"');
    return toCsv(
      ['day', 'requests', 'prompt_tokens', 'completion_tokens', 'cost', 'active_users'],
      data.byDay.map((d) => [d.day, d.requests, d.promptTokens, d.completionTokens, d.cost, d.activeUsers])
    );
  });

  // ─── Webhooks ──────────────────────────────────────────────────────────────
  app.get('/webhooks', async () => ({ webhooks: await ctx.webhooks.list() }));

  app.post('/webhooks', async (req, reply): Promise<WebhookWithSecret> => {
    const body = WebhookInput.parse(req.body);
    const secret = newWebhookSecret();
    const [row] = await ctx.db
      .insert(webhooks)
      .values({ id: uuidv7(), name: body.name, url: body.url, events: [...new Set(body.events)], enabled: body.enabled, secretCipher: ctx.secrets.encrypt(secret) })
      .returning();
    reply.code(201);
    return { webhook: toWebhookView(row), secret };
  });

  app.patch('/webhooks/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = parsePatch(WebhookInput, req.body);
    const [row] = await ctx.db
      .update(webhooks)
      .set({ ...body, ...(body.events ? { events: [...new Set(body.events)] } : {}), updatedAt: new Date() })
      .where(eq(webhooks.id, id))
      .returning();
    if (!row) throw notFound('Webhook');
    return { webhook: toWebhookView(row) };
  });

  app.post('/webhooks/:id/rotate-secret', async (req): Promise<WebhookWithSecret> => {
    const { id } = IdParams.parse(req.params);
    const secret = newWebhookSecret();
    const [row] = await ctx.db
      .update(webhooks)
      .set({ secretCipher: ctx.secrets.encrypt(secret), updatedAt: new Date() })
      .where(eq(webhooks.id, id))
      .returning();
    if (!row) throw notFound('Webhook');
    return { webhook: toWebhookView(row), secret };
  });

  app.post('/webhooks/:id/test', async (req) => {
    const { id } = IdParams.parse(req.params);
    const [row] = await ctx.db.select({ id: webhooks.id }).from(webhooks).where(eq(webhooks.id, id));
    if (!row) throw notFound('Webhook');
    return { result: await ctx.webhooks.test(id) };
  });

  app.delete('/webhooks/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const deleted = await ctx.db.delete(webhooks).where(eq(webhooks.id, id)).returning({ id: webhooks.id });
    if (deleted.length === 0) throw notFound('Webhook');
    return { ok: true };
  });
}

/** /api/banners — what to show signed-in users now. */
export async function bannerRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);
  app.get('/', async () => ({ banners: activeBanners((await ctx.settings.get('ui.banners')).items) }));
}
