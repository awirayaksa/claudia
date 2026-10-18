/**
 * LDAP group sync at sign-in: memberships of groups linked to directory
 * groups follow the directory (manual ones stay), and an admin group makes
 * and unmakes admins (never the last one).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildTestApp } from '../test/helpers';
import { TestClient } from '../test/client';
import { GROUPS_DN, PEOPLE_DN, SERVICE_DN, SERVICE_PASSWORD, STAFF_GROUP_DN, startFakeLdap, type FakeGroup, type FakeUser } from '../test/fake-ldap';
import { buildGroupFilter, normalizeDn } from './ldap';

const ALICE: FakeUser = {
  uid: 'alice',
  password: 'alice-pass',
  cn: 'Alice',
  mail: 'alice@example.com',
  entryUUID: '7f1c2c3e-0000-4000-8000-00000000a11c',
  memberOf: [STAFF_GROUP_DN],
};
const BOB: FakeUser = { uid: 'bob', password: 'bob-pass', cn: 'Bob', mail: 'bob@example.com', entryUUID: '7f1c2c3e-0000-4000-8000-000000000b0b' };
const ADMINS_DN = `cn=admins,${GROUPS_DN}`;

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup(settings: Record<string, unknown>, groups: FakeGroup[] = [], users: FakeUser[] = [ALICE, BOB]) {
  const dir = await startFakeLdap(users, groups);
  const t = await buildTestApp();
  const admin = new TestClient(t.app);
  await admin.signup('admin@example.com');
  await t.app.ctx.ldap.update({
    enabled: true,
    url: dir.url,
    bindDn: SERVICE_DN,
    bindPassword: SERVICE_PASSWORD,
    userSearchBase: PEOPLE_DN,
    userFilter: '(uid={{username}})',
    groupSync: true,
    ...settings,
  });
  close = async () => {
    await t.close();
    await dir.close();
  };
  const login = async (username: string, password: string) => {
    const c = new TestClient(t.app);
    await c.get('/api/auth/session');
    const res = await c.post('/api/auth/ldap', { username, password });
    expect(res.statusCode, res.body).toBe(200);
    return c;
  };
  const group = async (name: string, ldapDn: string | null) => {
    const res = await admin.post('/api/admin/groups', { name, ldapDn });
    expect(res.statusCode).toBe(201);
    return res.json().group.id as string;
  };
  const membersOf = async (id: string) =>
    ((await admin.get(`/api/admin/groups/${id}/members`)).json().members as Array<{ email: string; source: string }>).map(
      (m) => `${m.email}:${m.source}`
    );
  return { t, dir, admin, login, group, membersOf };
}

describe('LDAP group sync', () => {
  it('follows memberOf at each sign-in and leaves manual memberships alone', async () => {
    const s = await setup({ groupMode: 'memberOf' });
    // Stored normalized, so spacing and case don't matter
    const staff = await s.group('Staff', ' CN=Staff, OU=Groups,DC=example,DC=com ');
    const other = await s.group('Other', `cn=other,${GROUPS_DN}`);
    const manual = await s.group('Manual', null);

    await s.login('alice', 'alice-pass');
    expect(await s.membersOf(staff)).toEqual(['alice@example.com:ldap']);
    expect(await s.membersOf(other)).toEqual([]);

    const users = (await s.admin.get('/api/admin/users')).json().users as Array<{ id: string; email: string }>;
    const aliceId = users.find((u) => u.email === 'alice@example.com')!.id;
    await s.admin.post(`/api/admin/groups/${manual}/members`, { userId: aliceId });

    // Out of staff in the directory: out of Staff here at the next sign-in, Manual stays
    s.dir.users.get('alice')!.memberOf = [`cn=other,${GROUPS_DN}`];
    await s.login('alice', 'alice-pass');
    expect(await s.membersOf(staff)).toEqual([]);
    expect(await s.membersOf(other)).toEqual(['alice@example.com:ldap']);
    expect(await s.membersOf(manual)).toEqual(['alice@example.com:manual']);
  });

  it('searches groups with an escaped filter', async () => {
    const s = await setup(
      { groupMode: 'search', groupSearchBase: GROUPS_DN, groupFilter: '(&(objectClass=groupOfNames)(member={{dn}}))' },
      [
        { cn: 'devs', members: ['bob'] },
        { cn: 'ops', members: ['alice'] },
      ]
    );
    const devs = await s.group('Developers', `cn=devs,${GROUPS_DN}`);
    await s.login('bob', 'bob-pass');
    expect(await s.membersOf(devs)).toEqual(['bob@example.com:ldap']);
    // The user's DN went into the filter escaped
    expect(s.dir.filters.some((f) => f.includes('member=uid=bob,ou=people,dc=example,dc=com'))).toBe(true);
  });

  it('makes members of the admin group admins, and takes it away again', async () => {
    const s = await setup({ groupMode: 'memberOf', adminGroupDn: ADMINS_DN });
    s.dir.users.get('bob')!.memberOf = [ADMINS_DN];
    const bob = await s.login('bob', 'bob-pass');
    expect((await bob.get('/api/me')).json().user.role).toBe('admin');

    s.dir.users.get('bob')!.memberOf = [];
    const again = await s.login('bob', 'bob-pass');
    expect((await again.get('/api/me')).json().user.role).toBe('user');
  });

  it('never demotes the last admin', async () => {
    const s = await setup({ groupMode: 'memberOf', adminGroupDn: ADMINS_DN });
    s.dir.users.get('bob')!.memberOf = [ADMINS_DN];
    await s.login('bob', 'bob-pass');
    // The local admin goes; Bob is the only admin left
    const users = (await s.admin.get('/api/admin/users')).json().users as Array<{ id: string; email: string }>;
    const bobId = users.find((u) => u.email === 'bob@example.com')!.id;
    const bobAsAdmin = await s.login('bob', 'bob-pass');
    const localAdmin = users.find((u) => u.email === 'admin@example.com')!.id;
    expect((await bobAsAdmin.delete(`/api/admin/users/${localAdmin}`)).statusCode).toBe(200);

    s.dir.users.get('bob')!.memberOf = [];
    const later = await s.login('bob', 'bob-pass');
    expect((await later.get('/api/me')).json().user).toMatchObject({ id: bobId, role: 'admin' });
  });
});

describe('group filter helpers', () => {
  it('normalizes DNs and escapes filter values', () => {
    expect(normalizeDn(' CN=Staff , OU=Groups,DC=Example ')).toBe('cn=staff,ou=groups,dc=example');
    expect(buildGroupFilter('(member={{dn}})', 'cn=a*b,dc=x', 'u')).toBe('(member=cn=a\\2ab,dc=x)');
    expect(buildGroupFilter('(memberUid={{username}})', 'cn=x', 'bob)(uid=*')).toBe('(memberUid=bob\\29\\28uid=\\2a)');
  });
});
