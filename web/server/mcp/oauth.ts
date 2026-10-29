/**
 * OAuth sign-in to remote MCP servers (the MCP authorization spec), with the
 * SDK's `auth()` doing the protocol: protected-resource and authorization
 * server discovery, dynamic client registration (or a pre-registered
 * client), PKCE, the code exchange and refreshing.
 *
 * The browser goes to the authorization server, which sends it back to
 * GET /api/mcp/oauth/callback; the `state` there finds the pending sign-in,
 * which only the user who started it can finish. Tokens are kept encrypted
 * per server and refreshed by the transport when the server answers 401.
 */
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { auth, discoverAuthorizationServerMetadata } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Database } from '../db/client';
import { mcpOAuth } from '../db/schema';
import type { SecretBox } from '../crypto/secrets';
import { badRequest, notFound } from '../lib/errors';

/** A pending sign-in must be finished within this time. */
const PENDING_MS = 10 * 60_000;

/** What is kept (encrypted) for one server's sign-in. */
interface OAuthState {
  redirectUrl: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState;
}

/** The OAuth settings stored with a server's config. */
export interface StoredOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
}

type FetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** An OAuthClientProvider over the mcp_oauth row of one server. */
class StoredProvider implements OAuthClientProvider {
  /** Set when `auth()` wants the user to sign in. */
  authorizationUrl: URL | null = null;

  constructor(
    private readonly store: McpOAuth,
    private readonly serverId: string,
    private readonly userId: string,
    private data: OAuthState,
    private readonly config: StoredOAuthConfig
  ) {}

  get redirectUrl(): string {
    return this.data.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Claudia',
      redirect_uris: [this.data.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.config.clientSecret ? 'client_secret_post' : 'none',
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    };
  }

  async state(): Promise<string> {
    const state = crypto.randomBytes(24).toString('base64url');
    await this.store.setPending(this.serverId, state);
    return state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.config.clientId) {
      return { client_id: this.config.clientId, ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}) };
    }
    return this.data.clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this.data = { ...this.data, clientInformation: info };
    await this.save();
  }

  /** Read fresh each time: another instance may have refreshed (and rotated) them. */
  async tokens(): Promise<OAuthTokens | undefined> {
    const stored = await this.store.read(this.serverId);
    if (stored) this.data = { ...this.data, tokens: stored.tokens };
    return this.data.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.data = { ...this.data, tokens, codeVerifier: undefined };
    await this.save({ connected: true });
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.data = { ...this.data, codeVerifier };
    await this.save();
  }

  codeVerifier(): string {
    if (!this.data.codeVerifier) throw new Error('No sign-in is in progress.');
    return this.data.codeVerifier;
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    this.data = { ...this.data, discovery };
    await this.save();
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.data.discovery;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const next = { ...this.data };
    if (scope === 'all' || scope === 'client') delete next.clientInformation;
    if (scope === 'all' || scope === 'tokens') delete next.tokens;
    if (scope === 'all' || scope === 'verifier') delete next.codeVerifier;
    if (scope === 'all' || scope === 'discovery') delete next.discovery;
    this.data = next;
    await this.save({ connected: !!next.tokens });
  }

  private save(opts: { connected?: boolean } = {}): Promise<void> {
    return this.store.write(this.serverId, this.userId, this.data, opts.connected);
  }
}

export class McpOAuth {
  constructor(
    private readonly deps: {
      db: Database;
      secrets: SecretBox;
      log: FastifyBaseLogger;
    }
  ) {}

  private async row(serverId: string) {
    const [row] = await this.deps.db.select().from(mcpOAuth).where(eq(mcpOAuth.serverId, serverId));
    return row;
  }

  private decode(cipher: string): OAuthState {
    return JSON.parse(this.deps.secrets.decrypt(cipher)) as OAuthState;
  }

  /** @internal Used by the provider. */
  async read(serverId: string): Promise<OAuthState | null> {
    const row = await this.row(serverId);
    return row ? this.decode(row.cipher) : null;
  }

  /** @internal Used by the provider. */
  async write(serverId: string, userId: string, data: OAuthState, connected?: boolean): Promise<void> {
    const cipher = this.deps.secrets.encrypt(JSON.stringify(data));
    const now = new Date();
    const connectedAt = connected === undefined ? undefined : connected ? now : null;
    await this.deps.db
      .insert(mcpOAuth)
      .values({ serverId, userId, cipher, updatedAt: now, ...(connectedAt !== undefined ? { connectedAt } : {}) })
      .onConflictDoUpdate({
        target: mcpOAuth.serverId,
        set: {
          cipher,
          updatedAt: now,
          ...(connectedAt !== undefined ? { connectedAt } : {}),
          ...(connected ? { pendingState: null, pendingExpiresAt: null } : {}),
        },
      });
  }

  /** @internal Used by the provider. */
  async setPending(serverId: string, state: string): Promise<void> {
    await this.deps.db
      .update(mcpOAuth)
      .set({ pendingState: state, pendingExpiresAt: new Date(Date.now() + PENDING_MS) })
      .where(eq(mcpOAuth.serverId, serverId));
  }

  /** Whether the server has tokens. */
  async connected(serverId: string): Promise<boolean> {
    const row = await this.row(serverId);
    return !!row?.connectedAt;
  }

  /** Connected state of several servers at once. */
  async connectedSet(serverIds: string[]): Promise<Set<string>> {
    if (serverIds.length === 0) return new Set();
    const rows = await this.deps.db.select({ serverId: mcpOAuth.serverId, connectedAt: mcpOAuth.connectedAt }).from(mcpOAuth);
    const wanted = new Set(serverIds);
    return new Set(rows.filter((r) => wanted.has(r.serverId) && r.connectedAt).map((r) => r.serverId));
  }

  /**
   * The provider a transport uses (it adds the token and refreshes it), or
   * null if the server was never signed in to.
   */
  async providerFor(serverId: string, config: StoredOAuthConfig): Promise<OAuthClientProvider | null> {
    const row = await this.row(serverId);
    if (!row?.connectedAt) return null;
    return new StoredProvider(this, serverId, row.userId, this.decode(row.cipher), config);
  }

  /**
   * Start signing in as `userId`: the URL to send the browser to, or null if
   * the server already accepts the stored (or refreshed) tokens.
   */
  async start(
    serverId: string,
    userId: string,
    opts: { serverUrl: string; redirectUrl: string; config: StoredOAuthConfig; fetchFn: FetchFn }
  ): Promise<string | null> {
    const existing = await this.row(serverId);
    // A new sign-in keeps the client registration (and the discovery), not old tokens
    const previous = existing ? this.decode(existing.cipher) : null;
    const data: OAuthState = {
      redirectUrl: opts.redirectUrl,
      ...(previous?.clientInformation && previous.redirectUrl === opts.redirectUrl ? { clientInformation: previous.clientInformation } : {}),
      ...(previous?.discovery ? { discovery: previous.discovery } : {}),
    };
    await this.write(serverId, userId, data, false);
    const provider = new StoredProvider(this, serverId, userId, data, opts.config);
    const result = await auth(provider, { serverUrl: opts.serverUrl, fetchFn: opts.fetchFn, ...(opts.config.scope ? { scope: opts.config.scope } : {}) });
    if (result === 'AUTHORIZED') return null;
    if (!provider.authorizationUrl) throw new Error('The server did not ask for a sign-in.');
    return provider.authorizationUrl.toString();
  }

  /** The pending sign-in a callback's `state` belongs to, if `userId` started it and it hasn't expired. */
  async pending(state: string, userId: string): Promise<{ serverId: string } | null> {
    const [row] = await this.deps.db.select().from(mcpOAuth).where(eq(mcpOAuth.pendingState, state));
    if (!row || row.userId !== userId || !row.pendingExpiresAt || row.pendingExpiresAt.getTime() < Date.now()) return null;
    return { serverId: row.serverId };
  }

  /** Finish a sign-in with the code from the callback. */
  async finish(serverId: string, code: string, opts: { serverUrl: string; config: StoredOAuthConfig; fetchFn: FetchFn }): Promise<void> {
    const row = await this.row(serverId);
    if (!row) throw notFound('Sign-in');
    const provider = new StoredProvider(this, serverId, row.userId, this.decode(row.cipher), opts.config);
    const result = await auth(provider, { serverUrl: opts.serverUrl, authorizationCode: code, fetchFn: opts.fetchFn });
    if (result !== 'AUTHORIZED') throw badRequest('The sign-in was not accepted.', 'oauth_failed');
  }

  /** Sign out: revoke the tokens at the authorization server (when it can) and forget them. */
  async disconnect(serverId: string, opts: { serverUrl: string; config: StoredOAuthConfig; fetchFn: FetchFn }): Promise<void> {
    const row = await this.row(serverId);
    if (!row) return;
    const data = this.decode(row.cipher);
    if (data.tokens) {
      await this.revoke(data, opts).catch((err) => this.deps.log.warn({ err: String(err), serverId }, 'revoking MCP OAuth tokens failed'));
    }
    await this.deps.db.delete(mcpOAuth).where(eq(mcpOAuth.serverId, serverId));
  }

  /** Forget everything about a server's sign-in (the server's OAuth was switched off). */
  async forget(serverId: string): Promise<void> {
    await this.deps.db.delete(mcpOAuth).where(eq(mcpOAuth.serverId, serverId));
  }

  /** RFC 7009: revoke the refresh token, then the access token. */
  private async revoke(data: OAuthState, opts: { serverUrl: string; config: StoredOAuthConfig; fetchFn: FetchFn }): Promise<void> {
    const issuer = data.discovery?.authorizationServerUrl ?? new URL('/', opts.serverUrl).toString();
    const metadata = data.discovery?.authorizationServerMetadata ?? (await discoverAuthorizationServerMetadata(issuer, { fetchFn: opts.fetchFn }));
    const endpoint = (metadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint;
    if (!endpoint) return;
    const clientId = opts.config.clientId ?? data.clientInformation?.client_id;
    const clientSecret = opts.config.clientSecret ?? (data.clientInformation as { client_secret?: string } | undefined)?.client_secret;
    for (const [token, hint] of [
      [data.tokens?.refresh_token, 'refresh_token'],
      [data.tokens?.access_token, 'access_token'],
    ] as const) {
      if (!token) continue;
      const body = new URLSearchParams({ token, token_type_hint: hint, ...(clientId ? { client_id: clientId } : {}), ...(clientSecret ? { client_secret: clientSecret } : {}) });
      await opts.fetchFn(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    }
  }
}
