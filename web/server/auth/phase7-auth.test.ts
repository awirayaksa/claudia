/**
 * Phase 7 sign-in: TOTP two-factor sign-in (RFC 6238 vectors, replay,
 * recovery codes, required by policy), deactivated accounts, OpenID Connect
 * against a fake provider (PKCE, state, token validation, linking rules,
 * groups) and SCIM provisioning as Entra ID sends it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildTestApp } from '../test/helpers';
import { TestClient } from '../test/client';
import { startFakeOidc, type FakeOidc } from '../test/fake-oidc';
import { authIdentities, groupMembers, groups, users } from '../db/schema';
import { base32Encode, stepAt, totpAt, verifyTotp } from './totp';
import { uuidv7 } from '../lib/ids';

type T = Awaited<ReturnType<typeof buildTestApp>>;
let t: T | undefined;
let oidc: FakeOidc | undefined;
afterEach(async () => {
  await t?.close();
  await oidc?.close();
  t = undefined;
  oidc = undefined;
});

async function setup() {
  t = await buildTestApp();
  const admin = new TestClient(t.app);
  await admin.signup('admin@example.com');
  return { app: t.app, admin };
}

async function newUser(app: T['app'], admin: TestClient, email: string, password = 'user-password-1') {
  expect((await admin.post('/api/admin/users', { email, name: email.split('@')[0], password })).statusCode).toBe(201);
  const c = new TestClient(app);
  return { client: c, login: () => c.login(email, password) };
}

/** Turn two-factor sign-in on for this client; returns the secret and recovery codes. */
async function enableMfa(c: TestClient) {
  const setup = (await c.post('/api/me/mfa/setup')).json().setup;
  expect(setup.uri).toMatch(/^otpauth:\/\/totp\//);
  expect(setup.qrSvg).toContain('<svg');
  const confirmed = await c.post('/api/me/mfa/confirm', { code: totpAt(setup.secret, stepAt(Date.now())) });
  expect(confirmed.statusCode).toBe(200);
  return { secret: setup.secret as string, recovery: confirmed.json().recoveryCodes as string[] };
}

describe('TOTP', () => {
  // RFC 6238 appendix B, SHA-1 secret "12345678901234567890" (last six digits)
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches the RFC test vectors', () => {
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpAt(secret, Math.floor(1234567890 / 30))).toBe('005924');
    expect(totpAt(secret, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('accepts one step of drift, and each step once', () => {
    const now = 1111111109_000;
    const step = stepAt(now);
    expect(verifyTotp(secret, totpAt(secret, step), { now })).toBe(step);
    expect(verifyTotp(secret, totpAt(secret, step - 1), { now })).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(secret, step + 1), { now })).toBe(step + 1);
    expect(verifyTotp(secret, totpAt(secret, step - 2), { now })).toBeNull();
    expect(verifyTotp(secret, totpAt(secret, step), { now, lastUsedStep: step })).toBeNull();
    expect(verifyTotp(secret, '12345', { now })).toBeNull();
  });
});

describe('two-factor sign-in', () => {
  it('asks for a code after the password, and a code or recovery code works once', async () => {
    const { app, admin } = await setup();
    const kim = await newUser(app, admin, 'kim@example.com');
    await kim.login();
    const { secret, recovery } = await enableMfa(kim.client);
    expect(recovery).toHaveLength(10);
    expect((await kim.client.get('/api/auth/session')).json().mfa).toEqual({ enabled: true, required: false });

    const fresh = new TestClient(app);
    const first = await fresh.login('kim@example.com', 'user-password-1');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ user: null, mfaRequired: true });
    // No session yet
    expect((await fresh.get('/api/auth/session')).json().user).toBeNull();
    expect((await fresh.get('/api/chats')).statusCode).toBe(401);
    expect((await fresh.post('/api/auth/mfa', { code: '000000' })).statusCode).toBe(401);
    // The code used to turn it on can't be used again; the next one can
    const next = totpAt(secret, stepAt(Date.now()) + 1);
    const ok = await fresh.post('/api/auth/mfa', { code: next });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.email).toBe('kim@example.com');
    expect((await fresh.get('/api/chats')).statusCode).toBe(200);

    // Replaying the same code on another sign-in fails; a recovery code works once
    const again = new TestClient(app);
    await again.login('kim@example.com', 'user-password-1');
    expect((await again.post('/api/auth/mfa', { code: next })).statusCode).toBe(401);
    expect((await again.post('/api/auth/mfa', { code: recovery[0].toUpperCase() })).statusCode).toBe(200);
    const third = new TestClient(app);
    await third.login('kim@example.com', 'user-password-1');
    expect((await third.post('/api/auth/mfa', { code: recovery[0] })).statusCode).toBe(401);

    // Without a ticket there's nothing to finish
    expect((await new TestClient(app).post('/api/auth/mfa', { code: '123456' })).statusCode).toBe(403);

    // Turning it off needs a code; an admin can reset it
    expect((await kim.client.post('/api/me/mfa/disable', { code: '000000' })).statusCode).toBe(400);
    const listed = (await admin.get('/api/admin/users?search=kim')).json().users[0];
    expect(listed.mfaEnabled).toBe(true);
    expect((await admin.delete(`/api/admin/users/${listed.id}/mfa`)).statusCode).toBe(200);
    expect((await new TestClient(app).login('kim@example.com', 'user-password-1')).json().user.email).toBe('kim@example.com');
  });

  it('when required, users must turn it on before anything else', async () => {
    const { app, admin } = await setup();
    const lee = await newUser(app, admin, 'lee@example.com');
    await lee.login();
    expect((await admin.patch('/api/admin/settings/auth.mfa', { require: 'everyone' })).statusCode).toBe(200);
    // The admin themselves is now held too (they have no two-factor yet)
    expect((await admin.get('/api/admin/users')).json().error.code).toBe('mfa_setup_required');
    const blocked = await lee.client.get('/api/chats');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('mfa_setup_required');
    expect((await lee.client.get('/api/auth/session')).json().mfa).toEqual({ enabled: false, required: true });
    await enableMfa(lee.client);
    expect((await lee.client.get('/api/chats')).statusCode).toBe(200);
    // And can't turn it off while it's required
    expect((await lee.client.post('/api/me/mfa/disable', { code: '123456' })).json().error.code).toBe('mfa_required');
  });
});

describe('deactivated accounts', () => {
  it('lose their sessions and API keys at once and cannot sign in', async () => {
    const { app, admin } = await setup();
    await admin.patch('/api/admin/settings/permissions.default', { ...(await admin.get('/api/admin/settings')).json().settings['permissions.default'], 'api.keys': true });
    const max = await newUser(app, admin, 'max@example.com');
    await max.login();
    const key = (await max.client.post('/api/me/api-keys', { name: 'cli' })).json().secret;
    const id = (await admin.get('/api/admin/users?search=max')).json().users[0].id;

    expect((await admin.patch(`/api/admin/users/${id}`, { active: false })).json().user.active).toBe(false);
    expect((await max.client.get('/api/chats')).statusCode).toBe(401);
    const login = await new TestClient(app).login('max@example.com', 'user-password-1');
    expect(login.statusCode).toBe(403);
    expect(login.json().error.code).toBe('account_deactivated');
    expect((await app.inject({ method: 'GET', url: '/api/v1/models', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(401);

    // Not yourself, and back again
    const me = (await admin.get('/api/admin/users?search=admin')).json().users[0].id;
    expect((await admin.patch(`/api/admin/users/${me}`, { active: false })).json().error.code).toBe('self_deactivate');
    await admin.patch(`/api/admin/users/${id}`, { active: true });
    expect((await new TestClient(app).login('max@example.com', 'user-password-1')).statusCode).toBe(200);
  });
});

describe('single sign-on (OpenID Connect)', () => {
  async function withProvider(extra: Record<string, unknown> = {}) {
    const ctx = await setup();
    oidc = await startFakeOidc();
    const created = await ctx.admin.post('/api/admin/sso', {
      id: 'corp',
      name: 'Corp SSO',
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      clientSecret: oidc.clientSecret,
      ...extra,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().provider).toMatchObject({ hasSecret: true, callbackUrl: expect.stringContaining('/api/auth/oidc/corp/callback') });
    expect(JSON.stringify(created.json())).not.toContain(oidc.clientSecret);
    return ctx;
  }

  /** The browser's round trip: start → provider → callback. Returns the final redirect. */
  async function ssoSignIn(c: TestClient, tamper?: (callback: URL) => void) {
    const start = await c.get('/api/auth/oidc/corp/start');
    expect(start.statusCode).toBe(302);
    const atProvider = await fetch(String(start.headers.location), { redirect: 'manual' });
    const callback = new URL(atProvider.headers.get('location')!);
    tamper?.(callback);
    const done = await c.get(callback.pathname + callback.search);
    expect(done.statusCode).toBe(302);
    return new URL(String(done.headers.location), 'http://app');
  }

  it('signs in with PKCE, creates the account once and lists the provider on the sign-in page', async () => {
    const { app } = await withProvider({ defaultRole: 'user' });
    const c = new TestClient(app);
    expect((await c.get('/api/auth/session')).json().auth.sso).toEqual([{ id: 'corp', name: 'Corp SSO' }]);
    expect((await ssoSignIn(c)).pathname).toBe('/');
    const me = (await c.get('/api/auth/session')).json().user;
    expect(me).toMatchObject({ email: 'sso.user@example.com', name: 'Sso User', role: 'user', hasPassword: false });
    // The token request proved the code verifier and the client
    expect(oidc!.tokenRequests[0].form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(oidc!.tokenRequests[0].authorization).toMatch(/^Basic /);

    const again = new TestClient(app);
    await ssoSignIn(again);
    expect((await again.get('/api/auth/session')).json().user.id).toBe(me.id);
    const ids = await t!.db.db.select().from(authIdentities).where(eq(authIdentities.userId, me.id));
    expect(ids).toEqual([expect.objectContaining({ provider: 'oidc', subject: 'corp:u-1' })]);
  });

  it('refuses bad state, a token for another client, a forged signature and other domains', async () => {
    const { app } = await withProvider({ allowedDomains: ['example.com'] });
    const err = (u: URL) => u.searchParams.get('auth_error');

    expect(err(await ssoSignIn(new TestClient(app), (cb) => cb.searchParams.set('state', 'forged')))).toBe('sso_state');
    oidc!.idTokenOverrides = { aud: 'someone-else' };
    expect(err(await ssoSignIn(new TestClient(app)))).toBe('sso_token_invalid');
    oidc!.idTokenOverrides = {};
    oidc!.useRogueKey = true;
    expect(err(await ssoSignIn(new TestClient(app)))).toBe('sso_token_invalid');
    oidc!.useRogueKey = false;
    oidc!.idTokenOverrides = { nonce: 'replayed' };
    expect(err(await ssoSignIn(new TestClient(app)))).toBe('sso_nonce');
    oidc!.idTokenOverrides = {};
    oidc!.nextUser = { sub: 'u-2', email: 'x@elsewhere.org', email_verified: true };
    expect(err(await ssoSignIn(new TestClient(app)))).toBe('sso_domain');
    // A callback without having started here
    const lone = new TestClient(app);
    const res = await lone.get('/api/auth/oidc/corp/callback?code=abc&state=xyz');
    expect(new URL(String(res.headers.location), 'http://app').searchParams.get('auth_error')).toBe('sso_state');
  });

  it('links an existing account only when allowed, and always for one provisioned without a password', async () => {
    const { app, admin } = await withProvider();
    await newUser(app, admin, 'sso.user@example.com');
    const blocked = await ssoSignIn(new TestClient(app));
    expect(blocked.searchParams.get('auth_error')).toBe('email_conflict');

    await admin.patch('/api/admin/sso/corp', { linkByEmail: true });
    oidc!.nextUser = { ...oidc!.nextUser, email_verified: false };
    expect((await ssoSignIn(new TestClient(app))).searchParams.get('auth_error')).toBe('email_conflict');
    oidc!.nextUser = { ...oidc!.nextUser, email_verified: true };
    const c = new TestClient(app);
    expect((await ssoSignIn(c)).pathname).toBe('/');
    expect((await c.get('/api/auth/session')).json().user.hasPassword).toBe(true);

    // No password, no other sign-in: a provisioned account links even without linkByEmail
    await admin.patch('/api/admin/sso/corp', { linkByEmail: false });
    await t!.db.db.insert(users).values({ id: uuidv7(), email: 'provisioned@example.com', name: 'Prov', role: 'user' });
    oidc!.nextUser = { sub: 'u-9', email: 'provisioned@example.com', email_verified: true };
    const p = new TestClient(app);
    expect((await ssoSignIn(p)).pathname).toBe('/');
    expect((await p.get('/api/auth/session')).json().user.email).toBe('provisioned@example.com');
  });

  it('follows the groups claim: admin groups and Claudia groups of the same name', async () => {
    const { app, admin } = await withProvider({ groupsClaim: 'groups', adminGroups: ['claudia-admins'] });
    const team = (await admin.post('/api/admin/groups', { name: 'Research' })).json().group.id;
    oidc!.nextUser = { sub: 'g-1', email: 'g@example.com', email_verified: true, groups: ['research', 'claudia-admins'] };
    const c = new TestClient(app);
    await ssoSignIn(c);
    const me = (await c.get('/api/auth/session')).json().user;
    expect(me.role).toBe('admin');
    const member = () => t!.db.db.select().from(groupMembers).where(eq(groupMembers.groupId, team));
    expect(await member()).toEqual([expect.objectContaining({ userId: me.id, source: 'sso' })]);
    oidc!.nextUser = { ...oidc!.nextUser, groups: [] };
    await ssoSignIn(new TestClient(app));
    expect(await member()).toEqual([]);
  });

  it('asks for the code when two-factor is on, and refuses deactivated accounts', async () => {
    const { app, admin } = await withProvider({ defaultRole: 'user' });
    const c = new TestClient(app);
    await ssoSignIn(c);
    await enableMfa(c);
    const second = new TestClient(app);
    const landed = await ssoSignIn(second);
    expect(landed.pathname + landed.search).toBe('/?mfa=1');
    expect((await second.get('/api/auth/session')).json().user).toBeNull();

    const id = (await admin.get('/api/admin/users?search=sso.user')).json().users[0].id;
    await admin.patch(`/api/admin/users/${id}`, { active: false });
    expect((await ssoSignIn(new TestClient(app))).searchParams.get('auth_error')).toBe('account_deactivated');
  });
});

describe('SCIM provisioning', () => {
  async function withScim() {
    const ctx = await setup();
    const { token, baseUrl } = (await ctx.admin.post('/api/admin/scim/token')).json();
    expect(baseUrl).toMatch(/\/scim\/v2$/);
    const scim = (method: string, url: string, body?: unknown, auth = token) =>
      ctx.app.inject({
        method: method as 'GET',
        url: `/scim/v2${url}`,
        headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/scim+json' },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      });
    return { ...ctx, scim, token };
  }

  it('needs the token, and describes itself', async () => {
    const { scim, admin, token } = await withScim();
    expect((await scim('GET', '/Users', undefined, 'wrong')).statusCode).toBe(401);
    expect((await scim('GET', '/ServiceProviderConfig')).json().patch.supported).toBe(true);
    expect((await scim('GET', '/ResourceTypes')).json().Resources.map((r: any) => r.id)).toEqual(['User', 'Group']);
    // A new token replaces the old
    await admin.post('/api/admin/scim/token');
    expect((await scim('GET', '/Users', undefined, token)).statusCode).toBe(401);
  });

  it('creates, finds, updates, deactivates and deletes users the way Entra ID does', async () => {
    const { scim, app } = await withScim();
    const created = await scim('POST', '/Users', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      externalId: 'ext-42',
      userName: 'Ana.Lopez@Example.com',
      active: true,
      displayName: 'Ana Lopez',
      emails: [{ primary: true, type: 'work', value: 'Ana.Lopez@Example.com' }],
      name: { givenName: 'Ana', familyName: 'Lopez' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['content-type']).toContain('application/scim+json');
    const user = created.json();
    expect(user).toMatchObject({ userName: 'ana.lopez@example.com', externalId: 'ext-42', active: true, displayName: 'Ana Lopez' });
    expect((await scim('POST', '/Users', { userName: 'ana.lopez@example.com' })).json()).toMatchObject({ status: '409', scimType: 'uniqueness' });

    const found = (await scim('GET', '/Users?filter=userName eq "ana.lopez@example.com"')).json();
    expect(found).toMatchObject({ totalResults: 1, Resources: [{ id: user.id }] });
    expect((await scim('GET', '/Users?filter=externalId eq "ext-42"')).json().totalResults).toBe(1);
    expect((await scim('GET', '/Users?filter=userName eq "nobody@example.com"')).json().totalResults).toBe(0);
    expect((await scim('GET', '/Users?filter=title co "x"')).json().scimType).toBe('invalidFilter');

    // Signed in through SSO meanwhile: deactivation ends the session
    const [row] = await t!.db.db.select().from(users).where(eq(users.id, user.id));
    expect(row.role).toBe('user');
    const patched = await scim('PATCH', `/Users/${user.id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        { op: 'Replace', path: 'active', value: 'False' },
        { op: 'Add', path: 'displayName', value: 'Ana L.' },
      ],
    });
    expect(patched.json()).toMatchObject({ active: false, displayName: 'Ana L.' });
    const [after] = await t!.db.db.select().from(users).where(eq(users.id, user.id));
    expect(after.deactivatedAt).not.toBeNull();

    // A replace without "active" means active again
    const put = await scim('PUT', `/Users/${user.id}`, { userName: 'ana@example.com', displayName: 'Ana', emails: [{ value: 'ana@example.com', primary: true }] });
    expect(put.json()).toMatchObject({ userName: 'ana@example.com', active: true });

    expect((await scim('DELETE', `/Users/${user.id}`)).statusCode).toBe(204);
    expect((await scim('GET', `/Users/${user.id}`)).statusCode).toBe(404);
    // The audit log has the provider's changes
    const audit = (await new TestClient(app).get('/api/admin/audit')).statusCode;
    expect(audit).toBe(401);
  });

  it('manages groups and only the memberships it set', async () => {
    const { scim, admin } = await withScim();
    const a = (await scim('POST', '/Users', { userName: 'a@example.com' })).json().id;
    const b = (await scim('POST', '/Users', { userName: 'b@example.com' })).json().id;
    const group = await scim('POST', '/Groups', { displayName: 'Finance', externalId: 'g-fin', members: [{ value: a }] });
    expect(group.statusCode).toBe(201);
    const gid = group.json().id;
    expect(group.json().members.map((m: any) => m.value)).toEqual([a]);
    expect((await scim('GET', '/Groups?filter=displayName eq "finance"')).json().totalResults).toBe(1);

    // An admin adds someone by hand; SCIM changes leave them be
    const me = (await admin.get('/api/admin/users?search=admin')).json().users[0].id;
    await t!.db.db.insert(groupMembers).values({ groupId: gid, userId: me, source: 'manual' });
    await scim('PATCH', `/Groups/${gid}`, { Operations: [{ op: 'Add', path: 'members', value: [{ value: b }] }] });
    await scim('PATCH', `/Groups/${gid}`, { Operations: [{ op: 'Remove', path: `members[value eq "${a}"]` }] });
    const members = (await scim('GET', `/Groups/${gid}`)).json().members.map((m: any) => m.value).sort();
    expect(members).toEqual([b, me].sort());
    await scim('PUT', `/Groups/${gid}`, { displayName: 'Finance & Ops', members: [] });
    expect((await scim('GET', `/Groups/${gid}`)).json()).toMatchObject({ displayName: 'Finance & Ops', members: [{ value: me }] });
    expect((await scim('DELETE', `/Groups/${gid}`)).statusCode).toBe(204);
    expect(await t!.db.db.select().from(groups).where(eq(groups.id, gid))).toEqual([]);
  });
});
