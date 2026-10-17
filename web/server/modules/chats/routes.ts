import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { chats, folders } from '../../db/schema';
import { badRequest, notFound } from '../../lib/errors';
import { uuidv7 } from '../../lib/ids';
import { currentUser, requireUser } from '../../auth/rbac';
import {
  ChatListQuery,
  CompletionRequest,
  CreateChatRequest,
  FolderInput,
  LlmCompleteRequest,
  UpdateChatRequest,
  type ChatDetail,
} from '../../../shared/chats';
import { ChatRepo, toChatSummary, toFolder, toNode } from './repo';

const IdParams = z.object({ id: z.uuid() });

/** Per-user completion rate limit (completions and one-off LLM calls share it). */
function completionRateLimit(ctx: ServerContext) {
  return {
    rateLimit: {
      max: async () => (await ctx.settings.get('limits')).completionsPerMinute,
      timeWindow: '1 minute',
      keyGenerator: (req: any) => `completions:${req.user?.id ?? req.ip}`,
    },
  };
}

/** /api/chats */
export async function chatRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);
  const repo = new ChatRepo(ctx.db);

  app.get('/', async (req) => {
    const q = ChatListQuery.parse(req.query);
    const rows = await repo.list(currentUser(req).id, q);
    return { chats: rows.map(toChatSummary) };
  });

  app.post('/', async (req, reply) => {
    const me = currentUser(req);
    const body = CreateChatRequest.parse(req.body ?? {});
    if (body.folderId) await repo.folderOwned(me.id, body.folderId);
    const [row] = await ctx.db
      .insert(chats)
      .values({
        id: uuidv7(),
        userId: me.id,
        folderId: body.folderId ?? null,
        ...(body.title ? { title: body.title, titleSet: true } : {}),
        modelIds: body.modelIds ?? [],
      })
      .returning();
    reply.code(201);
    return { chat: toChatSummary(row) };
  });

  app.get('/:id', async (req): Promise<{ chat: ChatDetail }> => {
    const { id } = IdParams.parse(req.params);
    const chat = await repo.getOwned(currentUser(req).id, id);
    const nodes = (await repo.messages(chat.id)).map(toNode);
    return {
      chat: {
        ...toChatSummary(chat),
        currentLeafId: chat.currentLeafId,
        params: chat.params,
        messages: nodes,
        activeRuns: ctx.runs.activeForChat(chat.id).map((r) => ({ runId: r.id, lastSeq: r.events.length })),
      },
    };
  });

  app.patch('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const body = UpdateChatRequest.parse(req.body);
    const chat = await repo.getOwned(me.id, id);
    if (body.folderId) await repo.folderOwned(me.id, body.folderId);
    if (body.currentLeafId) {
      const nodes = await repo.messages(chat.id);
      if (!nodes.some((n) => n.id === body.currentLeafId)) throw badRequest('That message is not part of this chat.');
    }
    const [row] = await ctx.db
      .update(chats)
      .set({
        ...(body.title !== undefined ? { title: body.title, titleSet: true } : {}),
        ...(body.folderId !== undefined ? { folderId: body.folderId } : {}),
        ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
        ...(body.archived !== undefined ? { archived: body.archived } : {}),
        ...(body.currentLeafId !== undefined ? { currentLeafId: body.currentLeafId } : {}),
        ...(body.modelIds !== undefined ? { modelIds: body.modelIds } : {}),
        ...(body.params !== undefined ? { params: { ...chat.params, ...body.params } } : {}),
        updatedAt: new Date(),
      })
      .where(eq(chats.id, chat.id))
      .returning();
    return { chat: toChatSummary(row) };
  });

  app.delete('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const chat = await repo.getOwned(me.id, id);
    for (const run of ctx.runs.activeForChat(chat.id)) ctx.runs.stop(run);
    await ctx.db.delete(chats).where(eq(chats.id, chat.id));
    return { ok: true };
  });

  app.post('/:id/completions', { config: completionRateLimit(ctx) }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = CompletionRequest.parse(req.body);
    const result = await ctx.orchestrator.start(currentUser(req), id, body);
    reply.code(202);
    return result;
  });
}

/** /api/folders */
export async function folderRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);
  const repo = new ChatRepo(ctx.db);

  app.get('/', async (req) => ({ folders: (await repo.folders(currentUser(req).id)).map(toFolder) }));

  app.post('/', async (req, reply) => {
    const me = currentUser(req);
    const body = FolderInput.parse(req.body);
    if (body.parentId) await repo.folderOwned(me.id, body.parentId);
    const [row] = await ctx.db
      .insert(folders)
      .values({ id: uuidv7(), userId: me.id, name: body.name, parentId: body.parentId ?? null, systemPrompt: body.systemPrompt ?? null })
      .returning();
    reply.code(201);
    return { folder: toFolder(row) };
  });

  app.patch('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const body = FolderInput.partial().parse(req.body);
    await repo.folderOwned(me.id, id);
    if (body.parentId) {
      // No folder may end up inside itself
      const chain = await repo.folderChain(me.id, body.parentId);
      if (body.parentId === id || chain.some((f) => f.id === id)) throw badRequest('A folder cannot be moved into itself.');
    }
    const [row] = await ctx.db
      .update(folders)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        ...(body.systemPrompt !== undefined ? { systemPrompt: body.systemPrompt } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(folders.id, id), eq(folders.userId, me.id)))
      .returning();
    return { folder: toFolder(row) };
  });

  // Chats in the folder stay, moved out of it (folder_id is set null)
  app.delete('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    await repo.folderOwned(me.id, id);
    await ctx.db.delete(folders).where(and(eq(folders.id, id), eq(folders.userId, me.id)));
    return { ok: true };
  });
}

/** /api/runs — follow, stop and answer a run. */
export async function runRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);

  app.get('/:id/events', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const run = ctx.runs.getOwned(id, currentUser(req).id);
    const lastEventId = Number(req.headers['last-event-id']);
    const after = Number.isFinite(lastEventId)
      ? lastEventId
      : z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(req.query).after;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx: don't buffer the stream
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    let closed = false;
    // Replaying a finished run can reach run.completed inside subscribe(), before it returns
    let unsubscribe: () => void = () => {};
    const heartbeat = setInterval(() => !closed && res.write(': ping\n\n'), 15_000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };
    unsubscribe = ctx.runs.subscribe(run, after, (envelope) => {
      if (closed) return;
      res.write(`id: ${envelope.seq}\nevent: run\ndata: ${JSON.stringify(envelope)}\n\n`);
      if (envelope.event.type === 'run.completed') close();
    });
    if (closed) unsubscribe();
    else if (run.done) close();
    req.raw.on('close', close);
  });

  app.post('/:id/stop', async (req) => {
    const { id } = IdParams.parse(req.params);
    ctx.runs.stop(ctx.runs.getOwned(id, currentUser(req).id));
    return { ok: true };
  });

  // Answer to tool.client_request (browser-executed tools, Phase 5)
  app.post('/:id/tool-results', async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = z
      .object({ callId: z.string().min(1), content: z.string().max(1_000_000), isError: z.boolean().optional() })
      .parse(req.body);
    const run = ctx.runs.getOwned(id, currentUser(req).id);
    if (!ctx.runs.submitClientTool(run, body.callId, { content: body.content, isError: body.isError })) {
      throw notFound('Pending tool call');
    }
    return { ok: true };
  });
}

/** /api/llm — one-off completions for UI features (suggested prompts, Explain/Ask). */
export async function llmRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);

  app.post('/complete', { config: completionRateLimit(ctx) }, async (req) => {
    const me = currentUser(req);
    const body = LlmCompleteRequest.parse(req.body);
    const target = await ctx.models.resolve(body.model, me.role, me.id);
    const response = await target.provider.chatCompletion({
      model: target.providerModelId,
      messages: body.messages,
      stream: false,
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.maxTokens !== undefined ? { max_tokens: body.maxTokens } : {}),
    });
    const content = response.choices[0]?.message?.content;
    return { text: typeof content === 'string' ? content : '' };
  });
}
