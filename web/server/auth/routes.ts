import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { ServerContext } from '../context';
import { sessions, users } from '../db/schema';
import { hashToken, parseRefreshToken, safeEqualHex } from './tokens';
import { HttpError, conflict, forbidden, tooManyRequests, unauthorized } from '../lib/errors';
import { normalizeEmail, signupLocalUser, toPublicUser, webhookUser } from '../modules/users/service';
import { LdapLoginRequest, LoginRequest, MfaCode, SignupRequest, type SessionResponse, type SignInResponse } from '../../shared/auth';
import { clearMfaTicket, completeSignIn, mfaRequiredFor, readMfaTicket } from './signin';
import { mfaStatus, verifyMfaCode } from './mfa';
import { LocalAuthProvider } from './providers/local';
import { sandboxOriginFor } from '../sandbox';
import { activeCodeEngine } from '../code/sandbox';
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
      sso: await ctx.sso.enabledList(),
    };
  }

  async function checkLocked(key: string, reply: { header(k: string, v: unknown): unknown }) {
    const locked = await ctx.loginGuard.lockedFor(key);
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
    let mfa: SessionResponse['mfa'] = null;
    if (req.user) {
      const [row] = await ctx.db.select().from(users).where(eq(users.id, req.user.id));
      user = row ? toPublicUser(row) : null;
      if (row) {
        permissions = await ctx.access.permissionsFor(row);
        const enabled = (await mfaStatus(ctx, row.id)).enabled;
        mfa = { enabled, required: !enabled && mfaRequiredFor(await ctx.settings.get('auth.mfa'), row.role) };
      }
    }
    const arena = await ctx.settings.get('arena');
    const webSearch = (await ctx.rag.settings()).webSearch.engine !== 'none';
    const media = await ctx.media.settings();
    const mode = (engine: string) => (engine === 'none' ? 'none' : engine === 'browser' ? 'browser' : 'server') as 'none' | 'browser' | 'server';
    return {
      user,
      auth: await authOptions(),
      permissions,
      features: {
        webSearch,
        codeInterpreter: !!(await activeCodeEngine(ctx.settings, sandboxOriginFor(ctx.config), ctx.code)),
        imageGen: media.image.engine !== 'none',
        voiceInput: mode(media.stt.engine),
        readAloud: mode(media.tts.engine),
        arena: arena.enabled && arena.models.length >= 2,
        cloudFiles: await ctx.cloud.available(),
      },
      mfa,
    };
  });

  app.post('/login', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (req, reply): Promise<SignInResponse> => {
    const body = LoginRequest.parse(req.body);
    const key = `local:${normalizeEmail(body.email)}`;
    await checkLocked(key, reply);

    const result = await local.authenticate(body.email, body.password);
    if (!result.ok) {
      if (result.reason === 'disabled') throw forbidden('Password sign-in is turned off.', 'password_login_disabled');
      await ctx.loginGuard.recordFailure(key);
      void ctx.audit.fromRequest(req, 'auth.login_failed', { actor: null, details: { method: 'password', email: normalizeEmail(body.email) } });
      throw unauthorized('Wrong email or password.', 'invalid_credentials');
    }
    await ctx.loginGuard.recordSuccess(key);
    return completeSignIn(ctx, req, reply, result.userId, 'password');
  });

  // Directory (LDAP / Active Directory) sign-in
  app.post('/ldap', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (req, reply): Promise<SignInResponse> => {
    const body = LdapLoginRequest.parse(req.body);
    const key = `ldap:${body.username.trim().toLowerCase()}`;
    await checkLocked(key, reply);

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
          await ctx.loginGuard.recordFailure(key);
          void ctx.audit.fromRequest(req, 'auth.login_failed', { actor: null, details: { method: 'ldap', username: body.username.trim().toLowerCase() } });
          throw unauthorized('Wrong username or password.', 'invalid_credentials');
      }
    }
    await ctx.loginGuard.recordSuccess(key);
    if (result.created) {
      const [row] = await ctx.db.select().from(users).where(eq(users.id, result.userId));
      void ctx.webhooks.emit('user.created', { user: webhookUser(row), source: 'ldap' });
    }
    return completeSignIn(ctx, req, reply, result.userId, 'ldap', { created: result.created });
  });

  // The second step of a sign-in with two-factor on: a code from the app or a recovery code
  app.post('/mfa', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (req, reply): Promise<SignInResponse> => {
    const ticket = readMfaTicket(ctx, req);
    if (!ticket) throw unauthorized('This sign-in took too long. Start again.', 'mfa_expired');
    const { code } = MfaCode.parse(req.body);
    const key = `mfa:${ticket.userId}`;
    await checkLocked(key, reply);
    const how = await verifyMfaCode(ctx, ticket.userId, code);
    const [row] = await ctx.db.select().from(users).where(eq(users.id, ticket.userId));
    if (!how || !row) {
      await ctx.loginGuard.recordFailure(key);
      void ctx.audit.fromRequest(req, 'auth.login_failed', { actor: null, details: { method: ticket.method, email: row?.email, reason: 'mfa' } });
      throw unauthorized("That code doesn't match.", 'mfa_invalid_code');
    }
    await ctx.loginGuard.recordSuccess(key);
    clearMfaTicket(ctx, reply);
    if (row.deactivatedAt) throw forbidden('This account has been deactivated. Ask an administrator.', 'account_deactivated');
    await startSession(ctx, req, reply, row.id);
    void ctx.audit.fromRequest(req, 'auth.login', { actor: { id: row.id, email: row.email }, details: { method: ticket.method, mfa: how } });
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
    void ctx.audit.fromRequest(req, 'auth.signup', { actor: { id: user.id, email: user.email }, details: { role: user.role } });
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
    if (req.user) void ctx.audit.fromRequest(req, 'auth.logout');
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
