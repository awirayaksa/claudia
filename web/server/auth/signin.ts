/**
 * The end of every sign-in (password, directory, SSO): a deactivated
 * account is refused; with two-factor sign-in on, the browser gets a
 * five-minute ticket (an encrypted, HttpOnly cookie) to trade for a session
 * with a code at POST /api/auth/mfa; otherwise the session starts now.
 */
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context';
import { users } from '../db/schema';
import { forbidden } from '../lib/errors';
import { toPublicUser } from '../modules/users/service';
import { isMfaEnabled } from './mfa';
import { startSession } from './sessions';
import type { PublicUser } from '../../shared/auth';

export const MFA_COOKIE = 'claudia_mfa';
const MFA_COOKIE_PATH = '/api/auth';
const TICKET_MS = 5 * 60_000;

export type SignInMethod = 'password' | 'ldap' | 'oidc';
export type SignInResult = { user: PublicUser; mfaRequired?: false } | { user: null; mfaRequired: true };

interface Ticket {
  userId: string;
  method: SignInMethod;
  expires: number;
}

const cookieOptions = (ctx: ServerContext) => ({
  httpOnly: true,
  secure: ctx.config.secureCookies,
  sameSite: 'lax' as const,
  path: MFA_COOKIE_PATH,
});

export async function completeSignIn(
  ctx: ServerContext,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  method: SignInMethod,
  details: Record<string, unknown> = {}
): Promise<SignInResult> {
  const [row] = await ctx.db.select().from(users).where(eq(users.id, userId));
  if (!row) throw forbidden('This account no longer exists.', 'account_missing');
  if (row.deactivatedAt) {
    void ctx.audit.fromRequest(req, 'auth.login_failed', { actor: null, details: { method, email: row.email, reason: 'deactivated' } });
    throw forbidden('This account has been deactivated. Ask an administrator.', 'account_deactivated');
  }
  if (await isMfaEnabled(ctx, userId)) {
    const ticket: Ticket = { userId, method, expires: Date.now() + TICKET_MS };
    reply.setCookie(MFA_COOKIE, ctx.secrets.encrypt(JSON.stringify(ticket)), { ...cookieOptions(ctx), maxAge: TICKET_MS / 1000 });
    return { user: null, mfaRequired: true };
  }
  await startSession(ctx, req, reply, userId);
  void ctx.audit.fromRequest(req, 'auth.login', { actor: { id: row.id, email: row.email }, details: { method, ...details } });
  return { user: toPublicUser(row) };
}

/** The pending two-factor sign-in of this browser, if any (and not expired). */
export function readMfaTicket(ctx: ServerContext, req: FastifyRequest): Ticket | null {
  const raw = req.cookies[MFA_COOKIE];
  if (!raw) return null;
  try {
    const ticket = JSON.parse(ctx.secrets.decrypt(raw)) as Ticket;
    return ticket.expires > Date.now() ? ticket : null;
  } catch {
    return null;
  }
}

export function clearMfaTicket(ctx: ServerContext, reply: FastifyReply): void {
  reply.clearCookie(MFA_COOKIE, cookieOptions(ctx));
}

/** Whether this user must turn two-factor sign-in on before using the app. */
export function mfaRequiredFor(setting: { require: 'off' | 'admins' | 'everyone' }, role: string): boolean {
  return setting.require === 'everyone' || (setting.require === 'admins' && role === 'admin');
}
