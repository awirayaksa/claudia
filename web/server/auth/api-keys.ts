/**
 * API keys for the OpenAI-compatible API. A key is "ck-" + 32 random bytes
 * (base64url); only its sha256 is stored. Keys work only on /api/v1, never
 * with cookies, and only while the owner has the api.keys permission.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { apiKeys, users } from '../db/schema';
import { badRequest, notFound } from '../lib/errors';
import { uuidv7 } from '../lib/ids';
import { currentUser, requireUser } from './rbac';
import { hashToken } from './tokens';
import type { AuthUser } from './sessions';
import { ApiKeyInput, type ApiKeyView, type CreatedApiKey } from '../../shared/workspace';

export const API_KEY_PREFIX = 'ck-';
const MAX_KEYS_PER_USER = 20;
/** last_used_at is written at most this often per key. */
const LAST_USED_WRITE_MS = 60_000;

type ApiKeyRow = typeof apiKeys.$inferSelect;

const toView = (k: ApiKeyRow): ApiKeyView => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  createdAt: k.createdAt.toISOString(),
  expiresAt: k.expiresAt?.toISOString() ?? null,
  lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
});

export function newApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** The user a Bearer key belongs to, or null (unknown, expired, pending, or no permission). */
export async function authenticateApiKey(ctx: ServerContext, key: string): Promise<(AuthUser & { apiKeyId: string }) | null> {
  if (!key.startsWith(API_KEY_PREFIX) || key.length > 200) return null;
  const [row] = await ctx.db
    .select({ key: apiKeys, user: users })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(eq(apiKeys.keyHash, hashToken(key)));
  if (!row) return null;
  if (row.key.expiresAt && row.key.expiresAt.getTime() <= Date.now()) return null;
  if (row.user.role === 'pending') return null;
  if (!(await ctx.access.can(row.user, 'api.keys'))) return null;
  if (!row.key.lastUsedAt || Date.now() - row.key.lastUsedAt.getTime() > LAST_USED_WRITE_MS) {
    void ctx.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.key.id)).catch(() => {});
  }
  return {
    id: row.user.id,
    email: row.user.email,
    name: row.user.name,
    role: row.user.role,
    sessionId: `api-key:${row.key.id}`,
    hasPassword: !!row.user.passwordHash,
    apiKeyId: row.key.id,
  };
}

/** /api/me/api-keys */
export async function apiKeyRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);

  app.get('/', async (req) => {
    const me = currentUser(req);
    const rows = await ctx.db.select().from(apiKeys).where(eq(apiKeys.userId, me.id)).orderBy(desc(apiKeys.createdAt));
    return { keys: rows.map(toView), allowed: await ctx.access.can(me, 'api.keys') };
  });

  app.post('/', async (req, reply): Promise<CreatedApiKey> => {
    const me = currentUser(req);
    await ctx.access.require(me, 'api.keys');
    const body = ApiKeyInput.parse(req.body);
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(apiKeys).where(eq(apiKeys.userId, me.id));
    if (Number(n) >= MAX_KEYS_PER_USER) throw badRequest(`You can have at most ${MAX_KEYS_PER_USER} keys.`, 'too_many_keys');
    const secret = newApiKey();
    const [row] = await ctx.db
      .insert(apiKeys)
      .values({
        id: uuidv7(),
        userId: me.id,
        name: body.name,
        prefix: secret.slice(0, 12),
        keyHash: hashToken(secret),
        expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null,
      })
      .returning();
    reply.code(201);
    return { key: toView(row), secret };
  });

  // Always allowed, so keys can be revoked after the permission is gone
  app.delete('/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const deleted = await ctx.db
      .delete(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, currentUser(req).id)))
      .returning({ id: apiKeys.id });
    if (deleted.length === 0) throw notFound('API key');
    return { ok: true };
  });
}
