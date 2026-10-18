import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { ssoProviders, users } from '../db/schema';
import { HttpError, conflict, notFound } from '../lib/errors';
import { parsePatch } from '../lib/validation';
import { requireAdmin } from './rbac';
import { completeSignIn } from './signin';
import { toSsoView, type OidcState } from './providers/oidc';
import { webhookUser } from '../modules/users/service';
import { SsoProviderInput } from '../../shared/auth';

const STATE_COOKIE = 'claudia_oidc';
const STATE_PATH = '/api/auth/oidc';

const Params = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/) });

/** Where the provider sends the browser back to; register it with the provider. */
export function callbackUrl(ctx: ServerContext, req: FastifyRequest, id: string): string {
  const base = ctx.config.CLAUDIA_PUBLIC_URL?.replace(/\/+$/, '') ?? `${req.protocol}://${req.host}`;
  return `${base}/api/auth/oidc/${id}/callback`;
}

/** Back to the app's sign-in page with a message it shows. */
function backWithError(reply: FastifyReply, err: unknown) {
  const code = err instanceof HttpError ? err.code : 'sso_failed';
  const message = err instanceof Error ? err.message : 'Sign-in failed.';
  return reply.redirect(`/?auth_error=${encodeURIComponent(code)}&auth_message=${encodeURIComponent(message)}`, 302);
}

/** /api/auth/oidc — the browser's round trip through the provider. */
export async function oidcRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const cookie = { httpOnly: true, secure: ctx.config.secureCookies, sameSite: 'lax' as const, path: STATE_PATH };

  app.get('/:id/start', async (req, reply) => {
    const { id } = Params.parse(req.params);
    try {
      const { url, state } = await ctx.sso.start(id, callbackUrl(ctx, req, id));
      reply.setCookie(STATE_COOKIE, ctx.secrets.encrypt(JSON.stringify(state)), { ...cookie, maxAge: 600 });
      return reply.redirect(url, 302);
    } catch (err) {
      return backWithError(reply, err);
    }
  });

  app.get('/:id/callback', async (req, reply) => {
    const { id } = Params.parse(req.params);
    const query = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query);
    let saved: OidcState | null = null;
    try {
      saved = req.cookies[STATE_COOKIE] ? (JSON.parse(ctx.secrets.decrypt(req.cookies[STATE_COOKIE])) as OidcState) : null;
    } catch {
      saved = null;
    }
    reply.clearCookie(STATE_COOKIE, cookie);
    try {
      const claims = await ctx.sso.finish(id, query, saved, callbackUrl(ctx, req, id));
      const { userId, created } = await ctx.sso.provision(id, claims);
      if (created) {
        const [row] = await ctx.db.select().from(users).where(eq(users.id, userId));
        void ctx.webhooks.emit('user.created', { user: webhookUser(row), source: `sso:${id}` });
      }
      const result = await completeSignIn(ctx, req, reply, userId, 'oidc', { provider: id, created });
      return reply.redirect(result.mfaRequired ? '/?mfa=1' : '/', 302);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 403 && saved) {
        void ctx.audit.fromRequest(req, 'auth.login_failed', { actor: null, details: { method: 'oidc', provider: id, reason: err.code } });
      }
      return backWithError(reply, err);
    }
  });
}

/** /api/admin/sso — OpenID Connect providers. */
export async function adminSsoRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  const list = async (req: FastifyRequest) =>
    (await ctx.db.select().from(ssoProviders)).map((row) => ({ ...toSsoView(row), callbackUrl: callbackUrl(ctx, req, row.id) }));

  app.get('/', async (req) => ({ providers: await list(req) }));

  app.post('/', async (req, reply) => {
    const body = SsoProviderInput.parse(req.body);
    const [exists] = await ctx.db.select({ id: ssoProviders.id }).from(ssoProviders).where(eq(ssoProviders.id, body.id));
    if (exists) throw conflict(`There is already a provider called "${body.id}".`, 'sso_exists');
    const [row] = await ctx.db
      .insert(ssoProviders)
      .values({ ...body, clientSecretCipher: body.clientSecret ? ctx.secrets.encrypt(body.clientSecret) : null })
      .returning();
    reply.code(201);
    return { provider: { ...toSsoView(row), callbackUrl: callbackUrl(ctx, req, row.id) } };
  });

  app.patch('/:id', async (req) => {
    const { id } = Params.parse(req.params);
    const { id: _ignored, clientSecret, ...patch } = parsePatch(SsoProviderInput, req.body);
    const [row] = await ctx.db
      .update(ssoProviders)
      .set({
        ...patch,
        // Empty keeps the stored secret; null removes it
        ...(clientSecret === null ? { clientSecretCipher: null } : clientSecret ? { clientSecretCipher: ctx.secrets.encrypt(clientSecret) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(ssoProviders.id, id))
      .returning();
    if (!row) throw notFound('Sign-in provider');
    ctx.sso.forget(id);
    return { provider: { ...toSsoView(row), callbackUrl: callbackUrl(ctx, req, row.id) } };
  });

  // Reach the provider's discovery document (the admin's "Test" button)
  app.post('/:id/test', async (req) => {
    const { id } = Params.parse(req.params);
    const row = await ctx.sso.provider(id);
    ctx.sso.forget(id);
    try {
      const doc = await ctx.sso.discover(row);
      return { ok: true, issuer: doc.issuer, error: null };
    } catch (err) {
      return { ok: false, issuer: null, error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.delete('/:id', async (req) => {
    const { id } = Params.parse(req.params);
    const deleted = await ctx.db.delete(ssoProviders).where(eq(ssoProviders.id, id)).returning({ id: ssoProviders.id });
    if (deleted.length === 0) throw notFound('Sign-in provider');
    ctx.sso.forget(id);
    return { ok: true };
  });
}
