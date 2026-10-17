/**
 * The first admin.
 * - CLAUDIA_ADMIN_EMAIL + CLAUDIA_ADMIN_PASSWORD create it on first boot.
 * - Otherwise the first local sign-up becomes admin (modules/users/service).
 * - LDAP-only installs need one of the two above or `claudia admin create`;
 *   a first LDAP login never becomes admin.
 */
import { eq } from 'drizzle-orm';
import type { ServerContext } from '../context';
import { users } from '../db/schema';
import { countAdmins, createLocalUser, findUserByEmail } from '../modules/users/service';

export async function bootstrapAdmin(ctx: ServerContext): Promise<void> {
  const email = ctx.config.CLAUDIA_ADMIN_EMAIL;
  const password = ctx.config.CLAUDIA_ADMIN_PASSWORD;

  if (email && password) {
    const existing = await findUserByEmail(ctx, email);
    if (!existing) {
      await createLocalUser(ctx, { email, name: 'Administrator', password, role: 'admin' });
      ctx.log.info({ email }, 'created the admin account from CLAUDIA_ADMIN_EMAIL');
    } else if (existing.role !== 'admin') {
      await ctx.db.update(users).set({ role: 'admin', updatedAt: new Date() }).where(eq(users.id, existing.id));
      ctx.log.warn({ email }, 'promoted the existing account named by CLAUDIA_ADMIN_EMAIL to admin');
    }
    // An existing admin's password is never overwritten from the environment
    return;
  }

  if ((await countAdmins(ctx)) === 0) {
    if (ctx.config.ENABLE_PASSWORD_AUTH) {
      ctx.log.info('no admin yet: the first account to sign up becomes the admin');
    } else {
      ctx.log.warn(
        'no admin and password login is off: set CLAUDIA_ADMIN_EMAIL and CLAUDIA_ADMIN_PASSWORD, or run `claudia admin create`'
      );
    }
  }
}
