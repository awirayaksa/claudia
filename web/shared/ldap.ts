import { z } from 'zod';

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
});
export type LdapSettings = z.infer<typeof LdapSettings>;

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
