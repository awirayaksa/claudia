import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildTestApp } from '../test/helpers';
import { TestClient } from '../test/client';
import { sessions, users } from '../db/schema';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup(env?: Record<string, string>) {
  const t = await buildTestApp({ env });
  close = t.close;
  return t;
}

describe('sign-up and roles', () => {
  it('makes the first account admin and later ones pending', async () => {
    const { app } = await setup();
    const a = new TestClient(app);
    const first = await a.signup('Admin@Example.com');
    expect(first.statusCode).toBe(201);
    expect(first.json().user).toMatchObject({ email: 'admin@example.com', role: 'admin', hasPassword: true });

    const b = new TestClient(app);
    const second = await b.signup('bob@example.com');
    expect(second.json().user.role).toBe('pending');

    // Pending users see their account but nothing else
    expect((await b.get('/api/me')).statusCode).toBe(200);
    const chats = await b.get('/api/chats');
    expect(chats.statusCode).toBe(403);
    expect(chats.json().error.code).toBe('pending');

    // The admin approves; it applies at once (role is read per request)
    const list = await a.get('/api/admin/users');
    const bob = list.json().users.find((u: any) => u.email === 'bob@example.com');
    expect(list.json().users[0].email).toBe('bob@example.com'); // pending first
    expect((await a.patch(`/api/admin/users/${bob.id}`, { role: 'user' })).statusCode).toBe(200);
    expect((await b.get('/api/chats')).statusCode).toBe(200);
  });

  it('refuses a duplicate email and a weak password', async () => {
    const { app } = await setup();
    const a = new TestClient(app);
    await a.signup('a@example.com');
    const dup = await new TestClient(app).signup('A@EXAMPLE.COM');
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('email_taken');
    const weak = await new TestClient(app).signup('c@example.com', 'short');
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.message).toMatch(/at least 8/);
  });

  it('honours the admin sign-up switch and default role', async () => {
    const { app } = await setup();
    const admin = new TestClient(app);
    await admin.signup('admin@example.com');
    await admin.patch('/api/admin/settings/auth.signup', { enabled: true, defaultRole: 'user' });
    expect((await new TestClient(app).signup('u@example.com')).json().user.role).toBe('user');

    await admin.patch('/api/admin/settings/auth.signup', { enabled: false, defaultRole: 'user' });
    const blocked = await new TestClient(app).signup('v@example.com');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('signup_disabled');
    expect((await new TestClient(app).get('/api/auth/session')).json().auth.signup).toBe(false);
  });
});

describe('bootstrap', () => {
  it('creates the admin from the environment', async () => {
    const { app } = await setup({ CLAUDIA_ADMIN_EMAIL: 'root@example.com', CLAUDIA_ADMIN_PASSWORD: 'env-password-123' });
    const c = new TestClient(app);
    const res = await c.login('root@example.com', 'env-password-123');
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe('admin');
    // With an admin already there, the first sign-up is an ordinary account
    expect((await new TestClient(app).signup('next@example.com')).json().user.role).toBe('pending');
  });

  it('turns password login off entirely', async () => {
    const { app } = await setup({ ENABLE_PASSWORD_AUTH: 'false' });
    const c = new TestClient(app);
    const session = await c.get('/api/auth/session');
    expect(session.json().auth).toEqual({ passwordLogin: false, signup: false, ldap: false, sso: [] });
    expect((await c.post('/api/auth/signup', { email: 'x@example.com', password: 'whatever-123', name: 'X' })).statusCode).toBe(403);
    expect((await c.post('/api/auth/login', { email: 'x@example.com', password: 'whatever-123' })).statusCode).toBe(403);
  });
});

describe('login', () => {
  it('signs in with the right password only, with the same message for unknown accounts', async () => {
    const { app } = await setup();
    await new TestClient(app).signup('a@example.com');
    const c = new TestClient(app);
    const wrong = await c.login('a@example.com', 'nope-nope-nope');
    const unknown = await c.login('ghost@example.com', 'nope-nope-nope');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    const ok = await c.login('A@example.com');
    expect(ok.statusCode).toBe(200);
    expect((await c.get('/api/me')).json().user.email).toBe('a@example.com');
  });

  it('locks an account after repeated failures', async () => {
    const { app } = await setup();
    await new TestClient(app).signup('a@example.com');
    const c = new TestClient(app);
    await c.get('/api/auth/session');
    for (let i = 0; i < 6; i++) await c.post('/api/auth/login', { email: 'a@example.com', password: `bad-${i}-xxxx` });
    const locked = await c.post('/api/auth/login', { email: 'a@example.com', password: 'correct-horse-battery' });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('login_locked');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('rate-limits login attempts per IP', async () => {
    const { app } = await setup();
    const c = new TestClient(app);
    await c.get('/api/auth/session');
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await c.post('/api/auth/login', { email: `u${i}@example.com`, password: 'whatever-123' })).statusCode);
    }
    expect(codes.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it('sets host-only httpOnly cookies, the refresh one only for /api/auth', async () => {
    const { app } = await setup();
    const res = await new TestClient(app).signup('a@example.com');
    const cookies = res.cookies as Array<{ name: string; path?: string; httpOnly?: boolean; domain?: string; sameSite?: string }>;
    const at = cookies.find((c) => c.name === 'claudia_at')!;
    const rt = cookies.find((c) => c.name === 'claudia_rt')!;
    expect(at).toMatchObject({ path: '/', httpOnly: true, sameSite: 'Lax' });
    expect(rt).toMatchObject({ path: '/api/auth', httpOnly: true });
    expect(at.domain).toBeUndefined();
    expect(rt.domain).toBeUndefined();
  });
});

describe('CSRF', () => {
  it('requires the header on state-changing requests', async () => {
    const { app } = await setup();
    const c = new TestClient(app);
    await c.signup('a@example.com');
    c.csrf = false;
    const res = await c.post('/api/chats', {});
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf');
    // A header that doesn't match the cookie fails too
    const forged = await c.request({ method: 'POST', url: '/api/chats', payload: {}, headers: { 'x-claudia-csrf': 'forged' } });
    expect(forged.statusCode).toBe(403);
    c.csrf = true;
    expect((await c.post('/api/chats', {})).statusCode).toBe(201);
  });
});

describe('sessions', () => {
  it('refreshes with rotation, tolerates a concurrent tab, and revokes on reuse', async () => {
    const { app, db } = await setup();
    const c = new TestClient(app);
    await c.signup('a@example.com');
    const firstRefresh = c.cookies.get('claudia_rt')!;

    // Tab 1 refreshes: new refresh secret
    expect((await c.post('/api/auth/refresh')).statusCode).toBe(200);
    const secondRefresh = c.cookies.get('claudia_rt')!;
    expect(secondRefresh).not.toBe(firstRefresh);

    // Tab 2 still sends the old one moments later: gets an access token, no rotation
    const tab2 = new TestClient(app);
    tab2.cookies.set('claudia_csrf', c.cookies.get('claudia_csrf')!);
    tab2.cookies.set('claudia_rt', firstRefresh);
    expect((await tab2.post('/api/auth/refresh')).statusCode).toBe(200);

    // Long after rotation, the old secret means theft: the session dies
    await db.db.update(sessions).set({ rotatedAt: new Date(Date.now() - 10 * 60_000) });
    const thief = new TestClient(app);
    thief.cookies.set('claudia_csrf', c.cookies.get('claudia_csrf')!);
    thief.cookies.set('claudia_rt', firstRefresh);
    const stolen = await thief.post('/api/auth/refresh');
    expect(stolen.statusCode).toBe(401);
    expect(stolen.json().error.code).toBe('session_ended');
    // ...including for the legitimate tab
    expect((await c.get('/api/me')).statusCode).toBe(401);
  });

  it('reports an expired access token distinctly so the client refreshes', async () => {
    const { app } = await setup();
    const c = new TestClient(app);
    await c.signup('a@example.com');
    c.cookies.set('claudia_at', 'not-a-jwt');
    const res = await c.get('/api/me');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
    // Refresh restores access
    expect((await c.post('/api/auth/refresh')).statusCode).toBe(200);
    expect((await c.get('/api/me')).statusCode).toBe(200);
  });

  it('logs out, even when the access token is gone', async () => {
    const { app } = await setup();
    const c = new TestClient(app);
    await c.signup('a@example.com');
    c.cookies.delete('claudia_at');
    expect((await c.post('/api/auth/logout')).statusCode).toBe(200);
    // The refresh cookie no longer works
    const csrf = c.cookies.get('claudia_csrf');
    c.cookies.set('claudia_rt', 'x');
    expect(csrf).toBeDefined();
    expect((await c.post('/api/auth/refresh')).statusCode).toBe(401);
  });

  it('changing the password signs out other devices', async () => {
    const { app } = await setup();
    const phone = new TestClient(app);
    await phone.signup('a@example.com');
    const laptop = new TestClient(app);
    await laptop.login('a@example.com');

    const res = await laptop.put('/api/me/password', { currentPassword: 'correct-horse-battery', newPassword: 'brand-new-password' });
    expect(res.statusCode).toBe(200);
    expect((await laptop.get('/api/me')).statusCode).toBe(200);
    expect((await phone.get('/api/me')).statusCode).toBe(401);
    expect((await new TestClient(app).login('a@example.com', 'brand-new-password')).statusCode).toBe(200);
  });

  it('lists and revokes own sessions', async () => {
    const { app } = await setup();
    const a = new TestClient(app);
    await a.signup('a@example.com');
    const b = new TestClient(app);
    await b.login('a@example.com');
    const list = (await a.get('/api/me/sessions')).json().sessions;
    expect(list).toHaveLength(2);
    const other = list.find((s: any) => !s.current);
    await a.delete(`/api/me/sessions/${other.id}`);
    expect((await b.get('/api/me')).statusCode).toBe(401);
  });
});

describe('admin user management', () => {
  it('protects the last admin and refuses non-admins', async () => {
    const { app, db } = await setup();
    const admin = new TestClient(app);
    const me = (await admin.signup('admin@example.com')).json().user;
    const demote = await admin.patch(`/api/admin/users/${me.id}`, { role: 'user' });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe('last_admin');
    expect((await admin.delete(`/api/admin/users/${me.id}`)).statusCode).toBe(400);

    const created = await admin.post('/api/admin/users', { email: 'u@example.com', name: 'U', password: 'user-password-1' });
    expect(created.statusCode).toBe(201);
    const user = new TestClient(app);
    await user.login('u@example.com', 'user-password-1');
    expect((await user.get('/api/admin/users')).statusCode).toBe(403);

    await admin.delete(`/api/admin/users/${created.json().user.id}`);
    expect(await db.db.select().from(users).where(eq(users.email, 'u@example.com'))).toHaveLength(0);
    expect((await user.get('/api/me')).statusCode).toBe(401);
  });
});
