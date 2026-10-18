/**
 * Notes: Markdown documents of one's own, private until shared like
 * workspace items (read = see, write = edit; only the owner shares or
 * deletes). A chat can refer to one with #note.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { notes, users } from '../../db/schema';
import { currentUser, requireUser } from '../../auth/rbac';
import { forbidden, notFound } from '../../lib/errors';
import { uuidv7 } from '../../lib/ids';
import { parsePatch } from '../../lib/validation';
import { registerAccessRoutes } from '../workspace/access-routes';
import { NoteInput, type NoteDetail, type NoteSummary } from '../../../shared/notes';
import type { Principal } from '../../auth/access';

type NoteRow = typeof notes.$inferSelect;

const snippet = (content: string) => content.replace(/[#>*_`[\]-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

/** A note the user may read (owner, a grant, or admin), with their rights. */
export async function readableNote(ctx: ServerContext, user: Principal, id: string) {
  const [row] = await ctx.db.select().from(notes).where(eq(notes.id, id));
  if (!row) throw notFound('Note');
  const rights = await ctx.access.rights(user, 'note', row);
  if (!rights.read) throw notFound('Note');
  return { row, rights };
}

export async function noteRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);
  app.addHook('preHandler', async (req) => ctx.access.require(currentUser(req), 'features.notes'));

  const owners = async (rows: NoteRow[]) => {
    const ids = [...new Set(rows.map((r) => r.ownerId))];
    if (ids.length === 0) return new Map<string, string>();
    const list = await ctx.db.select({ id: users.id, name: users.name }).from(users).where(or(...ids.map((id) => eq(users.id, id))));
    return new Map(list.map((u) => [u.id, u.name]));
  };

  const summary = (r: NoteRow, me: string, ownerNames: Map<string, string>, write: boolean): NoteSummary => ({
    id: r.id,
    title: r.title,
    snippet: snippet(r.content),
    pinned: r.pinned,
    mine: r.ownerId === me,
    ownerName: ownerNames.get(r.ownerId) ?? null,
    canEdit: write,
    updatedAt: r.updatedAt.toISOString(),
  });

  app.get('/', async (req) => {
    const me = currentUser(req);
    const q = z.object({ search: z.string().trim().max(200).optional() }).parse(req.query);
    // Mine and those shared with me (admins see their own here, like everyone)
    const rows = await ctx.db
      .select()
      .from(notes)
      .where(or(eq(notes.ownerId, me.id), ctx.access.visibleSql(me, 'note', notes.id, notes.ownerId, { adminSeesAll: false })))
      .orderBy(desc(notes.pinned), desc(notes.updatedAt))
      .limit(500);
    const needle = q.search?.toLowerCase();
    const filtered = needle ? rows.filter((r) => r.title.toLowerCase().includes(needle) || r.content.toLowerCase().includes(needle)) : rows;
    const rights = await ctx.access.rightsMany(me, 'note', filtered);
    const names = await owners(filtered);
    return { notes: filtered.map((r) => summary(r, me.id, names, rights.get(r.id)?.write ?? false)) };
  });

  app.post('/', async (req, reply) => {
    const me = currentUser(req);
    const body = NoteInput.parse(req.body ?? {});
    const [row] = await ctx.db.insert(notes).values({ id: uuidv7(), ownerId: me.id, ...body }).returning();
    reply.code(201);
    return { note: await detail(row, me) };
  });

  const detail = async (row: NoteRow, me: Principal): Promise<NoteDetail> => {
    const rights = await ctx.access.rights(me, 'note', row);
    const names = await owners([row]);
    return { ...summary(row, me.id, names, rights.write), content: row.content, canManage: rights.manage, createdAt: row.createdAt.toISOString() };
  };

  app.get('/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const me = currentUser(req);
    return { note: await detail((await readableNote(ctx, me, id)).row, me) };
  });

  app.patch('/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const me = currentUser(req);
    const { row, rights } = await readableNote(ctx, me, id);
    if (!rights.write) throw forbidden('You can read this note but not change it.', 'read_only');
    const patch = parsePatch(NoteInput, req.body);
    const [updated] = await ctx.db
      .update(notes)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(notes.id, row.id))
      .returning();
    return { note: await detail(updated, me) };
  });

  app.delete('/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const me = currentUser(req);
    const { row, rights } = await readableNote(ctx, me, id);
    if (!rights.manage) throw forbidden('Only the owner can delete this note.', 'not_owner');
    await ctx.db.delete(notes).where(and(eq(notes.id, row.id)));
    await ctx.access.removeResource('note', row.id);
    return { ok: true };
  });

  registerAccessRoutes(app, ctx, 'note', 'Note', async (id) => {
    const [row] = await ctx.db.select({ id: notes.id, ownerId: notes.ownerId }).from(notes).where(eq(notes.id, id));
    return row;
  });
}
