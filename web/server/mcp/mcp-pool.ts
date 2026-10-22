/**
 * MCP clients on the server.
 * - global: one manager for the admin's servers, shared by everyone;
 * - user:<id>: one manager per user for the built-ins (sandboxed to the
 *   user's workspace) and the user's own remote servers (HTTP / SSE through
 *   the SSRF guard, with the mcp.user_servers permission), started on demand
 *   and stopped after 10 idle minutes.
 *
 * stdio servers get only the SDK's safe environment plus their configured
 * variables (never DATABASE_URL or the secret key), and exist only when
 * CLAUDIA_ALLOW_STDIO_MCP is on.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { MCPClientManager } from '../../../electron/services/mcp.service';
import { aliasesToOpenAI, buildToolAliases, normalizeToolResult, resolveToolAlias, type ToolSource } from '../../../src/services/mcp/tool-format';
import { uiResourceConfirmation } from '../../../src/services/chat/message-builder';
import type { MCPServerConfig, MCPServerStatus, MCPTool } from '../../../src/types/mcp.types';
import type { Database } from '../db/client';
import { mcpServers, toolServers, users, type McpTransport, type UserSettings } from '../db/schema';
import { callOperation } from '../tools/openapi';
import type { SecretBox } from '../crypto/secrets';
import type { AppSettings } from '../modules/settings/app-settings';
import type { RunToolset, ToolExecution } from '../llm/tools';
import { builtinConfigFor, builtinServers, isBuiltinId, redactWorkspacePath, userWorkspace, type BuiltinDeps } from './builtin';
import { forbidden, notFound } from '../lib/errors';
import { changedFiles, snapshotWorkspace } from '../workspace/files';
import { guardedTransport, type GuardedTransport } from '../net/safe-fetch';
import type { AccessService } from '../auth/access';

const USER_IDLE_MS = 10 * 60_000;
const TOOL_TIMEOUT_MS = 120_000;

/** Built-ins that write files in the workspace; their tools that only read are not watched. */
const WRITING_BUILTINS = new Set([
  'builtin-filesystem-001',
  'builtin-msoffice-001',
  'builtin-spreadsheet-001',
  'builtin-presentation-001',
  'builtin-pdf-001',
  'builtin-diagram-001',
]);
const READ_ONLY_TOOL = /^(read|get|list|search)_/;

/** What is stored (encrypted) for a configured server. */
export interface StoredMcpConfig {
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export type McpServerRow = typeof mcpServers.$inferSelect;

export interface ServerView {
  id: string;
  name: string;
  description: string | null;
  scope: 'global' | 'builtin' | 'user';
  transport: McpTransport | 'builtin' | 'openapi';
  /** The server's own status (global) or this user's instance (built-in). */
  status: MCPServerStatus;
  /** Whether this user has the server switched on. */
  enabled: boolean;
  error: string | null;
  tools: MCPTool[];
}

interface UserPool {
  manager: MCPClientManager;
  lastUsed: number;
}

export interface McpPoolDeps extends BuiltinDeps {
  db: Database;
  secrets: SecretBox;
  settings: AppSettings;
  allowStdio: boolean;
  log: FastifyBaseLogger;
  /** Without it, nobody has their own servers. */
  access?: AccessService;
}

export class McpPools {
  readonly global = new MCPClientManager({ inheritEnv: false });
  private readonly users = new Map<string, UserPool>();
  private readonly reaper: NodeJS.Timeout;
  /** HTTP for user-owned servers: the SSRF guard (admin allowlist applies). */
  private readonly guarded: GuardedTransport;

  constructor(private readonly deps: McpPoolDeps) {
    this.reaper = setInterval(() => void this.reapIdle(), 60_000);
    this.reaper.unref();
    this.guarded = guardedTransport(deps.netPolicy);
  }

  // ─── Global servers ────────────────────────────────────────────────────────

  decrypt(row: McpServerRow): StoredMcpConfig {
    return JSON.parse(this.deps.secrets.decrypt(row.configCipher)) as StoredMcpConfig;
  }

  private toConfig(row: McpServerRow, stored: StoredMcpConfig): MCPServerConfig {
    return {
      id: row.id,
      name: row.name,
      transport: row.transport,
      url: stored.url,
      command: stored.command,
      args: stored.args,
      env: stored.env,
      enabled: row.enabled,
      metadata: row.description ? { description: row.description } : undefined,
    };
  }

  async globalRows(): Promise<McpServerRow[]> {
    return this.deps.db.select().from(mcpServers).where(isNull(mcpServers.ownerId));
  }

  /** Start every enabled global server (startup). Failures are logged, not fatal. */
  async startAll(): Promise<void> {
    for (const row of await this.globalRows()) {
      if (row.enabled) await this.startGlobal(row).catch(() => {});
    }
  }

  async startGlobal(row: McpServerRow): Promise<void> {
    if (row.transport === 'stdio' && !this.deps.allowStdio) {
      this.deps.log.warn({ server: row.name }, 'stdio MCP server not started: CLAUDIA_ALLOW_STDIO_MCP is off');
      return;
    }
    const stored = this.decrypt(row);
    try {
      await this.global.startServer(this.toConfig(row, stored), stored.headers ? { headers: stored.headers } : {});
      this.deps.log.info({ server: row.name, tools: this.global.getServerTools(row.id).length }, 'MCP server ready');
    } catch (err) {
      this.deps.log.warn({ server: row.name, err: err instanceof Error ? err.message : String(err) }, 'MCP server failed to start');
      throw err;
    }
  }

  async stopGlobal(id: string): Promise<void> {
    await this.global.stopServer(id);
  }

  /** Another instance changed this global server: restart it here (or stop it if it's gone). */
  async reloadGlobal(id: string): Promise<void> {
    await this.stopGlobal(id);
    const [row] = await this.deps.db.select().from(mcpServers).where(and(eq(mcpServers.id, id), isNull(mcpServers.ownerId)));
    if (row?.enabled) await this.startGlobal(row).catch(() => {});
  }

  // ─── Per-user built-ins ────────────────────────────────────────────────────

  private userPool(userId: string): UserPool {
    let pool = this.users.get(userId);
    if (!pool) {
      pool = { manager: new MCPClientManager({ inheritEnv: false }), lastUsed: Date.now() };
      this.users.set(userId, pool);
    }
    pool.lastUsed = Date.now();
    return pool;
  }

  /** Built-ins the admin offers. */
  async allowedBuiltins(): Promise<string[]> {
    const { enabled } = await this.deps.settings.get('mcp.builtins');
    return enabled.filter(isBuiltinId);
  }

  /** Start one of the user's built-ins if it isn't running. */
  async ensureBuiltin(userId: string, builtinId: string): Promise<void> {
    if (!(await this.allowedBuiltins()).includes(builtinId)) throw forbidden('This tool server is turned off by the administrator.');
    const pool = this.userPool(userId);
    const status = pool.manager.getServerStatus(builtinId);
    if (status === 'ready' || status === 'starting' || status === 'initializing') return;
    const config = builtinConfigFor(userId, builtinId, this.deps);
    const { builtinContext, ...serverConfig } = config;
    await pool.manager.startServer(serverConfig, { builtinContext });
  }

  // ─── User-owned remote servers ─────────────────────────────────────────────

  /** The user's own servers, if they still have the permission. */
  async ownRows(userId: string): Promise<McpServerRow[]> {
    if (!this.deps.access) return [];
    const [user] = await this.deps.db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, userId));
    if (!user || !(await this.deps.access.can(user, 'mcp.user_servers'))) return [];
    return this.deps.db.select().from(mcpServers).where(eq(mcpServers.ownerId, userId));
  }

  /** Start one of the user's own servers if it isn't running. */
  async ensureOwn(userId: string, row: McpServerRow): Promise<void> {
    if (!row.enabled || row.transport === 'stdio') return;
    const pool = this.userPool(userId);
    const status = pool.manager.getServerStatus(row.id);
    if (status === 'ready' || status === 'starting' || status === 'initializing') return;
    const stored = this.decrypt(row);
    await pool.manager.startServer(this.toConfig(row, stored), {
      fetch: this.guarded.fetch,
      ...(stored.headers ? { headers: stored.headers } : {}),
    });
  }

  /** Forget a running instance of the user's own server (after it changes or goes). */
  async stopOwn(userId: string, serverId: string): Promise<void> {
    await this.users.get(userId)?.manager.stopServer(serverId).catch(() => {});
  }

  async stopUser(userId: string): Promise<void> {
    const pool = this.users.get(userId);
    if (pool) {
      this.users.delete(userId);
      await pool.manager.stopAll();
    }
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    for (const [userId, pool] of this.users) {
      if (now - pool.lastUsed > USER_IDLE_MS) await this.stopUser(userId).catch(() => {});
    }
  }

  // ─── What a user sees ──────────────────────────────────────────────────────

  async userPrefs(userId: string): Promise<Record<string, boolean>> {
    const [row] = await this.deps.db.select({ settings: users.settings }).from(users).where(eq(users.id, userId));
    return ((row?.settings as UserSettings | undefined)?.mcp?.enabled ?? {}) as Record<string, boolean>;
  }

  /** Global and own servers are on by default; built-ins are off until the user turns them on. */
  private isOn(prefs: Record<string, boolean>, id: string, scope: ServerView['scope']): boolean {
    return prefs[id] ?? scope !== 'builtin';
  }

  async serversFor(userId: string): Promise<ServerView[]> {
    const prefs = await this.userPrefs(userId);
    const views: ServerView[] = [];
    for (const row of await this.globalRows()) {
      if (!row.enabled) continue;
      views.push({
        id: row.id,
        name: row.name,
        description: row.description,
        scope: 'global',
        transport: row.transport,
        status: this.global.getServerStatus(row.id),
        enabled: this.isOn(prefs, row.id, 'global'),
        error: this.global.getServerError(row.id) ?? null,
        tools: this.global.getServerTools(row.id),
      });
    }
    const pool = this.users.get(userId);
    const allowed = new Set(await this.allowedBuiltins());
    for (const b of builtinServers()) {
      if (!allowed.has(b.id)) continue;
      views.push({
        id: b.id,
        name: b.name,
        description: b.description,
        scope: 'builtin',
        transport: 'builtin',
        status: pool?.manager.getServerStatus(b.id) ?? 'stopped',
        enabled: this.isOn(prefs, b.id, 'builtin'),
        error: pool?.manager.getServerError(b.id) ?? null,
        tools: pool?.manager.getServerTools(b.id) ?? [],
      });
    }
    // OpenAPI tool servers (admin), on by default like shared MCP servers
    for (const row of await this.openApiRows()) {
      views.push({
        id: row.id,
        name: row.name,
        description: row.description,
        scope: 'global',
        transport: 'openapi',
        status: 'ready',
        enabled: this.isOn(prefs, row.id, 'global'),
        error: null,
        tools: row.operations.map((op) => ({ name: op.name, description: op.description, inputSchema: op.inputSchema as MCPTool['inputSchema'] })),
      });
    }
    for (const row of await this.ownRows(userId)) {
      if (!row.enabled) continue;
      views.push({
        id: row.id,
        name: row.name,
        description: row.description,
        scope: 'user',
        transport: row.transport,
        status: pool?.manager.getServerStatus(row.id) ?? 'stopped',
        enabled: this.isOn(prefs, row.id, 'user'),
        error: pool?.manager.getServerError(row.id) ?? null,
        tools: pool?.manager.getServerTools(row.id) ?? [],
      });
    }
    return views;
  }

  /** Switch a server on or off for this user (built-ins start or stop with it). */
  async setEnabled(userId: string, serverId: string, enabled: boolean): Promise<ServerView> {
    const view = (await this.serversFor(userId)).find((s) => s.id === serverId);
    if (!view) throw notFound('Tool server');
    const [row] = await this.deps.db.select({ settings: users.settings }).from(users).where(eq(users.id, userId));
    const settings = (row?.settings ?? {}) as UserSettings;
    const next: UserSettings = { ...settings, mcp: { enabled: { ...(settings.mcp?.enabled ?? {}), [serverId]: enabled } } };
    await this.deps.db.update(users).set({ settings: next }).where(eq(users.id, userId));
    if (view.scope === 'builtin') {
      if (enabled) await this.ensureBuiltin(userId, serverId).catch(() => {});
      else await this.users.get(userId)?.manager.stopServer(serverId);
    } else if (view.scope === 'user') {
      const row = (await this.ownRows(userId)).find((r) => r.id === serverId);
      if (enabled && row) await this.ensureOwn(userId, row).catch(() => {});
      else await this.stopOwn(userId, serverId);
    }
    return (await this.serversFor(userId)).find((s) => s.id === serverId)!;
  }

  /** The manager that runs a server for this user, if the user may use it. */
  private async managerFor(userId: string, serverId: string): Promise<MCPClientManager> {
    if (isBuiltinId(serverId)) {
      await this.ensureBuiltin(userId, serverId);
      return this.userPool(userId).manager;
    }
    const own = (await this.ownRows(userId)).find((r) => r.id === serverId);
    if (own) {
      if (!own.enabled) throw notFound('Tool server');
      await this.ensureOwn(userId, own);
      return this.userPool(userId).manager;
    }
    const [row] = await this.deps.db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.id, serverId), isNull(mcpServers.ownerId)));
    if (!row || !row.enabled) throw notFound('Tool server');
    return this.global;
  }

  async openApiRows(): Promise<Array<typeof toolServers.$inferSelect>> {
    return this.deps.db.select().from(toolServers).where(eq(toolServers.enabled, true));
  }

  /** Call a tool on a server this user may use. */
  async callTool(userId: string, serverId: string, tool: string, args: Record<string, unknown>) {
    const api = (await this.openApiRows()).find((r) => r.id === serverId);
    if (api) {
      const op = api.operations.find((o) => o.name === tool);
      if (!op) throw notFound('Tool');
      const auth = api.authCipher ? (JSON.parse(this.deps.secrets.decrypt(api.authCipher)) as { header: string; value: string }) : null;
      const r = await callOperation(op, api.baseUrl, args, auth);
      return { content: [{ type: 'text', text: r.content }], ...(r.isError ? { isError: true } : {}) };
    }
    const manager = await this.managerFor(userId, serverId);
    const result = await manager.callTool(serverId, tool, args);
    return isBuiltinId(serverId) ? redactWorkspacePath(result, userWorkspace(this.deps.dataDir, userId)) : result;
  }

  /** Tool definitions of a server for this user (for UI-action checks). */
  async toolsOf(userId: string, serverId: string): Promise<MCPTool[]> {
    const api = (await this.openApiRows()).find((r) => r.id === serverId);
    if (api) return api.operations.map((op) => ({ name: op.name, description: op.description, inputSchema: op.inputSchema as MCPTool['inputSchema'] }));
    const manager = await this.managerFor(userId, serverId);
    return manager.getServerTools(serverId);
  }

  /**
   * The tools of a run: the requested servers this user has switched on (or
   * that a custom model always uses) and that are ready, named by alias so
   * same-named tools on two servers both work.
   */
  async toolset(userId: string, serverIds: string[], alwaysOn: string[] = [], firstTurnOnly = false): Promise<RunToolset> {
    const wanted = new Set(serverIds);
    const forced = new Set(alwaysOn);
    const usable = (s: ServerView) => wanted.has(s.id) && (s.enabled || forced.has(s.id));
    const views = (await this.serversFor(userId)).filter(usable);
    const own = views.some((v) => v.scope === 'user') ? await this.ownRows(userId) : [];
    for (const v of views) {
      if (v.scope === 'builtin') await this.ensureBuiltin(userId, v.id).catch(() => {});
      const row = v.scope === 'user' ? own.find((r) => r.id === v.id) : undefined;
      if (row) await this.ensureOwn(userId, row).catch(() => {});
    }
    const ready = (await this.serversFor(userId)).filter((s) => usable(s) && s.status === 'ready');
    const sources: ToolSource[] = ready.map((s) => ({ id: s.id, name: s.name, tools: s.tools }));
    const aliases = buildToolAliases(sources);
    // Workspace files already shown under this reply (a document edited five times is shown once)
    const shown = new Set<string>();

    return {
      definitions: aliasesToOpenAI(aliases),
      firstTurnOnly,
      locate: (alias) => {
        const a = resolveToolAlias(alias, aliases);
        return a ? { serverId: a.serverId, tool: a.tool } : null;
      },
      execute: async (call, signal): Promise<ToolExecution> => {
        const a = resolveToolAlias(call.function.name, aliases);
        const fail = (message: string): ToolExecution => ({
          serverId: a?.serverId ?? '',
          tool: a?.tool ?? call.function.name,
          result: { type: 'tool_result', callId: call.id, content: JSON.stringify({ error: message }), isError: true },
        });
        if (!a) return fail(`Tool "${call.function.name}" is not available.`);
        let args: Record<string, unknown>;
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch (err) {
          return fail(`Invalid tool arguments: ${err instanceof Error ? err.message : 'not JSON'}. Expected valid JSON.`);
        }
        try {
          const timeout = new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new Error(`Tool timed out after ${TOOL_TIMEOUT_MS / 1000} seconds.`)), TOOL_TIMEOUT_MS);
            t.unref?.();
            signal.addEventListener('abort', () => reject(new Error('Stopped.')), { once: true });
          });
          // Files a built-in writes are shown under the reply, as links to the workspace
          const workspace = WRITING_BUILTINS.has(a.serverId) && !READ_ONLY_TOOL.test(a.tool) ? userWorkspace(this.deps.dataDir, userId) : null;
          const before = workspace ? await snapshotWorkspace(workspace) : null;
          const raw = await Promise.race([this.callTool(userId, a.serverId, a.tool, args), timeout]);
          const normalized = normalizeToolResult(raw as Parameters<typeof normalizeToolResult>[0]);
          const after = workspace && before && !normalized.isError ? await snapshotWorkspace(workspace) : null;
          const written = before && after ? changedFiles(before, after).filter((f) => !shown.has(f.path)) : [];
          for (const f of written) shown.add(f.path);
          return {
            serverId: a.serverId,
            tool: a.tool,
            result: {
              type: 'tool_result',
              callId: call.id,
              // The model is told a UI was shown instead of getting its markup
              content: normalized.uiResource ? uiResourceConfirmation(a.tool) : normalized.content,
              ...(normalized.isError ? { isError: true } : {}),
              ...(normalized.uiResource ? { uiResource: normalized.uiResource } : {}),
            },
            ...(written.length ? { extraParts: written.map((f) => ({ type: 'workspace_file' as const, path: f.path, size: f.size })) } : {}),
          };
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    };
  }

  async close(): Promise<void> {
    clearInterval(this.reaper);
    await Promise.all([...this.users.keys()].map((id) => this.stopUser(id)));
    await this.global.stopAll();
  }
}
