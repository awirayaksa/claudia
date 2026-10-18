import type { FastifyInstance } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { schedules } from '../../db/schema';
import { currentUser, requireUser } from '../../auth/rbac';
import type { AuthUser } from '../../auth/sessions';
import { badRequest, notFound } from '../../lib/errors';
import { uuidv7 } from '../../lib/ids';
import { parsePatch } from '../../lib/validation';
import { ScheduleInput } from '../../../shared/schedules';
import { checkInterval, isTimezone, nextRun, toScheduleView, type ScheduleRunner } from './service';

const MAX_PER_USER = 25;

/** /api/schedules — the signed-in user's scheduled prompts. */
export async function scheduleRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const runner: ScheduleRunner = ctx.schedules;
  app.addHook('preHandler', requireUser);
  app.addHook('preHandler', async (req) => ctx.access.require(currentUser(req), 'features.schedules'));

  const owned = async (userId: string, id: string) => {
    const [row] = await ctx.db.select().from(schedules).where(and(eq(schedules.id, id), eq(schedules.ownerId, userId)));
    if (!row) throw notFound('Schedule');
    return row;
  };

  /** The schedule must parse, not run too often, and use a model this user has. */
  const validate = async (me: AuthUser, v: { cron: string; timezone: string; modelId: string }) => {
    if (!isTimezone(v.timezone)) throw badRequest(`"${v.timezone}" is not a time zone.`, 'invalid_timezone');
    nextRun(v.cron, v.timezone);
    checkInterval(v.cron, v.timezone);
    await ctx.models.resolve(v.modelId, me.role, me.id);
  };

  app.get('/', async (req) => {
    const rows = await ctx.db.select().from(schedules).where(eq(schedules.ownerId, currentUser(req).id)).orderBy(desc(schedules.createdAt));
    return { schedules: rows.map(toScheduleView) };
  });

  app.post('/', async (req, reply) => {
    const me = currentUser(req);
    const body = ScheduleInput.parse(req.body);
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(schedules).where(eq(schedules.ownerId, me.id));
    if (Number(n) >= MAX_PER_USER) throw badRequest(`You can have at most ${MAX_PER_USER} schedules.`, 'too_many_schedules');
    await validate(me, body);
    const [row] = await ctx.db
      .insert(schedules)
      .values({ id: uuidv7(), ownerId: me.id, ...body, nextRunAt: body.enabled ? nextRun(body.cron, body.timezone) : null })
      .returning();
    reply.code(201);
    return { schedule: toScheduleView(row) };
  });

  app.patch('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const old = await owned(me.id, id);
    const patch = parsePatch(ScheduleInput, req.body);
    const merged = { ...old, ...patch };
    if (patch.cron !== undefined || patch.timezone !== undefined || patch.modelId !== undefined) await validate(me, merged);
    // A new schedule (or switching it on) starts from now
    const timing = patch.cron !== undefined || patch.timezone !== undefined || patch.enabled !== undefined;
    const [row] = await ctx.db
      .update(schedules)
      .set({
        ...patch,
        ...(timing ? { nextRunAt: merged.enabled ? nextRun(merged.cron, merged.timezone) : null } : {}),
        // A different chat mode starts a new chat
        ...(patch.chatMode !== undefined && patch.chatMode !== old.chatMode ? { chatId: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schedules.id, id))
      .returning();
    return { schedule: toScheduleView(row) };
  });

  app.delete('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await owned(me.id, id);
    await ctx.db.delete(schedules).where(eq(schedules.id, id));
    return { ok: true };
  });

  // Run it now (to try it out); the schedule itself is unchanged
  app.post('/:id/run', async (req) => {
    const me = currentUser(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const row = await owned(me.id, id);
    const started = await runner.runOne(row);
    const [after] = await ctx.db.select().from(schedules).where(eq(schedules.id, id));
    return { schedule: toScheduleView(after), chatId: started?.chatId ?? null, runId: started?.runId ?? null };
  });
}
