/** /api/admin/code — whether the server sandbox is set up, and a test run. */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireAdmin } from '../auth/rbac';

export async function adminCodeRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => ({ dockerConfigured: ctx.code.configured }));

  // Reach the daemon, pull the images if they're missing, run print(6 * 7)
  app.post('/test', async () => ctx.code.test());
}
