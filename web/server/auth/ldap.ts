/**
 * LDAP / Active Directory: settings, sign-in and re-checking signed-in users.
 *
 * Sign-in, hardened:
 *  1. an empty password is refused before any bind (a simple bind with an
 *     empty password is an "unauthenticated bind" many servers accept);
 *  2. the username is trimmed, case-folded and (optionally) stripped of
 *     DOMAIN\ and @domain;
 *  3. the service account binds and searches with the username escaped per
 *     RFC 4515 (ldapts escapeFilter); exactly one entry must match;
 *  4. that entry's DN binds with the given password;
 *  5. the account is linked by entryUUID / objectGUID (else the DN), never by
 *     email; an email that already belongs to another account is refused.
 *
 * Direct bind (bindMode "direct", Active Directory): no service account and
 * no search. The user binds as user@domain, the domain made of the base DN's
 * dc= parts (dc=example,dc=com → example.com); a name typed with a domain
 * (user@domain, DOMAIN\user) binds as typed. The account is linked by that
 * user@domain, which is also its email; the name is the username. Without a
 * search there is no allowed group, no group sync and no re-check of
 * signed-in users: the directory decides at each sign-in.
 */
import fs from 'node:fs';
import { and, eq, isNotNull, ne, notInArray, sql } from 'drizzle-orm';
import { Client, InvalidCredentialsError, ResultCodeError, escapeFilter, type Entry } from 'ldapts';
import type { ConnectionOptions } from 'node:tls';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config';
import type { Database } from '../db/client';
import { appConfig, authIdentities, groupMembers, groups, users } from '../db/schema';
import type { SecretBox } from '../crypto/secrets';
import { uuidv7 } from '../lib/ids';
import { badRequest } from '../lib/errors';
import {
  LdapSettings,
  bindDomain,
  type LdapLookupResult,
  type LdapSettingsResponse,
  type LdapSettingsUpdate,
  type LdapTestResult,
} from '../../shared/ldap';

const SETTINGS_KEY = 'auth.ldap';

export const LDAP_DEFAULTS: LdapSettings = {
  enabled: false,
  url: '',
  startTls: false,
  tlsVerify: true,
  bindMode: 'search',
  caCert: null,
  bindDn: '',
  userSearchBase: '',
  userFilter: '(uid={{username}})',
  emailAttribute: 'mail',
  nameAttribute: 'cn',
  allowedGroupDn: null,
  stripDomain: true,
  defaultRole: 'user',
  timeoutMs: 10_000,
  verifyIntervalMinutes: 60,
  groupSync: false,
  groupMode: 'memberOf',
  groupSearchBase: '',
  groupFilter: '(member={{dn}})',
  adminGroupDn: null,
};

interface Stored {
  settings: Partial<LdapSettings>;
  bindPasswordCipher: string | null;
}

/** The settings in force, with the bind password in clear (server only). */
export interface EffectiveLdap extends LdapSettings {
  bindPassword: string;
}

export type LdapLoginResult =
  | { ok: true; userId: string; created: boolean }
  | {
      ok: false;
      reason: 'disabled' | 'invalid_credentials' | 'email_conflict' | 'unavailable';
      message?: string;
    };

export type LdapVerifyResult = 'active' | 'gone' | 'unavailable' | 'not_ldap';

/** RFC 4515-escaped filter from a template with {{username}} placeholders. */
export function buildUserFilter(template: string, username: string): string {
  const parts = template.split('{{username}}');
  const strings = Object.assign([...parts], { raw: [...parts] }) as unknown as TemplateStringsArray;
  return escapeFilter(strings, ...parts.slice(1).map(() => username));
}

/** A DN in the form groups are compared by: lower case, no spaces around , and =. */
export function normalizeDn(dn: string): string {
  return dn.trim().toLowerCase().replace(/\s*([,=+])\s*/g, '$1');
}

/** RFC 4515-escaped group filter: {{dn}} is the user's DN, {{username}} the sign-in name. */
export function buildGroupFilter(template: string, dn: string, username: string): string {
  const pieces = template.split(/(\{\{dn\}\}|\{\{username\}\})/);
  const strings = pieces.filter((_, i) => i % 2 === 0);
  const values = pieces.filter((_, i) => i % 2 === 1).map((p) => (p === '{{dn}}' ? dn : username));
  const raw = Object.assign([...strings], { raw: [...strings] }) as unknown as TemplateStringsArray;
  return escapeFilter(raw, ...values);
}

/** trim, NFKC, case-fold; DOMAIN\user and user@domain → user when stripping. Null if unusable. */
export function normalizeUsername(raw: string, stripDomain: boolean): string | null {
  let u = raw.normalize('NFKC').trim();
  if (stripDomain) {
    const backslash = u.lastIndexOf('\\');
    if (backslash >= 0) u = u.slice(backslash + 1);
    const at = u.indexOf('@');
    if (at >= 0) u = u.slice(0, at);
  }
  u = u.trim().toLowerCase();
  // eslint-disable-next-line no-control-regex
  if (!u || u.length > 256 || /[\u0000-\u001f\u007f]/.test(u)) return null;
  return u;
}

function firstValue(entry: Entry, attribute: string): string | null {
  const key = Object.keys(entry).find((k) => k.toLowerCase() === attribute.toLowerCase());
  const v = key ? entry[key] : undefined;
  const first = Array.isArray(v) ? v[0] : v;
  if (first === undefined || first === null) return null;
  return Buffer.isBuffer(first) ? first.toString('utf-8') : String(first);
}

function allValues(entry: Entry, attribute: string): string[] {
  const key = Object.keys(entry).find((k) => k.toLowerCase() === attribute.toLowerCase());
  const v = key ? entry[key] : undefined;
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return list.map((x) => (Buffer.isBuffer(x) ? x.toString('utf-8') : String(x)));
}

function bufferValue(entry: Entry, attribute: string): Buffer | null {
  const key = Object.keys(entry).find((k) => k.toLowerCase() === attribute.toLowerCase());
  const v = key ? entry[key] : undefined;
  const first = Array.isArray(v) ? v[0] : v;
  return Buffer.isBuffer(first) && first.length > 0 ? first : null;
}

/**
 * Direct bind: the name to bind as, and the account it signs in to
 * (user@domain, lower case). A name with a domain binds as typed; DOMAIN\user
 * binds as typed but is the same account as user@domain. Null if unusable.
 */
export function directBindName(raw: string, domain: string): { bindName: string; account: string } | null {
  const typed = raw.normalize('NFKC').trim();
  // eslint-disable-next-line no-control-regex
  if (!typed || typed.length > 256 || /[\u0000-\u001f\u007f]/.test(typed)) return null;
  const at = typed.indexOf('@');
  if (at > 0 && at < typed.length - 1) return { bindName: typed, account: typed.toLowerCase() };
  if (at >= 0) return null;
  const user = typed.slice(typed.lastIndexOf('\\') + 1).trim().toLowerCase();
  if (!user) return null;
  return { bindName: typed.includes('\\') ? typed : `${user}@${domain}`, account: `${user}@${domain}` };
}

/** The stable id we link accounts by: entryUUID (OpenLDAP), objectGUID (AD), else the DN. */
export function subjectOf(entry: Entry): string {
  const guid = bufferValue(entry, 'objectGUID');
  if (guid) return `guid:${guid.toString('hex')}`;
  const uuid = firstValue(entry, 'entryUUID');
  if (uuid) return `uuid:${uuid.toLowerCase()}`;
  return `dn:${entry.dn.toLowerCase()}`;
}

/** AD's "account disabled" flag (userAccountControl bit 2). */
function adDisabled(entry: Entry): boolean {
  const uac = Number(firstValue(entry, 'userAccountControl') ?? 0);
  return Number.isFinite(uac) && (uac & 2) === 2;
}

class LdapUnavailableError extends Error {}

export class LdapService {
  constructor(
    private readonly deps: { db: Database; secrets: SecretBox; config: AppConfig; log: FastifyBaseLogger }
  ) {}

  // ─── Settings ──────────────────────────────────────────────────────────────

  private async stored(): Promise<Stored> {
    const [row] = await this.deps.db.select().from(appConfig).where(eq(appConfig.key, SETTINGS_KEY));
    const value = (row?.value ?? {}) as Partial<Stored>;
    return { settings: value.settings ?? {}, bindPasswordCipher: value.bindPasswordCipher ?? null };
  }

  /** Values from environment variables (they win and are read-only in the UI). */
  private envOverrides(): Partial<EffectiveLdap> {
    const c = this.deps.config;
    const out: Partial<EffectiveLdap> = {};
    if (c.ENABLE_LDAP !== undefined) out.enabled = c.ENABLE_LDAP;
    if (c.LDAP_URL) out.url = c.LDAP_URL;
    if (c.LDAP_START_TLS !== undefined) out.startTls = c.LDAP_START_TLS;
    if (c.LDAP_BIND_MODE) out.bindMode = c.LDAP_BIND_MODE;
    if (c.LDAP_BIND_DN !== undefined) out.bindDn = c.LDAP_BIND_DN;
    if (c.LDAP_BIND_PASSWORD !== undefined) out.bindPassword = c.LDAP_BIND_PASSWORD;
    if (c.LDAP_USER_SEARCH_BASE) out.userSearchBase = c.LDAP_USER_SEARCH_BASE;
    if (c.LDAP_USER_FILTER) out.userFilter = c.LDAP_USER_FILTER;
    if (c.LDAP_CA_CERT_FILE) out.caCert = fs.readFileSync(c.LDAP_CA_CERT_FILE, 'utf-8');
    return out;
  }

  async effective(): Promise<EffectiveLdap> {
    const stored = await this.stored();
    const parsed = LdapSettings.safeParse({ ...LDAP_DEFAULTS, ...stored.settings });
    const base = parsed.success ? parsed.data : LDAP_DEFAULTS;
    const bindPassword = stored.bindPasswordCipher ? this.deps.secrets.decrypt(stored.bindPasswordCipher) : '';
    return { ...base, bindPassword, ...this.envOverrides() };
  }

  /** Enabled and complete enough to try a sign-in. */
  async isActive(): Promise<boolean> {
    const s = await this.effective();
    return s.enabled && !!s.url && !!s.userSearchBase && (s.bindMode !== 'direct' || !!bindDomain(s.userSearchBase));
  }

  async view(): Promise<LdapSettingsResponse> {
    const { bindPassword, ...settings } = await this.effective();
    const env = this.envOverrides();
    return {
      settings,
      hasBindPassword: !!bindPassword,
      locked: Object.keys(env) as LdapSettingsResponse['locked'],
    };
  }

  async update(patch: LdapSettingsUpdate): Promise<LdapSettingsResponse> {
    const stored = await this.stored();
    const { bindPassword, ...fields } = patch;
    const settings = LdapSettings.parse({ ...LDAP_DEFAULTS, ...stored.settings, ...fields });
    const { bindMode, userSearchBase } = { ...settings, ...this.envOverrides() };
    if (bindMode === 'direct' && userSearchBase && !bindDomain(userSearchBase)) {
      throw badRequest('For a direct bind the base DN needs dc= parts (dc=example,dc=com), which make the sign-in domain.', 'ldap_no_domain');
    }
    const bindPasswordCipher =
      bindPassword === undefined ? stored.bindPasswordCipher : bindPassword === '' ? null : this.deps.secrets.encrypt(bindPassword);
    const value: Stored = { settings, bindPasswordCipher };
    await this.deps.db
      .insert(appConfig)
      .values({ key: SETTINGS_KEY, value })
      .onConflictDoUpdate({ target: appConfig.key, set: { value, updatedAt: new Date() } });
    return this.view();
  }

  // ─── Directory access ──────────────────────────────────────────────────────

  private tlsOptions(s: EffectiveLdap): ConnectionOptions {
    return {
      rejectUnauthorized: s.tlsVerify,
      ...(s.caCert ? { ca: [s.caCert] } : {}),
      minVersion: 'TLSv1.2',
    };
  }

  /**
   * A new client; StartTLS done when configured. (ldapts speaks TLS whenever
   * tlsOptions are given, so they're only passed for ldaps:// URLs.)
   */
  private async connect(s: EffectiveLdap): Promise<Client> {
    const ldaps = s.url.toLowerCase().startsWith('ldaps://');
    const client = new Client({
      url: s.url,
      timeout: s.timeoutMs,
      connectTimeout: s.timeoutMs,
      ...(ldaps ? { tlsOptions: this.tlsOptions(s) } : {}),
    });
    if (s.startTls && !ldaps) {
      try {
        await client.startTLS(this.tlsOptions(s));
      } catch (err) {
        await client.unbind().catch(() => {});
        throw err;
      }
    }
    return client;
  }

  /**
   * A client that has talked to the server (ldapts connects lazily): it reads
   * the root DSE, which needs no sign-in; any LDAP answer means it's there.
   */
  private async reach(s: EffectiveLdap): Promise<Client> {
    const client = await this.connect(s);
    try {
      await client.search('', { scope: 'base', filter: '(objectClass=*)', attributes: ['namingContexts'] });
    } catch (err) {
      if (!(err instanceof ResultCodeError)) {
        await client.unbind().catch(() => {});
        throw new LdapUnavailableError(`Can't reach the directory: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return client;
  }

  /** A connected client bound as the service account. */
  private async serviceClient(s: EffectiveLdap): Promise<Client> {
    let client: Client | null = null;
    try {
      client = await this.connect(s);
      if (s.bindDn) {
        // An empty service password would be an anonymous bind in disguise
        if (!s.bindPassword) throw new LdapUnavailableError('The service account has no password set.');
        await client.bind(s.bindDn, s.bindPassword);
      }
      return client;
    } catch (err) {
      await client?.unbind().catch(() => {});
      if (err instanceof LdapUnavailableError) throw err;
      throw new LdapUnavailableError(
        err instanceof InvalidCredentialsError
          ? 'The service account was refused (check the bind DN and password).'
          : `Can't reach the directory: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private attributes(s: EffectiveLdap): string[] {
    return [s.emailAttribute, s.nameAttribute, 'entryUUID', 'objectGUID', 'userAccountControl', 'memberOf'];
  }

  /** Entries matching the user filter (max 2: we only care whether it's exactly one). */
  private async findUser(client: Client, s: EffectiveLdap, username: string): Promise<Entry[]> {
    let filter = buildUserFilter(s.userFilter, username);
    if (s.allowedGroupDn) filter = `(&${filter}${escapeFilter`(memberOf=${s.allowedGroupDn})`})`;
    try {
      const { searchEntries } = await client.search(s.userSearchBase, {
        scope: 'sub',
        filter,
        attributes: this.attributes(s),
        explicitBufferAttributes: ['objectGUID'],
        sizeLimit: 2,
      });
      return searchEntries;
    } catch (err) {
      // More than sizeLimit matches: ambiguous, which is as good as none
      if ((err as Error).name === 'SizeLimitExceededError') return [{ dn: '' }, { dn: '' }] as Entry[];
      throw err;
    }
  }

  async testConnection(): Promise<LdapTestResult> {
    const s = await this.effective();
    if (!s.url) return { ok: false, error: 'Set the server URL first.' };
    try {
      // Direct bind has no service account: reaching the server (and StartTLS) is all there is to test
      const client = s.bindMode === 'direct' ? await this.reach(s) : await this.serviceClient(s);
      await client.unbind().catch(() => {});
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** "Test user lookup": what sign-in would find for this username (no password involved). */
  async lookup(rawUsername: string): Promise<LdapLookupResult> {
    const s = await this.effective();
    if (s.bindMode === 'direct') {
      return { matches: 0, entry: null, error: 'With a direct bind users are only checked with their password, at sign-in.' };
    }
    const username = normalizeUsername(rawUsername, s.stripDomain);
    if (!username) return { matches: 0, entry: null, error: 'Enter a username.' };
    let client: Client | null = null;
    try {
      client = await this.serviceClient(s);
      const entries = await this.findUser(client, s, username);
      const entry = entries.length === 1 ? entries[0] : null;
      return {
        matches: entries.length,
        entry: entry
          ? {
              dn: entry.dn,
              email: firstValue(entry, s.emailAttribute),
              name: firstValue(entry, s.nameAttribute),
              subject: subjectOf(entry),
            }
          : null,
        error: null,
      };
    } catch (err) {
      return { matches: 0, entry: null, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await client?.unbind().catch(() => {});
    }
  }

  // ─── Sign-in ───────────────────────────────────────────────────────────────

  async login(rawUsername: string, password: string): Promise<LdapLoginResult> {
    const s = await this.effective();
    if (!s.enabled || !s.url || !s.userSearchBase) return { ok: false, reason: 'disabled' };
    // 1. Never bind with an empty password
    if (password.length === 0) return { ok: false, reason: 'invalid_credentials' };
    if (s.bindMode === 'direct') return this.loginDirect(s, rawUsername, password);
    // 2.
    const username = normalizeUsername(rawUsername, s.stripDomain);
    if (!username) return { ok: false, reason: 'invalid_credentials' };

    let service: Client | null = null;
    let entry: Entry;
    try {
      // 3.
      service = await this.serviceClient(s);
      const entries = await this.findUser(service, s, username);
      if (entries.length !== 1 || !entries[0].dn) return { ok: false, reason: 'invalid_credentials' };
      entry = entries[0];
      if (adDisabled(entry)) return { ok: false, reason: 'invalid_credentials' };
    } catch (err) {
      this.deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'LDAP search failed');
      return { ok: false, reason: 'unavailable', message: err instanceof Error ? err.message : undefined };
    } finally {
      await service?.unbind().catch(() => {});
    }

    // 4.
    const refused = await this.userBind(s, entry.dn, password);
    if (refused) return refused;

    // 5.
    const result = await this.linkOrCreate(s, {
      subject: subjectOf(entry),
      name: firstValue(entry, s.nameAttribute) ?? username,
      mail: firstValue(entry, s.emailAttribute),
      username,
    });
    if (result.ok && s.groupSync) await this.syncGroups(s, entry, username, result.userId);
    return result;
  }

  /** Direct bind: the password is checked by binding as user@domain; nothing is searched. */
  private async loginDirect(s: EffectiveLdap, rawUsername: string, password: string): Promise<LdapLoginResult> {
    const domain = bindDomain(s.userSearchBase);
    if (!domain) return { ok: false, reason: 'disabled' };
    const name = directBindName(rawUsername, domain);
    if (!name) return { ok: false, reason: 'invalid_credentials' };
    const refused = await this.userBind(s, name.bindName, password);
    if (refused) return refused;
    const username = name.account.slice(0, name.account.indexOf('@'));
    return this.linkOrCreate(s, { subject: `upn:${name.account}`, name: username, mail: name.account, username });
  }

  /** Binds as the user on a fresh connection: null when the directory took the password. */
  private async userBind(s: EffectiveLdap, bindName: string, password: string): Promise<LdapLoginResult | null> {
    let client: Client | null = null;
    try {
      client = await this.connect(s);
      await client.bind(bindName, password);
      return null;
    } catch (err) {
      if (err instanceof InvalidCredentialsError) return { ok: false, reason: 'invalid_credentials' };
      this.deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'LDAP user bind failed');
      return { ok: false, reason: 'unavailable' };
    } finally {
      await client?.unbind().catch(() => {});
    }
  }

  // ─── Group sync ────────────────────────────────────────────────────────────

  /** The user's directory groups (normalized DNs), or null when the directory couldn't say. */
  private async directoryGroups(s: EffectiveLdap, entry: Entry, username: string): Promise<Set<string> | null> {
    if (s.groupMode === 'memberOf') return new Set(allValues(entry, 'memberOf').map(normalizeDn));
    if (!s.groupSearchBase) return null;
    let client: Client | null = null;
    try {
      client = await this.serviceClient(s);
      const { searchEntries } = await client.search(s.groupSearchBase, {
        scope: 'sub',
        filter: buildGroupFilter(s.groupFilter, entry.dn, username),
        attributes: ['dn'],
        paged: { pageSize: 200 },
        sizeLimit: 2000,
      });
      return new Set(searchEntries.map((e) => normalizeDn(e.dn)));
    } catch (err) {
      this.deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'LDAP group search failed; memberships kept');
      return null;
    } finally {
      await client?.unbind().catch(() => {});
    }
  }

  /**
   * Make the user's directory-sourced memberships match their directory
   * groups (manual memberships stay), and — when an admin group is set —
   * their admin role too. The last admin is never demoted.
   */
  async syncGroups(s: EffectiveLdap, entry: Entry, username: string, userId: string): Promise<void> {
    const dns = await this.directoryGroups(s, entry, username);
    if (!dns) return;
    const linked = await this.deps.db
      .select({ id: groups.id, ldapDn: groups.ldapDn })
      .from(groups)
      .where(isNotNull(groups.ldapDn));
    const wanted = linked.filter((g) => dns.has(g.ldapDn!)).map((g) => g.id);
    await this.deps.db.transaction(async (tx) => {
      await tx
        .delete(groupMembers)
        .where(
          and(
            eq(groupMembers.userId, userId),
            eq(groupMembers.source, 'ldap'),
            wanted.length ? notInArray(groupMembers.groupId, wanted) : undefined
          )
        );
      if (wanted.length > 0) {
        await tx
          .insert(groupMembers)
          .values(wanted.map((groupId) => ({ groupId, userId, source: 'ldap' as const })))
          .onConflictDoNothing();
      }
      if (!s.adminGroupDn) return;
      const isAdmin = dns.has(normalizeDn(s.adminGroupDn));
      const [user] = await tx.select({ role: users.role }).from(users).where(eq(users.id, userId));
      if (isAdmin && user?.role !== 'admin') {
        await tx.update(users).set({ role: 'admin', updatedAt: new Date() }).where(eq(users.id, userId));
      } else if (!isAdmin && user?.role === 'admin') {
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(users)
          .where(and(eq(users.role, 'admin'), ne(users.id, userId)));
        if (Number(n) > 0) await tx.update(users).set({ role: 'user', updatedAt: new Date() }).where(eq(users.id, userId));
      }
    });
    this.deps.log.info({ userId, groups: wanted.length }, 'LDAP groups synced');
  }

  private async linkOrCreate(
    s: EffectiveLdap,
    profile: { subject: string; name: string; mail: string | null; username: string }
  ): Promise<LdapLoginResult> {
    const { subject, username } = profile;
    const name = profile.name.trim().slice(0, 100) || username;
    const mail = profile.mail?.trim().toLowerCase() || null;

    return this.deps.db.transaction(async (tx) => {
      const [linked] = await tx
        .select({ userId: authIdentities.userId })
        .from(authIdentities)
        .where(and(eq(authIdentities.provider, 'ldap'), eq(authIdentities.subject, subject)));
      if (linked) {
        // Keep the name current; take a changed email only if nobody else has it
        const patch: Partial<typeof users.$inferInsert> = { name, updatedAt: new Date() };
        if (mail) {
          const [other] = await tx.select({ id: users.id }).from(users).where(eq(users.email, mail));
          if (!other || other.id === linked.userId) patch.email = mail;
        }
        await tx.update(users).set(patch).where(eq(users.id, linked.userId));
        return { ok: true as const, userId: linked.userId, created: false };
      }

      // A placeholder address keeps emails unique for entries without one
      const email = mail ?? `${username}@ldap.invalid`;
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (existing) {
        return {
          ok: false as const,
          reason: 'email_conflict' as const,
          message: 'An account with this email already exists. Ask an administrator to link it to your directory login.',
        };
      }
      const id = uuidv7();
      // Never admin on a first directory login, even on an empty install
      await tx.insert(users).values({ id, email, name, passwordHash: null, role: s.defaultRole });
      await tx.insert(authIdentities).values({ userId: id, provider: 'ldap', subject });
      this.deps.log.info({ userId: id, subject }, 'LDAP account created');
      return { ok: true as const, userId: id, created: true };
    });
  }

  // ─── Re-checking signed-in users ───────────────────────────────────────────

  /** Is this user still in the directory (and allowed)? */
  async verifyUser(userId: string): Promise<LdapVerifyResult> {
    const [identity] = await this.deps.db
      .select({ subject: authIdentities.subject })
      .from(authIdentities)
      .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, 'ldap')));
    if (!identity) return 'not_ldap';
    const s = await this.effective();
    if (!s.enabled || !s.url) return 'unavailable';
    // A direct bind has no account to search with: the directory decides at the next sign-in
    if (s.bindMode === 'direct') return 'active';

    const [kind, ...rest] = identity.subject.split(':');
    const value = rest.join(':');
    let base = s.userSearchBase;
    let scope: 'sub' | 'base' = 'sub';
    let filter: string;
    if (kind === 'guid') filter = escapeFilter`(objectGUID=${Buffer.from(value, 'hex')})`;
    else if (kind === 'uuid') filter = escapeFilter`(entryUUID=${value})`;
    // Linked by a direct bind, checked since the switch to search
    else if (kind === 'upn') filter = escapeFilter`(userPrincipalName=${value})`;
    else {
      base = value;
      scope = 'base';
      filter = '(objectClass=*)';
    }
    if (s.allowedGroupDn) filter = `(&${filter}${escapeFilter`(memberOf=${s.allowedGroupDn})`})`;

    let client: Client | null = null;
    try {
      client = await this.serviceClient(s);
      const { searchEntries } = await client.search(base, {
        scope,
        filter,
        attributes: this.attributes(s),
        explicitBufferAttributes: ['objectGUID'],
        sizeLimit: 2,
      });
      if (searchEntries.length !== 1 || adDisabled(searchEntries[0])) return 'gone';
      return 'active';
    } catch (err) {
      if ((err as Error).name === 'NoSuchObjectError') return 'gone';
      this.deps.log.warn({ userId, err: err instanceof Error ? err.message : String(err) }, 'LDAP re-check failed');
      return 'unavailable';
    } finally {
      await client?.unbind().catch(() => {});
    }
  }
}
