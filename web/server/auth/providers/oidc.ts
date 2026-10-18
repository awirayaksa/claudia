/**
 * OpenID Connect sign-in (Entra ID, Google, Keycloak, Okta, Authentik…):
 * the authorization-code flow with PKCE, state and nonce. The ID token is
 * verified against the provider's JWKS (issuer, audience, expiry, nonce).
 *
 * Accounts are found by the provider's subject. A first sign-in with an
 * email that already has an account links to it only when the provider
 * allows linking by email and the email is verified, or when the account was
 * provisioned (SCIM or an admin) and has no other way to sign in. Otherwise
 * a new account is made, if the provider allows sign-up, with its default
 * role, or admin when the groups claim names one of its admin groups. The
 * groups claim decides membership of Claudia groups with the same names
 * (memberships it added go when the claim no longer names the group).
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../db/client';
import { authIdentities, groupMembers, groups, ssoProviders, users, type UserRole } from '../../db/schema';
import type { SecretBox } from '../../crypto/secrets';
import { uuidv7 } from '../../lib/ids';
import { HttpError, conflict, forbidden, notFound } from '../../lib/errors';
import { normalizeEmail } from '../../modules/users/service';
import type { SsoProviderView } from '../../../shared/auth';

type ProviderRow = typeof ssoProviders.$inferSelect;

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

/** Kept in an encrypted cookie between /start and /callback. */
export interface OidcState {
  provider: string;
  state: string;
  nonce: string;
  verifier: string;
  expires: number;
}

export interface OidcClaims {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  groups: string[];
}

const DISCOVERY_TTL_MS = 60 * 60_000;
const b64url = (buf: Buffer) => buf.toString('base64url');

export function toSsoView(row: ProviderRow): SsoProviderView {
  return {
    id: row.id,
    name: row.name,
    issuer: row.issuer,
    clientId: row.clientId,
    hasSecret: !!row.clientSecretCipher,
    scopes: row.scopes,
    enabled: row.enabled,
    allowSignup: row.allowSignup,
    defaultRole: row.defaultRole,
    allowedDomains: row.allowedDomains,
    linkByEmail: row.linkByEmail,
    groupsClaim: row.groupsClaim,
    adminGroups: row.adminGroups,
  };
}

export class OidcService {
  private discoveries = new Map<string, { at: number; doc: Discovery }>();
  private jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor(private readonly deps: { db: Database; secrets: SecretBox; log: FastifyBaseLogger }) {}

  async enabledList(): Promise<Array<{ id: string; name: string }>> {
    const rows = await this.deps.db.select({ id: ssoProviders.id, name: ssoProviders.name }).from(ssoProviders).where(eq(ssoProviders.enabled, true));
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async provider(id: string): Promise<ProviderRow> {
    const [row] = await this.deps.db.select().from(ssoProviders).where(eq(ssoProviders.id, id));
    if (!row) throw notFound('Sign-in provider');
    return row;
  }

  /** Forget cached discovery and keys (the provider changed). */
  forget(id: string): void {
    for (const key of [...this.discoveries.keys()]) if (key.startsWith(`${id}|`)) this.discoveries.delete(key);
    this.jwks.clear();
  }

  async discover(row: Pick<ProviderRow, 'id' | 'issuer'>): Promise<Discovery> {
    const key = `${row.id}|${row.issuer}`;
    const cached = this.discoveries.get(key);
    if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.doc;
    const url = `${row.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } }).catch((err) => {
      throw new HttpError(502, 'sso_unreachable', `The sign-in provider can't be reached (${err instanceof Error ? err.message : String(err)}).`);
    });
    if (!res.ok) throw new HttpError(502, 'sso_unreachable', `The sign-in provider's discovery document answered ${res.status}.`);
    const doc = (await res.json()) as Discovery;
    for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (typeof doc[field] !== 'string') throw new HttpError(502, 'sso_bad_discovery', `The provider's discovery document has no ${field}.`);
    }
    this.discoveries.set(key, { at: Date.now(), doc });
    return doc;
  }

  /** Where to send the browser, and what to remember until it comes back. */
  async start(id: string, redirectUri: string): Promise<{ url: string; state: OidcState }> {
    const row = await this.provider(id);
    if (!row.enabled) throw forbidden('This sign-in provider is turned off.', 'sso_disabled');
    const doc = await this.discover(row);
    const state: OidcState = {
      provider: id,
      state: b64url(randomBytes(24)),
      nonce: b64url(randomBytes(24)),
      verifier: b64url(randomBytes(32)),
      expires: Date.now() + 10 * 60_000,
    };
    const url = new URL(doc.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: row.clientId,
      redirect_uri: redirectUri,
      scope: row.scopes,
      state: state.state,
      nonce: state.nonce,
      code_challenge: b64url(createHash('sha256').update(state.verifier).digest()),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString(), state };
  }

  /** Trade the code for tokens and return the verified claims. */
  async finish(id: string, params: { code?: string; state?: string; error?: string }, saved: OidcState | null, redirectUri: string): Promise<OidcClaims> {
    if (params.error) throw forbidden(`The sign-in provider refused: ${params.error}.`, 'sso_refused');
    if (!saved || saved.provider !== id || saved.expires < Date.now() || !params.state || params.state !== saved.state) {
      throw forbidden('This sign-in attempt expired or was not started here. Try again.', 'sso_state');
    }
    if (!params.code) throw forbidden('The sign-in provider sent no code.', 'sso_no_code');
    const row = await this.provider(id);
    const doc = await this.discover(row);
    const secret = row.clientSecretCipher ? this.deps.secrets.decrypt(row.clientSecretCipher) : null;

    const body = new URLSearchParams({ grant_type: 'authorization_code', code: params.code, redirect_uri: redirectUri, code_verifier: saved.verifier });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const methods = doc.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
    if (secret && methods.includes('client_secret_basic')) {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(row.clientId)}:${encodeURIComponent(secret)}`).toString('base64')}`;
    } else {
      body.set('client_id', row.clientId);
      if (secret) body.set('client_secret', secret);
    }
    const res = await fetch(doc.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    const tokens = (await res.json().catch(() => ({}))) as { id_token?: string; access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !tokens.id_token) {
      this.deps.log.warn({ provider: id, status: res.status, error: tokens.error }, 'OIDC token exchange failed');
      throw forbidden(`The sign-in provider didn't accept the sign-in (${tokens.error_description ?? tokens.error ?? res.status}).`, 'sso_token');
    }

    let keys = this.jwks.get(doc.jwks_uri);
    if (!keys) this.jwks.set(doc.jwks_uri, (keys = createRemoteJWKSet(new URL(doc.jwks_uri))));
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(tokens.id_token, keys, { issuer: doc.issuer, audience: row.clientId, clockTolerance: 60 }));
    } catch (err) {
      throw forbidden(`The sign-in provider's ID token is not valid (${err instanceof Error ? err.message : String(err)}).`, 'sso_token_invalid');
    }
    if (payload.nonce !== saved.nonce) throw forbidden('The ID token was not issued for this sign-in.', 'sso_nonce');
    if (typeof payload.sub !== 'string' || !payload.sub) throw forbidden('The ID token has no subject.', 'sso_token_invalid');

    let claims: Record<string, unknown> = payload;
    // Some providers keep the email and groups for the userinfo endpoint
    if ((!claims.email || (row.groupsClaim && claims[row.groupsClaim] === undefined)) && doc.userinfo_endpoint && tokens.access_token) {
      const info: Record<string, unknown> = await fetch(doc.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(10_000),
      })
        .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : {}))
        .catch(() => ({}));
      if (info.sub === undefined || info.sub === payload.sub) claims = { ...info, ...payload, ...(payload.email ? {} : { email: info.email, email_verified: info.email_verified }) };
    }
    const rawGroups = row.groupsClaim ? claims[row.groupsClaim] : undefined;
    return {
      sub: payload.sub,
      email: typeof claims.email === 'string' ? normalizeEmail(claims.email) : null,
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
      name: typeof claims.name === 'string' ? claims.name : typeof claims.preferred_username === 'string' ? claims.preferred_username : null,
      groups: Array.isArray(rawGroups) ? rawGroups.map(String) : typeof rawGroups === 'string' ? [rawGroups] : [],
    };
  }

  /** The account for these claims, found, linked or created. */
  async provision(id: string, claims: OidcClaims): Promise<{ userId: string; created: boolean }> {
    const row = await this.provider(id);
    const subject = `${row.id}:${claims.sub}`;
    const db = this.deps.db;
    const isAdminByGroup = row.adminGroups.length > 0 && claims.groups.some((g) => row.adminGroups.includes(g));

    const result = await db.transaction(async (tx) => {
      const [linked] = await tx
        .select({ userId: authIdentities.userId })
        .from(authIdentities)
        .where(and(eq(authIdentities.provider, 'oidc'), eq(authIdentities.subject, subject)));
      if (linked) return { userId: linked.userId, created: false };

      if (!claims.email) throw forbidden('The sign-in provider did not share an email address.', 'sso_no_email');
      const domain = claims.email.split('@')[1] ?? '';
      if (row.allowedDomains.length > 0 && !row.allowedDomains.map((d) => d.toLowerCase()).includes(domain)) {
        throw forbidden(`Accounts from ${domain} can't sign in here.`, 'sso_domain');
      }
      const [existing] = await tx.select().from(users).where(eq(users.email, claims.email));
      if (existing) {
        const identities = await tx.select({ provider: authIdentities.provider }).from(authIdentities).where(eq(authIdentities.userId, existing.id));
        const provisioned = !existing.passwordHash && identities.length === 0;
        if (!(provisioned || (row.linkByEmail && claims.emailVerified))) {
          throw conflict('An account with this email already exists. Sign in the way you usually do, or ask an administrator to allow linking.', 'email_conflict');
        }
        await tx.insert(authIdentities).values({ userId: existing.id, provider: 'oidc', subject });
        return { userId: existing.id, created: false };
      }
      if (!row.allowSignup) throw forbidden(`There is no account for ${claims.email}. Ask an administrator.`, 'signup_disabled');
      const userId = uuidv7();
      const role: UserRole = isAdminByGroup ? 'admin' : row.defaultRole;
      await tx.insert(users).values({ id: userId, email: claims.email, name: claims.name?.trim() || claims.email.split('@')[0], passwordHash: null, role });
      await tx.insert(authIdentities).values({ userId, provider: 'oidc', subject });
      return { userId, created: true };
    });

    // Groups from the claim, and admin by group (never taken away here)
    if (isAdminByGroup) await db.update(users).set({ role: 'admin', updatedAt: new Date() }).where(and(eq(users.id, result.userId), sql`${users.role} <> 'admin'`));
    if (row.groupsClaim) {
      const names = claims.groups.map((g) => g.toLowerCase());
      const matched = names.length ? await db.select({ id: groups.id }).from(groups).where(inArray(sql`lower(${groups.name})`, names)) : [];
      const keep = matched.map((g) => g.id);
      await db
        .delete(groupMembers)
        .where(
          and(
            eq(groupMembers.userId, result.userId),
            eq(groupMembers.source, 'sso'),
            keep.length ? sql`${groupMembers.groupId} not in (${sql.join(keep.map((k) => sql`${k}::uuid`), sql`, `)})` : undefined
          )
        );
      if (keep.length > 0) {
        await db
          .insert(groupMembers)
          .values(keep.map((groupId) => ({ groupId, userId: result.userId, source: 'sso' as const })))
          .onConflictDoNothing();
      }
    }
    return result;
  }
}
