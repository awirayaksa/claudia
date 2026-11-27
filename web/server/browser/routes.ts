/** /api/admin/browser — where the Web browser built-in runs, and a test start. */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireAdmin } from '../auth/rbac';

export async function adminBrowserRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => ctx.browser.status());

  // Start (or reach) the browser and open a blank page
  app.post('/test', async () => ctx.browser.test());
}
