/**
 * Directory sign-in against a real OpenLDAP (docker/compose.ldap.yml). Runs
 * when TEST_LDAP_HOST is set (CI); skipped otherwise.
 *
 *   TEST_LDAP_HOST=ldap.claudia.test   (must resolve to the container and match its certificate)
 *   TEST_LDAP_CA_FILE=/path/to/ca.crt
 */
import fs from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { Client } from 'ldapts';
import { buildTestApp } from '../test/helpers';
import { TestClient } from '../test/client';
import { sessions } from '../db/schema';
import type { LdapSettingsUpdate } from '../../shared/ldap';

const HOST = process.env.TEST_LDAP_HOST;
const CA = process.env.TEST_LDAP_CA_FILE ? fs.readFileSync(process.env.TEST_LDAP_CA_FILE, 'utf-8') : null;
const BASE = 'dc=claudia,dc=test';

const settings = (over: LdapSettingsUpdate = {}): LdapSettingsUpdate => ({
  enabled: true,
  url: `ldap://${HOST}:389`,
  bindDn: `cn=readonly,${BASE}`,
  bindPassword: 'readonly-secret',
  userSearchBase: `ou=people,${BASE}`,
  userFilter: '(uid={{username}})',
  caCert: CA,
  ...over,
});

type Setup = Awaited<ReturnType<typeof setup>>;
let current: Setup | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function setup(over: LdapSettingsUpdate = {}) {
  const t = await buildTestApp();
  const admin = new TestClient(t.app);
  await admin.signup('admin@example.com');
  await t.app.ctx.ldap.update(settings(over));
  const login = async (username: string, password: string) => {
    const client = new TestClient(t.app);
    await client.get('/api/auth/session');
    return { client, res: await client.post('/api/auth/ldap', { username, password }) };
  };
  const s = { ...t, admin, login };
  current = s;
  return s;
}

/** Directory admin, to add and remove entries. */
async function directoryAdmin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ url: `ldap://${HOST}:389` });
  await c.bind(`cn=admin,${BASE}`, 'admin-secret');
  try {
    return await fn(c);
  } finally {
    await c.unbind();
  }
}

describe.skipIf(!HOST)('LDAP against OpenLDAP', () => {
  it('signs in, links by entryUUID and refuses bad credentials', async () => {
    const s = await setup();
    const ok = await s.login('Alice', 'alice-pass');
    expect(ok.res.statusCode).toBe(200);
    expect(ok.res.json().user).toMatchObject({ email: 'alice@claudia.test', name: 'Alice Liddell', hasPassword: false });
    const lookup = (await s.admin.post('/api/admin/ldap/lookup', { username: 'alice' })).json();
    expect(lookup.entry.subject).toMatch(/^uuid:[0-9a-f-]{36}$/);

    expect((await s.login('alice', 'wrong')).res.statusCode).toBe(401);
    expect((await s.login('nobody', 'x')).res.statusCode).toBe(401);
    expect(await s.app.ctx.ldap.login('alice', '')).toEqual({ ok: false, reason: 'invalid_credentials' });
    expect((await s.login('al*', 'alice-pass')).res.statusCode).toBe(401);
    expect((await s.login('*)(uid=*', 'alice-pass')).res.statusCode).toBe(401);
  });

  it('checks group membership with memberOf', async () => {
    const s = await setup({ allowedGroupDn: `cn=staff,ou=groups,${BASE}` });
    expect((await s.login('bob', 'bob-pass')).res.statusCode).toBe(401);
    expect((await s.login('alice', 'alice-pass')).res.statusCode).toBe(200);
  });

  it('upgrades with StartTLS and verifies the certificate', async () => {
    const s = await setup({ startTls: true });
    expect((await s.admin.post('/api/admin/ldap/test')).json()).toEqual({ ok: true, error: null });
    expect((await s.login('alice', 'alice-pass')).res.statusCode).toBe(200);
  });

  it('speaks ldaps:// and refuses an untrusted certificate', async () => {
    const s = await setup({ url: `ldaps://${HOST}:636` });
    expect((await s.admin.post('/api/admin/ldap/test')).json()).toEqual({ ok: true, error: null });
    expect((await s.login('alice', 'alice-pass')).res.statusCode).toBe(200);

    await s.app.ctx.ldap.update({ caCert: null });
    const untrusted = (await s.admin.post('/api/admin/ldap/test')).json();
    expect(untrusted.ok).toBe(false);
    expect((await s.login('alice', 'alice-pass')).res.statusCode).toBe(503);
  });

  it('refuses an email that belongs to a local account', async () => {
    const s = await setup();
    await s.admin.post('/api/admin/users', { email: 'bob@claudia.test', name: 'Local Bob', password: 'local-password' });
    expect((await s.login('bob', 'bob-pass')).res.json().error.code).toBe('email_conflict');
  });

  it('ends the sessions of a user removed from the directory', async () => {
    const s = await setup();
    const dave = `uid=dave,ou=people,${BASE}`;
    await directoryAdmin((c) =>
      c.add(dave, { objectClass: 'inetOrgPerson', uid: 'dave', cn: 'Dave', sn: 'Dave', mail: 'dave@claudia.test', userPassword: 'dave-pass' })
    );
    try {
      const { client, res } = await s.login('dave', 'dave-pass');
      expect(res.statusCode).toBe(200);
      await directoryAdmin((c) => c.del(dave));
      await s.db.db
        .update(sessions)
        .set({ lastVerifiedAt: new Date(Date.now() - 2 * 3600_000) })
        .where(eq(sessions.userId, res.json().user.id));
      expect((await client.post('/api/auth/refresh')).statusCode).toBe(401);
    } finally {
      await directoryAdmin((c) => c.del(dave)).catch(() => {});
    }
  });
});
