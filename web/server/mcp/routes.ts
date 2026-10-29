import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { chats, mcpServers, messages } from '../db/schema';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { uuidv7 } from '../lib/ids';
import { currentUser, requireAdmin, requireUser } from '../auth/rbac';
import { normalizeToolResult } from '../../../src/services/mcp/tool-format';
import type { MessagePart, PartOf } from '../../../src/types/turn.types';
import {
  McpServerInput,
  UIActionRequest,
  type AdminMcpServerView,
  type McpOAuthInput,
  type McpOAuthView,
  type UIActionResponse,
} from '../../shared/mcp';
import { UserMcpServerInput, type UserMcpServerView } from '../../shared/workspace';
import type { McpServerRow, StoredMcpConfig } from './mcp-pool';
import type { StoredOAuthConfig } from './oauth';

const IdParams = z.object({ id: z.uuid() });

/** Tool servers one user may add. */
const MAX_USER_SERVERS = 10;

// ─── OAuth sign-in (shared by own and global servers) ────────────────────────

export function mcpOAuthCallbackUrl(ctx: ServerContext, req: FastifyRequest): string {
  const base = ctx.config.CLAUDIA_PUBLIC_URL?.replace(/\/+$/, '') ?? `${req.protocol}://${req.host}`;
  return `${base}/api/mcp/oauth/callback`;
}

/** A page for the sign-in pop-up to end on (the app notices and closes it). */
const donePage = (ok: boolean, message: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${ok ? 'Connected' : 'Not connected'}</title><meta name="viewport" content="width=device-width"></head>` +
  `<body style="font-family:system-ui,sans-serif;padding:2rem"><p data-mcp-oauth-result="${ok ? 'ok' : 'error'}">${message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')}</p><p>You can close this window.</p></body></html>`;

/** The OAuth settings after an update: undefined keeps them, null removes them, an omitted secret stays. */
function mergeOAuth(old: StoredOAuthConfig | undefined, input: McpOAuthInput | null | undefined): StoredOAuthConfig | undefined {
  if (input === undefined) return old;
  if (input === null) return undefined;
  const clientSecret = input.clientSecret ?? (input.clientId && input.clientId === old?.clientId ? old.clientSecret : undefined);
  return {
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(clientSecret && input.clientId ? { clientSecret } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
  };
}

async function oauthView(ctx: ServerContext, row: McpServerRow, stored: StoredMcpConfig): Promise<McpOAuthView | null> {
  if (!stored.oauth) return null;
  return {
    connected: await ctx.mcpOAuth.connected(row.id),
    clientId: stored.oauth.clientId ?? null,
    hasClientSecret: !!stored.oauth.clientSecret,
    scope: stored.oauth.scope ?? null,
  };
}

/** After a sign-in or sign-out: start the server again with (or without) its tokens. */
async function restartAfterOAuth(ctx: ServerContext, row: McpServerRow, userId: string): Promise<void> {
  if (row.ownerId) {
    await ctx.mcp.stopOwn(userId, row.id);
    if (row.enabled) await ctx.mcp.ensureOwn(userId, row).catch(() => {});
  } else {
    await ctx.mcp.stopGlobal(row.id);
    if (row.enabled) await ctx.mcp.startGlobal(row).catch(() => {});
    ctx.cluster.signal('mcp.global', { id: row.id });
  }
}

/** Opened in a pop-up: off to the authorization server (or done, if the stored tokens still work). */
async function connectOAuth(ctx: ServerContext, req: FastifyRequest, reply: FastifyReply, row: McpServerRow, userId: string) {
  const stored = ctx.mcp.decrypt(row);
  if (!stored.oauth || !stored.url) throw badRequest('This server doesn’t sign in with OAuth.', 'oauth_off');
  reply.header('Cache-Control', 'no-store');
  try {
    const url = await ctx.mcpOAuth.start(row.id, userId, {
      serverUrl: stored.url,
      redirectUrl: mcpOAuthCallbackUrl(ctx, req),
      config: stored.oauth,
      fetchFn: ctx.mcp.oauthFetch(row),
    });
    if (url) {
      if (!/^https?:\/\//i.test(url)) throw new Error('The authorization server gave an address that is not http(s).');
      return reply.redirect(url, 302);
    }
    await restartAfterOAuth(ctx, row, userId);
    return reply.type('text/html; charset=utf-8').send(donePage(true, 'Connected.'));
  } catch (err) {
    ctx.log.warn({ err: err instanceof Error ? err.message : String(err), server: row.name }, 'MCP OAuth sign-in could not start');
    return reply.type('text/html; charset=utf-8').send(donePage(false, `Signing in failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

async function disconnectOAuth(ctx: ServerContext, row: McpServerRow, userId: string): Promise<void> {
  const stored = ctx.mcp.decrypt(row);
  if (stored.url && stored.oauth) {
    await ctx.mcpOAuth.disconnect(row.id, { serverUrl: stored.url, config: stored.oauth, fetchFn: ctx.mcp.oauthFetch(row) });
  } else {
    await ctx.mcpOAuth.forget(row.id);
  }
  await restartAfterOAuth(ctx, row, userId);
}

/** /api/mcp — the tool servers the signed-in user can use. */
export async function mcpUserRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);

  app.get('/servers', async (req) => ({ servers: await ctx.mcp.serversFor(currentUser(req).id) }));

  app.post('/servers/:id/enable', async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    return { server: await ctx.mcp.setEnabled(currentUser(req).id, id, true) };
  });

  app.post('/servers/:id/disable', async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    return { server: await ctx.mcp.setEnabled(currentUser(req).id, id, false) };
  });

  // ─── The user's own remote servers (/api/mcp/own) ─────────────────────────

  const ownView = async (row: McpServerRow): Promise<UserMcpServerView> => {
    const stored = ctx.mcp.decrypt(row);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      transport: row.transport as UserMcpServerView['transport'],
      url: stored.url ?? '',
      headerNames: Object.keys(stored.headers ?? {}),
      oauth: await oauthView(ctx, row, stored),
      enabled: row.enabled,
    };
  };
  const getOwn = async (userId: string, id: string) => {
    const [row] = await ctx.db.select().from(mcpServers).where(and(eq(mcpServers.id, id), eq(mcpServers.ownerId, userId)));
    if (!row) throw notFound('Tool server');
    return row;
  };

  app.get('/own', async (req) => {
    const me = currentUser(req);
    const rows = await ctx.db.select().from(mcpServers).where(eq(mcpServers.ownerId, me.id));
    return { servers: await Promise.all(rows.map(ownView)), allowed: await ctx.access.can(me, 'mcp.user_servers') };
  });

  app.post('/own', async (req, reply) => {
    const me = currentUser(req);
    await ctx.access.require(me, 'mcp.user_servers');
    const body = UserMcpServerInput.parse(req.body);
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(mcpServers).where(eq(mcpServers.ownerId, me.id));
    if (Number(n) >= MAX_USER_SERVERS) throw badRequest(`You can add at most ${MAX_USER_SERVERS} tool servers.`, 'too_many_servers');
    const oauth = mergeOAuth(undefined, body.oauth);
    const stored: StoredMcpConfig = { url: body.url, headers: body.headers, ...(oauth ? { oauth } : {}) };
    const [row] = await ctx.db
      .insert(mcpServers)
      .values({
        id: uuidv7(),
        ownerId: me.id,
        name: body.name,
        description: body.description,
        transport: body.transport,
        configCipher: ctx.secrets.encrypt(JSON.stringify(stored)),
        enabled: body.enabled,
      })
      .returning();
    reply.code(201);
    return { server: await ownView(row) };
  });

  app.patch('/own/:id', async (req) => {
    const me = currentUser(req);
    await ctx.access.require(me, 'mcp.user_servers');
    const { id } = IdParams.parse(req.params);
    const row = await getOwn(me.id, id);
    const old = ctx.mcp.decrypt(row);
    // Merge over the stored values, so headers can stay unchanged
    const merged = UserMcpServerInput.parse({
      name: row.name,
      description: row.description,
      transport: row.transport,
      enabled: row.enabled,
      url: old.url,
      headers: old.headers,
      ...(req.body as object),
    });
    const oauth = mergeOAuth(old.oauth, (req.body as { oauth?: McpOAuthInput | null })?.oauth);
    // Tokens belong to one server and one client: a new address or client signs in again
    if (!oauth || merged.url !== old.url || oauth.clientId !== old.oauth?.clientId) await ctx.mcpOAuth.forget(id);
    const [updated] = await ctx.db
      .update(mcpServers)
      .set({
        name: merged.name,
        description: merged.description,
        transport: merged.transport,
        enabled: merged.enabled,
        configCipher: ctx.secrets.encrypt(
          JSON.stringify({ url: merged.url, headers: merged.headers, ...(oauth ? { oauth } : {}) } satisfies StoredMcpConfig)
        ),
        updatedAt: new Date(),
      })
      .where(eq(mcpServers.id, id))
      .returning();
    await ctx.mcp.stopOwn(me.id, id);
    return { server: await ownView(updated) };
  });

  // Always allowed, so servers (and their tokens) can be removed after the permission is gone
  app.delete('/own/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const row = await getOwn(me.id, id);
    // Revoke its tokens on the way out
    await disconnectOAuth(ctx, row, me.id).catch(() => {});
    await ctx.mcp.stopOwn(me.id, id);
    await ctx.db.delete(mcpServers).where(eq(mcpServers.id, id));
    return { ok: true };
  });

  // OAuth sign-in to one of the user's own servers (opened in a pop-up)
  app.get('/own/:id/oauth/connect', async (req, reply) => {
    const me = currentUser(req);
    await ctx.access.require(me, 'mcp.user_servers');
    const { id } = IdParams.parse(req.params);
    return connectOAuth(ctx, req, reply, await getOwn(me.id, id), me.id);
  });

  app.delete('/own/:id/oauth', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const row = await getOwn(me.id, id);
    await disconnectOAuth(ctx, row, me.id);
    return { server: await ownView(row) };
  });

  // The authorization server sends the pop-up back here, for own and global servers
  app.get('/oauth/callback', async (req, reply) => {
    const me = currentUser(req);
    const query = z
      .object({ code: z.string().max(4000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional(), error_description: z.string().max(1000).optional() })
      .parse(req.query);
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store');
    if (query.error) return donePage(false, `The sign-in was refused: ${query.error_description ?? query.error}`);
    const pending = query.state ? await ctx.mcpOAuth.pending(query.state, me.id) : null;
    if (!pending || !query.code) return donePage(false, 'This sign-in has expired or was started by someone else. Try again.');
    const [row] = await ctx.db.select().from(mcpServers).where(eq(mcpServers.id, pending.serverId));
    // Own servers are their owner's to connect; global ones an admin's
    if (!row || (row.ownerId ? row.ownerId !== me.id : me.role !== 'admin')) return donePage(false, 'The tool server was not found.');
    const stored = ctx.mcp.decrypt(row);
    if (!stored.url || !stored.oauth) return donePage(false, 'This server no longer signs in with OAuth.');
    try {
      await ctx.mcpOAuth.finish(row.id, query.code, { serverUrl: stored.url, config: stored.oauth, fetchFn: ctx.mcp.oauthFetch(row) });
    } catch (err) {
      return donePage(false, `Signing in failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await restartAfterOAuth(ctx, row, me.id);
    return donePage(true, `${row.name} is connected.`);
  });
}

/** /api/tools — actions raised by MCP-UI resources. */
export async function toolRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);

  /**
   * Run a tool on behalf of an MCP-UI resource. Only tools of the server that
   * produced the resource may run, and tools marked destructive need the
   * user's confirmation. The result replaces the original tool result.
   */
  app.post('/ui-action', async (req): Promise<UIActionResponse> => {
    const me = currentUser(req);
    const body = UIActionRequest.parse(req.body);

    // The message holding the result that rendered this UI, in one of the user's chats
    const needle = JSON.stringify([{ type: 'tool_result', callId: body.originalToolCallId }]);
    const [msg] = await ctx.db
      .select({ id: messages.id, parts: messages.parts })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .where(and(eq(chats.userId, me.id), sql`${messages.parts} @> ${needle}::jsonb`))
      .limit(1);
    if (!msg) throw notFound('Tool result');

    const call = msg.parts.find(
      (p): p is PartOf<'tool_call'> => p.type === 'tool_call' && p.callId === body.originalToolCallId
    );
    if (!call?.serverId) throw notFound('Tool call');

    const tools = await ctx.mcp.toolsOf(me.id, call.serverId);
    const tool = tools.find((t) => t.name === body.toolName);
    if (!tool) {
      throw forbidden('This interface may only use tools of the server that created it.', 'ui_action_other_server');
    }
    if (tool.annotations?.destructiveHint && !body.confirmed) {
      throw conflict(`"${tool.annotations.title ?? tool.name}" may change or delete data. Confirm to run it.`, 'confirmation_required');
    }

    const raw = await ctx.mcp.callTool(me.id, call.serverId, tool.name, body.params);
    const normalized = normalizeToolResult(raw as Parameters<typeof normalizeToolResult>[0]);
    const part: PartOf<'tool_result'> = {
      type: 'tool_result',
      callId: body.originalToolCallId,
      content: normalized.content,
      ...(normalized.isError ? { isError: true } : {}),
      ...(normalized.uiResource ? { uiResource: normalized.uiResource } : {}),
    };
    const parts: MessagePart[] = msg.parts.map((p) =>
      p.type === 'tool_result' && p.callId === body.originalToolCallId ? part : p
    );
    await ctx.db.update(messages).set({ parts, updatedAt: new Date() }).where(eq(messages.id, msg.id));

    return {
      result: {
        tool_call_id: body.originalToolCallId,
        role: 'tool',
        name: tool.name,
        content: part.content,
        isError: part.isError,
        hasUI: !!part.uiResource,
        uiResource: part.uiResource,
        serverId: call.serverId,
      },
    };
  });
}

/** /api/admin/mcp-servers — global tool servers. */
export async function adminMcpRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  const view = async (row: McpServerRow): Promise<AdminMcpServerView> => {
    const stored = ctx.mcp.decrypt(row);
    const oauth = await oauthView(ctx, row, stored);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      transport: row.transport,
      url: stored.url ?? null,
      command: stored.command ?? null,
      args: stored.args ?? [],
      headerNames: Object.keys(stored.headers ?? {}),
      envNames: Object.keys(stored.env ?? {}),
      oauth,
      enabled: row.enabled,
      status: ctx.mcp.global.getServerStatus(row.id),
      error:
        ctx.mcp.global.getServerError(row.id) ??
        (row.transport === 'stdio' && !ctx.config.CLAUDIA_ALLOW_STDIO_MCP ? 'stdio servers are off (CLAUDIA_ALLOW_STDIO_MCP).' : null) ??
        (oauth && !oauth.connected ? 'Sign in to use this server.' : null),
      toolCount: ctx.mcp.global.getServerTools(row.id).length,
    };
  };

  const ensureStdioAllowed = (transport: string) => {
    if (transport === 'stdio' && !ctx.config.CLAUDIA_ALLOW_STDIO_MCP) {
      throw forbidden('stdio servers run commands on this machine. Set CLAUDIA_ALLOW_STDIO_MCP=true to allow them.', 'stdio_disabled');
    }
  };

  const getRow = async (id: string) => {
    const [row] = await ctx.db.select().from(mcpServers).where(and(eq(mcpServers.id, id), isNull(mcpServers.ownerId)));
    if (!row) throw notFound('Tool server');
    return row;
  };

  const restart = async (row: McpServerRow) => {
    await ctx.mcp.stopGlobal(row.id);
    if (row.enabled) await ctx.mcp.startGlobal(row).catch(() => {});
    ctx.cluster.signal('mcp.global', { id: row.id });
  };

  app.get('/', async () => ({ servers: await Promise.all((await ctx.mcp.globalRows()).map(view)) }));

  app.post('/', async (req, reply) => {
    const body = McpServerInput.parse(req.body);
    ensureStdioAllowed(body.transport);
    const oauth = body.transport === 'stdio' ? undefined : mergeOAuth(undefined, body.oauth);
    const stored: StoredMcpConfig = {
      url: body.url,
      headers: body.headers,
      command: body.command,
      args: body.args,
      env: body.env,
      ...(oauth ? { oauth } : {}),
    };
    const [row] = await ctx.db
      .insert(mcpServers)
      .values({
        id: uuidv7(),
        ownerId: null,
        name: body.name,
        description: body.description,
        transport: body.transport,
        configCipher: ctx.secrets.encrypt(JSON.stringify(stored)),
        enabled: body.enabled,
      })
      .returning();
    await restart(row);
    reply.code(201);
    return { server: await view(row) };
  });

  app.patch('/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const row = await getRow(id);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const old = ctx.mcp.decrypt(row);
    // Merge over the stored values, so secrets can stay unchanged
    const merged = McpServerInput.parse({
      name: row.name,
      description: row.description,
      transport: row.transport,
      enabled: row.enabled,
      ...old,
      ...raw,
    });
    ensureStdioAllowed(merged.transport);
    const oauth = merged.transport === 'stdio' ? undefined : mergeOAuth(old.oauth, raw.oauth as McpOAuthInput | null | undefined);
    if (!oauth || merged.url !== old.url || oauth.clientId !== old.oauth?.clientId) await ctx.mcpOAuth.forget(id);
    const stored: StoredMcpConfig = {
      url: merged.url,
      headers: merged.headers,
      command: merged.command,
      args: merged.args,
      env: merged.env,
      ...(oauth ? { oauth } : {}),
    };
    const [updated] = await ctx.db
      .update(mcpServers)
      .set({
        name: merged.name,
        description: merged.description,
        transport: merged.transport,
        enabled: merged.enabled,
        configCipher: ctx.secrets.encrypt(JSON.stringify(stored)),
        updatedAt: new Date(),
      })
      .where(eq(mcpServers.id, id))
      .returning();
    await restart(updated);
    return { server: await view(updated) };
  });

  app.post('/:id/restart', async (req) => {
    const { id } = IdParams.parse(req.params);
    const row = await getRow(id);
    if (!row.enabled) throw badRequest('The server is turned off.');
    await restart(row);
    return { server: await view(row) };
  });

  // OAuth sign-in for everyone's use of a global server (opened in a pop-up)
  app.get('/:id/oauth/connect', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    return connectOAuth(ctx, req, reply, await getRow(id), currentUser(req).id);
  });

  app.delete('/:id/oauth', async (req) => {
    const { id } = IdParams.parse(req.params);
    const row = await getRow(id);
    await disconnectOAuth(ctx, row, currentUser(req).id);
    return { server: await view(row) };
  });

  app.get('/:id/logs', async (req) => {
    const { id } = IdParams.parse(req.params);
    await getRow(id);
    return { logs: ctx.mcp.global.getServerLogs(id) };
  });

  app.delete('/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const row = await getRow(id);
    await disconnectOAuth(ctx, row, currentUser(req).id).catch(() => {});
    await ctx.mcp.stopGlobal(id);
    await ctx.db.delete(mcpServers).where(eq(mcpServers.id, id));
    ctx.cluster.signal('mcp.global', { id });
    return { ok: true };
  });
}
