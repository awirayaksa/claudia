/**
 * Who is calling, and may they? Every /api request is authenticated here;
 * routes then declare the role they need.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context';
import { sessions, userMfa, users } from '../db/schema';
import { forbidden, unauthorized } from '../lib/errors';
import { ACCESS_COOKIE, CSRF_COOKIE, CSRF_HEADER, type AuthUser } from './sessions';
import { safeEqualHex, verifyAccessToken } from './tokens';
import { authenticateApiKey } from './api-keys';
import { mfaRequiredFor } from './signin';

/** The OpenAI-compatible API: Bearer API keys only, never cookies (so no CSRF check). */
export const API_V1_PREFIX = '/api/v1/';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when a valid session cookie came with the request. */
    user: AuthUser | null;
    /** Why `user` is null: no cookie, or an expired / invalid one. */
    authError: 'none' | 'expired' | 'invalid' | null;
  }
}

/** last_active_at is written at most this often per user. */
const ACTIVITY_WRITE_MS = 5 * 60_000;
const lastActivityWrite = new Map<string, number>();

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function registerAuthHooks(app: FastifyInstance, ctx: ServerContext): void {
  app.decorateRequest('user', null);
  app.decorateRequest('authError', null);

  app.addHook('onRequest', async (req) => {
    req.user = null;
    req.authError = 'none';
    if (req.url.startsWith(API_V1_PREFIX)) {
      const header = req.headers.authorization;
      const bearer = typeof header === 'string' && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
      if (!bearer) return;
      req.user = await authenticateApiKey(ctx, bearer);
      if (!req.user) req.authError = 'invalid';
      return;
    }
    const token = req.cookies[ACCESS_COOKIE];
    if (!token) return;

    const verified = await verifyAccessToken(ctx.keyring.jwt, token);
    if (!verified.ok) {
      req.authError = verified.reason;
      return;
    }

    // One query: the user, provided the session is still live (logout and
    // revocation take effect at once, and role changes apply immediately)
    const [row] = await ctx.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        passwordHash: users.passwordHash,
        mfaEnabledAt: userMfa.enabledAt,
      })
      .from(users)
      .innerJoin(sessions, eq(sessions.userId, users.id))
      .leftJoin(userMfa, eq(userMfa.userId, users.id))
      .where(
        and(
          eq(users.id, verified.claims.userId),
          eq(sessions.id, verified.claims.sessionId),
          isNull(sessions.revokedAt),
          isNull(users.deactivatedAt),
          sql`${sessions.expiresAt} > now()`
        )
      );
    if (!row) {
      req.authError = 'invalid';
      return;
    }
    req.user = {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      sessionId: verified.claims.sessionId,
      hasPassword: !!row.passwordHash,
      mfaEnabled: !!row.mfaEnabledAt,
    };

    const now = Date.now();
    if (now - (lastActivityWrite.get(row.id) ?? 0) > ACTIVITY_WRITE_MS) {
      lastActivityWrite.set(row.id, now);
      void ctx.db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, row.id)).catch(() => {});
    }
  });

  // Double-submit CSRF check on every state-changing API call. The sandbox
  // origin can neither read the cookie nor set the header.
  app.addHook('preHandler', async (req) => {
    if (SAFE_METHODS.has(req.method) || !req.url.startsWith('/api/') || req.url.startsWith(API_V1_PREFIX)) return;
    const cookie = req.cookies[CSRF_COOKIE];
    const header = req.headers[CSRF_HEADER];
    if (!cookie || typeof header !== 'string' || !safeEqualHex(cookie, header)) {
      throw forbidden('Missing or invalid CSRF token. Reload the page and try again.', 'csrf');
    }
  });
}

function requireSession(req: FastifyRequest): AuthUser {
  if (!req.user) {
    throw unauthorized(
      req.authError === 'expired' ? 'Session expired.' : 'Sign in to continue.',
      req.authError === 'expired' ? 'token_expired' : 'unauthorized'
    );
  }
  return req.user;
}

/** Signed in, any role (pending users only reach their own account routes). */
export async function requireSignedIn(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  requireSession(req);
}

/**
 * When the admin requires two-factor sign-in, a session without it reaches
 * only the routes for setting it up (/api/me, /api/auth). API keys are a
 * separate credential and aren't affected.
 */
function requireMfaIfDemanded(req: FastifyRequest, user: AuthUser): void {
  if (user.mfaEnabled || user.sessionId.startsWith('api-key:')) return;
  if (mfaRequiredFor(req.server.ctx.settings.peek('auth.mfa'), user.role)) {
    throw forbidden('Turn on two-factor sign-in to continue (Settings → Account).', 'mfa_setup_required');
  }
}

/** An approved user or an admin. */
export async function requireUser(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const user = requireSession(req);
  if (user.role === 'pending') throw forbidden('Your account is waiting for approval by an administrator.', 'pending');
  requireMfaIfDemanded(req, user);
}

export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const user = requireSession(req);
  if (user.role !== 'admin') throw forbidden('Administrators only.');
  requireMfaIfDemanded(req, user);
}

/** The signed-in user (call after one of the guards above). */
export function currentUser(req: FastifyRequest): AuthUser {
  return requireSession(req);
}
