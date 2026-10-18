/**
 * Groups: admins manage them (/api/admin/groups); everyone can list the
 * groups they belong to and look people up to share workspace items with
 * (/api/directory).
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { groupMembers, groups, users } from '../../db/schema';
import { conflict, notFound } from '../../lib/errors';
import { uuidv7 } from '../../lib/ids';
import { parsePatch } from '../../lib/validation';
import { currentUser, requireAdmin, requireUser } from '../../auth/rbac';
import { normalizeDn } from '../../auth/ldap';
import { GroupInput, type GroupMemberView, type GroupRef, type GroupView } from '../../../shared/access';

type GroupRow = typeof groups.$inferSelect;

const IdParams = z.object({ id: z.uuid() });

function toView(g: GroupRow, memberCount: number): GroupView {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    permissions: g.permissions,
    modelIds: g.modelIds,
    caps: g.caps,
    ldapDn: g.ldapDn,
    memberCount,
  };
}

/** Only granted permissions are stored (groups can't take any away). */
function grantedOnly(p: Record<string, boolean | undefined>): Record<string, true> {
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v === true)) as Record<string, true>;
}

async function uniqueChecks(ctx: ServerContext, input: { name?: string; ldapDn?: string | null }, exceptId?: string) {
  if (input.name !== undefined) {
    const [other] = await ctx.db
      .select({ id: groups.id })
      .from(groups)
      .where(and(sql`lower(${groups.name}) = lower(${input.name})`, exceptId ? ne(groups.id, exceptId) : undefined));
    if (other) throw conflict(`There is already a group called "${input.name}".`, 'group_name_taken');
  }
  if (input.ldapDn) {
    const [other] = await ctx.db
      .select({ name: groups.name })
      .from(groups)
      .where(and(eq(groups.ldapDn, input.ldapDn), exceptId ? ne(groups.id, exceptId) : undefined));
    if (other) throw conflict(`The group "${other.name}" is already linked to this directory group.`, 'ldap_dn_taken');
  }
}

export async function adminGroupRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  const getRow = async (id: string) => {
    const [row] = await ctx.db.select().from(groups).where(eq(groups.id, id));
    if (!row) throw notFound('Group');
    return row;
  };
  const countOf = async (id: string) => {
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(groupMembers).where(eq(groupMembers.groupId, id));
    return Number(n);
  };

  app.get('/', async () => {
    const rows = await ctx.db
      .select({ group: groups, n: sql<number>`(select count(*)::int from ${groupMembers} where ${groupMembers.groupId} = ${groups.id})` })
      .from(groups)
      .orderBy(asc(groups.name));
    return { groups: rows.map((r) => toView(r.group, Number(r.n))) };
  });

  app.post('/', async (req, reply) => {
    const body = GroupInput.parse(req.body);
    const ldapDn = body.ldapDn ? normalizeDn(body.ldapDn) : null;
    await uniqueChecks(ctx, { name: body.name, ldapDn });
    const [row] = await ctx.db
      .insert(groups)
      .values({ id: uuidv7(), ...body, permissions: grantedOnly(body.permissions), ldapDn })
      .returning();
    reply.code(201);
    return { group: toView(row, 0) };
  });

  app.patch('/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    await getRow(id);
    const body = parsePatch(GroupInput, req.body);
    const ldapDn = body.ldapDn === undefined ? undefined : body.ldapDn ? normalizeDn(body.ldapDn) : null;
    await uniqueChecks(ctx, { name: body.name, ldapDn }, id);
    const [row] = await ctx.db
      .update(groups)
      .set({
        ...body,
        ...(body.permissions ? { permissions: grantedOnly(body.permissions) } : {}),
        ...(ldapDn !== undefined ? { ldapDn } : {}),
        updatedAt: new Date(),
      })
      .where(eq(groups.id, id))
      .returning();
    return { group: toView(row, await countOf(id)) };
  });

  app.delete('/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    await getRow(id);
    await ctx.db.delete(groups).where(eq(groups.id, id));
    await ctx.access.removePrincipal('group', id);
    return { ok: true };
  });

  app.get('/:id/members', async (req): Promise<{ members: GroupMemberView[] }> => {
    const { id } = IdParams.parse(req.params);
    await getRow(id);
    const rows = await ctx.db
      .select({ userId: users.id, email: users.email, name: users.name, source: groupMembers.source })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(eq(groupMembers.groupId, id))
      .orderBy(asc(users.email));
    return { members: rows };
  });

  app.post('/:id/members', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { userId } = z.object({ userId: z.uuid() }).parse(req.body);
    await getRow(id);
    const [user] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!user) throw notFound('User');
    await ctx.db.insert(groupMembers).values({ groupId: id, userId, source: 'manual' }).onConflictDoNothing();
    reply.code(201);
    return { ok: true };
  });

  app.delete('/:id/members/:userId', async (req) => {
    const { id, userId } = z.object({ id: z.uuid(), userId: z.uuid() }).parse(req.params);
    await ctx.db.delete(groupMembers).where(and(eq(groupMembers.groupId, id), eq(groupMembers.userId, userId)));
    return { ok: true };
  });
}

/** /api/directory — for sharing: your groups (admins: all) and people by name or email. */
export async function directoryRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);

  app.get('/groups', async (req): Promise<{ groups: GroupRef[] }> => {
    const me = currentUser(req);
    const rows =
      me.role === 'admin'
        ? await ctx.db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(asc(groups.name))
        : await ctx.db
            .select({ id: groups.id, name: groups.name })
            .from(groupMembers)
            .innerJoin(groups, eq(groups.id, groupMembers.groupId))
            .where(eq(groupMembers.userId, me.id))
            .orderBy(asc(groups.name));
    return { groups: rows };
  });

  // At least 2 characters and 8 results, approved accounts only: enough to share, not to list everyone
  app.get('/users', async (req) => {
    const me = currentUser(req);
    const { q } = z.object({ q: z.string().trim().min(2).max(200) }).parse(req.query);
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await ctx.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(inArray(users.role, ['user', 'admin']), ne(users.id, me.id), or(ilike(users.email, pattern), ilike(users.name, pattern))))
      .orderBy(asc(users.email))
      .limit(8);
    return { users: rows };
  });
}
