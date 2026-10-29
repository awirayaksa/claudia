import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { currentUser, requireUser } from '../auth/rbac';
import { AzdoConnectInput } from '../../shared/azdo';

const ServerParams = z.object({ serverId: z.uuid() });

/** /api/azdo — a user's connections to the admin's Azure DevOps Server collections. */
export async function azdoRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);

  app.get('/connections', async (req) => ({ connections: await ctx.azdo.connections(currentUser(req).id) }));

  app.put('/connections/:serverId', async (req) => {
    const { serverId } = ServerParams.parse(req.params);
    return { connection: await ctx.azdo.connect(currentUser(req).id, serverId, AzdoConnectInput.parse(req.body)) };
  });

  app.delete('/connections/:serverId', async (req) => {
    const { serverId } = ServerParams.parse(req.params);
    await ctx.azdo.disconnect(currentUser(req).id, serverId);
    return { ok: true };
  });
}
