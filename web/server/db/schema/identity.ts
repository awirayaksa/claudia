import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { UserCaps } from '../../../shared/access';

export type UserRole = 'admin' | 'user' | 'pending';

/** Per-user preferences and appearance (the desktop `settings` slice, minus API config). */
export interface UserSettings {
  appearance?: Record<string, unknown>;
  preferences?: Record<string, unknown>;
  /** Last model the user picked, used for new chats. */
  defaultModel?: string;
  /** Tool servers this user switched on or off (default: global on, built-ins off). */
  mcp?: { enabled: Record<string, boolean> };
  /** Saved memories are added to every chat (default on). */
  memory?: { enabled: boolean };
}

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    /** Always stored lower-cased. */
    email: text('email').notNull(),
    name: text('name').notNull(),
    /** argon2id; null for directory (LDAP) users. */
    passwordHash: text('password_hash'),
    role: text('role').$type<UserRole>().notNull().default('pending'),
    settings: jsonb('settings').$type<UserSettings>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    /** Admin override of the usage caps; null = defaults and groups. */
    caps: jsonb('caps').$type<UserCaps>(),
    /** Set: the account can't sign in and its sessions and keys stop working (SCIM active=false, or an admin). */
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    /** The identity provider's id for this user (SCIM externalId). */
    externalId: text('external_id'),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email), index('users_role_idx').on(t.role)]
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 of the current refresh secret. */
    refreshHash: text('refresh_hash').notNull(),
    /** The previous secret, accepted briefly so two tabs refreshing at once don't log each other out. */
    prevRefreshHash: text('prev_refresh_hash'),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    userAgent: text('ua'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Last time the user was re-checked with their identity provider (LDAP deprovisioning). */
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  },
  (t) => [index('sessions_user_idx').on(t.userId)]
);

export const authIdentities = pgTable(
  'auth_identities',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<'local' | 'ldap' | 'oidc'>().notNull(),
    /** Stable id at the provider (LDAP objectGUID / entryUUID; OIDC "<provider id>:<sub>"). */
    subject: text('subject').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.subject] }),
    index('auth_identities_user_idx').on(t.userId),
  ]
);

/** Sessions still usable: not revoked, not expired. */
export const activeSession = sql`${sessions.revokedAt} is null and ${sessions.expiresAt} > now()`;

/**
 * Time-based one-time passwords (RFC 6238). The secret is encrypted; a new
 * one waits in `pendingSecretCipher` until the user confirms a code from it.
 */
export const userMfa = pgTable('user_mfa', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secretCipher: text('secret_cipher'),
  pendingSecretCipher: text('pending_secret_cipher'),
  enabledAt: timestamp('enabled_at', { withTimezone: true }),
  /** The last 30-second step accepted: a code works once. */
  lastUsedStep: integer('last_used_step').notNull().default(0),
  /** sha256 of the unused recovery codes. */
  recoveryHashes: jsonb('recovery_hashes').$type<string[]>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** OpenID Connect sign-in providers (Entra ID, Google, Keycloak, Okta, Authentik…). */
export const ssoProviders = pgTable('sso_providers', {
  /** Slug used in the callback URL: /api/auth/oidc/<id>/callback. */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  issuer: text('issuer').notNull(),
  clientId: text('client_id').notNull(),
  clientSecretCipher: text('client_secret_cipher'),
  scopes: text('scopes').notNull().default('openid email profile'),
  enabled: boolean('enabled').notNull().default(true),
  /** Create accounts on first sign-in (else only existing or SCIM-provisioned ones). */
  allowSignup: boolean('allow_signup').notNull().default(true),
  defaultRole: text('default_role').$type<'pending' | 'user'>().notNull().default('pending'),
  /** Email domains allowed to sign in; empty = any. */
  allowedDomains: jsonb('allowed_domains').$type<string[]>().notNull().default([]),
  /** Sign an existing account with the same (verified) email into this provider. */
  linkByEmail: boolean('link_by_email').notNull().default(false),
  /** Claim with the user's groups (e.g. "groups"); members follow Claudia groups of the same name. */
  groupsClaim: text('groups_claim'),
  /** Values of the groups claim that make someone an admin. */
  adminGroups: jsonb('admin_groups').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A user's connected Google Drive / OneDrive account (tokens encrypted). */
export const cloudAccounts = pgTable(
  'cloud_accounts',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<'google' | 'microsoft'>().notNull(),
    accountEmail: text('account_email'),
    accessCipher: text('access_cipher').notNull(),
    refreshCipher: text('refresh_cipher'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.provider] })]
);
