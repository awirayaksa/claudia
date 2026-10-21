import { z } from 'zod';

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** LDAP / Active Directory settings as the admin edits them (no bind password). */
export const LdapSettings = z.object({
  enabled: z.boolean(),
  /** ldap://host:389 or ldaps://host:636 */
  url: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^ldaps?:\/\/[^\s/]+\/?$/i.test(v), 'Use ldap://host:port or ldaps://host:port'),
  /** Upgrade an ldap:// connection with StartTLS. */
  startTls: z.boolean(),
  /** Check the server's certificate (only turn off for testing). */
  tlsVerify: z.boolean(),
  /**
   * search: a service account finds the user's entry, which then binds with
   * the password. direct: the user binds as user@domain (Active Directory),
   * the domain being signInDomain or the base DN's dc= parts; no service
   * account, no search.
   */
  bindMode: z.enum(['search', 'direct']),
  /**
   * Direct bind: the domain added to a bare username (the users' UPN suffix,
   * e.g. app.example.com). Empty = the base DN's dc= parts.
   */
  signInDomain: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .refine((v) => v === '' || DOMAIN.test(v.replace(/^@/, '')), 'Use a domain such as app.example.com'),
  /** PEM of the CA that signed the directory's certificate, if not a public one. */
  caCert: z.string().max(20_000).nullable(),
  /** Service account that searches for users; empty = anonymous search. */
  bindDn: z.string().trim().max(500),
  userSearchBase: z.string().trim().max(500),
  /** Must contain {{username}}, e.g. (uid={{username}}) or (sAMAccountName={{username}}). */
  userFilter: z
    .string()
    .trim()
    .max(1000)
    .refine((v) => v.includes('{{username}}'), 'The filter must contain {{username}}')
    .refine((v) => v.startsWith('(') && v.endsWith(')'), 'The filter must be wrapped in parentheses'),
  emailAttribute: z.string().trim().min(1).max(100),
  nameAttribute: z.string().trim().min(1).max(100),
  /** Only members of this group may sign in (checked with memberOf). */
  allowedGroupDn: z.string().trim().max(500).nullable(),
  /** Accept DOMAIN\user and user@domain by keeping only "user". */
  stripDomain: z.boolean(),
  /** Role of accounts created by a first directory login. */
  defaultRole: z.enum(['user', 'pending']),
  timeoutMs: z.number().int().min(1000).max(60_000),
  /** How often a signed-in directory user is re-checked (on token refresh). */
  verifyIntervalMinutes: z.number().int().min(1).max(1440),
  /** Sync memberships of groups linked to directory groups at each sign-in. */
  groupSync: z.boolean(),
  /** memberOf: read the user's memberOf attribute (AD, OpenLDAP memberof overlay); search: run groupFilter. */
  groupMode: z.enum(['memberOf', 'search']),
  groupSearchBase: z.string().trim().max(500),
  /**
   * With {{dn}} (the user's DN) or {{username}}, e.g. (member={{dn}}); AD
   * nested groups: (member:1.2.840.113556.1.4.1941:={{dn}}).
   */
  groupFilter: z
    .string()
    .trim()
    .max(1000)
    .refine((v) => v.includes('{{dn}}') || v.includes('{{username}}'), 'The filter must contain {{dn}} or {{username}}')
    .refine((v) => v.startsWith('(') && v.endsWith(')'), 'The filter must be wrapped in parentheses'),
  /** Members of this directory group are admins here; others lose admin at sign-in. */
  adminGroupDn: z.string().trim().max(500).nullable(),
});
export type LdapSettings = z.infer<typeof LdapSettings>;

/** Direct bind's sign-in domain: example.com from the dc= parts of a DN (dc=example,dc=com); null without any. */
export function bindDomain(baseDn: string): string | null {
  const parts = baseDn
    .split(',')
    .map((p) => /^dc\s*=\s*(.+)$/i.exec(p.trim())?.[1]?.trim().toLowerCase())
    .filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join('.') : null;
}

/** The domain direct bind adds to a bare username: signInDomain, else the base DN's dc= parts. */
export function directDomain(s: Pick<LdapSettings, 'signInDomain' | 'userSearchBase'>): string | null {
  return s.signInDomain.replace(/^@/, '') || bindDomain(s.userSearchBase);
}

export const LdapSettingsUpdate = LdapSettings.partial().extend({
  /** Omitted = keep the stored one; '' = remove it. */
  bindPassword: z.string().max(1000).optional(),
});
export type LdapSettingsUpdate = z.infer<typeof LdapSettingsUpdate>;

export interface LdapSettingsResponse {
  settings: LdapSettings;
  hasBindPassword: boolean;
  /** Fields set by environment variables (read-only here). */
  locked: Array<keyof LdapSettings | 'bindPassword'>;
}

export interface LdapTestResult {
  ok: boolean;
  error: string | null;
}

export interface LdapLookupResult {
  /** How many entries the filter matched (sign-in needs exactly one). */
  matches: number;
  entry: { dn: string; email: string | null; name: string | null; subject: string } | null;
  error: string | null;
}
