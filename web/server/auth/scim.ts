/**
 * SCIM 2.0 provisioning (RFC 7643/7644) at /scim/v2, for identity providers
 * such as Entra ID, Okta or OneLogin: they create, update, deactivate and
 * delete users and groups here, so accounts exist (and stop working) before
 * anyone signs in. Authentication is a bearer token the admin generates
 * (only its hash is stored).
 *
 * Users: userName is the email; `active: false` deactivates the account
 * (sessions and API keys stop at once). Provisioned users are approved
 * ("user") and sign in through SSO or the directory. Groups map to Claudia
 * groups; memberships the provider sets are marked "scim", so a group's
 * hand-added members are left alone.
 *
 * Filters: `<attribute> eq "<value>"` on userName, externalId, emails.value,
 * id (users) and displayName, externalId, id (groups).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { ServerContext } from '../context';
import { appConfig, groupMembers, groups, users } from '../db/schema';
import { uuidv7 } from '../lib/ids';
import { normalizeEmail, countAdmins, webhookUser } from '../modules/users/service';
import { revokeAllSessions } from './sessions';
import { requireAdmin } from './rbac';

const SCHEMA = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  list: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  patch: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
};
const TOKEN_KEY = 'scim.token';
const CONTENT_TYPE = 'application/scim+json; charset=utf-8';

class ScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly scimType?: string
  ) {
    super(message);
  }
}

type UserRow = typeof users.$inferSelect;
type GroupRow = typeof groups.$inferSelect;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

// ─── Token (admin) ───────────────────────────────────────────────────────────

async function storedToken(ctx: ServerContext): Promise<{ hash: string; createdAt: string } | null> {
  const [row] = await ctx.db.select().from(appConfig).where(eq(appConfig.key, TOKEN_KEY));
  return (row?.value as { hash: string; createdAt: string } | undefined) ?? null;
}

/** /api/admin/scim — turn provisioning on (a new token) or off. */
export async function adminScimRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireAdmin);
  const baseUrl = (req: FastifyRequest) => `${ctx.config.CLAUDIA_PUBLIC_URL?.replace(/\/+$/, '') ?? `${req.protocol}://${req.host}`}/scim/v2`;

  app.get('/', async (req) => {
    const token = await storedToken(ctx);
    return { enabled: !!token, createdAt: token?.createdAt ?? null, baseUrl: baseUrl(req) };
  });

  // The token is shown once; a new one replaces the old
  app.post('/token', async (req) => {
    const token = `scim_${randomBytes(32).toString('base64url')}`;
    const value = { hash: hash(token), createdAt: new Date().toISOString() };
    await ctx.db
      .insert(appConfig)
      .values({ key: TOKEN_KEY, value })
      .onConflictDoUpdate({ target: appConfig.key, set: { value, updatedAt: new Date() } });
    return { token, baseUrl: baseUrl(req) };
  });

  app.delete('/token', async () => {
    await ctx.db.delete(appConfig).where(eq(appConfig.key, TOKEN_KEY));
    return { ok: true };
  });
}

// ─── Mapping ─────────────────────────────────────────────────────────────────

function location(req: FastifyRequest, ctx: ServerContext, path: string): string {
  return `${ctx.config.CLAUDIA_PUBLIC_URL?.replace(/\/+$/, '') ?? `${req.protocol}://${req.host}`}/scim/v2/${path}`;
}

function toScimUser(req: FastifyRequest, ctx: ServerContext, u: UserRow) {
  return {
    schemas: [SCHEMA.user],
    id: u.id,
    ...(u.externalId ? { externalId: u.externalId } : {}),
    userName: u.email,
    name: { formatted: u.name },
    displayName: u.name,
    emails: [{ value: u.email, type: 'work', primary: true }],
    active: !u.deactivatedAt,
    meta: { resourceType: 'User', created: u.createdAt.toISOString(), lastModified: u.updatedAt.toISOString(), location: location(req, ctx, `Users/${u.id}`) },
  };
}

async function toScimGroup(req: FastifyRequest, ctx: ServerContext, g: GroupRow) {
  const members = await ctx.db
    .select({ id: users.id, email: users.email })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(eq(groupMembers.groupId, g.id));
  return {
    schemas: [SCHEMA.group],
    id: g.id,
    ...(g.externalId ? { externalId: g.externalId } : {}),
    displayName: g.name,
    members: members.map((m) => ({ value: m.id, display: m.email, $ref: location(req, ctx, `Users/${m.id}`) })),
    meta: { resourceType: 'Group', created: g.createdAt.toISOString(), lastModified: g.updatedAt.toISOString(), location: location(req, ctx, `Groups/${g.id}`) },
  };
}

/** `attr eq "value"` → [attr, value]. */
function parseFilter(filter: string | undefined): [string, string] | null {
  if (!filter) return null;
  const m = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!m) throw new ScimError(400, `Only filters like 'userName eq "someone@example.com"' are supported.`, 'invalidFilter');
  return [m[1].toLowerCase(), m[2].replace(/\\(.)/g, '$1')];
}

const bool = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() === 'true' : !!v);
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

interface UserFields {
  email?: string;
  name?: string;
  active?: boolean;
  externalId?: string | null;
}

/** What a full SCIM User (POST / PUT) says. */
function userFields(body: Record<string, any>): UserFields {
  const emails = Array.isArray(body.emails) ? body.emails : [];
  const email = body.userName ?? emails.find((e: any) => e?.primary)?.value ?? emails[0]?.value;
  const name =
    body.displayName ?? body.name?.formatted ?? ([body.name?.givenName, body.name?.familyName].filter(Boolean).join(' ') || undefined);
  return {
    ...(typeof email === 'string' ? { email: normalizeEmail(email) } : {}),
    ...(typeof name === 'string' && name.trim() ? { name: name.trim().slice(0, 100) } : {}),
    ...(body.active !== undefined ? { active: bool(body.active) } : {}),
    ...(body.externalId !== undefined ? { externalId: body.externalId === null ? null : String(body.externalId) } : {}),
  };
}

/** One PATCH operation on a User, as fields to change. */
function userPatch(op: { op?: string; path?: string; value?: any }): UserFields {
  const kind = String(op.op ?? '').toLowerCase();
  const path = (op.path ?? '').toLowerCase();
  if (kind !== 'add' && kind !== 'replace' && kind !== 'remove') throw new ScimError(400, `Unknown PATCH op "${op.op}".`, 'invalidSyntax');
  if (!path) {
    if (typeof op.value !== 'object' || op.value === null) throw new ScimError(400, 'A PATCH without a path needs an object value.', 'invalidValue');
    // Entra sends {"name.givenName": "..."} style keys too
    const flat: Record<string, any> = {};
    for (const [k, v] of Object.entries(op.value)) {
      if (k.includes('.')) {
        const [a, b] = k.split('.');
        flat[a] = { ...(flat[a] ?? {}), [b]: v };
      } else flat[k] = v;
    }
    return userFields(flat);
  }
  const value = kind === 'remove' ? null : op.value;
  if (path === 'active') return { active: bool(value) };
  if (path === 'username') return value ? { email: normalizeEmail(String(value)) } : {};
  if (path === 'displayname' || path === 'name.formatted') return value ? { name: String(value).trim().slice(0, 100) } : {};
  if (path === 'externalid') return { externalId: value === null ? null : String(value) };
  if (path.startsWith('emails')) {
    const v = Array.isArray(value) ? value[0]?.value : typeof value === 'object' && value ? value.value : value;
    return v ? { email: normalizeEmail(String(v)) } : {};
  }
  // Attributes Claudia doesn't keep (title, phone numbers…) are accepted and ignored
  return {};
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function scimRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addContentTypeParser(['application/scim+json'], { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(String(body)) : {});
    } catch {
      done(new ScimError(400, 'The body is not valid JSON.', 'invalidSyntax'), undefined);
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof ScimError ? err.status : (err.statusCode ?? 500);
    if (status >= 500) ctx.log.error({ err }, 'SCIM request failed');
    void reply
      .code(status)
      .type(CONTENT_TYPE)
      .send({ schemas: [SCHEMA.error], status: String(status), ...(err instanceof ScimError && err.scimType ? { scimType: err.scimType } : {}), detail: status >= 500 ? 'Internal error' : err.message });
  });

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization ?? '';
    const token = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
    const stored = await storedToken(ctx);
    const given = Buffer.from(hash(token || 'none'));
    if (!stored || !token || !timingSafeEqual(given, Buffer.from(stored.hash))) throw new ScimError(401, 'A valid SCIM bearer token is required.');
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.type(CONTENT_TYPE);
    return payload;
  });

  // Changes go in the audit log
  app.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || reply.statusCode >= 400) return;
    await ctx.audit.fromRequest(req, 'scim.request', {
      actor: null,
      route: `${req.method} ${req.routeOptions.url}`,
      targetType: (req.routeOptions.url ?? '').split('/')[3]?.toLowerCase() ?? null,
      targetId: (req.params as { id?: string })?.id ?? null,
      details: { body: req.body ?? null },
      status: reply.statusCode,
    });
  });

  // ─── Discovery ───────────────────────────────────────────────────────────
  app.get('/ServiceProviderConfig', async () => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'The token from Admin → Single sign-on → SCIM' }],
  }));

  app.get('/ResourceTypes', async () => ({
    schemas: [SCHEMA.list],
    totalResults: 2,
    Resources: [
      { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: SCHEMA.user },
      { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: SCHEMA.group },
    ],
  }));

  app.get('/Schemas', async () => ({
    schemas: [SCHEMA.list],
    totalResults: 2,
    Resources: [
      { id: SCHEMA.user, name: 'User', attributes: ['userName', 'name', 'displayName', 'emails', 'active', 'externalId'].map((name) => ({ name })) },
      { id: SCHEMA.group, name: 'Group', attributes: ['displayName', 'members', 'externalId'].map((name) => ({ name })) },
    ],
  }));

  const page = (req: FastifyRequest) => {
    const q = req.query as { startIndex?: string; count?: string };
    const startIndex = Math.max(1, Number(q.startIndex) || 1);
    const count = Math.min(200, Math.max(0, q.count === undefined ? 100 : Number(q.count) || 0));
    return { startIndex, count };
  };

  // ─── Users ───────────────────────────────────────────────────────────────
  const getUser = async (id: string): Promise<UserRow> => {
    if (!isUuid(id)) throw new ScimError(404, 'No such user.');
    const [row] = await ctx.db.select().from(users).where(eq(users.id, id));
    if (!row) throw new ScimError(404, 'No such user.');
    return row;
  };

  /** Apply fields to a user, with SCIM's rules (unique email, last admin, sessions end on deactivation). */
  const applyUser = async (row: UserRow, f: UserFields): Promise<UserRow> => {
    if (f.email && f.email !== row.email) {
      const [taken] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, f.email));
      if (taken) throw new ScimError(409, `${f.email} is already in use.`, 'uniqueness');
    }
    if (f.active === false && !row.deactivatedAt && row.role === 'admin' && (await countAdmins(ctx, row.id)) === 0) {
      throw new ScimError(400, "The only admin can't be deactivated.", 'mutability');
    }
    const [updated] = await ctx.db
      .update(users)
      .set({
        ...(f.email ? { email: f.email } : {}),
        ...(f.name ? { name: f.name } : {}),
        ...(f.externalId !== undefined ? { externalId: f.externalId } : {}),
        ...(f.active !== undefined ? { deactivatedAt: f.active ? null : (row.deactivatedAt ?? new Date()) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, row.id))
      .returning();
    if (f.active === false) await revokeAllSessions(ctx, row.id);
    if (f.name || f.email || f.active !== undefined) void ctx.webhooks.emit('user.updated', { user: webhookUser(updated), source: 'scim' });
    return updated;
  };

  app.get('/Users', async (req) => {
    const filter = parseFilter((req.query as { filter?: string }).filter);
    const { startIndex, count } = page(req);
    let where: SQL | undefined;
    if (filter) {
      const [attr, value] = filter;
      if (attr === 'username' || attr === 'emails.value' || attr === 'emails') where = eq(users.email, normalizeEmail(value));
      else if (attr === 'externalid') where = eq(users.externalId, value);
      else if (attr === 'id') where = isUuid(value) ? eq(users.id, value) : sql`false`;
      else throw new ScimError(400, `Filtering on ${attr} is not supported.`, 'invalidFilter');
    }
    const [{ total }] = await ctx.db.select({ total: sql<number>`count(*)::int` }).from(users).where(where);
    const rows = await ctx.db.select().from(users).where(where).orderBy(asc(users.createdAt)).limit(count).offset(startIndex - 1);
    return { schemas: [SCHEMA.list], totalResults: Number(total), startIndex, itemsPerPage: rows.length, Resources: rows.map((u) => toScimUser(req, ctx, u)) };
  });

  app.get('/Users/:id', async (req) => toScimUser(req, ctx, await getUser((req.params as { id: string }).id)));

  app.post('/Users', async (req, reply) => {
    const f = userFields((req.body ?? {}) as Record<string, any>);
    if (!f.email || !/^[^@\s]+@[^@\s]+$/.test(f.email)) throw new ScimError(400, 'userName must be an email address.', 'invalidValue');
    const [taken] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, f.email));
    if (taken) throw new ScimError(409, `${f.email} is already in use.`, 'uniqueness');
    const [row] = await ctx.db
      .insert(users)
      .values({
        id: uuidv7(),
        email: f.email,
        name: f.name ?? f.email.split('@')[0],
        passwordHash: null,
        role: 'user',
        externalId: f.externalId ?? null,
        deactivatedAt: f.active === false ? new Date() : null,
      })
      .returning();
    void ctx.webhooks.emit('user.created', { user: webhookUser(row), source: 'scim' });
    reply.code(201);
    return toScimUser(req, ctx, row);
  });

  app.put('/Users/:id', async (req) => {
    const row = await getUser((req.params as { id: string }).id);
    const f = userFields((req.body ?? {}) as Record<string, any>);
    // A replace without "active" means active
    return toScimUser(req, ctx, await applyUser(row, { active: true, ...f }));
  });

  app.patch('/Users/:id', async (req) => {
    let row = await getUser((req.params as { id: string }).id);
    const ops = ((req.body ?? {}) as { Operations?: any[] }).Operations;
    if (!Array.isArray(ops)) throw new ScimError(400, 'Operations is required.', 'invalidSyntax');
    const fields = ops.reduce<UserFields>((acc, op) => ({ ...acc, ...userPatch(op) }), {});
    row = await applyUser(row, fields);
    return toScimUser(req, ctx, row);
  });

  app.delete('/Users/:id', async (req, reply) => {
    const row = await getUser((req.params as { id: string }).id);
    if (row.role === 'admin' && (await countAdmins(ctx, row.id)) === 0) throw new ScimError(400, "The only admin can't be deleted.", 'mutability');
    await ctx.db.delete(users).where(eq(users.id, row.id));
    reply.code(204);
    return null;
  });

  // ─── Groups ──────────────────────────────────────────────────────────────
  const getGroup = async (id: string): Promise<GroupRow> => {
    if (!isUuid(id)) throw new ScimError(404, 'No such group.');
    const [row] = await ctx.db.select().from(groups).where(eq(groups.id, id));
    if (!row) throw new ScimError(404, 'No such group.');
    return row;
  };

  const memberIds = (value: unknown): string[] =>
    (Array.isArray(value) ? value : value ? [value] : [])
      .map((m: any) => String(typeof m === 'object' && m ? m.value : m))
      .filter(isUuid);

  const addMembers = async (groupId: string, ids: string[]) => {
    if (ids.length === 0) return;
    const existing = await ctx.db.select({ id: users.id }).from(users).where(inArray(users.id, ids));
    if (existing.length === 0) return;
    await ctx.db
      .insert(groupMembers)
      .values(existing.map((u) => ({ groupId, userId: u.id, source: 'scim' as const })))
      .onConflictDoNothing();
  };
  const removeMembers = async (groupId: string, ids: string[] | 'all') => {
    await ctx.db
      .delete(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.source, 'scim'),
          ids === 'all' ? undefined : ids.length ? inArray(groupMembers.userId, ids) : sql`false`
        )
      );
  };
  const touch = (id: string, set: Partial<typeof groups.$inferInsert> = {}) =>
    ctx.db.update(groups).set({ ...set, updatedAt: new Date() }).where(eq(groups.id, id)).returning();

  app.get('/Groups', async (req) => {
    const filter = parseFilter((req.query as { filter?: string }).filter);
    const { startIndex, count } = page(req);
    let where: SQL | undefined;
    if (filter) {
      const [attr, value] = filter;
      if (attr === 'displayname') where = sql`lower(${groups.name}) = ${value.toLowerCase()}`;
      else if (attr === 'externalid') where = eq(groups.externalId, value);
      else if (attr === 'id') where = isUuid(value) ? eq(groups.id, value) : sql`false`;
      else throw new ScimError(400, `Filtering on ${attr} is not supported.`, 'invalidFilter');
    }
    const [{ total }] = await ctx.db.select({ total: sql<number>`count(*)::int` }).from(groups).where(where);
    const rows = await ctx.db.select().from(groups).where(where).orderBy(asc(groups.createdAt)).limit(count).offset(startIndex - 1);
    const excludeMembers = String((req.query as { excludedAttributes?: string }).excludedAttributes ?? '').includes('members');
    const resources = await Promise.all(
      rows.map(async (g) => {
        const r = await toScimGroup(req, ctx, g);
        return excludeMembers ? { ...r, members: undefined } : r;
      })
    );
    return { schemas: [SCHEMA.list], totalResults: Number(total), startIndex, itemsPerPage: rows.length, Resources: resources };
  });

  app.get('/Groups/:id', async (req) => toScimGroup(req, ctx, await getGroup((req.params as { id: string }).id)));

  app.post('/Groups', async (req, reply) => {
    const body = (req.body ?? {}) as { displayName?: string; externalId?: string; members?: unknown };
    const name = body.displayName?.trim();
    if (!name) throw new ScimError(400, 'displayName is required.', 'invalidValue');
    const [taken] = await ctx.db.select({ id: groups.id }).from(groups).where(sql`lower(${groups.name}) = ${name.toLowerCase()}`);
    if (taken) throw new ScimError(409, `A group called ${name} exists.`, 'uniqueness');
    const [row] = await ctx.db
      .insert(groups)
      .values({ id: uuidv7(), name: name.slice(0, 100), externalId: body.externalId ?? null })
      .returning();
    await addMembers(row.id, memberIds(body.members));
    reply.code(201);
    return toScimGroup(req, ctx, row);
  });

  app.put('/Groups/:id', async (req) => {
    const group = await getGroup((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { displayName?: string; externalId?: string; members?: unknown };
    await removeMembers(group.id, 'all');
    await addMembers(group.id, memberIds(body.members));
    const [row] = await touch(group.id, {
      ...(body.displayName?.trim() ? { name: body.displayName.trim().slice(0, 100) } : {}),
      ...(body.externalId !== undefined ? { externalId: body.externalId } : {}),
    });
    return toScimGroup(req, ctx, row);
  });

  app.patch('/Groups/:id', async (req, reply) => {
    const group = await getGroup((req.params as { id: string }).id);
    const ops = ((req.body ?? {}) as { Operations?: any[] }).Operations;
    if (!Array.isArray(ops)) throw new ScimError(400, 'Operations is required.', 'invalidSyntax');
    for (const op of ops) {
      const kind = String(op.op ?? '').toLowerCase();
      const path = String(op.path ?? '');
      const member = /^members\[value eq "([^"]+)"\]$/i.exec(path);
      if (path.toLowerCase() === 'members') {
        if (kind === 'add') await addMembers(group.id, memberIds(op.value));
        else if (kind === 'remove') await removeMembers(group.id, op.value ? memberIds(op.value) : 'all');
        else if (kind === 'replace') {
          await removeMembers(group.id, 'all');
          await addMembers(group.id, memberIds(op.value));
        }
      } else if (member && kind === 'remove') {
        await removeMembers(group.id, [member[1]]);
      } else if (path.toLowerCase() === 'displayname' || (!path && op.value?.displayName)) {
        const name = String(path ? op.value : op.value.displayName).trim();
        if (name) await touch(group.id, { name: name.slice(0, 100) });
      } else if (path.toLowerCase() === 'externalid' || (!path && op.value?.externalId !== undefined)) {
        await touch(group.id, { externalId: String(path ? op.value : op.value.externalId) });
      } else if (!path && op.value?.members) {
        if (kind === 'add') await addMembers(group.id, memberIds(op.value.members));
      }
    }
    await touch(group.id);
    // Entra and Okta accept 204 for PATCH; return the group for others
    if ((req.headers['accept'] ?? '').includes('none')) return reply.code(204).send();
    return toScimGroup(req, ctx, await getGroup(group.id));
  });

  app.delete('/Groups/:id', async (req, reply) => {
    const group = await getGroup((req.params as { id: string }).id);
    await ctx.access.removePrincipal('group', group.id);
    await ctx.db.delete(groups).where(eq(groups.id, group.id));
    reply.code(204);
    return null;
  });

  // Unknown SCIM paths answer in SCIM's error format
  app.setNotFoundHandler((_req, reply: FastifyReply) => {
    void reply.code(404).type(CONTENT_TYPE).send({ schemas: [SCHEMA.error], status: '404', detail: 'Not found' });
  });
}
