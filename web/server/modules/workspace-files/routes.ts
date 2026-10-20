import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { badRequest } from '../../lib/errors';
import { currentUser, requireUser } from '../../auth/rbac';
import { MAX_UPLOAD_BYTES } from '../../../shared/files';
import { workspaceMime } from '../../../shared/workspace-files';
import { userWorkspace } from '../../mcp/builtin';
import { listWorkspaceDir, relativeToWorkspace, resolveInWorkspace, workspaceFile } from '../../workspace/files';
import { dispositionFilename } from '../files/routes';

const PathQuery = z.object({ path: z.string().max(4000).default('') });

/** A single file or folder name: no separators, not "." or "..". */
function validName(name: string): string {
  const clean = name.trim();
  if (!clean || clean === '.' || clean === '..' || /[\\/\0]/.test(clean) || clean.length > 255) {
    throw badRequest('Invalid name.', 'invalid_name');
  }
  return clean;
}

/**
 * /api/workspace-files: the user's workspace, where the built-in Files, Word
 * and Diagrams tools read and write. Paths are relative to it ("" is the top).
 */
export async function workspaceFileRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);
  const root = (req: Parameters<typeof currentUser>[0]) => userWorkspace(ctx.config.dataDir, currentUser(req).id);

  app.get('/', async (req) => {
    const { path: dir } = PathQuery.parse(req.query);
    return { path: dir, entries: await listWorkspaceDir(root(req), dir) };
  });

  // Downloads only: never rendered on the app origin (as /api/files/:id/content)
  app.get('/content', async (req, reply) => {
    const { path: rel } = PathQuery.parse(req.query);
    const { abs, size } = await workspaceFile(root(req), rel);
    const name = path.basename(abs);
    reply
      .header('Content-Type', workspaceMime(name))
      .header('Content-Length', String(size))
      .header('Content-Disposition', `attachment; ${dispositionFilename(name)}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', 'sandbox')
      .header('Cache-Control', 'private, no-store');
    return reply.send(fs.createReadStream(abs));
  });

  // Upload into a folder (?path=), replacing a file of the same name
  app.post('/upload', async (req, reply) => {
    const { path: dir } = PathQuery.parse(req.query);
    const base = root(req);
    const folder = resolveInWorkspace(base, dir);
    const part = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    if (!part) throw badRequest('No file in the request.', 'no_file');
    const data = await part.toBuffer().catch((err: Error & { code?: string }) => {
      if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
        throw badRequest(`The file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`, 'file_too_large');
      }
      throw err;
    });
    const target = resolveInWorkspace(base, path.posix.join(dir, validName(path.basename(part.filename))));
    await fs.promises.mkdir(folder, { recursive: true });
    await fs.promises.writeFile(target, data);
    reply.code(201);
    return { path: relativeToWorkspace(base, target), size: data.length };
  });

  app.post('/folders', async (req, reply) => {
    const body = z.object({ parent: z.string().max(4000).default(''), name: z.string() }).parse(req.body);
    const base = root(req);
    const target = resolveInWorkspace(base, path.posix.join(body.parent, validName(body.name)));
    await fs.promises.mkdir(target, { recursive: true });
    reply.code(201);
    return { path: relativeToWorkspace(base, target) };
  });

  // A file, or a folder with everything in it
  app.delete('/', async (req) => {
    const { path: rel } = PathQuery.parse(req.query);
    const base = root(req);
    const target = resolveInWorkspace(base, rel);
    if (path.resolve(target) === path.resolve(base)) throw badRequest('The workspace itself cannot be deleted.', 'invalid_path');
    await fs.promises.rm(target, { recursive: true, force: true });
    return { ok: true };
  });
}
