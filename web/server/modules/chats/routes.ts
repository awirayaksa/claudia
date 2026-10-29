import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { arenaVotes, chats, folders, messages } from '../../db/schema';
import { ArenaVoteInput, type ArenaVoteResult } from '../../../shared/arena';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import type { AuthUser } from '../../auth/sessions';
import { registerAccessRoutes } from '../workspace/access-routes';
import { uuidv7 } from '../../lib/ids';
import { currentUser, requireUser } from '../../auth/rbac';
import {
  ChatListQuery,
  CompletionRequest,
  CreateChatRequest,
  FeedbackRequest,
  FolderInput,
  ForkRequest,
  ImportRequest,
  LlmCompleteRequest,
  UpdateChatRequest,
  type ChatDetail,
} from '../../../shared/chats';
import { ChatRepo, maskArena, pathTo, toChatSummary, toFolder, toNode, toShareView } from './repo';
import { chatToMarkdown } from '../../../../src/services/chat/chat-markdown';
import { ChatTransfer, dropNulls } from './transfer';
import { readableKbIds } from '../../rag/sources';

/** Imports arrive in batches of chats; one batch may be this large. */
const IMPORT_BODY_LIMIT = 16 * 1024 * 1024;

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
  const transfer = new ChatTransfer(ctx.db);

  app.get('/', async (req) => {
    const q = ChatListQuery.parse(req.query);
    const rows = await repo.list(currentUser(req).id, q);
    return { chats: rows.map((r) => ({ ...toChatSummary(r), ...(r.match ? { match: r.match } : {}) })) };
  });

  app.get('/tags', async (req) => ({ tags: await repo.tags(currentUser(req).id) }));

  app.post('/', async (req, reply) => {
    const me = currentUser(req);
    const body = CreateChatRequest.parse(req.body ?? {});
    if (body.temporary) await ctx.access.require(me, 'chat.temporary');
    // One's own folder, or one shared with one (the chat stays one's own)
    if (body.folderId) await ctx.folders.get(me, body.folderId);
    const [row] = await ctx.db
      .insert(chats)
      .values({
        id: uuidv7(),
        userId: me.id,
        folderId: body.folderId ?? null,
        ...(body.title ? { title: body.title, titleSet: true } : {}),
        modelIds: body.modelIds ?? [],
        temporary: body.temporary ?? false,
      })
      .returning();
    reply.code(201);
    return { chat: toChatSummary(row) };
  });

  // Every (non-temporary) chat of the user, as Claudia JSON
  app.get('/export', async (req, reply) => {
    await ctx.access.require(currentUser(req), 'chat.export');
    const data = await transfer.exportChats(currentUser(req).id);
    reply.header('Content-Disposition', `attachment; filename="claudia-chats-${new Date().toISOString().slice(0, 10)}.json"`);
    return data;
  });

  // Claudia JSON; the client converts other formats first and sends them in batches
  app.post('/import', { bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
    const body = ImportRequest.parse(req.body);
    const result = await transfer.importChats(currentUser(req).id, body.chats);
    reply.code(201);
    return result;
  });

  app.get('/:id', async (req): Promise<{ chat: ChatDetail }> => {
    const { id } = IdParams.parse(req.params);
    const chat = await repo.getOwned(currentUser(req).id, id);
    const nodes = maskArena((await repo.messages(chat.id)).map(toNode));
    const share = await repo.share(chat.id);
    return {
      chat: {
        ...toChatSummary(chat),
        currentLeafId: chat.currentLeafId,
        params: chat.params,
        messages: nodes,
        activeRuns: (await ctx.runs.activeForChat(chat.id)).map((r) => ({ runId: r.id, lastSeq: r.lastSeq })),
        share: share ? toShareView(share) : null,
      },
    };
  });

  app.patch('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const body = UpdateChatRequest.parse(req.body);
    const chat = await repo.getOwned(me.id, id);
    if (body.folderId) await ctx.folders.get(me, body.folderId);
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
        ...(body.temporary !== undefined ? { temporary: body.temporary } : {}),
        ...(body.tags !== undefined ? { tags: [...new Set(body.tags)] } : {}),
        ...(body.currentLeafId !== undefined ? { currentLeafId: body.currentLeafId } : {}),
        ...(body.modelIds !== undefined ? { modelIds: body.modelIds } : {}),
        ...(body.params !== undefined ? { params: dropNulls({ ...chat.params, ...body.params }) } : {}),
        // Switching versions isn't activity: the chat keeps its place in the list
        ...(Object.keys(body).some((k) => k !== 'currentLeafId') ? { updatedAt: new Date() } : {}),
      })
      .where(eq(chats.id, chat.id))
      .returning();
    return { chat: toChatSummary(row) };
  });

  app.delete('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const chat = await repo.getOwned(me.id, id);
    for (const run of await ctx.runs.activeForChat(chat.id)) await ctx.runs.stop(run);
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

  // Rating (and an optional comment) of one reply
  // A blind comparison's vote: records it and reveals the two models
  app.post('/:id/messages/:messageId/arena-vote', async (req): Promise<ArenaVoteResult> => {
    const me = currentUser(req);
    const { id, messageId } = z.object({ id: z.uuid(), messageId: z.uuid() }).parse(req.params);
    const { winner } = ArenaVoteInput.parse(req.body);
    const chat = await repo.getOwned(me.id, id);
    const [turn] = await ctx.db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.chatId, chat.id), eq(messages.role, 'user')));
    const pair = turn?.meta?.arena;
    if (!turn || !pair) throw notFound('Comparison');
    if (pair.winner) throw conflict('You already voted on this comparison.', 'arena_voted');
    const replies = await ctx.db.select({ status: messages.status }).from(messages).where(eq(messages.parentId, turn.id));
    if (replies.some((r) => r.status === 'streaming')) throw badRequest('Wait for both replies first.', 'arena_busy');
    await ctx.db.transaction(async (tx) => {
      await tx.insert(arenaVotes).values({ id: uuidv7(), userId: me.id, chatId: chat.id, userMessageId: turn.id, modelA: pair.models[0], modelB: pair.models[1], winner });
      await tx
        .update(messages)
        .set({ meta: { ...turn.meta, arena: { ...pair, winner }, models: [...pair.models] } })
        .where(eq(messages.id, turn.id));
    });
    return { winner, models: pair.models };
  });

  app.put('/:id/messages/:messageId/feedback', async (req) => {
    const me = currentUser(req);
    const { id, messageId } = z.object({ id: z.uuid(), messageId: z.uuid() }).parse(req.params);
    const body = FeedbackRequest.parse(req.body);
    const chat = await repo.getOwned(me.id, id);
    const withText = body.rating !== null && (!!body.comment || !!body.reasons?.length);
    const [row] = await ctx.db
      .update(messages)
      .set({
        rating: body.rating,
        feedback: withText
          ? {
              ...(body.comment ? { comment: body.comment } : {}),
              ...(body.reasons?.length ? { reasons: body.reasons } : {}),
              at: new Date().toISOString(),
            }
          : null,
      })
      .where(and(eq(messages.id, messageId), eq(messages.chatId, chat.id), eq(messages.role, 'assistant')))
      .returning({ id: messages.id });
    if (!row) throw notFound('Reply');
    return { ok: true };
  });

  // A new chat with the path up to one message
  app.post('/:id/fork', async (req, reply) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const { messageId } = ForkRequest.parse(req.body);
    const chat = await repo.getOwned(me.id, id);
    const nodes = await repo.messages(chat.id);
    if (!nodes.some((n) => n.id === messageId)) throw badRequest('That message is not part of this chat.');
    const forked = await transfer.fork(me.id, chat, messageId);
    reply.code(201);
    return { chat: toChatSummary(forked) };
  });

  // One chat: Claudia JSON (every branch, re-importable), or the shown branch as Markdown or PDF
  app.get('/:id/export', async (req, reply) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const { format } = z.object({ format: z.enum(['json', 'md', 'pdf']).default('json') }).parse(req.query);
    await ctx.access.require(me, 'chat.export');
    if (format === 'json') {
      const data = await transfer.exportChats(me.id, [id]);
      reply.header('Content-Disposition', 'attachment; filename="claudia-chat.json"');
      return data;
    }
    const chat = await repo.getOwned(me.id, id);
    const path = pathTo(maskArena((await repo.messages(chat.id)).map(toNode)), chat.currentLeafId).filter((n) => n.status !== 'streaming');
    const names = new Map((await ctx.models.forUser(me)).map((m) => [m.id, m.name]));
    const base = chat.title.replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 80) || 'chat';
    const filename = (ext: string) => `attachment; filename="${base.replace(/[^\x20-\x7e]/g, '_')}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`;
    if (format === 'md') {
      reply.header('Content-Type', 'text/markdown; charset=utf-8').header('Content-Disposition', filename('md'));
      return chatToMarkdown({ title: chat.title, path, modelName: (m) => names.get(m) ?? m });
    }
    // PDF: the user's images are embedded (up to 20, 5 MB each)
    const imageIds = [...new Set(path.flatMap((n) => n.parts.flatMap((p) => (p.type === 'file' && p.mime.startsWith('image/') && p.fileId ? [p.fileId] : []))))].slice(0, 20);
    const images: Record<string, string> = {};
    for (const row of await ctx.files.ownedByIds(me.id, imageIds)) {
      if (row.size > 5 * 1024 * 1024) continue;
      const data = await ctx.files.content(row).catch(() => null);
      if (data) images[`image-${row.id}`] = `data:${row.mime};base64,${data.toString('base64')}`;
    }
    const markdown = chatToMarkdown({
      title: chat.title,
      path,
      modelName: (m) => names.get(m) ?? m,
      folding: 'quote',
      imageRef: (f) => (images[`image-${f.fileId}`] ? `image-${f.fileId}` : null),
    });
    const pdf = await ctx.extract.renderMarkdownPdf(markdown, { pageSize: 'A4', landscape: false, title: chat.title }, images);
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', filename('pdf'));
    return reply.send(pdf);
  });

  // Create the share link, or refresh its snapshot
  app.post('/:id/share', async (req, reply) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    await ctx.access.require(me, 'chat.share');
    const chat = await repo.getOwned(me.id, id);
    if (chat.temporary) throw badRequest('Keep the chat before sharing it.', 'chat_temporary');
    const share = await ctx.shares.upsert(me.id, chat);
    reply.code(201);
    return { share: toShareView(share) };
  });

  app.delete('/:id/share', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const chat = await repo.getOwned(me.id, id);
    await ctx.shares.revokeForChat(chat.id);
    return { ok: true };
  });
}

/** /api/folders */
export async function folderRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);
  const repo = new ChatRepo(ctx.db);

  app.get('/', async (req) => {
    const visible = await ctx.folders.visible(currentUser(req));
    const shared = await ctx.folders.withGrants(visible.filter((f) => f.rights.manage).map((f) => f.row.id));
    return {
      folders: visible.map((f) =>
        toFolder(f.row, { ownerName: f.ownerName, canEdit: f.rights.write, canManage: f.rights.manage, shared: shared.has(f.row.id) })
      ),
    };
  });

  const asSeen = async (me: AuthUser, row: typeof folders.$inferSelect) => {
    const found = await ctx.folders.get(me, row.id);
    const shared = found.rights.manage ? await ctx.folders.withGrants([row.id]) : new Set<string>();
    return toFolder(row, { canEdit: found.rights.write, canManage: found.rights.manage, shared: shared.has(row.id) });
  };

  app.post('/', async (req, reply) => {
    const me = currentUser(req);
    const body = FolderInput.parse(req.body);
    // Subfolders go in one's own folders only
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
    const { row: current, rights } = await ctx.folders.get(me, id);
    if (!rights.write) throw forbidden('You can use this folder but not change it.', 'read_only');
    // Moving is the owner's
    if (body.parentId !== undefined && !rights.manage) throw forbidden('Only the owner can move this folder.', 'not_owner');
    if (body.parentId) await repo.folderOwned(me.id, body.parentId);
    // Only knowledge bases the user can read
    const knowledgeIds =
      body.knowledgeIds === undefined
        ? undefined
        : await readableKbIds(ctx.db, body.knowledgeIds, async (kb) => (await ctx.access.rights(me, 'knowledge', kb)).read);
    if (knowledgeIds && body.knowledgeIds && knowledgeIds.length !== new Set(body.knowledgeIds).size) {
      throw badRequest('A knowledge base was not found.', 'kb_not_found');
    }
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
        ...(knowledgeIds !== undefined ? { knowledgeIds } : {}),
        updatedAt: new Date(),
      })
      .where(eq(folders.id, current.id))
      .returning();
    return { folder: await asSeen(me, row) };
  });

  // Chats in the folder stay, moved out of it (folder_id is set null)
  app.delete('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    await repo.folderOwned(me.id, id);
    // Its subfolders go with it, so do their grants
    const ids = [id, ...(await ctx.folders.descendants(id))];
    await ctx.db.delete(folders).where(and(eq(folders.id, id), eq(folders.userId, me.id)));
    for (const fid of ids) await ctx.access.removeResource('folder', fid);
    return { ok: true };
  });

  // Who else may use it (viewers) or also change it (editors); the owner's to decide
  registerAccessRoutes(app, ctx, 'folder', 'Folder', async (id) => {
    const [row] = await ctx.db.select({ id: folders.id, ownerId: folders.userId }).from(folders).where(eq(folders.id, id));
    return row;
  });
}

/** /api/runs — follow, stop and answer a run. */
export async function runRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);

  app.get('/:id/events', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const run = await ctx.runs.find(id, currentUser(req).id);
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
    req.raw.on('close', close);
    unsubscribe = await ctx.runs.subscribe(run, after, (envelope) => {
      if (closed) return;
      res.write(`id: ${envelope.seq}\nevent: run\ndata: ${JSON.stringify(envelope)}\n\n`);
      if (envelope.event.type === 'run.completed') close();
    });
    if (closed) unsubscribe();
    else if (run.done) close();
  });

  app.post('/:id/stop', async (req) => {
    const { id } = IdParams.parse(req.params);
    await ctx.runs.stop(await ctx.runs.find(id, currentUser(req).id));
    return { ok: true };
  });

  // Answer to tool.client_request (browser-executed tools, Phase 5)
  app.post('/:id/tool-results', async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = z
      .object({
        callId: z.string().min(1),
        content: z.string().max(1_000_000),
        isError: z.boolean().optional(),
        // Files the code wrote, already uploaded to /api/files (shown under the reply)
        fileIds: z.array(z.uuid()).max(20).optional(),
      })
      .parse(req.body);
    const run = await ctx.runs.find(id, currentUser(req).id);
    const result = { content: body.content, isError: body.isError, ...(body.fileIds?.length ? { fileIds: body.fileIds } : {}) };
    if (!(await ctx.runs.submitClientTool(run, body.callId, result))) {
      throw notFound('Pending tool call');
    }
    return { ok: true };
  });

  // Answer to tool.approval_request (tools that change data elsewhere)
  app.post('/:id/approvals', async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = z.object({ callId: z.string().min(1).max(200), approved: z.boolean() }).parse(req.body);
    const run = await ctx.runs.find(id, currentUser(req).id);
    if (!(await ctx.runs.submitApproval(run, body.callId, body.approved))) throw notFound('Pending tool call');
    return { ok: true };
  });
}

/** /api/llm — one-off completions for UI features (suggested prompts, Explain/Ask). */
export async function llmRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);

  app.post('/complete', { config: completionRateLimit(ctx) }, async (req) => {
    const me = currentUser(req);
    const body = LlmCompleteRequest.parse(req.body);
    await ctx.usage.check(me);
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
