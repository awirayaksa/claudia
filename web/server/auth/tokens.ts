/**
 * Session tokens.
 * - Access: a 15-minute HS256 JWT in an httpOnly cookie (subject + session id).
 * - Refresh: `<sessionId>.<random secret>`; only sha256(secret) is stored,
 *   and the secret rotates on every use.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
/** A just-replaced refresh secret still works this long (two tabs refreshing at once). */
export const REFRESH_GRACE_SECONDS = 60;

const ISSUER = 'claudia-web';

export interface AccessClaims {
  userId: string;
  sessionId: string;
}

export async function signAccessToken(key: Uint8Array, claims: AccessClaims, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  return new SignJWT({ sid: claims.sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ACCESS_TTL_SECONDS)
    .sign(key);
}

export type VerifyResult = { ok: true; claims: AccessClaims } | { ok: false; reason: 'expired' | 'invalid' };

export async function verifyAccessToken(key: Uint8Array, token: string): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return { ok: false, reason: 'invalid' };
    return { ok: true, claims: { userId: payload.sub, sessionId: payload.sid } };
  } catch (err) {
    return { ok: false, reason: err instanceof joseErrors.JWTExpired ? 'expired' : 'invalid' };
  }
}

export function newRefreshSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function formatRefreshToken(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

export function parseRefreshToken(token: string | undefined): { sessionId: string; secret: string } | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  return { sessionId: token.slice(0, dot), secret: token.slice(dot + 1) };
}

export function safeEqualHex(a: string | null | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function newCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}
