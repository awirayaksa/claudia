import { boolean, index, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';

export type McpTransport = 'stdio' | 'streamable-http' | 'sse';

/**
 * Configured MCP servers. owner_id null = global (admin). The connection
 * details (command, args, env, url, headers) are one encrypted JSON blob,
 * since env values and headers often hold tokens.
 */
export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    transport: text('transport').$type<McpTransport>().notNull(),
    configCipher: text('config_cipher').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mcp_servers_owner_idx').on(t.ownerId)]
);

/**
 * OAuth sign-in to a remote MCP server (MCP authorization: discovery,
 * dynamic client registration, PKCE). One per server: a user's own server
 * signs in as its owner; a global one as the admin who connected it, for
 * everyone. The client registration, tokens and PKCE verifier are one
 * encrypted JSON blob.
 */
export const mcpOAuth = pgTable(
  'mcp_oauth',
  {
    serverId: uuid('server_id')
      .primaryKey()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    /** Who signed in (and who may finish a pending sign-in). */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    cipher: text('cipher').notNull(),
    /** The `state` of a sign-in in progress, matched by the callback. */
    pendingState: text('pending_state'),
    pendingExpiresAt: timestamp('pending_expires_at', { withTimezone: true }),
    /** Set once tokens were received; null while waiting for the first sign-in. */
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('mcp_oauth_state_idx').on(t.pendingState)]
);

/** Skills and (Phase 3) the prompt library. owner_id null = built-in / global. */
export const prompts = pgTable(
  'prompts',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    /** What follows the slash: "/summarize". */
    command: text('command').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    body: text('body').notNull(),
    variables: jsonb('variables').$type<Array<{ name: string; label?: string; default?: string }>>().notNull().default([]),
    /** 'system': a skill, sent as a system prompt; 'insert': text put into the input (Phase 3). */
    mode: text('mode').$type<'system' | 'insert'>().notNull().default('system'),
    builtin: boolean('builtin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('prompts_owner_command_unique').on(t.ownerId, t.command).nullsNotDistinct()]
);
