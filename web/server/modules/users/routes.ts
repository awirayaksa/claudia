import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { sessions, users, type UserSettings } from '../../db/schema';
import { badRequest, conflict, notFound, unauthorized } from '../../lib/errors';
import { currentUser, requireAdmin, requireSignedIn } from '../../auth/rbac';
import { hashPassword, verifyPassword } from '../../auth/passwords';
import { revokeAllSessions } from '../../auth/sessions';
import {
  AdminCreateUserRequest,
  AdminUpdateUserRequest,
  ChangePasswordRequest,
  type AdminUser,
  type SessionInfo,
} from '../../../shared/auth';
import { UserSettingsSchema } from '../../../shared/settings';
import { countAdmins, createLocalUser, toPublicUser, type UserRow } from './service';

function toAdminUser(u: UserRow): AdminUser {
  return {
    ...toPublicUser(u),
    createdAt: u.createdAt.toISOString(),
    lastActiveAt: u.lastActiveAt?.toISOString() ?? null,
  };
}

/** /api/me — the signed-in user's own account (pending users included). */
export async function meRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireSignedIn);

  app.get('/', async (req) => {
    const [row] = await ctx.db.select().from(users).where(eq(users.id, currentUser(req).id));
    return { user: toPublicUser(row) };
  });

  app.patch('/', async (req) => {
    const body = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    const [row] = await ctx.db
      .update(users)
      .set({ name: body.name, updatedAt: new Date() })
      .where(eq(users.id, currentUser(req).id))
      .returning();
    return { user: toPublicUser(row) };
  });

  app.put('/password', async (req) => {
    const me = currentUser(req);
    const body = ChangePasswordRequest.parse(req.body);
    const [row] = await ctx.db.select().from(users).where(eq(users.id, me.id));
    if (!row.passwordHash) throw badRequest('This account signs in through a directory and has no password here.', 'no_password');
    if (!(await verifyPassword(row.passwordHash, body.currentPassword))) {
      throw unauthorized('The current password is wrong.', 'invalid_credentials');
    }
    await ctx.db
      .update(users)
      .set({ passwordHash: await hashPassword(body.newPassword), updatedAt: new Date() })
      .where(eq(users.id, me.id));
    // Other devices must sign in again with the new password
    await revokeAllSessions(ctx, me.id, me.sessionId);
    return { ok: true };
  });

  app.get('/settings', async (req) => {
    const [row] = await ctx.db.select({ settings: users.settings }).from(users).where(eq(users.id, currentUser(req).id));
    return { settings: row.settings };
  });

  // Partial update: top-level sections are merged, so the client can save one section at a time
  app.patch('/settings', async (req) => {
    const patch = UserSettingsSchema.partial().parse(req.body);
    const me = currentUser(req);
    const [row] = await ctx.db.select({ settings: users.settings }).from(users).where(eq(users.id, me.id));
    const merged: UserSettings = { ...row.settings };
    for (const [k, v] of Object.entries(patch) as Array<[keyof UserSettings, any]>) {
      merged[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(merged[k] as object), ...v } : v;
    }
    await ctx.db.update(users).set({ settings: merged, updatedAt: new Date() }).where(eq(users.id, me.id));
    return { settings: merged };
  });

  app.get('/sessions', async (req): Promise<{ sessions: SessionInfo[] }> => {
    const me = currentUser(req);
    const rows = await ctx.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, me.id), isNull(sessions.revokedAt), sql`${sessions.expiresAt} > now()`))
      .orderBy(desc(sessions.createdAt));
    return {
      sessions: rows.map((s) => ({
        id: s.id,
        userAgent: s.userAgent,
        ip: s.ip,
        createdAt: s.createdAt.toISOString(),
        current: s.id === me.sessionId,
      })),
    };
  });

  app.delete('/sessions/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await ctx.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, id), eq(sessions.userId, currentUser(req).id)));
    return { ok: true };
  });
}

/** /api/admin/users */
export async function adminUserRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async (req) => {
    const q = z
      .object({
        search: z.string().trim().max(200).optional(),
        role: z.enum(['admin', 'user', 'pending']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const where = and(
      q.search ? or(ilike(users.email, `%${q.search}%`), ilike(users.name, `%${q.search}%`)) : undefined,
      q.role ? eq(users.role, q.role) : undefined
    );
    const rows = await ctx.db
      .select()
      .from(users)
      .where(where)
      // Pending accounts first: they are waiting for someone
      .orderBy(sql`${users.role} = 'pending' desc`, asc(users.email))
      .limit(q.limit)
      .offset(q.offset);
    const [{ total }] = await ctx.db.select({ total: sql<number>`count(*)::int` }).from(users).where(where);
    return { users: rows.map(toAdminUser), total: Number(total) };
  });

  app.post('/', async (req, reply) => {
    const body = AdminCreateUserRequest.parse(req.body);
    const user = await createLocalUser(ctx, body);
    reply.code(201);
    return { user: toAdminUser(user) };
  });

  app.patch('/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = AdminUpdateUserRequest.parse(req.body);
    const [existing] = await ctx.db.select().from(users).where(eq(users.id, id));
    if (!existing) throw notFound('User');

    if (body.role && body.role !== 'admin' && existing.role === 'admin' && (await countAdmins(ctx, id)) === 0) {
      throw conflict('This is the only admin. Make someone else an admin first.', 'last_admin');
    }
    if (body.password && !existing.passwordHash) {
      throw badRequest('This account signs in through a directory and has no password here.', 'no_password');
    }

    const [row] = await ctx.db
      .update(users)
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.role ? { role: body.role } : {}),
        ...(body.password ? { passwordHash: await hashPassword(body.password) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();
    if (body.password) await revokeAllSessions(ctx, id);
    return { user: toAdminUser(row) };
  });

  app.delete('/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (id === currentUser(req).id) throw badRequest('You cannot delete your own account here.', 'self_delete');
    const [existing] = await ctx.db.select().from(users).where(eq(users.id, id));
    if (!existing) throw notFound('User');
    if (existing.role === 'admin' && (await countAdmins(ctx, id)) === 0) {
      throw conflict('This is the only admin.', 'last_admin');
    }
    // Sessions, chats, folders and connections cascade
    await ctx.db.delete(users).where(eq(users.id, id));
    return { ok: true };
  });
}
