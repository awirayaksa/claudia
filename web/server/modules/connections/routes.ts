import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { providerConnections } from '../../db/schema';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { uuidv7 } from '../../lib/ids';
import { currentUser, requireAdmin, requireUser } from '../../auth/rbac';
import { maskSecret } from '../../crypto/secrets';
import { parsePatch } from '../../lib/validation';
import {
  ConnectionInput,
  type ConnectionView,
  type ModelsResponse,
  type UserConnectionsResponse,
} from '../../../shared/models';
import type { ConnectionRow } from '../../llm/model-registry';

const IdParams = z.object({ id: z.uuid() });

/** Connections a user may own at most. */
const MAX_USER_CONNECTIONS = 10;

function connectionView(ctx: ServerContext, c: ConnectionRow): ConnectionView {
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
}

/** The stored-key change an update asks for: omitted = keep, '' = remove. */
function keyChange(ctx: ServerContext, apiKey: string | undefined) {
  if (apiKey === undefined) return {};
  if (apiKey === '') return { keyCipher: null, keyVersion: null };
  return { keyCipher: ctx.secrets.encrypt(apiKey), keyVersion: ctx.secrets.currentKeyId };
}

/** /api/admin/connections — global LLM connections. Keys never leave the server. */
export async function adminConnectionRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  const view = (c: ConnectionRow) => connectionView(ctx, c);

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
    const body = parsePatch(ConnectionInput, req.body);
    const [existing] = await ctx.db
      .select()
      .from(providerConnections)
      .where(and(eq(providerConnections.id, id), isNull(providerConnections.ownerId)));
    if (!existing) throw notFound('Connection');
    if (body.prefix && (await prefixTaken(body.prefix, id))) {
      throw conflict(`Another connection already uses the prefix "${body.prefix}".`, 'prefix_taken');
    }
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
        ...keyChange(ctx, body.apiKey),
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
    const [row] = await ctx.db
      .select()
      .from(providerConnections)
      .where(and(eq(providerConnections.id, id), isNull(providerConnections.ownerId)));
    if (!row) throw notFound('Connection');
    ctx.models.invalidate(id);
    const models = (await ctx.models.all({ refresh: true })).filter((m) => m.connectionId === id);
    const { error } = ctx.models.status(id);
    return { ok: !error, error, models: models.map((m) => m.id) };
  });
}

/** Users may only set the quirks that describe their endpoint. */
function userQuirks(q: ConnectionInput['quirks']): ConnectionInput['quirks'] {
  return {
    ...(q.apiCompatibility ? { apiCompatibility: q.apiCompatibility } : {}),
    ...(q.toolsFirstTurnOnly !== undefined ? { toolsFirstTurnOnly: q.toolsFirstTurnOnly } : {}),
  };
}

/**
 * /api/connections — the user's own LLM connections, when the admin allows
 * them. Every request they cause goes through the SSRF guard.
 */
export async function userConnectionRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);

  const ensureAllowed = async (me: ReturnType<typeof currentUser>) => {
    if (!(await ctx.access.can(me, 'connections.own'))) {
      throw forbidden('Your administrator does not allow personal connections.', 'user_connections_disabled');
    }
  };

  const checkBaseUrl = (type: string, baseUrl: string) => {
    if (type === 'openrouter') return; // fixed public endpoint
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw badRequest('Enter the endpoint URL, e.g. https://api.example.com/v1.', 'invalid_base_url');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('Use an http or https URL.', 'invalid_base_url');
    if (url.username || url.password) throw badRequest('Put the key in the API key field, not the URL.', 'invalid_base_url');
  };

  const getOwned = async (userId: string, id: string) => {
    const [row] = await ctx.db
      .select()
      .from(providerConnections)
      .where(and(eq(providerConnections.id, id), eq(providerConnections.ownerId, userId)));
    if (!row) throw notFound('Connection');
    return row;
  };

  const prefixTaken = async (userId: string, prefix: string, exceptId?: string) => {
    const rows = await ctx.db
      .select({ id: providerConnections.id })
      .from(providerConnections)
      .where(and(eq(providerConnections.ownerId, userId), eq(providerConnections.prefix, prefix)));
    return rows.some((r) => r.id !== exceptId);
  };

  app.get('/', async (req): Promise<UserConnectionsResponse> => {
    const me = currentUser(req);
    const enabled = await ctx.access.can(me, 'connections.own');
    const rows = await ctx.models.ownConnections(me.id);
    return { enabled, connections: rows.map((r) => connectionView(ctx, r)) };
  });

  app.post('/', async (req, reply) => {
    const me = currentUser(req);
    await ensureAllowed(me);
    const body = ConnectionInput.parse(req.body);
    checkBaseUrl(body.type, body.baseUrl);
    const existing = await ctx.models.ownConnections(me.id);
    if (existing.length >= MAX_USER_CONNECTIONS) {
      throw badRequest(`You can have at most ${MAX_USER_CONNECTIONS} connections.`, 'too_many_connections');
    }
    if (await prefixTaken(me.id, body.prefix)) {
      throw conflict(`You already use the prefix "${body.prefix}".`, 'prefix_taken');
    }
    const [row] = await ctx.db
      .insert(providerConnections)
      .values({
        id: uuidv7(),
        ownerId: me.id,
        name: body.name,
        prefix: body.prefix,
        type: body.type,
        baseUrl: body.baseUrl,
        ...keyChange(ctx, body.apiKey || undefined),
        quirks: userQuirks(body.quirks),
        modelFilter: body.modelFilter,
        enabled: body.enabled,
        position: existing.length,
      })
      .returning();
    await ctx.models.own(me, { refresh: true });
    reply.code(201);
    return { connection: connectionView(ctx, row) };
  });

  app.patch('/:id', async (req) => {
    const me = currentUser(req);
    await ensureAllowed(me);
    const { id } = IdParams.parse(req.params);
    const existing = await getOwned(me.id, id);
    const body = parsePatch(ConnectionInput, req.body);
    checkBaseUrl(body.type ?? existing.type, body.baseUrl ?? existing.baseUrl);
    if (body.prefix && (await prefixTaken(me.id, body.prefix, id))) {
      throw conflict(`You already use the prefix "${body.prefix}".`, 'prefix_taken');
    }
    const [row] = await ctx.db
      .update(providerConnections)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.prefix !== undefined ? { prefix: body.prefix } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
        ...(body.quirks !== undefined ? { quirks: userQuirks(body.quirks) } : {}),
        ...(body.modelFilter !== undefined ? { modelFilter: body.modelFilter } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...keyChange(ctx, body.apiKey),
        updatedAt: new Date(),
      })
      .where(eq(providerConnections.id, id))
      .returning();
    ctx.models.invalidate(id);
    await ctx.models.own(me, { refresh: true });
    return { connection: connectionView(ctx, row) };
  });

  // Allowed while the feature is off, so users can always remove their keys
  app.delete('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    await getOwned(me.id, id);
    await ctx.db.delete(providerConnections).where(eq(providerConnections.id, id));
    ctx.models.invalidate(id);
    return { ok: true };
  });

  app.post('/:id/test', async (req) => {
    const me = currentUser(req);
    await ensureAllowed(me);
    const { id } = IdParams.parse(req.params);
    await getOwned(me.id, id);
    ctx.models.invalidate(id);
    const models = (await ctx.models.own(me, { refresh: true })).filter((m) => m.connectionId === id);
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
    return { models: await ctx.models.forUser(me), defaultModel: await ctx.models.defaultFor(me.role) };
  });
}
