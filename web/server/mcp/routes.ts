import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { chats, mcpServers, messages } from '../db/schema';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { uuidv7 } from '../lib/ids';
import { currentUser, requireAdmin, requireUser } from '../auth/rbac';
import { normalizeToolResult } from '../../../src/services/mcp/tool-format';
import type { MessagePart, PartOf } from '../../../src/types/turn.types';
import { McpServerInput, UIActionRequest, type AdminMcpServerView, type UIActionResponse } from '../../shared/mcp';
import { UserMcpServerInput, type UserMcpServerView } from '../../shared/workspace';
import type { McpServerRow, StoredMcpConfig } from './mcp-pool';

const IdParams = z.object({ id: z.uuid() });

/** Tool servers one user may add. */
const MAX_USER_SERVERS = 10;

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

  const ownView = (row: McpServerRow): UserMcpServerView => {
    const stored = ctx.mcp.decrypt(row);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      transport: row.transport as UserMcpServerView['transport'],
      url: stored.url ?? '',
      headerNames: Object.keys(stored.headers ?? {}),
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
    return { servers: rows.map(ownView), allowed: await ctx.access.can(me, 'mcp.user_servers') };
  });

  app.post('/own', async (req, reply) => {
    const me = currentUser(req);
    await ctx.access.require(me, 'mcp.user_servers');
    const body = UserMcpServerInput.parse(req.body);
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(mcpServers).where(eq(mcpServers.ownerId, me.id));
    if (Number(n) >= MAX_USER_SERVERS) throw badRequest(`You can add at most ${MAX_USER_SERVERS} tool servers.`, 'too_many_servers');
    const stored: StoredMcpConfig = { url: body.url, headers: body.headers };
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
    return { server: ownView(row) };
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
    const [updated] = await ctx.db
      .update(mcpServers)
      .set({
        name: merged.name,
        description: merged.description,
        transport: merged.transport,
        enabled: merged.enabled,
        configCipher: ctx.secrets.encrypt(JSON.stringify({ url: merged.url, headers: merged.headers } satisfies StoredMcpConfig)),
        updatedAt: new Date(),
      })
      .where(eq(mcpServers.id, id))
      .returning();
    await ctx.mcp.stopOwn(me.id, id);
    return { server: ownView(updated) };
  });

  // Always allowed, so servers (and their tokens) can be removed after the permission is gone
  app.delete('/own/:id', async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    await getOwn(me.id, id);
    await ctx.mcp.stopOwn(me.id, id);
    await ctx.db.delete(mcpServers).where(eq(mcpServers.id, id));
    return { ok: true };
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

  const view = (row: McpServerRow): AdminMcpServerView => {
    const stored = ctx.mcp.decrypt(row);
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
      enabled: row.enabled,
      status: ctx.mcp.global.getServerStatus(row.id),
      error:
        ctx.mcp.global.getServerError(row.id) ??
        (row.transport === 'stdio' && !ctx.config.CLAUDIA_ALLOW_STDIO_MCP ? 'stdio servers are off (CLAUDIA_ALLOW_STDIO_MCP).' : null),
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

  app.get('/', async () => ({ servers: (await ctx.mcp.globalRows()).map(view) }));

  app.post('/', async (req, reply) => {
    const body = McpServerInput.parse(req.body);
    ensureStdioAllowed(body.transport);
    const stored: StoredMcpConfig = {
      url: body.url,
      headers: body.headers,
      command: body.command,
      args: body.args,
      env: body.env,
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
    return { server: view(row) };
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
    const stored: StoredMcpConfig = {
      url: merged.url,
      headers: merged.headers,
      command: merged.command,
      args: merged.args,
      env: merged.env,
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
    return { server: view(updated) };
  });

  app.post('/:id/restart', async (req) => {
    const { id } = IdParams.parse(req.params);
    const row = await getRow(id);
    if (!row.enabled) throw badRequest('The server is turned off.');
    await restart(row);
    return { server: view(row) };
  });

  app.get('/:id/logs', async (req) => {
    const { id } = IdParams.parse(req.params);
    await getRow(id);
    return { logs: ctx.mcp.global.getServerLogs(id) };
  });

  app.delete('/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    await getRow(id);
    await ctx.mcp.stopGlobal(id);
    await ctx.db.delete(mcpServers).where(eq(mcpServers.id, id));
    ctx.cluster.signal('mcp.global', { id });
    return { ok: true };
  });
}
