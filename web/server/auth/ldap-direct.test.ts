/**
 * Direct bind: users bind as user@domain, with no service account and no
 * search. The fake directory (ldapjs) only takes DNs as bind names, so Active
 * Directory's user@domain binds are answered at the client instead; the fake
 * still answers the connection test.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Client, InvalidCredentialsError } from 'ldapts';
import { buildTestApp } from '../test/helpers';
import { TestClient } from '../test/client';
import { BASE_DN, startFakeLdap, type FakeLdap } from '../test/fake-ldap';
import { authIdentities } from '../db/schema';
import { directBindName } from './ldap';
import { bindDomain, directDomain } from '../../shared/ldap';

/** Active Directory: what a bind with these names and this password accepts. */
const AD_PASSWORDS: Record<string, string> = {
  'alice@example.com': 'alice-pass',
  'example\\alice': 'alice-pass',
  // UPN suffix other than the base DN's domain
  'bob@app.example.com': 'bob-pass',
};

type Setup = Awaited<ReturnType<typeof setup>>;
let current: Setup | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await current?.close();
  current = undefined;
});

async function setup() {
  const dir: FakeLdap = await startFakeLdap([]);
  const t = await buildTestApp();
  const admin = new TestClient(t.app);
  await admin.signup('admin@example.com');
  await t.app.ctx.ldap.update({ enabled: true, url: dir.url, bindMode: 'direct', userSearchBase: BASE_DN });

  const binds: string[] = [];
  vi.spyOn(Client.prototype, 'bind').mockImplementation(async (name: unknown, password?: unknown) => {
    binds.push(String(name));
    if (AD_PASSWORDS[String(name).toLowerCase()] !== password) throw new InvalidCredentialsError('Invalid credentials');
  });
  const search = vi.spyOn(Client.prototype, 'search');

  const login = async (username: string, password: string) => {
    const c = new TestClient(t.app);
    await c.get('/api/auth/session');
    return c.post('/api/auth/ldap', { username, password });
  };
  const s = {
    ...t,
    dir,
    admin,
    binds,
    search,
    login,
    async close() {
      await t.close();
      await dir.close();
    },
  };
  current = s;
  return s;
}

describe('direct bind helpers', () => {
  it('makes the sign-in domain from the dc= parts of the base DN', () => {
    expect(bindDomain('dc=jac,dc=mil,dc=ae')).toBe('jac.mil.ae');
    expect(bindDomain('OU=Staff, DC=Example ,DC=com')).toBe('example.com');
    expect(bindDomain('ou=people,o=acme')).toBeNull();
    expect(bindDomain('')).toBeNull();
  });

  it('uses the sign-in domain when one is set, else the base DN', () => {
    expect(directDomain({ signInDomain: 'app.example.com', userSearchBase: 'dc=example,dc=com' })).toBe('app.example.com');
    expect(directDomain({ signInDomain: '@app.example.com', userSearchBase: '' })).toBe('app.example.com');
    expect(directDomain({ signInDomain: '', userSearchBase: 'dc=example,dc=com' })).toBe('example.com');
    expect(directDomain({ signInDomain: '', userSearchBase: 'ou=people,o=acme' })).toBeNull();
  });

  it('binds as user@domain, or as typed when the name has a domain', () => {
    expect(directBindName(' Alice ', 'example.com')).toEqual({ bindName: 'alice@example.com', account: 'alice@example.com' });
    expect(directBindName('Alice@Other.org', 'example.com')).toEqual({ bindName: 'Alice@Other.org', account: 'alice@other.org' });
    expect(directBindName('EXAMPLE\\Alice', 'example.com')).toEqual({ bindName: 'EXAMPLE\\Alice', account: 'alice@example.com' });
    expect(directBindName('alice@', 'example.com')).toBeNull();
    expect(directBindName('@example.com', 'example.com')).toBeNull();
    expect(directBindName('a\u0000b', 'example.com')).toBeNull();
  });
});

describe('LDAP direct bind', () => {
  it('signs in with only a server URL and base DN: no service account, no search', async () => {
    const s = await setup();
    expect((await s.admin.get('/api/auth/session')).json().auth.ldap).toBe(true);

    const first = await s.login('alice', 'alice-pass');
    expect(first.statusCode).toBe(200);
    expect(first.json().user).toMatchObject({ email: 'alice@example.com', name: 'alice', role: 'user', hasPassword: false });
    expect(s.binds).toEqual(['alice@example.com']);
    expect(s.search).not.toHaveBeenCalled();

    // The same account however the name is typed
    for (const name of ['EXAMPLE\\alice', 'Alice@Example.com']) {
      const again = await s.login(name, 'alice-pass');
      expect(again.statusCode).toBe(200);
      expect(again.json().user.id).toBe(first.json().user.id);
    }
    const identities = await s.db.db.select().from(authIdentities).where(eq(authIdentities.provider, 'ldap'));
    expect(identities).toEqual([expect.objectContaining({ subject: 'upn:alice@example.com', userId: first.json().user.id })]);

    // Nothing to re-check without a search: the session stays
    expect(await s.app.ctx.ldap.verifyUser(first.json().user.id)).toBe('active');
  });

  it('refuses a wrong password, an unknown user and an empty password', async () => {
    const s = await setup();
    const wrong = await s.login('alice', 'nope');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('invalid_credentials');
    expect((await s.login('mallory', 'whatever')).statusCode).toBe(401);
    expect(await s.app.ctx.ldap.login('alice', '')).toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(s.binds).toEqual(['alice@example.com', 'mallory@example.com']);
    expect(await s.db.db.select().from(authIdentities).where(eq(authIdentities.provider, 'ldap'))).toEqual([]);
  });

  it('signs in with the bare username or the full UPN when the sign-in domain differs from the base DN', async () => {
    const s = await setup();
    // Spaces and capitals are tidied away
    expect((await s.admin.put('/api/admin/ldap', { signInDomain: ' App.Example.com ' })).statusCode).toBe(200);
    expect((await s.admin.get('/api/admin/ldap')).json().settings.signInDomain).toBe('app.example.com');

    const bare = await s.login('bob', 'bob-pass');
    expect(bare.statusCode).toBe(200);
    expect(bare.json().user).toMatchObject({ email: 'bob@app.example.com', name: 'bob' });
    const full = await s.login('Bob@App.Example.com', 'bob-pass');
    expect(full.statusCode).toBe(200);
    expect(full.json().user.id).toBe(bare.json().user.id);
    expect(s.binds).toEqual(['bob@app.example.com', 'Bob@App.Example.com']);
    expect((await s.login('bob', 'nope')).statusCode).toBe(401);

    // With a sign-in domain the base DN needs no dc= parts; a malformed domain is refused
    expect((await s.admin.put('/api/admin/ldap', { userSearchBase: 'ou=people,o=acme' })).statusCode).toBe(200);
    expect((await s.login('bob', 'bob-pass')).statusCode).toBe(200);
    expect((await s.admin.put('/api/admin/ldap', { signInDomain: 'not a domain' })).statusCode).toBe(400);
    expect((await s.admin.put('/api/admin/ldap', { signInDomain: '' })).json().error.code).toBe('ldap_no_domain');
  });

  it('needs dc= parts in the base DN, tests the connection and has no user lookup', async () => {
    const s = await setup();
    const noDomain = await s.admin.put('/api/admin/ldap', { userSearchBase: 'ou=people,o=acme' });
    expect(noDomain.statusCode).toBe(400);
    expect(noDomain.json().error.code).toBe('ldap_no_domain');

    expect((await s.admin.post('/api/admin/ldap/test', {})).json()).toEqual({ ok: true, error: null });
    expect((await s.admin.post('/api/admin/ldap/lookup', { username: 'alice' })).json()).toMatchObject({ entry: null, error: expect.any(String) });

    await s.dir.close();
    expect((await s.admin.post('/api/admin/ldap/test', {})).json()).toMatchObject({ ok: false });
  });
});
