import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { requireAdmin } from '../../auth/rbac';
import { AppSettingsSchema, type AppSettingKey } from './app-settings';

/** /api/admin/settings — app-wide settings stored in the database. */
export async function adminSettingsRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => ({
    settings: await ctx.settings.all(),
    // Set by environment: shown read-only in the admin UI
    locked: {
      passwordLogin: { value: ctx.config.ENABLE_PASSWORD_AUTH, source: 'env' },
    },
  }));

  app.patch('/:key', async (req) => {
    const { key } = z
      .object({ key: z.enum(Object.keys(AppSettingsSchema) as [AppSettingKey, ...AppSettingKey[]]) })
      .parse(req.params);
    const value = await ctx.settings.set(key, req.body);
    return { key, value };
  });
}
