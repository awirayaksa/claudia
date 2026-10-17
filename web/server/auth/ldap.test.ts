/**
 * Directory sign-in against an in-process LDAP server. The same scenarios run
 * against OpenLDAP in CI (ldap.integration.test.ts).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildTestApp } from '../test/helpers';
import { TestClient } from '../test/client';
import {
  PEOPLE_DN,
  SERVICE_DN,
  SERVICE_PASSWORD,
  STAFF_GROUP_DN,
  startFakeLdap,
  userDn,
  type FakeLdap,
  type FakeUser,
} from '../test/fake-ldap';
import { authIdentities, sessions, users } from '../db/schema';
import { buildUserFilter, normalizeUsername } from './ldap';

const ALICE: FakeUser = {
  uid: 'alice',
  password: 'alice-pass',
  cn: 'Alice Liddell',
  mail: 'alice@example.com',
  entryUUID: '6f1c2c3e-0000-4000-8000-00000000a11c',
  memberOf: [STAFF_GROUP_DN],
};
const BOB: FakeUser = {
  uid: 'bob',
  password: 'bob-pass',
  cn: 'Bob Builder',
  mail: 'bob@example.com',
  entryUUID: '6f1c2c3e-0000-4000-8000-000000000b0b',
};

type Setup = Awaited<ReturnType<typeof setup>>;
let current: Setup | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function setup(opts: { users?: FakeUser[]; env?: Record<string, string>; settings?: Record<string, unknown> } = {}) {
  const dir = await startFakeLdap(opts.users ?? [ALICE, BOB]);
  const t = await buildTestApp({ env: opts.env });
  const admin = new TestClient(t.app);
  if (opts.env?.ENABLE_PASSWORD_AUTH !== 'false') await admin.signup('admin@example.com');
  // Stored directly: the admin route refuses fields locked by env (tested below)
  await t.app.ctx.ldap.update({
    enabled: true,
    url: dir.url,
    bindPassword: SERVICE_PASSWORD,
    userSearchBase: PEOPLE_DN,
    userFilter: '(uid={{username}})',
    ...(opts.env?.LDAP_BIND_DN ? {} : { bindDn: SERVICE_DN }),
    ...opts.settings,
  });
  const login = async (username: string, password: string) => {
    const c = new TestClient(t.app);
    await c.get('/api/auth/session');
    const res = await c.post('/api/auth/ldap', { username, password });
    return { client: c, res };
  };
  const s = {
    ...t,
    dir,
    admin,
    login,
    async close() {
      await t.close();
      await dir.close();
    },
  };
  current = s;
  return s;
}

const userBinds = (dir: FakeLdap, uid: string) => dir.binds.filter((b) => b.dn.toLowerCase() === userDn(uid));

describe('LDAP helpers', () => {
  it('normalizes usernames', () => {
    expect(normalizeUsername('  Alice ', true)).toBe('alice');
    expect(normalizeUsername('EXAMPLE\\Alice', true)).toBe('alice');
    expect(normalizeUsername('alice@example.com', true)).toBe('alice');
    expect(normalizeUsername('alice@example.com', false)).toBe('alice@example.com');
    expect(normalizeUsername('   ', true)).toBeNull();
    expect(normalizeUsername('a\u0000b', true)).toBeNull();
  });

  it('escapes the username in filters (RFC 4515)', () => {
    expect(buildUserFilter('(uid={{username}})', '*)(uid=*')).toBe('(uid=\\2a\\29\\28uid=\\2a)');
    expect(buildUserFilter('(|(uid={{username}})(mail={{username}}))', 'a\\b')).toBe('(|(uid=a\\5cb)(mail=a\\5cb))');
  });
});

describe('LDAP sign-in', () => {
  it('creates the account on first sign-in and links it afterwards', async () => {
    const s = await setup();
    expect((await s.admin.get('/api/auth/session')).json().auth.ldap).toBe(true);

    const first = await s.login('alice', 'alice-pass');
    expect(first.res.statusCode).toBe(200);
    expect(first.res.json().user).toMatchObject({ email: 'alice@example.com', name: 'Alice Liddell', role: 'user', hasPassword: false });

    const again = await s.login('EXAMPLE\\Alice', 'alice-pass');
    expect(again.res.statusCode).toBe(200);
    expect(again.res.json().user.id).toBe(first.res.json().user.id);

    const [identity] = await s.db.db.select().from(authIdentities).where(eq(authIdentities.provider, 'ldap'));
    expect(identity).toMatchObject({ subject: `uuid:${ALICE.entryUUID}`, userId: first.res.json().user.id });
    // Signed in for real
    expect((await again.client.get('/api/chats')).statusCode).toBe(200);
  });

  it('refuses a wrong password and an unknown user', async () => {
    const s = await setup();
    const wrong = await s.login('alice', 'nope');
    expect(wrong.res.statusCode).toBe(401);
    expect(wrong.res.json().error.code).toBe('invalid_credentials');
    expect((await s.login('mallory', 'whatever')).res.statusCode).toBe(401);
    expect(await s.db.db.select().from(authIdentities).where(eq(authIdentities.provider, 'ldap'))).toEqual([]);
  });

  it('never binds with an empty password (the server would accept it)', async () => {
    const s = await setup();
    const res = await s.login('alice', '');
    expect(res.res.statusCode).toBe(400);
    // Below the HTTP layer too
    expect(await s.app.ctx.ldap.login('alice', '')).toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(userBinds(s.dir, 'alice')).toEqual([]);
    expect(s.dir.binds.every((b) => b.withPassword)).toBe(true);
  });

  it('is not fooled by filter injection', async () => {
    const s = await setup({ users: [ALICE] });
    // Unescaped, "al*" would be a substring match for alice
    const res = await s.login('al*', 'alice-pass');
    expect(res.res.statusCode).toBe(401);
    expect(userBinds(s.dir, 'alice')).toEqual([]);
    expect((await s.login('*)(uid=*', 'alice-pass')).res.statusCode).toBe(401);
    expect(userBinds(s.dir, 'alice')).toEqual([]);
  });

  it('requires exactly one match', async () => {
    const s = await setup({ settings: { userFilter: '(|(uid={{username}})(objectClass=inetOrgPerson))' } });
    expect((await s.login('alice', 'alice-pass')).res.statusCode).toBe(401);
    expect(userBinds(s.dir, 'alice')).toEqual([]);
  });

  it('refuses an email that belongs to a local account', async () => {
    const s = await setup();
    await s.admin.post('/api/admin/users', { email: 'alice@example.com', name: 'Local Alice', password: 'local-password' });
    const res = await s.login('alice', 'alice-pass');
    expect(res.res.statusCode).toBe(409);
    expect(res.res.json().error.code).toBe('email_conflict');
  });

  it('only lets members of the allowed group in', async () => {
    const s = await setup({ settings: { allowedGroupDn: STAFF_GROUP_DN } });
    expect((await s.login('bob', 'bob-pass')).res.statusCode).toBe(401);
    expect((await s.login('alice', 'alice-pass')).res.statusCode).toBe(200);
  });

  it('refuses accounts Active Directory marks disabled', async () => {
    const s = await setup({ users: [{ ...ALICE, userAccountControl: 514 }] });
    expect((await s.login('alice', 'alice-pass')).res.statusCode).toBe(401);
  });

  it('never makes the first directory user admin, even on an empty install', async () => {
    const s = await setup({ env: { ENABLE_PASSWORD_AUTH: 'false' } });
    expect(await s.db.db.select().from(users)).toEqual([]);
    const res = await s.login('alice', 'alice-pass');
    expect(res.res.json().user.role).toBe('user');
    // Password sign-in is off; directory sign-in still works
    expect((await res.client.get('/api/auth/session')).json().auth).toMatchObject({ passwordLogin: false, signup: false, ldap: true });
  });

  it('gives new accounts the configured role', async () => {
    const s = await setup({ settings: { defaultRole: 'pending' } });
    expect((await s.login('alice', 'alice-pass')).res.json().user.role).toBe('pending');
  });

  it('reports an unreachable directory as unavailable', async () => {
    const s = await setup();
    await s.dir.close();
    const res = await s.login('alice', 'alice-pass');
    expect(res.res.statusCode).toBe(503);
    expect(res.res.json().error.code).toBe('ldap_unavailable');
  });
});

describe('LDAP deprovisioning', () => {
  const expireCheck = async (s: Setup, userId: string) =>
    s.db.db.update(sessions).set({ lastVerifiedAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(sessions.userId, userId));

  it('ends every session of a user removed from the directory', async () => {
    const s = await setup();
    const a = await s.login('alice', 'alice-pass');
    const b = await s.login('alice', 'alice-pass');
    const userId = a.res.json().user.id;

    // Still there: refresh works and the check is recorded
    await expireCheck(s, userId);
    expect((await a.client.post('/api/auth/refresh')).statusCode).toBe(200);

    s.dir.users.delete('alice');
    await expireCheck(s, userId);
    const res = await a.client.post('/api/auth/refresh');
    expect(res.statusCode).toBe(401);
    const live = await s.db.db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(live.every((x) => x.revokedAt !== null)).toBe(true);
    expect((await b.client.post('/api/auth/refresh')).statusCode).toBe(401);
  });

  it('keeps sessions while the directory is unreachable', async () => {
    const s = await setup();
    const a = await s.login('alice', 'alice-pass');
    await s.dir.close();
    await expireCheck(s, a.res.json().user.id);
    expect((await a.client.post('/api/auth/refresh')).statusCode).toBe(200);
  });

  it('leaves local accounts alone', async () => {
    const s = await setup();
    const [me] = await s.db.db.select().from(users).where(eq(users.email, 'admin@example.com'));
    await expireCheck(s, me.id);
    expect((await s.admin.post('/api/auth/refresh')).statusCode).toBe(200);
  });
});

describe('LDAP admin settings', () => {
  it('never returns the bind password and tests the connection', async () => {
    const s = await setup();
    const view = await s.admin.get('/api/admin/ldap');
    expect(view.json()).toMatchObject({ hasBindPassword: true, settings: { url: s.dir.url, bindDn: SERVICE_DN } });
    expect(view.body).not.toContain(SERVICE_PASSWORD);

    expect((await s.admin.post('/api/admin/ldap/test')).json()).toEqual({ ok: true, error: null });
    const lookup = (await s.admin.post('/api/admin/ldap/lookup', { username: 'Alice' })).json();
    expect(lookup).toMatchObject({ matches: 1, entry: { dn: userDn('alice'), email: 'alice@example.com', subject: `uuid:${ALICE.entryUUID}` } });

    await s.admin.put('/api/admin/ldap', { bindPassword: 'wrong' });
    const bad = (await s.admin.post('/api/admin/ldap/test')).json();
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/service account was refused/);
  });

  it('is admin only and respects environment locks', async () => {
    const s = await setup({ env: { LDAP_BIND_DN: SERVICE_DN } });
    const alice = await s.login('alice', 'alice-pass');
    expect((await alice.client.get('/api/admin/ldap')).statusCode).toBe(403);

    expect((await s.admin.get('/api/admin/ldap')).json().locked).toEqual(['bindDn']);
    const res = await s.admin.put('/api/admin/ldap', { bindDn: 'cn=other' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('locked_by_env');
  });
});
