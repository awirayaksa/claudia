import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { MessagePart, MessageStatus } from '../../../../src/types/turn.types';
import type { MessageUsage } from '../../../../src/types/statistics.types';
import { users } from './identity';

/** Desktop projects import as top-level folders. */
export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => folders.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    systemPrompt: text('system_prompt'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('folders_user_idx').on(t.userId)]
);

/** Per-chat request parameters (Phase 2 exposes them in the UI). */
export interface ChatParams {
  temperature?: number;
  systemPrompt?: string;
}

export const chats = pgTable(
  'chats',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    folderId: uuid('folder_id').references(() => folders.id, { onDelete: 'set null' }),
    title: text('title').notNull().default('New chat'),
    /** True once the title came from the model or the user (no more automatic titles). */
    titleSet: boolean('title_set').notNull().default(false),
    modelIds: jsonb('model_ids').$type<string[]>().notNull().default([]),
    /** The visible path ends here. */
    currentLeafId: uuid('current_leaf_id'),
    params: jsonb('params').$type<ChatParams>().notNull().default({}),
    pinned: boolean('pinned').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    temporary: boolean('temporary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chats_user_updated_idx').on(t.userId, t.updatedAt), index('chats_folder_idx').on(t.folderId)]
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    /** Siblings (same parent) are alternatives: regenerations, multi-model answers, edits. */
    parentId: uuid('parent_id'),
    role: text('role').$type<'user' | 'assistant' | 'system'>().notNull(),
    parts: jsonb('parts').$type<MessagePart[]>().notNull().default([]),
    modelId: text('model_id'),
    usage: jsonb('usage').$type<MessageUsage>(),
    effort: text('effort'),
    status: text('status').$type<MessageStatus>().notNull().default('completed'),
    error: text('error'),
    rating: smallint('rating'),
    feedback: jsonb('feedback'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_chat_idx').on(t.chatId), index('messages_parent_idx').on(t.parentId)]
);

/** One row per model call, for analytics and (Phase 3) caps. */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id'),
    modelId: text('model_id').notNull(),
    connectionId: uuid('connection_id'),
    /** 'chat' | 'title' | ... */
    kind: text('kind').notNull().default('chat'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    cost: doublePrecision('cost'),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('usage_events_user_created_idx').on(t.userId, t.createdAt)]
);
