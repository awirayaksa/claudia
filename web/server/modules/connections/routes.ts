import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { providerConnections } from '../../db/schema';
import { conflict, notFound } from '../../lib/errors';
import { uuidv7 } from '../../lib/ids';
import { currentUser, requireAdmin, requireUser } from '../../auth/rbac';
import { maskSecret } from '../../crypto/secrets';
import { ConnectionInput, type ConnectionView, type ModelsResponse } from '../../../shared/models';
import type { ConnectionRow } from '../../llm/model-registry';

const IdParams = z.object({ id: z.uuid() });

/** /api/admin/connections — global LLM connections. Keys never leave the server. */
export async function adminConnectionRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  const view = (c: ConnectionRow): ConnectionView => {
    const plain = c.keyCipher ? ctx.secrets.decrypt(c.keyCipher) : null;
    const masked = maskSecret(plain);
    return {
      id: c.id,
      name: c.name,
      prefix: c.prefix,
      type: c.type,
      baseUrl: c.baseUrl,
      hasKey: masked.hasKey,
      keyLast4: masked.last4 ?? null,
      quirks: c.quirks,
      modelFilter: c.modelFilter ?? null,
      enabled: c.enabled,
      ...ctx.models.status(c.id),
    };
  };

  const prefixTaken = async (prefix: string, exceptId?: string) => {
    const rows = await ctx.db
      .select({ id: providerConnections.id })
      .from(providerConnections)
      .where(and(isNull(providerConnections.ownerId), eq(providerConnections.prefix, prefix)));
    return rows.some((r) => r.id !== exceptId);
  };

  app.get('/', async () => {
    const conns = await ctx.models.connections();
    return { connections: conns.map(view) };
  });

  app.post('/', async (req, reply) => {
    const body = ConnectionInput.parse(req.body);
    if (await prefixTaken(body.prefix)) throw conflict(`Another connection already uses the prefix "${body.prefix}".`, 'prefix_taken');
    const [{ maxPos }] = await ctx.db
      .select({ maxPos: sql<number>`coalesce(max(${providerConnections.position}), -1)::int` })
      .from(providerConnections)
      .where(isNull(providerConnections.ownerId));
    const [row] = await ctx.db
      .insert(providerConnections)
      .values({
        id: uuidv7(),
        ownerId: null,
        name: body.name,
        prefix: body.prefix,
        type: body.type,
        baseUrl: body.baseUrl,
        keyCipher: body.apiKey ? ctx.secrets.encrypt(body.apiKey) : null,
        keyVersion: body.apiKey ? ctx.secrets.currentKeyId : null,
        quirks: body.quirks,
        modelFilter: body.modelFilter,
        enabled: body.enabled,
        position: Number(maxPos) + 1,
      })
      .returning();
    ctx.models.invalidate(row.id);
    await ctx.models.all({ refresh: true });
    reply.code(201);
    return { connection: view(row) };
  });

  app.patch('/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = ConnectionInput.partial().parse(req.body);
    const [existing] = await ctx.db
      .select()
      .from(providerConnections)
      .where(and(eq(providerConnections.id, id), isNull(providerConnections.ownerId)));
    if (!existing) throw notFound('Connection');
    if (body.prefix && (await prefixTaken(body.prefix, id))) {
      throw conflict(`Another connection already uses the prefix "${body.prefix}".`, 'prefix_taken');
    }
    const keyChange =
      body.apiKey === undefined
        ? {}
        : body.apiKey === ''
          ? { keyCipher: null, keyVersion: null }
          : { keyCipher: ctx.secrets.encrypt(body.apiKey), keyVersion: ctx.secrets.currentKeyId };
    const [row] = await ctx.db
      .update(providerConnections)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.prefix !== undefined ? { prefix: body.prefix } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
        ...(body.quirks !== undefined ? { quirks: body.quirks } : {}),
        ...(body.modelFilter !== undefined ? { modelFilter: body.modelFilter } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...keyChange,
        updatedAt: new Date(),
      })
      .where(eq(providerConnections.id, id))
      .returning();
    ctx.models.invalidate(id);
    await ctx.models.all({ refresh: true });
    return { connection: view(row) };
  });

  app.delete('/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const deleted = await ctx.db
      .delete(providerConnections)
      .where(and(eq(providerConnections.id, id), isNull(providerConnections.ownerId)))
      .returning({ id: providerConnections.id });
    if (deleted.length === 0) throw notFound('Connection');
    ctx.models.invalidate(id);
    return { ok: true };
  });

  // List the endpoint's models now and report whether that worked
  app.post('/:id/test', async (req) => {
    const { id } = IdParams.parse(req.params);
    const [row] = await ctx.db.select().from(providerConnections).where(eq(providerConnections.id, id));
    if (!row) throw notFound('Connection');
    ctx.models.invalidate(id);
    const models = (await ctx.models.all({ refresh: true })).filter((m) => m.connectionId === id);
    const { error } = ctx.models.status(id);
    return { ok: !error, error, models: models.map((m) => m.id) };
  });
}

/** /api/models — what the signed-in user may pick. */
export async function modelRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);

  app.get('/', async (req): Promise<ModelsResponse> => {
    const me = currentUser(req);
    const refresh = z.object({ refresh: z.coerce.boolean().optional() }).parse(req.query).refresh;
    if (refresh && me.role === 'admin') await ctx.models.all({ refresh: true });
    return { models: await ctx.models.forRole(me.role), defaultModel: await ctx.models.defaultFor(me.role) };
  });
}
