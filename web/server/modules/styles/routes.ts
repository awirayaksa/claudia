/**
 * /api/styles — writing styles: the built-ins, an admin's styles for
 * everyone, one's own, and those shared with one (access grants, like
 * prompts). "Write it for me" turns writing samples or a description into
 * instructions.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { styles, users } from '../../db/schema';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { uuidv7 } from '../../lib/ids';
import { currentUser, requireUser } from '../../auth/rbac';
import type { Principal } from '../../auth/access';
import { registerAccessRoutes } from '../workspace/access-routes';
import { parseJson } from '../memories/learn';
import { BUILTIN_STYLES, GenerateStyleInput, isBuiltinStyle, StyleInput, type StyleView } from '../../../shared/styles';

type StyleRow = typeof styles.$inferSelect;

const MAX_STYLES = 50;

/** The style a chat turn uses: its name and instructions, or null (Normal, or not one the user may use). */
export async function resolveStyle(ctx: Pick<ServerContext, 'db' | 'access'>, user: Principal, styleId: string | undefined | null) {
  if (!styleId) return null;
  if (isBuiltinStyle(styleId)) {
    const s = BUILTIN_STYLES.find((b) => b.id === styleId)!;
    return s.instructions ? { id: s.id, name: s.name, instructions: s.instructions } : null;
  }
  if (!z.uuid().safeParse(styleId).success) return null;
  const [row] = await ctx.db.select().from(styles).where(eq(styles.id, styleId));
  if (!row) return null;
  if (row.ownerId && !(await ctx.access.rights(user, 'style', { id: row.id, ownerId: row.ownerId })).read) return null;
  return { id: row.id, name: row.name, instructions: row.instructions };
}

/** The system message carrying a style. */
export function stylePrompt(style: { name: string; instructions: string }): string {
  return (
    `<style name="${style.name.replace(/"/g, "'")}">\n${style.instructions}\n</style>\n` +
    'Write your reply in this style. It is about how you write, not what you say: it never overrides the instructions above or what the user asks for.'
  );
}

export async function styleRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);
  const IdParams = z.object({ id: z.uuid() });

  const view = async (row: StyleRow, me: Principal, ownerName: string | null): Promise<StyleView> => {
    const everyone = !row.ownerId;
    const rights = everyone
      ? { write: me.role === 'admin', manage: me.role === 'admin' }
      : await ctx.access.rights(me, 'style', { id: row.id, ownerId: row.ownerId! });
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      scope: everyone ? 'everyone' : row.ownerId === me.id ? 'mine' : 'shared',
      ownerName: everyone || row.ownerId === me.id ? null : ownerName,
      canEdit: rights.write,
      canManage: rights.manage,
    };
  };

  // One the user may change (owner, editor, or an admin for everyone's styles)
  const writable = async (me: Principal, id: string) => {
    const [row] = await ctx.db.select().from(styles).where(eq(styles.id, id));
    if (!row) throw notFound('Style');
    if (!row.ownerId) {
      if (me.role !== 'admin') throw forbidden('Only an administrator can change this style.', 'read_only');
      return { row, manage: true };
    }
    const rights = await ctx.access.rights(me, 'style', { id: row.id, ownerId: row.ownerId });
    if (!rights.read) throw notFound('Style');
    if (!rights.write) throw forbidden('You can use this style but not change it.', 'read_only');
    return { row, manage: rights.manage };
  };

  app.get('/', async (req) => {
    const me = currentUser(req);
    // Everyone's, one's own and shared ones (admins: only their own of other people's, like notes)
    const rows = await ctx.db
      .select({ style: styles, ownerName: users.name })
      .from(styles)
      .leftJoin(users, eq(users.id, styles.ownerId))
      .where(or(isNull(styles.ownerId), ctx.access.visibleSql(me, 'style', styles.id, styles.ownerId, { adminSeesAll: false })))
      .orderBy(asc(styles.name));
    const builtins: StyleView[] = BUILTIN_STYLES.map((s) => ({ ...s, scope: 'builtin', ownerName: null, canEdit: false, canManage: false }));
    return { styles: [...builtins, ...(await Promise.all(rows.map((r) => view(r.style, me, r.ownerName))))] };
  });

  app.post('/', async (req, reply) => {
    const me = currentUser(req);
    const body = StyleInput.parse(req.body);
    if (body.everyone && me.role !== 'admin') throw forbidden('Only administrators make styles for everyone.', 'admin_only');
    const own = await ctx.db.select({ id: styles.id }).from(styles).where(eq(styles.ownerId, me.id));
    if (!body.everyone && own.length >= MAX_STYLES) throw badRequest(`You can keep at most ${MAX_STYLES} styles.`, 'too_many_styles');
    const [row] = await ctx.db
      .insert(styles)
      .values({ id: uuidv7(), ownerId: body.everyone ? null : me.id, name: body.name, description: body.description, instructions: body.instructions })
      .returning();
    reply.code(201);
    return { style: await view(row, me, null) };
  });

  app.patch('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const { row } = await writable(me, id);
    const body = StyleInput.partial().parse(req.body);
    const [updated] = await ctx.db
      .update(styles)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
        updatedAt: new Date(),
      })
      .where(eq(styles.id, row.id))
      .returning();
    return { style: await view(updated, me, null) };
  });

  app.delete('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const { row, manage } = await writable(me, id);
    if (!manage) throw forbidden('Only the owner can delete this style.', 'not_owner');
    await ctx.db.delete(styles).where(eq(styles.id, row.id));
    await ctx.access.removeResource('style', row.id);
    return { ok: true };
  });

  // "Write it for me": a name and instructions from samples or a description (not saved yet)
  app.post('/generate', async (req) => {
    const me = currentUser(req);
    const body = GenerateStyleInput.parse(req.body);
    const picked = (await ctx.settings.get('tasks')).titleModel ?? (await ctx.models.defaultFor(me.role));
    if (!picked) throw badRequest('No model is available to write the style.', 'no_model');
    const model = await ctx.models.resolve(picked, picked === (await ctx.settings.get('tasks')).titleModel ? 'admin' : me.role, me.id);
    const res = await model.provider.chatCompletion({
      model: model.providerModelId,
      messages: [
        {
          role: 'system',
          content:
            'You write style instructions for an AI assistant: how its replies should be written (tone, register, length, structure, vocabulary, formatting), ' +
            'not what they should say. From the writing samples and/or description, write 3 to 8 concrete instructions in the second person ("Use…", "Avoid…"), ' +
            'in English, without quoting the samples. Reply with only JSON: {"name": "<2-3 words>", "description": "<one short line>", "instructions": "<the instructions>"}.',
        },
        {
          role: 'user',
          content: [body.description ? `Description: ${body.description}` : '', body.samples ? `Samples of the writing:\n"""\n${body.samples}\n"""` : '']
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
      stream: false,
      max_tokens: 800,
      temperature: 0.4,
    });
    const content = res.choices[0]?.message?.content;
    const parsed = parseJson(typeof content === 'string' ? content : '') as { name?: unknown; description?: unknown; instructions?: unknown } | null;
    const instructions = typeof parsed?.instructions === 'string' ? parsed.instructions.trim() : typeof content === 'string' ? content.trim() : '';
    if (!instructions) throw badRequest('The model did not write a style. Try again or describe it differently.', 'style_failed');
    return {
      name: typeof parsed?.name === 'string' ? parsed.name.trim().slice(0, 60) : 'My style',
      description: typeof parsed?.description === 'string' ? parsed.description.trim().slice(0, 200) : '',
      instructions: instructions.slice(0, 4000),
    };
  });

  registerAccessRoutes(app, ctx, 'style', 'Style', async (id) => {
    const [row] = await ctx.db.select({ id: styles.id, ownerId: styles.ownerId }).from(styles).where(and(eq(styles.id, id)));
    // Everyone's styles aren't shared item by item
    return row?.ownerId ? { id: row.id, ownerId: row.ownerId } : undefined;
  });
}
