/**
 * Azure DevOps Server / TFS for the built-in work-item tools. The admin lists
 * the collections (`azdo.servers`); each user connects with a personal access
 * token, kept encrypted and read again on every request, so reconnecting or
 * disconnecting applies at once.
 *
 * Requests go only to the admin's collections: the tool server names a path
 * under a collection, never a URL. They pass the SSRF guard with the
 * collection's host allowed (on-premises servers are usually private), and
 * redirects are refused so the token never travels elsewhere.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { azdoConnections } from '../db/schema';
import type { SecretBox } from '../crypto/secrets';
import type { AppSettings } from '../modules/settings/app-settings';
import { HttpError, badRequest, notFound } from '../lib/errors';
import { BlockedRequestError, readBodyLimited, safeFetch, type SafeFetchPolicy } from '../net/safe-fetch';
import type { AzdoConnection, AzdoRequest, AzdoResponse } from '../../../electron/services/builtin-mcp/azure-devops.server';
import type { AzdoConnectInput, AzdoConnectionView, AzdoServer } from '../../shared/azdo';

const TIMEOUT_MS = 30_000;
const MAX_BYTES = 5 * 1024 * 1024;

export interface AzdoServiceDeps {
  db: Database;
  secrets: SecretBox;
  settings: AppSettings;
  netPolicy: () => SafeFetchPolicy;
}

const TOKEN_REJECTED =
  'Azure DevOps rejected your token, or it lacks the needed scopes (Work Items: Read & write; Project and Team: Read). Reconnect in Settings → Tools.';

export class AzdoService {
  constructor(private readonly deps: AzdoServiceDeps) {}

  async servers(): Promise<AzdoServer[]> {
    return (await this.deps.settings.get('azdo.servers')).servers;
  }

  private async server(serverId: string): Promise<AzdoServer> {
    const found = (await this.servers()).find((s) => s.id === serverId);
    if (!found) throw notFound('Azure DevOps server');
    return found;
  }

  private async row(userId: string, serverId: string) {
    const [row] = await this.deps.db
      .select()
      .from(azdoConnections)
      .where(and(eq(azdoConnections.userId, userId), eq(azdoConnections.serverId, serverId)));
    return row;
  }

  /** The admin's collections and whether this user is connected to each. */
  async connections(userId: string): Promise<AzdoConnectionView[]> {
    const servers = await this.servers();
    if (servers.length === 0) return [];
    const rows = await this.deps.db.select().from(azdoConnections).where(eq(azdoConnections.userId, userId));
    return servers.map((s) => {
      const row = rows.find((r) => r.serverId === s.id);
      return {
        serverId: s.id,
        serverName: s.name,
        url: s.url,
        connected: !!row,
        displayName: row?.displayName ?? null,
        defaultProject: row?.defaultProject ?? null,
      };
    });
  }

  /** What the tool server sees (no tokens). */
  async toolConnections(userId: string): Promise<AzdoConnection[]> {
    const byId = new Map((await this.servers()).map((s) => [s.id, s]));
    return (await this.connections(userId)).map((c) => ({
      serverId: c.serverId,
      name: c.serverName,
      url: c.url,
      apiVersion: byId.get(c.serverId)!.apiVersion,
      connected: c.connected,
      displayName: c.displayName,
      defaultProject: c.defaultProject,
    }));
  }

  /** Check the token (connectionData), then store it encrypted. Without a token, only the default project changes. */
  async connect(userId: string, serverId: string, input: AzdoConnectInput): Promise<AzdoConnectionView> {
    const server = await this.server(serverId);
    const defaultProject = input.defaultProject === undefined ? undefined : input.defaultProject || null;
    if (!input.pat) {
      if (!(await this.row(userId, serverId))) throw badRequest('Enter a personal access token.', 'azdo_no_token');
      if (defaultProject !== undefined) {
        await this.deps.db
          .update(azdoConnections)
          .set({ defaultProject })
          .where(and(eq(azdoConnections.userId, userId), eq(azdoConnections.serverId, serverId)));
      }
    } else {
      const res = await this.send(server, input.pat, { method: 'GET', path: '_apis/connectionData', query: { connectOptions: 'none' } }, null);
      const user = (res.json as { authenticatedUser?: { providerDisplayName?: string; descriptor?: string } } | null)?.authenticatedUser;
      if (res.status >= 400 || !user?.providerDisplayName || /anonymous|publicaccess/i.test(user.descriptor ?? '')) {
        throw badRequest(res.status === 401 || res.status === 403 || res.status < 400 ? 'Azure DevOps rejected this token.' : `Azure DevOps answered ${res.status}.`, 'azdo_token');
      }
      const values = {
        patCipher: this.deps.secrets.encrypt(input.pat),
        displayName: user.providerDisplayName,
        verifiedAt: new Date(),
        ...(defaultProject !== undefined ? { defaultProject } : {}),
      };
      await this.deps.db
        .insert(azdoConnections)
        .values({ userId, serverId, ...values })
        .onConflictDoUpdate({ target: [azdoConnections.userId, azdoConnections.serverId], set: values });
    }
    return (await this.connections(userId)).find((c) => c.serverId === serverId)!;
  }

  async disconnect(userId: string, serverId: string): Promise<void> {
    await this.deps.db.delete(azdoConnections).where(and(eq(azdoConnections.userId, userId), eq(azdoConnections.serverId, serverId)));
  }

  /** One request for the tool server, signed in as the user. */
  async request(userId: string, serverId: string, req: AzdoRequest): Promise<AzdoResponse> {
    const server = await this.server(serverId);
    const row = await this.row(userId, serverId);
    if (!row) throw new Error(`Connect ${server.name} in Settings → Tools first.`);
    const res = await this.send(server, this.deps.secrets.decrypt(row.patCipher), req, server.apiVersion);
    if (res.status === 401 || res.status === 403) throw new Error(TOKEN_REJECTED);
    return res;
  }

  /** The request URL: a path under the collection, nothing else. */
  static urlFor(server: AzdoServer, req: Pick<AzdoRequest, 'path' | 'query'>, apiVersion: string | null): URL {
    const base = new URL(`${server.url}/`);
    if (/^[a-z][a-z0-9+.-]*:|^\/\/|\\|(^|\/)\.\.?(\/|$)|%2e|%2f|%5c/i.test(req.path)) throw badRequest('Invalid Azure DevOps path.', 'azdo_path');
    const url = new URL(req.path.replace(/^\/+/, ''), base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw badRequest('Invalid Azure DevOps path.', 'azdo_path');
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    if (apiVersion) url.searchParams.set('api-version', apiVersion);
    return url;
  }

  private async send(server: AzdoServer, pat: string, req: AzdoRequest, apiVersion: string | null): Promise<AzdoResponse> {
    const url = AzdoService.urlFor(server, req, apiVersion);
    const base = this.deps.netPolicy();
    let res;
    try {
      res = await safeFetch(url, {
        method: req.method,
        headers: {
          authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
          accept: 'application/json',
          ...(req.body !== undefined ? { 'content-type': req.contentType ?? 'application/json' } : {}),
        },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        policy: { allow: [...(base.allow ?? []), url.hostname] },
        maxRedirects: 0,
        timeoutMs: TIMEOUT_MS,
      });
    } catch (err) {
      // A redirect usually means a sign-in page: the token wasn't accepted
      if (err instanceof BlockedRequestError && /redirect/i.test(err.message)) return { status: 401, json: null };
      throw new HttpError(502, 'azdo_unreachable', `Couldn't reach ${server.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = await readBodyLimited(res, MAX_BYTES);
    const type = res.headers.get('content-type') ?? '';
    // TFS answers a bad token with 203 and an HTML sign-in page
    if (res.status === 203 || (res.ok && !/json/i.test(type))) return { status: 401, json: null };
    let parsed: unknown = null;
    try {
      parsed = body.length ? JSON.parse(body.toString('utf8')) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, json: parsed };
  }
}
