import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context';
import { sessions, users, type UserRole } from '../db/schema';
import { uuidv7 } from '../lib/ids';
import {
  ACCESS_TTL_SECONDS,
  REFRESH_GRACE_SECONDS,
  REFRESH_TTL_SECONDS,
  formatRefreshToken,
  hashToken,
  newCsrfToken,
  newRefreshSecret,
  parseRefreshToken,
  safeEqualHex,
  signAccessToken,
} from './tokens';

export const ACCESS_COOKIE = 'claudia_at';
export const REFRESH_COOKIE = 'claudia_rt';
export const CSRF_COOKIE = 'claudia_csrf';
export const CSRF_HEADER = 'x-claudia-csrf';
/** The refresh cookie is only ever sent to the auth routes. */
const REFRESH_PATH = '/api/auth';

/** Host-only cookies (no Domain), so a sandbox subdomain never receives them. */
function cookieBase(ctx: ServerContext) {
  return { httpOnly: true, sameSite: 'lax' as const, secure: ctx.config.secureCookies };
}

export function setAccessCookie(ctx: ServerContext, reply: FastifyReply, token: string): void {
  reply.setCookie(ACCESS_COOKIE, token, { ...cookieBase(ctx), path: '/', maxAge: ACCESS_TTL_SECONDS });
}

export function setRefreshCookie(ctx: ServerContext, reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, { ...cookieBase(ctx), path: REFRESH_PATH, maxAge: REFRESH_TTL_SECONDS });
}

/** Readable by the page (double-submit); the page echoes it in X-Claudia-CSRF. */
export function ensureCsrfCookie(ctx: ServerContext, req: FastifyRequest, reply: FastifyReply): string {
  const existing = req.cookies[CSRF_COOKIE];
  if (existing) return existing;
  const token = newCsrfToken();
  reply.setCookie(CSRF_COOKIE, token, { ...cookieBase(ctx), httpOnly: false, path: '/' });
  return token;
}

export function clearAuthCookies(ctx: ServerContext, reply: FastifyReply): void {
  reply.clearCookie(ACCESS_COOKIE, { ...cookieBase(ctx), path: '/' });
  reply.clearCookie(REFRESH_COOKIE, { ...cookieBase(ctx), path: REFRESH_PATH });
}

/** Start a session and set its cookies. */
export async function startSession(
  ctx: ServerContext,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string
): Promise<string> {
  const sessionId = uuidv7();
  const secret = newRefreshSecret();
  await ctx.db.insert(sessions).values({
    id: sessionId,
    userId,
    refreshHash: hashToken(secret),
    userAgent: req.headers['user-agent']?.slice(0, 500) ?? null,
    ip: req.ip,
    expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
    lastVerifiedAt: new Date(),
  });
  await ctx.db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, userId));
  setAccessCookie(ctx, reply, await signAccessToken(ctx.keyring.jwt, { userId, sessionId }));
  setRefreshCookie(ctx, reply, formatRefreshToken(sessionId, secret));
  ensureCsrfCookie(ctx, req, reply);
  return sessionId;
}

export type RefreshOutcome =
  | { ok: true; userId: string; sessionId: string; rotated: boolean }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'reused' };

/**
 * Exchange the refresh cookie for a new access token, rotating the refresh
 * secret. A secret replaced moments ago (another tab refreshed first) still
 * gets an access token; an older one means the token leaked, so the whole
 * session is revoked.
 */
export async function refreshSession(
  ctx: ServerContext,
  req: FastifyRequest,
  reply: FastifyReply
): Promise<RefreshOutcome> {
  const parsed = parseRefreshToken(req.cookies[REFRESH_COOKIE]);
  if (!parsed) return { ok: false, reason: 'missing' };

  const [session] = await ctx.db.select().from(sessions).where(eq(sessions.id, parsed.sessionId));
  if (!session || session.revokedAt) return { ok: false, reason: 'invalid' };
  if (session.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  const presented = hashToken(parsed.secret);
  if (safeEqualHex(session.refreshHash, presented)) {
    const secret = newRefreshSecret();
    // Only the request that still sees the old hash may rotate (another tab may have just done it)
    const updated = await ctx.db
      .update(sessions)
      .set({
        refreshHash: hashToken(secret),
        prevRefreshHash: session.refreshHash,
        rotatedAt: new Date(),
        expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
      })
      .where(and(eq(sessions.id, session.id), eq(sessions.refreshHash, session.refreshHash)))
      .returning({ id: sessions.id });
    if (updated.length === 1) {
      setRefreshCookie(ctx, reply, formatRefreshToken(session.id, secret));
    }
    setAccessCookie(ctx, reply, await signAccessToken(ctx.keyring.jwt, { userId: session.userId, sessionId: session.id }));
    ensureCsrfCookie(ctx, req, reply);
    return { ok: true, userId: session.userId, sessionId: session.id, rotated: updated.length === 1 };
  }

  const withinGrace =
    session.rotatedAt && Date.now() - session.rotatedAt.getTime() <= REFRESH_GRACE_SECONDS * 1000;
  if (withinGrace && safeEqualHex(session.prevRefreshHash, presented)) {
    setAccessCookie(ctx, reply, await signAccessToken(ctx.keyring.jwt, { userId: session.userId, sessionId: session.id }));
    return { ok: true, userId: session.userId, sessionId: session.id, rotated: false };
  }

  // An old refresh secret came back: treat the session as stolen
  await revokeSession(ctx, session.id);
  ctx.log.warn({ sessionId: session.id, userId: session.userId }, 'refresh token reuse; session revoked');
  return { ok: false, reason: 'reused' };
}

export async function revokeSession(ctx: ServerContext, sessionId: string): Promise<void> {
  await ctx.db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

export async function revokeAllSessions(ctx: ServerContext, userId: string, exceptSessionId?: string): Promise<void> {
  await ctx.db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        exceptSessionId ? sql`${sessions.id} <> ${exceptSessionId}` : undefined
      )
    );
}

/** The signed-in user attached to a request. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  sessionId: string;
  hasPassword: boolean;
}
