/**
 * /api/workspace/models — the model builder: a base model with its own
 * system prompt, parameters, tools and starter prompts, private until its
 * owner shares it. A shared model runs on its owner's model access, so a
 * group can be given an assistant without being given the raw model.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { customModels, users } from '../../db/schema';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { uuidv7 } from '../../lib/ids';
import { parsePatch } from '../../lib/validation';
import { currentUser, requireUser } from '../../auth/rbac';
import type { Principal } from '../../auth/access';
import type { CustomModelRow } from '../../llm/model-registry';
import { CustomModelInput, customModelKey, type CustomModelView } from '../../../shared/workspace';
import { registerAccessRoutes } from './access-routes';
import { readableKbIds } from '../../rag/sources';

const IdParams = z.object({ id: z.uuid() });

function toView(row: CustomModelRow, ownerName: string, access: { write: boolean; manage: boolean }): CustomModelView {
  return {
    id: row.id,
    key: customModelKey(row.id),
    ownerId: row.ownerId,
    ownerName,
    name: row.name,
    description: row.description,
    baseModelId: row.baseModelId,
    systemPrompt: row.systemPrompt,
    params: row.params,
    toolIds: row.toolIds,
    knowledgeIds: row.knowledgeIds,
    suggestions: row.suggestions,
    active: row.active,
    access: { write: access.write, manage: access.manage },
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function workspaceModelRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);

  const load = async (id: string) => {
    const [row] = await ctx.db
      .select({ model: customModels, ownerName: users.name })
      .from(customModels)
      .innerJoin(users, eq(users.id, customModels.ownerId))
      .where(eq(customModels.id, id));
    return row;
  };

  const loadFor = async (me: Principal, id: string) => {
    const row = await load(id);
    if (!row) throw notFound('Model');
    const rights = await ctx.access.rights(me, 'model', row.model);
    if (!rights.read) throw notFound('Model');
    return { ...row, rights };
  };

  /**
   * The base model must be a global model that both the editor and the
   * owner may use (the model runs with the owner's access); tools must be
   * servers the editor can see.
   */
  const validate = async (me: Principal, ownerId: string, input: Pick<CustomModelInput, 'baseModelId' | 'toolIds' | 'knowledgeIds'>) => {
    const mine = await ctx.models.allowedGlobal(me);
    if (!mine.some((m) => m.id === input.baseModelId)) {
      throw badRequest('Choose a base model you can use (not a personal or custom one).', 'invalid_base_model');
    }
    if (ownerId !== me.id) {
      const owners = await ctx.models.baseModelsByOwner([ownerId]);
      if (!owners.get(ownerId)?.some((m) => m.id === input.baseModelId)) {
        throw badRequest("The model's owner can't use this base model.", 'invalid_base_model');
      }
    }
    if (input.toolIds.length > 0) {
      const visible = new Set((await ctx.mcp.serversFor(me.id)).map((s) => s.id));
      const unknown = input.toolIds.filter((id) => !visible.has(id));
      if (unknown.length > 0) throw badRequest('One of the tool servers is not available.', 'invalid_tool');
    }
    // The model searches them with its owner's access, so both must be able to read them
    if (input.knowledgeIds.length > 0) {
      const [owner] = await ctx.db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, ownerId));
      const ok = await readableKbIds(ctx.db, input.knowledgeIds, async (kb) =>
        (await ctx.access.rights(me, 'knowledge', kb)).read && !!owner && (await ctx.access.rights(owner, 'knowledge', kb)).read
      );
      if (ok.length !== new Set(input.knowledgeIds).size) throw badRequest('One of the knowledge bases is not available.', 'invalid_knowledge');
    }
  };

  app.get('/', async (req) => {
    const me = currentUser(req);
    const rows = await ctx.db
      .select({ model: customModels, ownerName: users.name })
      .from(customModels)
      .innerJoin(users, eq(users.id, customModels.ownerId))
      .where(ctx.access.visibleSql(me, 'model', customModels.id, customModels.ownerId))
      .orderBy(asc(customModels.name));
    const rights = await ctx.access.rightsMany(me, 'model', rows.map((r) => r.model));
    return { models: rows.map((r) => toView(r.model, r.ownerName, rights.get(r.model.id)!)) };
  });

  app.get('/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const row = await loadFor(currentUser(req), id);
    return { model: toView(row.model, row.ownerName, row.rights) };
  });

  app.post('/', async (req, reply) => {
    const me = currentUser(req);
    await ctx.access.require(me, 'workspace.models');
    const body = CustomModelInput.parse(req.body);
    await validate(me, me.id, body);
    const [row] = await ctx.db
      .insert(customModels)
      .values({ id: uuidv7(), ownerId: me.id, ...body })
      .returning();
    reply.code(201);
    return { model: toView(row, me.name, { write: true, manage: true }) };
  });

  app.patch('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const existing = await loadFor(me, id);
    if (!existing.rights.write) throw forbidden('You can use this model but not change it.', 'read_only');
    const body = parsePatch(CustomModelInput, req.body);
    const merged = { ...existing.model, ...body };
    if (body.baseModelId !== undefined || body.toolIds !== undefined || body.knowledgeIds !== undefined) {
      await validate(me, existing.model.ownerId, merged);
    }
    const [row] = await ctx.db
      .update(customModels)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(customModels.id, id))
      .returning();
    return { model: toView(row, existing.ownerName, existing.rights) };
  });

  app.delete('/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const existing = await loadFor(me, id);
    if (!existing.rights.manage) throw forbidden('Only the owner can delete this model.', 'not_owner');
    await ctx.db.delete(customModels).where(and(eq(customModels.id, id)));
    await ctx.access.removeResource('model', id);
    return { ok: true };
  });

  registerAccessRoutes(app, ctx, 'model', 'Model', async (id) => (await load(id))?.model);
}
