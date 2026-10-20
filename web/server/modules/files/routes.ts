import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { badRequest } from '../../lib/errors';
import { currentUser, requireUser } from '../../auth/rbac';
import { MAX_UPLOAD_BYTES } from '../../../shared/files';

const IdParams = z.object({ id: z.uuid() });

/** RFC 6266 filename for Content-Disposition (ASCII fallback + UTF-8). */
export function dispositionFilename(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** /api/files */
export async function fileRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);

  app.post('/', async (req, reply) => {
    const part = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    if (!part) throw badRequest('No file in the request.', 'no_file');
    const data = await part.toBuffer().catch((err: Error & { code?: string }) => {
      if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
        throw badRequest(`The file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`, 'file_too_large');
      }
      throw err;
    });
    const row = await ctx.files.ingest(currentUser(req).id, { name: part.filename, mime: part.mimetype, data });
    reply.code(201);
    return { file: ctx.files.toView(row) };
  });

  app.get('/', async (req) => ({ files: (await ctx.files.listOwned(currentUser(req).id)).map((f) => ctx.files.toView(f)) }));

  app.get('/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return { file: ctx.files.toView(await ctx.files.getOwned(currentUser(req).id, id)) };
  });

  // Downloads only: never rendered on the app origin (previews go through the sandbox origin)
  app.get('/:id/content', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const row = await ctx.files.getOwned(currentUser(req).id, id);
    reply
      .header('Content-Type', row.mime || 'application/octet-stream')
      .header('Content-Length', String(row.size))
      .header('Content-Disposition', `attachment; ${dispositionFilename(row.name)}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', 'sandbox')
      .header('Cache-Control', 'private, no-store');
    return reply.send(ctx.storage.stream(row.storageKey));
  });

  app.delete('/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    await ctx.files.delete(currentUser(req).id, id);
    return { ok: true };
  });
}
