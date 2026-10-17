import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { currentUser, requireUser } from '../../auth/rbac';
import { notFound } from '../../lib/errors';
import { toShareView } from '../chats/repo';
import type { ShareListItem } from '../../../shared/chats';

const TokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });

/** /api/shares — the user's own share links. */
export async function shareRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);

  app.get('/', async (req): Promise<{ shares: ShareListItem[] }> => ({
    shares: (await ctx.shares.listOwned(currentUser(req).id)).map((s) => ({ ...toShareView(s), chatId: s.chatId })),
  }));

  app.delete('/:token', async (req) => {
    const { token } = TokenParams.parse(req.params);
    await ctx.shares.revoke(currentUser(req).id, token);
    return { ok: true };
  });
}

/** /api/shared/:token — what a share link shows, to anyone (signed in or not). */
export async function sharedRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.get(
    '/:token',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: (req: any) => `shared:${req.ip}` } } },
    async (req, reply) => {
      const parsed = TokenParams.safeParse(req.params);
      const shared = parsed.success ? await ctx.shares.read(parsed.data.token) : null;
      if (!shared) throw notFound('Share link');
      // A revoked link must stop working at once, and shared chats aren't for search engines
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Robots-Tag', 'noindex, nofollow');
      return { chat: shared };
    }
  );
}
