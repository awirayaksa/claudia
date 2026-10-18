/**
 * Channels: rooms where people write to each other, and to a model by
 * mentioning it ("@openai/gpt-4o what do you think?"). Admins create them
 * and decide who is in (access grants: read = read and post, or everyone
 * with a public grant). New, edited and deleted messages, and a model's
 * reply as it is written, go to everyone watching over the WebSocket
 * (topic "channel:<id>").
 *
 * A model reply sees the last messages of the channel, uses the mentioning
 * user's model access and usage caps, and is counted as their usage.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { channelMessages, channels, usageEvents, users } from '../../db/schema';
import { currentUser, requireAdmin, requireUser } from '../../auth/rbac';
import type { AuthUser } from '../../auth/sessions';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { uuidv7 } from '../../lib/ids';
import { parsePatch } from '../../lib/validation';
import { registerAccessRoutes } from '../workspace/access-routes';
import type { ChatMessage } from '../../../../src/types/api.types';
import { ChannelInput, ChannelPost, MENTION_RE, type ChannelEvent, type ChannelMessageView, type ChannelView } from '../../../shared/channels';

type ChannelRow = typeof channels.$inferSelect;
type MessageRow = typeof channelMessages.$inferSelect;

/** Messages a model reply sees. */
const CONTEXT_MESSAGES = 30;
const REPLY_TIMEOUT_MS = 5 * 60_000;

export async function channelRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);
  const topic = (id: string) => `channel:${id}`;
  const publish = (channelId: string, event: ChannelEvent) => ctx.events.publish(topic(channelId), event);

  ctx.events.guard('channel', async (user, id) => {
    const [row] = await ctx.db.select().from(channels).where(eq(channels.id, id));
    return !!row && (await ctx.access.rights(user, 'channel', row)).read;
  });

  const readable = async (user: AuthUser, id: string) => {
    const [row] = await ctx.db.select().from(channels).where(eq(channels.id, id));
    if (!row) throw notFound('Channel');
    const rights = await ctx.access.rights(user, 'channel', row);
    if (!rights.read) throw notFound('Channel');
    return { row, rights };
  };

  const authors = async (rows: MessageRow[]) => {
    const ids = [...new Set(rows.flatMap((r) => (r.userId ? [r.userId] : [])))];
    if (ids.length === 0) return new Map<string, string>();
    const list = await ctx.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
    return new Map(list.map((u) => [u.id, u.name]));
  };

  const view = (m: MessageRow, names: Map<string, string>): ChannelMessageView => ({
    id: m.id,
    channelId: m.channelId,
    author: m.userId ? { kind: 'user', id: m.userId, name: names.get(m.userId) ?? 'Former member' } : { kind: 'model', id: m.modelId ?? '', name: m.modelId ?? 'Model' },
    replyToId: m.replyToId,
    content: m.deletedAt ? '' : m.content,
    status: m.status,
    deleted: !!m.deletedAt,
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt?.toISOString() ?? null,
  });

  const channelView = (c: ChannelRow, rights: { write: boolean; manage: boolean }, lastMessageAt: Date | null): ChannelView => ({
    id: c.id,
    name: c.name,
    description: c.description,
    archived: c.archived,
    canManage: rights.manage,
    lastMessageAt: lastMessageAt?.toISOString() ?? null,
  });

  app.get('/', async (req) => {
    const me = currentUser(req);
    const rows = await ctx.db
      .select()
      .from(channels)
      .where(ctx.access.visibleSql(me, 'channel', channels.id, channels.ownerId))
      .orderBy(asc(channels.name));
    const rights = await ctx.access.rightsMany(me, 'channel', rows);
    const last = rows.length
      ? await ctx.db
          .select({ channelId: channelMessages.channelId, at: sql<Date>`max(${channelMessages.createdAt})` })
          .from(channelMessages)
          .where(inArray(channelMessages.channelId, rows.map((r) => r.id)))
          .groupBy(channelMessages.channelId)
      : [];
    const lastAt = new Map(last.map((l) => [l.channelId, l.at ? new Date(l.at) : null]));
    return { channels: rows.map((c) => channelView(c, rights.get(c.id) ?? { write: false, manage: false }, lastAt.get(c.id) ?? null)) };
  });

  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = ChannelInput.parse(req.body);
    const [row] = await ctx.db.insert(channels).values({ id: uuidv7(), ownerId: currentUser(req).id, ...body }).returning();
    reply.code(201);
    return { channel: channelView(row, { write: true, manage: true }, null) };
  });

  app.get('/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { row, rights } = await readable(currentUser(req), id);
    return { channel: channelView(row, rights, null) };
  });

  app.patch('/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { row, rights } = await readable(currentUser(req), id);
    if (!rights.manage) throw forbidden('Only admins change channels.', 'not_owner');
    const [updated] = await ctx.db
      .update(channels)
      .set({ ...parsePatch(ChannelInput, req.body), updatedAt: new Date() })
      .where(eq(channels.id, row.id))
      .returning();
    return { channel: channelView(updated, rights, null) };
  });

  app.delete('/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { row, rights } = await readable(currentUser(req), id);
    if (!rights.manage) throw forbidden('Only admins delete channels.', 'not_owner');
    await ctx.db.delete(channels).where(eq(channels.id, row.id));
    await ctx.access.removeResource('channel', row.id);
    return { ok: true };
  });

  registerAccessRoutes(app, ctx, 'channel', 'Channel', async (id) => {
    const [row] = await ctx.db.select({ id: channels.id, ownerId: channels.ownerId }).from(channels).where(eq(channels.id, id));
    return row;
  });

  // ─── Messages ──────────────────────────────────────────────────────────────

  // Newest last; `before` pages back through older ones
  app.get('/:id/messages', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const q = z.object({ before: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    await readable(currentUser(req), id);
    const rows = await ctx.db
      .select()
      .from(channelMessages)
      .where(and(eq(channelMessages.channelId, id), q.before ? lt(channelMessages.id, q.before) : undefined))
      .orderBy(desc(channelMessages.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit).reverse();
    const names = await authors(page);
    return { messages: page.map((m) => view(m, names)), more: rows.length > q.limit };
  });

  app.post('/:id/messages', async (req, reply) => {
    const me = currentUser(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { row: channel } = await readable(me, id);
    if (channel.archived) throw badRequest('This channel is archived.', 'channel_archived');
    const { content } = ChannelPost.parse(req.body);

    // A mentioned model must be one this user may use
    const mention = MENTION_RE.exec(content)?.[1];
    const target = mention ? await ctx.models.resolve(mention, me.role, me.id).catch(() => null) : null;
    if (mention && !target) throw badRequest(`@${mention} is not a model you can use.`, 'unknown_model');
    if (target) await ctx.usage.check(me);

    const [row] = await ctx.db.insert(channelMessages).values({ id: uuidv7(), channelId: id, userId: me.id, content }).returning();
    await ctx.db.update(channels).set({ updatedAt: new Date() }).where(eq(channels.id, id));
    const names = new Map([[me.id, me.name]]);
    const message = view(row, names);
    publish(id, { type: 'channel.message', message });
    if (target && mention) void answer(me, channel, row, mention, target);
    reply.code(201);
    return { message };
  });

  app.patch('/:id/messages/:messageId', async (req) => {
    const me = currentUser(req);
    const { id, messageId } = z.object({ id: z.uuid(), messageId: z.uuid() }).parse(req.params);
    await readable(me, id);
    const { content } = ChannelPost.parse(req.body);
    const [row] = await ctx.db
      .update(channelMessages)
      .set({ content, editedAt: new Date() })
      .where(and(eq(channelMessages.id, messageId), eq(channelMessages.channelId, id), eq(channelMessages.userId, me.id), isNull(channelMessages.deletedAt)))
      .returning();
    if (!row) throw notFound('Message');
    const message = view(row, new Map([[me.id, me.name]]));
    publish(id, { type: 'channel.message.updated', message });
    return { message };
  });

  // The author, or whoever manages the channel
  app.delete('/:id/messages/:messageId', async (req) => {
    const me = currentUser(req);
    const { id, messageId } = z.object({ id: z.uuid(), messageId: z.uuid() }).parse(req.params);
    const { rights } = await readable(me, id);
    const [existing] = await ctx.db
      .select()
      .from(channelMessages)
      .where(and(eq(channelMessages.id, messageId), eq(channelMessages.channelId, id)));
    if (!existing) throw notFound('Message');
    if (existing.userId !== me.id && !rights.manage) throw forbidden('You can delete only your own messages.', 'not_author');
    const [row] = await ctx.db.update(channelMessages).set({ deletedAt: new Date(), content: '' }).where(eq(channelMessages.id, messageId)).returning();
    publish(id, { type: 'channel.message.updated', message: view(row, await authors([row])) });
    return { ok: true };
  });

  /** Stream a mentioned model's reply into the channel. */
  async function answer(user: AuthUser, channel: ChannelRow, question: MessageRow, modelKey: string, target: NonNullable<Awaited<ReturnType<typeof ctx.models.resolve>>>) {
    const [reply] = await ctx.db
      .insert(channelMessages)
      .values({ id: uuidv7(), channelId: channel.id, userId: null, modelId: modelKey, replyToId: question.id, content: '', status: 'streaming' })
      .returning();
    publish(channel.id, { type: 'channel.message', message: view(reply, new Map()) });

    const recent = (
      await ctx.db
        .select()
        .from(channelMessages)
        .where(and(eq(channelMessages.channelId, channel.id), isNull(channelMessages.deletedAt), lt(channelMessages.id, reply.id)))
        .orderBy(desc(channelMessages.id))
        .limit(CONTEXT_MESSAGES)
    ).reverse();
    const names = await authors(recent);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          `You are ${modelKey}, taking part in a group chat channel called "${channel.name}"${channel.description ? ` (${channel.description})` : ''}. ` +
          `Messages are prefixed with their author's name. ${user.name} mentioned you; answer them briefly and in the channel's language. Don't prefix your answer with your name.`,
      },
      ...recent.map((m): ChatMessage => (m.userId ? { role: 'user', content: `${names.get(m.userId) ?? 'Someone'}: ${m.content}` } : { role: 'assistant', content: m.content })),
    ];

    let text = '';
    let usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null = null;
    let status: 'done' | 'error' = 'done';
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REPLY_TIMEOUT_MS);
    try {
      await new Promise<void>((resolve, reject) => {
        target.provider
          .streamChatCompletion(
            { model: target.providerModelId, messages, stream: true },
            {
              onChunk: (t: string) => {
                text += t;
                publish(channel.id, { type: 'channel.delta', messageId: reply.id, text: t });
              },
              onReasoning: () => {},
              onUsage: (u: typeof usage) => {
                usage = u;
              },
              onToolCalls: () => {},
              onComplete: () => resolve(),
              onError: (err: unknown) => reject(err),
            },
            controller.signal
          )
          .catch(reject);
      });
    } catch (err) {
      status = 'error';
      text = text || `The model couldn't answer: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      clearTimeout(timer);
    }
    const [done] = await ctx.db.update(channelMessages).set({ content: text || '…', status }).where(eq(channelMessages.id, reply.id)).returning();
    publish(channel.id, { type: 'channel.message.updated', message: view(done, new Map()) });
    const u = usage as { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null;
    if (u) {
      await ctx.db
        .insert(usageEvents)
        .values({
          id: uuidv7(),
          userId: user.id,
          modelId: modelKey,
          connectionId: target.connection.id,
          kind: 'channel',
          promptTokens: u.prompt_tokens ?? 0,
          completionTokens: u.completion_tokens ?? 0,
          cost: u.cost ?? null,
          latencyMs: Date.now() - started,
        })
        .catch(() => {});
    }
  }
}
