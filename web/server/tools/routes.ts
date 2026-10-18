/**
 * /api/admin/tool-servers — OpenAPI tool servers. The spec is loaded from a
 * URL or pasted; its operations become tools for everyone (users switch the
 * server off under Settings → Tools like any shared server). The admin's
 * endpoints, so not put through the SSRF guard (like admin MCP servers).
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { toolServers } from '../db/schema';
import { badRequest, notFound } from '../lib/errors';
import { uuidv7 } from '../lib/ids';
import { requireAdmin } from '../auth/rbac';
import { baseUrlOf, OpenApiError, operationsOf, parseSpec } from './openapi';

const Input = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(500).nullable().default(null),
    specUrl: z.url().nullable().default(null),
    /** A pasted spec (JSON or YAML), instead of a URL. */
    specText: z.string().max(5_000_000).optional(),
    /** Overrides the spec's server address. */
    baseUrl: z.string().trim().max(500).default(''),
    authHeader: z.string().trim().max(100).optional(),
    /** Omitted on update = keep; '' = remove. */
    authValue: z.string().max(10_000).optional(),
    enabled: z.boolean().default(true),
  })
  .refine((v) => v.specUrl || v.specText, { message: 'Give the spec URL or paste the spec.' });

type Row = typeof toolServers.$inferSelect;

export async function adminToolServerRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  const view = (r: Row) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    specUrl: r.specUrl,
    baseUrl: r.baseUrl,
    enabled: r.enabled,
    hasAuth: !!r.authCipher,
    authHeader: r.authCipher ? (JSON.parse(ctx.secrets.decrypt(r.authCipher)) as { header: string }).header : null,
    operations: r.operations.map((o) => ({ name: o.name, method: o.method, path: o.path, description: o.description })),
  });

  /** Load and read the spec; returns the operations and base URL. */
  const load = async (input: { specUrl: string | null; specText?: string; baseUrl: string }) => {
    let text = input.specText;
    if (!text && input.specUrl) {
      const res = await fetch(input.specUrl, { headers: { Accept: 'application/json, application/yaml, text/yaml, */*' }, signal: AbortSignal.timeout(20_000) }).catch(
        (err: Error) => {
          throw badRequest(`Couldn't load the spec: ${err.message}`, 'spec_unreachable');
        }
      );
      if (!res.ok) throw badRequest(`Couldn't load the spec (${res.status}).`, 'spec_unreachable');
      text = await res.text();
    }
    try {
      const spec = parseSpec(text ?? '');
      const operations = operationsOf(spec);
      if (operations.length === 0) throw new OpenApiError('The spec has no operations.');
      return { operations, baseUrl: input.baseUrl.replace(/\/+$/, '') || baseUrlOf(spec, input.specUrl) };
    } catch (err) {
      if (err instanceof OpenApiError) throw badRequest(err.message, 'invalid_spec');
      throw err;
    }
  };

  const auth = (header: string | undefined, value: string | undefined, old: string | null) => {
    if (value === undefined) return old;
    if (value === '') return null;
    return ctx.secrets.encrypt(JSON.stringify({ header: header || 'Authorization', value }));
  };

  app.get('/', async () => ({ servers: (await ctx.db.select().from(toolServers)).map(view) }));

  app.post('/', async (req, reply) => {
    const body = Input.parse(req.body);
    const { operations, baseUrl } = await load(body);
    const [row] = await ctx.db
      .insert(toolServers)
      .values({
        id: uuidv7(),
        name: body.name,
        description: body.description,
        specUrl: body.specUrl,
        baseUrl,
        operations,
        authCipher: auth(body.authHeader, body.authValue, null),
        enabled: body.enabled,
      })
      .returning();
    reply.code(201);
    return { server: view(row) };
  });

  const Patch = z.object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    specUrl: z.url().nullable().optional(),
    specText: z.string().max(5_000_000).optional(),
    baseUrl: z.string().trim().max(500).optional(),
    authHeader: z.string().trim().max(100).optional(),
    authValue: z.string().max(10_000).optional(),
    enabled: z.boolean().optional(),
    /** Load the spec again from its URL. */
    refresh: z.boolean().optional(),
  });

  app.patch('/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const [old] = await ctx.db.select().from(toolServers).where(eq(toolServers.id, id));
    if (!old) throw notFound('Tool server');
    const body = Patch.parse(req.body ?? {});
    const specUrl = body.specUrl !== undefined ? body.specUrl : old.specUrl;
    // Read the spec again when it, its address or the base URL changed, or on refresh
    const reload = body.specText !== undefined || body.specUrl !== undefined || body.baseUrl !== undefined || body.refresh;
    if (reload && !body.specText && !specUrl) throw badRequest('Paste the spec again (it was not loaded from a URL).', 'spec_needed');
    const loaded = reload ? await load({ specUrl, specText: body.specText, baseUrl: body.baseUrl ?? '' }) : null;
    const [row] = await ctx.db
      .update(toolServers)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        specUrl: body.specText ? null : specUrl,
        ...(loaded ? { operations: loaded.operations, baseUrl: loaded.baseUrl } : {}),
        authCipher: auth(body.authHeader ?? (old.authCipher ? (JSON.parse(ctx.secrets.decrypt(old.authCipher)) as { header: string }).header : undefined), body.authValue, old.authCipher),
        updatedAt: new Date(),
      })
      .where(eq(toolServers.id, id))
      .returning();
    return { server: view(row) };
  });

  app.delete('/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const deleted = await ctx.db.delete(toolServers).where(eq(toolServers.id, id)).returning({ id: toolServers.id });
    if (deleted.length === 0) throw notFound('Tool server');
    return { ok: true };
  });
}
