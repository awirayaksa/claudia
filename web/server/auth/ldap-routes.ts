import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireAdmin } from './rbac';
import { badRequest } from '../lib/errors';
import { LdapSettingsUpdate, type LdapLookupResult, type LdapSettingsResponse, type LdapTestResult } from '../../shared/ldap';

/** /api/admin/ldap — directory sign-in settings. The bind password never leaves the server. */
export async function adminLdapRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async (): Promise<LdapSettingsResponse> => ctx.ldap.view());

  app.put('/', async (req): Promise<LdapSettingsResponse> => {
    const patch = LdapSettingsUpdate.parse(req.body);
    const { locked } = await ctx.ldap.view();
    const lockedChanged = (Object.keys(patch) as Array<keyof typeof patch>).filter((k) => locked.includes(k));
    if (lockedChanged.length > 0) {
      throw badRequest(`Set by environment variables: ${lockedChanged.join(', ')}.`, 'locked_by_env');
    }
    return ctx.ldap.update(patch);
  });

  // Connect and bind as the service account
  app.post('/test', async (): Promise<LdapTestResult> => ctx.ldap.testConnection());

  // What sign-in would find for a username (no password)
  app.post('/lookup', async (req): Promise<LdapLookupResult> => {
    const { username } = z.object({ username: z.string().min(1).max(256) }).parse(req.body);
    return ctx.ldap.lookup(username);
  });
}
