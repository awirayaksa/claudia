/**
 * /api/knowledge — knowledge bases: private until shared (access grants,
 * like models and prompts). Files are uploaded with /api/files first, then
 * added here; each is processed by a background job with progress on the
 * WebSocket topic "kb:<id>".
 *
 * /api/admin/rag — embedding, retrieval and web search settings.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { files, kbFiles, kbSources, knowledgeBases, users } from '../../db/schema';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { uuidv7 } from '../../lib/ids';
import { parsePatch } from '../../lib/validation';
import { currentUser, requireAdmin, requireUser } from '../../auth/rbac';
import type { Principal } from '../../auth/access';
import { registerAccessRoutes } from '../workspace/access-routes';
import { GitHubSourceInput, KnowledgeInput, RagSettingsUpdate, type KbFileView, type KnowledgeDetail, type KnowledgeView } from '../../../shared/knowledge';
import { toSourceView } from '../../rag/github-source';

const IdParams = z.object({ id: z.uuid() });
const MAX_FILES = 1000;
/** Repositories one knowledge base syncs. */
const MAX_SOURCES = 10;

type KbRow = typeof knowledgeBases.$inferSelect;

function toView(kb: KbRow, ownerName: string, fileCount: number, access: { write: boolean; manage: boolean }): KnowledgeView {
  return {
    id: kb.id,
    ownerId: kb.ownerId,
    ownerName,
    name: kb.name,
    description: kb.description,
    chunkSize: kb.chunkSize,
    chunkOverlap: kb.chunkOverlap,
    fullContext: kb.fullContext,
    embedModel: kb.embedModel,
    fileCount,
    access: { write: access.write, manage: access.manage },
    updatedAt: kb.updatedAt.toISOString(),
  };
}

const fileCount = sql<number>`(select count(*)::int from ${kbFiles} where ${kbFiles.kbId} = ${knowledgeBases.id})`;

export async function knowledgeRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);

  const load = async (id: string) => {
    const [row] = await ctx.db
      .select({ kb: knowledgeBases, ownerName: users.name, files: fileCount })
      .from(knowledgeBases)
      .innerJoin(users, eq(users.id, knowledgeBases.ownerId))
      .where(eq(knowledgeBases.id, id));
    return row;
  };
  const loadFor = async (me: Principal, id: string) => {
    const row = await load(id);
    if (!row) throw notFound('Knowledge base');
    const rights = await ctx.access.rights(me, 'knowledge', row.kb);
    if (!rights.read) throw notFound('Knowledge base');
    return { ...row, rights };
  };
  const writable = async (me: Principal, id: string) => {
    const row = await loadFor(me, id);
    if (!row.rights.write) throw forbidden('You can use this knowledge base but not change it.', 'read_only');
    return row;
  };

  app.get('/', async (req) => {
    const me = currentUser(req);
    const rows = await ctx.db
      .select({ kb: knowledgeBases, ownerName: users.name, files: fileCount })
      .from(knowledgeBases)
      .innerJoin(users, eq(users.id, knowledgeBases.ownerId))
      .where(ctx.access.visibleSql(me, 'knowledge', knowledgeBases.id, knowledgeBases.ownerId))
      .orderBy(asc(knowledgeBases.name));
    const rights = await ctx.access.rightsMany(me, 'knowledge', rows.map((r) => r.kb));
    return { knowledge: rows.map((r) => toView(r.kb, r.ownerName, Number(r.files), rights.get(r.kb.id)!)) };
  });

  app.get('/:id', async (req): Promise<{ knowledge: KnowledgeDetail }> => {
    const { id } = IdParams.parse(req.params);
    const row = await loadFor(currentUser(req), id);
    const list = await ctx.db
      .select({ link: kbFiles, name: files.name, mime: files.mime, size: files.size })
      .from(kbFiles)
      .innerJoin(files, eq(files.id, kbFiles.fileId))
      .where(eq(kbFiles.kbId, id))
      .orderBy(asc(kbFiles.createdAt));
    const fileViews: KbFileView[] = list.map((f) => ({
      fileId: f.link.fileId,
      name: f.name,
      mime: f.mime,
      size: f.size,
      status: f.link.status,
      error: f.link.error,
      chunks: f.link.chunkCount,
      addedAt: f.link.createdAt.toISOString(),
    }));
    const sources = await ctx.db.select().from(kbSources).where(eq(kbSources.kbId, id)).orderBy(asc(kbSources.createdAt));
    return { knowledge: { ...toView(row.kb, row.ownerName, Number(row.files), row.rights), files: fileViews, sources: sources.map(toSourceView) } };
  });

  // ─── Sources: a GitHub repository, synced into the knowledge base ──────────

  const sourceOf = async (kbId: string, sourceId: string) => {
    const [source] = await ctx.db.select().from(kbSources).where(and(eq(kbSources.id, sourceId), eq(kbSources.kbId, kbId)));
    if (!source) throw notFound('Source');
    return source;
  };

  app.post('/:id/sources', async (req, reply) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    await writable(me, id);
    const body = GitHubSourceInput.parse(req.body);
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(kbSources).where(eq(kbSources.kbId, id));
    if (Number(n) >= MAX_SOURCES) throw badRequest(`A knowledge base can sync at most ${MAX_SOURCES} repositories.`, 'too_many_sources');
    const [source] = await ctx.db
      .insert(kbSources)
      .values({
        id: uuidv7(),
        kbId: id,
        kind: 'github',
        config: { repo: body.repo, ref: body.ref || null, paths: body.paths, apiUrl: body.apiUrl ?? null },
        tokenCipher: body.token ? ctx.secrets.encrypt(body.token) : null,
        createdBy: me.id,
      })
      .returning();
    await ctx.kbSources.queue(source.id);
    reply.code(202);
    return { source: toSourceView(source) };
  });

  // Pull the latest commit (nothing changes if the repository didn't)
  app.post('/:id/sources/:sourceId/sync', async (req, reply) => {
    const { id, sourceId } = z.object({ id: z.uuid(), sourceId: z.uuid() }).parse(req.params);
    await writable(currentUser(req), id);
    await sourceOf(id, sourceId);
    await ctx.kbSources.queue(sourceId);
    reply.code(202);
    return { ok: true };
  });

  // The source goes, and so do the files it brought in
  app.delete('/:id/sources/:sourceId', async (req) => {
    const { id, sourceId } = z.object({ id: z.uuid(), sourceId: z.uuid() }).parse(req.params);
    const row = await writable(currentUser(req), id);
    await ctx.kbSources.remove(await sourceOf(id, sourceId), row.kb.ownerId);
    return { ok: true };
  });

  app.post('/', async (req, reply) => {
    const me = currentUser(req);
    await ctx.access.require(me, 'workspace.knowledge');
    const body = KnowledgeInput.parse(req.body);
    const [kb] = await ctx.db
      .insert(knowledgeBases)
      .values({ id: uuidv7(), ownerId: me.id, ...body, embedModel: await ctx.rag.embedderKey() })
      .returning();
    reply.code(201);
    return { knowledge: toView(kb, me.name, 0, { write: true, manage: true }) };
  });

  app.patch('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const row = await writable(me, id);
    const body = parsePatch(KnowledgeInput, req.body);
    const [kb] = await ctx.db
      .update(knowledgeBases)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(knowledgeBases.id, id))
      .returning();
    const rechunk =
      (body.chunkSize !== undefined && body.chunkSize !== row.kb.chunkSize) ||
      (body.chunkOverlap !== undefined && body.chunkOverlap !== row.kb.chunkOverlap);
    if (rechunk) await ctx.jobs.enqueue('kb.reindex', { kbId: id });
    return { knowledge: toView(kb, row.ownerName, Number(row.files), row.rights) };
  });

  app.delete('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const row = await loadFor(me, id);
    if (!row.rights.manage) throw forbidden('Only the owner can delete this knowledge base.', 'not_owner');
    await ctx.db.delete(knowledgeBases).where(eq(knowledgeBases.id, id));
    await ctx.access.removeResource('knowledge', id);
    return { ok: true };
  });

  // Add one of your uploaded files
  app.post('/:id/files', async (req, reply) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const { fileId } = z.object({ fileId: z.uuid() }).parse(req.body);
    const row = await writable(me, id);
    await ctx.files.getOwned(me.id, fileId);
    if (Number(row.files) >= MAX_FILES) throw badRequest(`A knowledge base holds at most ${MAX_FILES} files.`, 'too_many_files');
    const inserted = await ctx.db
      .insert(kbFiles)
      .values({ kbId: id, fileId, addedBy: me.id })
      .onConflictDoNothing()
      .returning({ fileId: kbFiles.fileId });
    if (inserted.length === 0) throw conflict('This file is already in the knowledge base.', 'file_exists');
    await ctx.knowledge.queue(id, fileId);
    reply.code(202);
    return { ok: true };
  });

  app.delete('/:id/files/:fileId', async (req) => {
    const me = currentUser(req);
    const { id, fileId } = z.object({ id: z.uuid(), fileId: z.uuid() }).parse(req.params);
    await writable(me, id);
    const deleted = await ctx.db
      .delete(kbFiles)
      .where(and(eq(kbFiles.kbId, id), eq(kbFiles.fileId, fileId)))
      .returning({ fileId: kbFiles.fileId });
    if (deleted.length === 0) throw notFound('File');
    // Its passages go too (chunks of this file in this knowledge base)
    await ctx.db.execute(sql`delete from chunks where kb_id = ${id}::uuid and file_id = ${fileId}::uuid`);
    return { ok: true };
  });

  app.post('/:id/reindex', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    await writable(currentUser(req), id);
    await ctx.jobs.enqueue('kb.reindex', { kbId: id });
    reply.code(202);
    return { ok: true };
  });

  // "Try a query": what a chat would get from this knowledge base
  app.post('/:id/search', async (req) => {
    const { id } = IdParams.parse(req.params);
    await loadFor(currentUser(req), id);
    const { query, k } = z.object({ query: z.string().trim().min(1).max(2000), k: z.number().int().min(1).max(50).optional() }).parse(req.body);
    return { hits: await ctx.knowledge.search([id], query, k) };
  });

  registerAccessRoutes(app, ctx, 'knowledge', 'Knowledge base', async (id) => (await load(id))?.kb);
}

export async function adminRagRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => ctx.rag.view());

  app.put('/', async (req) => {
    const patch = RagSettingsUpdate.parse(req.body);
    const { view, embeddingChanged } = await ctx.rag.update(patch);
    // Vectors of another model can't be compared: everything is embedded again
    if (embeddingChanged) await ctx.jobs.enqueue('rag.reindex-all', {});
    return { ...view, reindexing: embeddingChanged };
  });

  app.post('/test-embeddings', async () => {
    const embedder = await ctx.rag.embedder();
    if (!embedder) return { ok: false, error: 'Embeddings are off: knowledge uses keyword search only.', dims: null };
    try {
      const [v] = await embedder.embed(['Claudia embedding test']);
      return { ok: true, error: null, dims: v.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), dims: null };
    }
  });
}
