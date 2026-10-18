/**
 * /api/workspace/prompts — the prompt library: `/command` text with
 * {{variables}} that the composer asks for, then puts into the message box.
 * Rows share the `prompts` table with skills (mode 'insert' vs 'system'), so
 * one user can't have a prompt and a skill with the same command.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { prompts, users } from '../../db/schema';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { uuidv7 } from '../../lib/ids';
import { parsePatch } from '../../lib/validation';
import { currentUser, requireUser } from '../../auth/rbac';
import type { Principal } from '../../auth/access';
import { PromptInput, type PromptView } from '../../../shared/workspace';
import { templateVariables } from '../../../shared/prompts';
import { registerAccessRoutes } from './access-routes';

const IdParams = z.object({ id: z.uuid() });

type PromptRow = typeof prompts.$inferSelect;

function toView(row: PromptRow, ownerName: string, access: { write: boolean; manage: boolean }): PromptView {
  return {
    id: row.id,
    ownerId: row.ownerId!,
    ownerName,
    command: row.command,
    title: row.title,
    description: row.description,
    body: row.body,
    variables: row.variables.map((v) => ({ name: v.name, default: v.default ?? '' })),
    access: { write: access.write, manage: access.manage },
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function workspacePromptRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);

  const isPrompt = eq(prompts.mode, 'insert');

  const load = async (id: string) => {
    const [row] = await ctx.db
      .select({ prompt: prompts, ownerName: users.name })
      .from(prompts)
      .innerJoin(users, eq(users.id, prompts.ownerId))
      .where(and(eq(prompts.id, id), isPrompt));
    return row;
  };

  const loadFor = async (me: Principal, id: string) => {
    const row = await load(id);
    if (!row) throw notFound('Prompt');
    const rights = await ctx.access.rights(me, 'prompt', { id: row.prompt.id, ownerId: row.prompt.ownerId! });
    if (!rights.read) throw notFound('Prompt');
    return { ...row, rights };
  };

  const commandTaken = async (ownerId: string, command: string, exceptId?: string) => {
    const rows = await ctx.db
      .select({ id: prompts.id, mode: prompts.mode })
      .from(prompts)
      .where(and(eq(prompts.ownerId, ownerId), eq(prompts.command, command)));
    const other = rows.find((r) => r.id !== exceptId);
    if (other) {
      throw conflict(
        other.mode === 'system' ? `You have a skill called /${command}. Choose another command.` : `You already have a prompt called /${command}.`,
        'command_taken'
      );
    }
  };

  /**
   * ?scope=usable: what the composer offers (own and shared, also for
   * admins); otherwise everything the user may see (admins: all).
   */
  app.get('/', async (req) => {
    const me = currentUser(req);
    const { scope } = z.object({ scope: z.enum(['usable', 'all']).default('all') }).parse(req.query);
    const rows = await ctx.db
      .select({ prompt: prompts, ownerName: users.name })
      .from(prompts)
      .innerJoin(users, eq(users.id, prompts.ownerId))
      .where(
        and(
          isPrompt,
          ctx.access.visibleSql(me, 'prompt', prompts.id, prompts.ownerId, { adminSeesAll: scope === 'all' })
        )
      )
      .orderBy(asc(prompts.command));
    const rights = await ctx.access.rightsMany(
      me,
      'prompt',
      rows.map((r) => ({ id: r.prompt.id, ownerId: r.prompt.ownerId! }))
    );
    return { prompts: rows.map((r) => toView(r.prompt, r.ownerName, rights.get(r.prompt.id)!)) };
  });

  app.get('/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const row = await loadFor(currentUser(req), id);
    return { prompt: toView(row.prompt, row.ownerName, row.rights) };
  });

  app.post('/', async (req, reply) => {
    const me = currentUser(req);
    await ctx.access.require(me, 'workspace.prompts');
    const body = PromptInput.parse(req.body);
    await commandTaken(me.id, body.command);
    const [row] = await ctx.db
      .insert(prompts)
      .values({
        id: uuidv7(),
        ownerId: me.id,
        command: body.command,
        title: body.title,
        description: body.description,
        body: body.body,
        variables: templateVariables(body.body),
        mode: 'insert',
      })
      .returning();
    reply.code(201);
    return { prompt: toView(row, me.name, { write: true, manage: true }) };
  });

  app.patch('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const existing = await loadFor(me, id);
    if (!existing.rights.write) throw forbidden('You can use this prompt but not change it.', 'read_only');
    const body = parsePatch(PromptInput, req.body);
    if (body.command && body.command !== existing.prompt.command) await commandTaken(existing.prompt.ownerId!, body.command, id);
    const [row] = await ctx.db
      .update(prompts)
      .set({ ...body, ...(body.body !== undefined ? { variables: templateVariables(body.body) } : {}), updatedAt: new Date() })
      .where(eq(prompts.id, id))
      .returning();
    return { prompt: toView(row, existing.ownerName, existing.rights) };
  });

  app.delete('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const existing = await loadFor(me, id);
    if (!existing.rights.manage) throw forbidden('Only the owner can delete this prompt.', 'not_owner');
    await ctx.db.delete(prompts).where(eq(prompts.id, id));
    await ctx.access.removeResource('prompt', id);
    return { ok: true };
  });

  registerAccessRoutes(app, ctx, 'prompt', 'Prompt', async (id) => {
    const row = await load(id);
    return row ? { id: row.prompt.id, ownerId: row.prompt.ownerId! } : undefined;
  });
}
