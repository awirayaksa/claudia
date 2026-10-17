import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import type { ResourceType } from '../../db/schema';
import { currentUser } from '../../auth/rbac';
import { forbidden, notFound } from '../../lib/errors';
import { SetGrantsRequest } from '../../../shared/access';

/**
 * GET/PUT /:id/access for a workspace item type: who else may use it. Only
 * its owner and admins see or change this.
 */
export function registerAccessRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  type: ResourceType,
  what: string,
  load: (id: string) => Promise<{ id: string; ownerId: string } | undefined>
): void {
  const manageable = async (req: Parameters<typeof currentUser>[0], id: string) => {
    const me = currentUser(req);
    const item = await load(id);
    if (!item) throw notFound(what);
    const rights = await ctx.access.rights(me, type, item);
    if (!rights.read) throw notFound(what);
    if (!rights.manage) throw forbidden('Only the owner can change who has access.', 'not_owner');
    return { me, item };
  };

  app.get('/:id/access', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await manageable(req, id);
    return { grants: await ctx.access.grants(type, id) };
  });

  app.put('/:id/access', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { me } = await manageable(req, id);
    const { grants } = SetGrantsRequest.parse(req.body);
    return { grants: await ctx.access.setGrants(me, type, id, grants) };
  });
}
