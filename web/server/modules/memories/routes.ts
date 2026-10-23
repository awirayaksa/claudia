/**
 * /api/me/memories — what chats know about the user. They are injected as
 * one system message (see `MemoryStore.prompt`), the closest ones first
 * when there are many and embeddings are on.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { badRequest } from '../../lib/errors';
import { currentUser, requireUser } from '../../auth/rbac';
import { MemoryImportInput, MemoryInput } from '../../../shared/workspace';
import type { Principal } from '../../auth/access';
import { toMemoryView } from './store';

export async function memoryRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);
  const IdParams = z.object({ id: z.uuid() });
  // A project memory belongs to a folder the user can use (theirs, or shared with them)
  const checkFolder = async (user: Principal, folderId: string | null | undefined) => {
    if (!folderId) return;
    if (!(await ctx.folders.rights(user, folderId))) throw badRequest('That folder was not found.', 'folder_not_found');
  };

  app.get('/', async (req) => ({ memories: (await ctx.memories.list(currentUser(req).id)).map(toMemoryView) }));

  app.post('/', async (req, reply) => {
    const me = currentUser(req);
    const input = MemoryInput.parse(req.body);
    await checkFolder(me, input.folderId);
    const { memory } = await ctx.memories.add(me.id, { ...input, source: 'user' });
    reply.code(201);
    return { memory: toMemoryView(memory) };
  });

  app.patch('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const input = MemoryInput.parse(req.body);
    await checkFolder(me, input.folderId);
    const { memory } = await ctx.memories.update(me.id, id, input);
    return { memory: toMemoryView(memory) };
  });

  app.delete('/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    await ctx.memories.remove(currentUser(req).id, id);
    return { ok: true };
  });

  app.delete('/', async (req) => {
    await ctx.memories.clear(currentUser(req).id);
    return { ok: true };
  });

  // Another assistant's memory export, sorted into topics
  app.post('/import', async (req) => {
    const { text } = MemoryImportInput.parse(req.body);
    return ctx.memoryLearner.importText(currentUser(req).id, text);
  });

  // Undo a change the model made (the chip under a reply)
  app.post('/changes/:id/undo', async (req) => {
    const { id } = IdParams.parse(req.params);
    return { change: await ctx.memories.undo(currentUser(req).id, id) };
  });
}
