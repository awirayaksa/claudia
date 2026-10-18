import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { currentUser, requireUser } from '../../auth/rbac';
import { notFound } from '../../lib/errors';

const SkillPayload = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).default(''),
  body: z.string().min(1).max(100_000),
});

/** /api/skills — same `{ success, skill(s) }` shape the desktop's skill slice expects. */
export async function skillRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);

  app.get('/', async (req) => ({ success: true, skills: await ctx.skills.list(currentUser(req).id) }));

  app.get('/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const skill = await ctx.skills.find(currentUser(req).id, id);
    if (!skill) throw notFound('Skill');
    return { success: true, skill };
  });

  app.post('/', async (req, reply) => {
    const skill = await ctx.skills.create(currentUser(req).id, SkillPayload.parse(req.body));
    reply.code(201);
    return { success: true, skill };
  });

  app.put('/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = SkillPayload.parse({ ...(req.body as object), id });
    return { success: true, skill: await ctx.skills.update(currentUser(req).id, body) };
  });

  app.delete('/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await ctx.skills.delete(currentUser(req).id, id);
    return { success: true };
  });
}
