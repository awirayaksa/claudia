import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { ServerContext } from '../context';
import { sessions, users } from '../db/schema';
import { hashToken, parseRefreshToken, safeEqualHex } from './tokens';
import { HttpError, conflict, forbidden, tooManyRequests, unauthorized } from '../lib/errors';
import { normalizeEmail, signupLocalUser, toPublicUser } from '../modules/users/service';
import { LdapLoginRequest, LoginRequest, SignupRequest, type SessionResponse } from '../../shared/auth';
import { LocalAuthProvider } from './providers/local';
import {
  REFRESH_COOKIE,
  clearAuthCookies,
  ensureCsrfCookie,
  refreshSession,
  revokeSession,
  startSession,
} from './sessions';

/** Per IP, on top of the per-account backoff in LoginGuard. */
const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

export async function authRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const local = new LocalAuthProvider(ctx);

  async function authOptions(): Promise<SessionResponse['auth']> {
    const signup = await ctx.settings.get('auth.signup');
    return {
      passwordLogin: ctx.config.ENABLE_PASSWORD_AUTH,
      signup: ctx.config.ENABLE_PASSWORD_AUTH && signup.enabled,
      ldap: await ctx.ldap.isActive(),
    };
  }

  function checkLocked(key: string, reply: { header(k: string, v: unknown): unknown }) {
    const locked = ctx.loginGuard.lockedFor(key);
    if (locked > 0) {
      reply.header('Retry-After', Math.ceil(locked / 1000));
      throw tooManyRequests(
        `Too many failed sign-in attempts. Try again in ${Math.ceil(locked / 1000)} seconds.`,
        'login_locked'
      );
    }
  }

  // Who am I, and how can I sign in? Also hands out the CSRF cookie.
  app.get('/session', async (req, reply): Promise<SessionResponse> => {
    ensureCsrfCookie(ctx, req, reply);
    let user = null;
    let permissions = null;
    if (req.user) {
      const [row] = await ctx.db.select().from(users).where(eq(users.id, req.user.id));
      user = row ? toPublicUser(row) : null;
      if (row) permissions = await ctx.access.permissionsFor(row);
    }
    const webSearch = (await ctx.rag.settings()).webSearch.engine !== 'none';
    return { user, auth: await authOptions(), permissions, features: { webSearch } };
  });

  app.post('/login', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (req, reply) => {
    const body = LoginRequest.parse(req.body);
    const key = `local:${normalizeEmail(body.email)}`;
    checkLocked(key, reply);

    const result = await local.authenticate(body.email, body.password);
    if (!result.ok) {
      if (result.reason === 'disabled') throw forbidden('Password sign-in is turned off.', 'password_login_disabled');
      ctx.loginGuard.recordFailure(key);
      throw unauthorized('Wrong email or password.', 'invalid_credentials');
    }
    ctx.loginGuard.recordSuccess(key);
    await startSession(ctx, req, reply, result.userId);
    const [row] = await ctx.db.select().from(users).where(eq(users.id, result.userId));
    return { user: toPublicUser(row) };
  });

  // Directory (LDAP / Active Directory) sign-in
  app.post('/ldap', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (req, reply) => {
    const body = LdapLoginRequest.parse(req.body);
    const key = `ldap:${body.username.trim().toLowerCase()}`;
    checkLocked(key, reply);

    const result = await ctx.ldap.login(body.username, body.password);
    if (!result.ok) {
      switch (result.reason) {
        case 'disabled':
          throw forbidden('Directory sign-in is turned off.', 'ldap_disabled');
        case 'unavailable':
          throw new HttpError(503, 'ldap_unavailable', "The directory can't be reached right now. Try again later.");
        case 'email_conflict':
          throw conflict(result.message ?? 'An account with this email already exists.', 'email_conflict');
        default:
          ctx.loginGuard.recordFailure(key);
          throw unauthorized('Wrong username or password.', 'invalid_credentials');
      }
    }
    ctx.loginGuard.recordSuccess(key);
    await startSession(ctx, req, reply, result.userId);
    const [row] = await ctx.db.select().from(users).where(eq(users.id, result.userId));
    return { user: toPublicUser(row) };
  });

  app.post('/signup', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (req, reply) => {
    const options = await authOptions();
    if (!options.signup) throw forbidden('Sign-up is turned off. Ask an administrator for an account.', 'signup_disabled');
    const body = SignupRequest.parse(req.body);
    const signup = await ctx.settings.get('auth.signup');
    const user = await signupLocalUser(ctx, body, signup.defaultRole);
    if (user.role === 'admin') ctx.log.info({ email: user.email }, 'first account created; it is the admin');
    await startSession(ctx, req, reply, user.id);
    reply.code(201);
    return { user: toPublicUser(user) };
  });

  app.post('/refresh', async (req, reply) => {
    const outcome = await refreshSession(ctx, req, reply);
    if (!outcome.ok) {
      clearAuthCookies(ctx, reply);
      throw new HttpError(401, 'session_ended', 'Your session has ended. Sign in again.');
    }
    return { ok: true };
  });

  app.post('/logout', async (req, reply) => {
    if (req.user) {
      await revokeSession(ctx, req.user.sessionId);
    } else {
      // Access token already expired: the refresh cookie still names the session
      const parsed = parseRefreshToken(req.cookies[REFRESH_COOKIE]);
      if (parsed) {
        const [session] = await ctx.db.select().from(sessions).where(eq(sessions.id, parsed.sessionId));
        const presented = hashToken(parsed.secret);
        if (session && (safeEqualHex(session.refreshHash, presented) || safeEqualHex(session.prevRefreshHash, presented))) {
          await revokeSession(ctx, session.id);
        }
      }
    }
    clearAuthCookies(ctx, reply);
    return { ok: true };
  });
}
