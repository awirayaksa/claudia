import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
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
