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
 */
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { Client, InvalidCredentialsError, escapeFilter, type Entry } from 'ldapts';
import type { ConnectionOptions } from 'node:tls';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config';
import type { Database } from '../db/client';
import { appConfig, authIdentities, users } from '../db/schema';
import type { SecretBox } from '../crypto/secrets';
import { uuidv7 } from '../lib/ids';
import {
  LdapSettings,
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

function bufferValue(entry: Entry, attribute: string): Buffer | null {
  const key = Object.keys(entry).find((k) => k.toLowerCase() === attribute.toLowerCase());
  const v = key ? entry[key] : undefined;
  const first = Array.isArray(v) ? v[0] : v;
  return Buffer.isBuffer(first) && first.length > 0 ? first : null;
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
    return s.enabled && !!s.url && !!s.userSearchBase;
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
    return [s.emailAttribute, s.nameAttribute, 'entryUUID', 'objectGUID', 'userAccountControl'];
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
      const client = await this.serviceClient(s);
      await client.unbind().catch(() => {});
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** "Test user lookup": what sign-in would find for this username (no password involved). */
  async lookup(rawUsername: string): Promise<LdapLookupResult> {
    const s = await this.effective();
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

    // 4. Bind as the user on a fresh connection
    let userClient: Client | null = null;
    try {
      userClient = await this.connect(s);
      await userClient.bind(entry.dn, password);
    } catch (err) {
      if (err instanceof InvalidCredentialsError) return { ok: false, reason: 'invalid_credentials' };
      this.deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'LDAP user bind failed');
      return { ok: false, reason: 'unavailable' };
    } finally {
      await userClient?.unbind().catch(() => {});
    }

    // 5.
    return this.linkOrCreate(s, entry, username);
  }

  private async linkOrCreate(s: EffectiveLdap, entry: Entry, username: string): Promise<LdapLoginResult> {
    const subject = subjectOf(entry);
    const name = (firstValue(entry, s.nameAttribute) ?? username).trim().slice(0, 100) || username;
    const mail = firstValue(entry, s.emailAttribute)?.trim().toLowerCase() || null;

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

    const [kind, ...rest] = identity.subject.split(':');
    const value = rest.join(':');
    let base = s.userSearchBase;
    let scope: 'sub' | 'base' = 'sub';
    let filter: string;
    if (kind === 'guid') filter = escapeFilter`(objectGUID=${Buffer.from(value, 'hex')})`;
    else if (kind === 'uuid') filter = escapeFilter`(entryUUID=${value})`;
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
