import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export type UserRole = 'admin' | 'user' | 'pending';

/** Per-user preferences and appearance (the desktop `settings` slice, minus API config). */
export interface UserSettings {
  appearance?: Record<string, unknown>;
  preferences?: Record<string, unknown>;
  /** Last model the user picked, used for new chats. */
  defaultModel?: string;
  /** Tool servers this user switched on or off (default: global on, built-ins off). */
  mcp?: { enabled: Record<string, boolean> };
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
    /** Stable id at the provider (LDAP objectGUID / entryUUID, OIDC sub). */
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
