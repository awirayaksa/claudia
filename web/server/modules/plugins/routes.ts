/**
 * ESM plugins (renderer extensions and replacements, the desktop's plugin
 * API built for the browser). Admins upload a bundle and its manifest; the
 * bundle is served immutably from /plugins/:id/:version/index.mjs and the
 * app imports it. Plugins run with the page's full privileges, so only
 * admins can install them.
 *
 * /api/admin/plugins — manage; /api/plugins — the enabled ones, for the app.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { plugins } from '../../db/schema';
import { badRequest, notFound } from '../../lib/errors';
import { requireAdmin, requireUser } from '../../auth/rbac';
import { PluginManifestInput, type PluginView } from '../../../shared/plugins';

const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

type Row = typeof plugins.$inferSelect;

const bundleUrl = (r: Pick<Row, 'id' | 'version'>) => `/plugins/${encodeURIComponent(r.id)}/${encodeURIComponent(r.version)}/index.mjs`;

const toView = (r: Row): PluginView => ({
  id: r.id,
  version: r.version,
  manifest: r.manifest as PluginManifestInput,
  enabled: r.enabled,
  settings: r.settings,
  url: bundleUrl(r),
});

export async function adminPluginRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => ({ plugins: (await ctx.db.select().from(plugins)).map(toView) }));

  // multipart: "manifest" (JSON) and "bundle" (the ESM file)
  app.post('/', async (req, reply) => {
    let manifestText: string | null = null;
    let bundle: Buffer | null = null;
    for await (const part of req.parts({ limits: { fileSize: MAX_BUNDLE_BYTES, files: 1 } })) {
      if (part.type === 'file') {
        bundle = await part.toBuffer().catch((err: Error & { code?: string }) => {
          if (err.code === 'FST_REQ_FILE_TOO_LARGE') throw badRequest('The bundle is larger than 5 MB.', 'bundle_too_large');
          throw err;
        });
      } else if (part.fieldname === 'manifest') {
        manifestText = String(part.value);
      }
    }
    if (!manifestText || !bundle) throw badRequest('Send the manifest and the bundle.', 'plugin_incomplete');
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(manifestText);
    } catch {
      throw badRequest('The manifest is not valid JSON.', 'invalid_manifest');
    }
    const manifest = PluginManifestInput.parse(manifestJson);
    const text = bundle.toString('utf-8');
    if (text.includes('\u0000')) throw badRequest('The bundle must be a JavaScript (ESM) file.', 'invalid_bundle');
    if (/\brequire\s*\(/.test(text) && !/\bexport\b/.test(text)) {
      throw badRequest('This looks like a CommonJS bundle. Web plugins must be ES modules (export default …).', 'invalid_bundle');
    }

    const [old] = await ctx.db.select().from(plugins).where(eq(plugins.id, manifest.id));
    const bundleKey = `plugins/${manifest.id}/${manifest.version}/index.mjs`;
    await ctx.storage.put(bundleKey, bundle);
    const values = { id: manifest.id, version: manifest.version, manifest, bundleKey, updatedAt: new Date() };
    const [row] = old
      ? await ctx.db.update(plugins).set(values).where(eq(plugins.id, manifest.id)).returning()
      : await ctx.db.insert(plugins).values(values).returning();
    // An upgrade replaces the old bundle
    if (old && old.bundleKey !== bundleKey) await ctx.storage.delete(old.bundleKey).catch(() => {});
    reply.code(old ? 200 : 201);
    return { plugin: toView(row) };
  });

  app.patch('/:id', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const body = z.object({ enabled: z.boolean().optional(), settings: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
    const [row] = await ctx.db
      .update(plugins)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(plugins.id, id))
      .returning();
    if (!row) throw notFound('Plugin');
    return { plugin: toView(row) };
  });

  app.delete('/:id', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const [row] = await ctx.db.delete(plugins).where(eq(plugins.id, id)).returning();
    if (!row) throw notFound('Plugin');
    await ctx.storage.delete(row.bundleKey).catch(() => {});
    return { ok: true };
  });
}

export async function pluginListRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);
  app.get('/', async () => ({ plugins: (await ctx.db.select().from(plugins).where(eq(plugins.enabled, true))).map(toView) }));
}

/** GET /plugins/:id/:version/index.mjs — the bundle (signed-in users; versioned, so cached forever). */
export function registerPluginBundles(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/plugins/:id/:version/index.mjs', { preHandler: requireUser }, async (req, reply) => {
    const { id, version } = z.object({ id: z.string().max(64), version: z.string().max(64) }).parse(req.params);
    const [row] = await ctx.db.select().from(plugins).where(eq(plugins.id, id));
    if (!row || !row.enabled || row.version !== version) throw notFound('Plugin');
    reply
      .header('Content-Type', 'text/javascript; charset=utf-8')
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff');
    return reply.send(await ctx.storage.get(row.bundleKey));
  });
}
