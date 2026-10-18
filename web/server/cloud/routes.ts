import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { currentUser, requireAdmin, requireUser } from '../auth/rbac';
import type { CloudState } from './cloud-files';
import { CLOUD_PROVIDERS, CloudSettingsUpdate } from '../../shared/cloud';

const STATE_COOKIE = 'claudia_cloud';
const STATE_PATH = '/api/cloud';
const Provider = z.object({ provider: z.enum(CLOUD_PROVIDERS) });

export function cloudCallbackUrl(ctx: ServerContext, req: FastifyRequest, provider: string): string {
  const base = ctx.config.CLAUDIA_PUBLIC_URL?.replace(/\/+$/, '') ?? `${req.protocol}://${req.host}`;
  return `${base}/api/cloud/${provider}/callback`;
}

/** A page for the connect pop-up to end on (the app closes it). */
const donePage = (ok: boolean, message: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${ok ? 'Connected' : 'Not connected'}</title><meta name="viewport" content="width=device-width"></head>` +
  `<body style="font-family:system-ui,sans-serif;padding:2rem"><p data-cloud-result="${ok ? 'ok' : 'error'}">${message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')}</p><p>You can close this window.</p></body></html>`;

/** /api/cloud — a user's Google Drive / OneDrive. */
export async function cloudRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);
  const cookie = { httpOnly: true, secure: ctx.config.secureCookies, sameSite: 'lax' as const, path: STATE_PATH };

  app.get('/accounts', async (req) => ({ accounts: await ctx.cloud.accounts(currentUser(req).id) }));

  // Opened in a pop-up: off to the provider…
  app.get('/:provider/connect', async (req, reply) => {
    const { provider } = Provider.parse(req.params);
    const { url, state } = await ctx.cloud.connectUrl(provider, currentUser(req).id, cloudCallbackUrl(ctx, req, provider));
    reply.setCookie(STATE_COOKIE, ctx.secrets.encrypt(JSON.stringify(state)), { ...cookie, maxAge: 600 });
    return reply.redirect(url, 302);
  });

  // …and back
  app.get('/:provider/callback', async (req, reply) => {
    const { provider } = Provider.parse(req.params);
    const query = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query);
    let saved: CloudState | null = null;
    try {
      saved = req.cookies[STATE_COOKIE] ? (JSON.parse(ctx.secrets.decrypt(req.cookies[STATE_COOKIE])) as CloudState) : null;
    } catch {
      saved = null;
    }
    reply.clearCookie(STATE_COOKIE, cookie);
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store');
    try {
      await ctx.cloud.finishConnect(provider, saved, currentUser(req).id, query, cloudCallbackUrl(ctx, req, provider));
      return donePage(true, 'Your account is connected.');
    } catch (err) {
      return donePage(false, err instanceof Error ? err.message : 'Connecting failed.');
    }
  });

  app.delete('/:provider', async (req) => {
    const { provider } = Provider.parse(req.params);
    await ctx.cloud.disconnect(currentUser(req).id, provider);
    return { ok: true };
  });

  app.get('/:provider/files', async (req) => {
    const { provider } = Provider.parse(req.params);
    const q = z
      .object({ folder: z.string().max(500).optional(), q: z.string().trim().max(200).optional(), page: z.string().max(4000).optional() })
      .parse(req.query);
    return ctx.cloud.list(currentUser(req).id, provider, { folder: q.folder || undefined, q: q.q || undefined, page: q.page || undefined });
  });

  // Copy the file into Claudia (then it attaches or goes into knowledge like an upload)
  app.post('/:provider/import', async (req, reply) => {
    const { provider } = Provider.parse(req.params);
    const { fileId } = z.object({ fileId: z.string().min(1).max(500) }).parse(req.body);
    const me = currentUser(req);
    const file = await ctx.cloud.download(me.id, provider, fileId);
    const row = await ctx.files.ingest(me.id, file);
    reply.code(201);
    return { file: ctx.files.toView(row) };
  });
}

/** /api/admin/cloud — the OAuth clients. */
export async function adminCloudRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireAdmin);
  app.get('/', async (req) => ({
    ...(await ctx.cloud.view()),
    redirectUris: { google: cloudCallbackUrl(ctx, req, 'google'), microsoft: cloudCallbackUrl(ctx, req, 'microsoft') },
  }));
  app.put('/', async (req) => {
    const result = await ctx.cloud.update(CloudSettingsUpdate.parse(req.body));
    ctx.cluster.signal('cloud');
    return result;
  });
}
