import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** One operation of an OpenAPI tool server, as a tool. */
export interface OpenApiOperation {
  /** Tool name (sanitized operationId). */
  name: string;
  description: string;
  method: string;
  path: string;
  /** JSON Schema of the tool's arguments: path/query/header params and `body`. */
  inputSchema: Record<string, unknown>;
  params: Array<{ name: string; in: 'path' | 'query' | 'header' }>;
  hasBody: boolean;
}

/**
 * OpenAPI tool servers (admin-managed): each operation of the spec becomes a
 * tool; calls go to the server's base URL with its auth header.
 */
export const toolServers = pgTable('tool_servers', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  /** Where the spec was loaded from (null: pasted). */
  specUrl: text('spec_url'),
  /** Calls go here (the spec's first server, resolved, unless set). */
  baseUrl: text('base_url').notNull(),
  operations: jsonb('operations').$type<OpenApiOperation[]>().notNull().default([]),
  /** Encrypted {header, value} sent with every call. */
  authCipher: text('auth_cipher'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export interface PluginManifestRow {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  type: 'renderer-extension' | 'renderer-replacement';
  renderer?: { priority?: number; allowFallback?: boolean };
  settingsSchema?: Record<string, unknown>;
}

/** Admin-installed ESM plugins (served from /plugins/:id/:version/index.mjs). */
export const plugins = pgTable('plugins', {
  id: text('id').primaryKey(),
  version: text('version').notNull(),
  manifest: jsonb('manifest').$type<PluginManifestRow>().notNull(),
  bundleKey: text('bundle_key').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
