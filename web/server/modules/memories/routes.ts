/**
 * /api/me/memories — things the user wants every chat to know about them.
 * They are injected as one system message (see `memoryPrompt`); retrieval by
 * relevance arrives with embeddings in Phase 4.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import type { Database } from '../../db/client';
import { memories } from '../../db/schema';
import { badRequest, notFound } from '../../lib/errors';
import { uuidv7 } from '../../lib/ids';
import { currentUser, requireUser } from '../../auth/rbac';
import { MAX_MEMORIES, MemoryInput, type MemoryView } from '../../../shared/workspace';

/** At most this much memory text goes into a request (newest first). */
const MEMORY_PROMPT_CHARS = 6000;

type MemoryRow = typeof memories.$inferSelect;

const toView = (m: MemoryRow): MemoryView => ({
  id: m.id,
  content: m.content,
  createdAt: m.createdAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
});

/** The system message carrying the user's memories, or null when there are none. */
export async function memoryPrompt(db: Database, userId: string): Promise<string | null> {
  const rows = await db
    .select({ content: memories.content })
    .from(memories)
    .where(eq(memories.userId, userId))
    .orderBy(desc(memories.updatedAt))
    .limit(MAX_MEMORIES);
  const lines: string[] = [];
  let used = 0;
  for (const r of rows) {
    if (used + r.content.length > MEMORY_PROMPT_CHARS) break;
    lines.push(`- ${r.content.replace(/\s+/g, ' ')}`);
    used += r.content.length;
  }
  if (lines.length === 0) return null;
  return `The user asked you to remember these things about them. Use them when relevant; don't mention this list unless asked.\n${lines.join('\n')}`;
}

export async function memoryRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);
  const IdParams = z.object({ id: z.uuid() });

  app.get('/', async (req) => {
    const rows = await ctx.db
      .select()
      .from(memories)
      .where(eq(memories.userId, currentUser(req).id))
      .orderBy(desc(memories.updatedAt));
    return { memories: rows.map(toView) };
  });

  app.post('/', async (req, reply) => {
    const me = currentUser(req);
    const { content } = MemoryInput.parse(req.body);
    const [{ n }] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memories)
      .where(eq(memories.userId, me.id));
    if (Number(n) >= MAX_MEMORIES) throw badRequest(`You can keep at most ${MAX_MEMORIES} memories.`, 'too_many_memories');
    const [row] = await ctx.db.insert(memories).values({ id: uuidv7(), userId: me.id, content }).returning();
    reply.code(201);
    return { memory: toView(row) };
  });

  app.patch('/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { content } = MemoryInput.parse(req.body);
    const [row] = await ctx.db
      .update(memories)
      .set({ content, updatedAt: new Date() })
      .where(and(eq(memories.id, id), eq(memories.userId, currentUser(req).id)))
      .returning();
    if (!row) throw notFound('Memory');
    return { memory: toView(row) };
  });

  app.delete('/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const deleted = await ctx.db
      .delete(memories)
      .where(and(eq(memories.id, id), eq(memories.userId, currentUser(req).id)))
      .returning({ id: memories.id });
    if (deleted.length === 0) throw notFound('Memory');
    return { ok: true };
  });

  app.delete('/', async (req) => {
    await ctx.db.delete(memories).where(eq(memories.userId, currentUser(req).id));
    return { ok: true };
  });
}
