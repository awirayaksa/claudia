import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';

export type ConnectionType = 'openai' | 'openrouter' | 'openwebui' | 'opencode-go' | 'anthropic' | 'ollama';

/** Provider-specific behaviour switches. */
export interface ConnectionQuirks {
  /** Offer tools only on the first request of a tool loop (Kimi via opencode-go). */
  toolsFirstTurnOnly?: boolean;
  /** opencode-go: which API the models speak. */
  apiCompatibility?: 'openai' | 'anthropic';
  /** OpenRouter dashboard attribution. */
  siteUrl?: string;
  siteName?: string;
  /**
   * Don't verify the endpoint's TLS certificate (self-signed or an internal
   * CA). Admin connections only; user-owned ones always verify.
   */
  insecureTls?: boolean;
}

/** A configured LLM endpoint. owner_id null = global (admin-managed). */
export const providerConnections = pgTable(
  'provider_connections',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Prefix of model keys from this connection ("<prefix>/<model id>"). */
    prefix: text('prefix').notNull(),
    type: text('type').$type<ConnectionType>().notNull(),
    baseUrl: text('base_url').notNull().default(''),
    /** AES-GCM ciphertext of the API key (crypto/secrets.ts). */
    keyCipher: text('key_cipher'),
    keyVersion: text('key_version'),
    quirks: jsonb('quirks').$type<ConnectionQuirks>().notNull().default({}),
    /**
     * Model ids to offer. null = everything the endpoint lists; a list is also
     * used as-is when the endpoint has no /models.
     */
    modelFilter: jsonb('model_filter').$type<string[] | null>(),
    enabled: boolean('enabled').notNull().default(true),
    /** Display order. */
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('provider_connections_owner_prefix_unique').on(t.ownerId, t.prefix).nullsNotDistinct(), index('provider_connections_owner_idx').on(t.ownerId)]
);
