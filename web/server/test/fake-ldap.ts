/**
 * An in-process LDAP directory for tests (ldapjs server). Like many real
 * servers it treats a bind with an empty password as an anonymous success,
 * so tests can prove the client never sends one.
 */
import type { AddressInfo } from 'node:net';
import ldap from 'ldapjs';

export const BASE_DN = 'dc=example,dc=com';
export const PEOPLE_DN = `ou=people,${BASE_DN}`;
export const SERVICE_DN = `cn=svc,${BASE_DN}`;
export const SERVICE_PASSWORD = 'svc-secret';
export const STAFF_GROUP_DN = `cn=staff,ou=groups,${BASE_DN}`;

export interface FakeUser {
  uid: string;
  password: string;
  cn: string;
  mail?: string;
  entryUUID: string;
  memberOf?: string[];
  userAccountControl?: number;
}

export interface FakeLdap {
  url: string;
  users: Map<string, FakeUser>;
  /** Every bind: DN and whether a password was sent. */
  binds: Array<{ dn: string; withPassword: boolean }>;
  /** Every search filter, as the server parsed it. */
  filters: string[];
  close(): Promise<void>;
}

const dnOf = (uid: string) => `uid=${uid},${PEOPLE_DN}`;

export async function startFakeLdap(initial: FakeUser[]): Promise<FakeLdap> {
  const users = new Map(initial.map((u) => [u.uid, u]));
  const binds: FakeLdap['binds'] = [];
  const filters: string[] = [];
  const server = ldap.createServer();

  const sameDn = (a: string, b: string) => a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase();

  server.bind(BASE_DN, (req: any, res: any, next: any) => {
    const dn = req.dn.toString();
    const password = String(req.credentials ?? '');
    binds.push({ dn, withPassword: password.length > 0 });
    const ok = () => {
      req.connection.boundDn = password === '' ? '' : dn;
      res.end();
    };
    // Unauthenticated bind (RFC 4513 5.1.2): a name without a password "succeeds"
    if (password === '') return ok();
    if (sameDn(dn, SERVICE_DN) && password === SERVICE_PASSWORD) return ok();
    const user = [...users.values()].find((u) => sameDn(dn, dnOf(u.uid)));
    if (user && user.password === password) return ok();
    return next(new ldap.InvalidCredentialsError());
  });

  server.search(PEOPLE_DN, (req: any, res: any, next: any) => {
    // Only the service account may search
    if (!sameDn(req.connection.boundDn ?? '', SERVICE_DN)) return next(new ldap.InsufficientAccessRightsError());
    filters.push(req.filter.toString());
    // Attribute names are case-insensitive in LDAP; ldapjs only matches lower case
    if (Array.isArray(res.attributes)) res.attributes = res.attributes.map((a: string) => a.toLowerCase());
    const base = req.dn.toString();
    for (const u of users.values()) {
      const dn = dnOf(u.uid);
      const baseScope = req.scope === 'base' || req.scope === 0;
      if (baseScope && !sameDn(base, dn)) continue;
      const attributes: Record<string, string | string[]> = {
        objectClass: ['inetOrgPerson'],
        uid: u.uid,
        cn: u.cn,
        entryUUID: u.entryUUID,
        ...(u.mail ? { mail: u.mail } : {}),
        ...(u.memberOf ? { memberOf: u.memberOf } : {}),
        ...(u.userAccountControl !== undefined ? { userAccountControl: String(u.userAccountControl) } : {}),
      };
      if (req.filter.matches(attributes, false)) res.send({ dn, attributes });
    }
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = (server as unknown as { address(): AddressInfo }).address();

  return {
    url: `ldap://127.0.0.1:${port}`,
    users,
    binds,
    filters,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const userDn = dnOf;
