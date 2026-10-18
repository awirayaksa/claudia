import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { MessageNode, MessagePart, MessageStatus } from '../../../../src/types/turn.types';
import type { MessageUsage } from '../../../../src/types/statistics.types';
import { users } from './identity';
import type { MessageRef } from '../../../shared/knowledge';

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
    /** Knowledge bases searched for every chat in the folder (and its subfolders). */
    knowledgeIds: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('folders_user_idx').on(t.userId)]
);

/** Per-chat request parameters; unset ones fall back to the user's preferences. */
export interface ChatParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  systemPrompt?: string;
}

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/** What a node carries besides its parts. */
export interface MessageMeta {
  /** User nodes: the models asked at once (more than one → shown side by side). */
  models?: string[];
  /** User nodes: the `/skill` invoked, so a regeneration uses it again. */
  skill?: { id: string; args: string };
  /** Assistant nodes: suggested next questions. */
  followUps?: string[];
  /** User nodes: #kb, #url and #chat references, and whether the web was searched. */
  refs?: MessageRef[];
  webSearch?: boolean;
  /** User nodes: the code interpreter was offered. */
  code?: boolean;
  /** User nodes: image generation was offered. */
  imageGen?: boolean;
  /** User nodes of a blind comparison: the real models (A, B) and the vote. */
  arena?: { models: [string, string]; winner?: 'a' | 'b' | 'tie' };
}

export interface MessageFeedback {
  comment?: string;
  reasons?: string[];
  at: string;
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
    /** Not listed, never titled, deleted after a day without activity (unless kept). */
    temporary: boolean('temporary').notNull().default(false),
    /** Lower-case labels, filtered with `@>`. */
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('chats_user_updated_idx').on(t.userId, t.updatedAt),
    index('chats_folder_idx').on(t.folderId),
    index('chats_tags_idx').using('gin', t.tags),
  ]
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
    feedback: jsonb('feedback').$type<MessageFeedback>(),
    meta: jsonb('meta').$type<MessageMeta>().notNull().default({}),
    /**
     * Full-text index of the text parts. 'simple' (no stemming) because chats
     * are in any language; claudia_parts_text is created by the migration.
     */
    search: tsvector('search').generatedAlwaysAs(sql`to_tsvector('simple'::regconfig, claudia_parts_text(parts))`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_chat_idx').on(t.chatId),
    index('messages_parent_idx').on(t.parentId),
    index('messages_search_idx').using('gin', t.search),
  ]
);

/**
 * Share links: a snapshot of the visible path when shared (re-sharing
 * refreshes it). Anyone with the token can read it; deleting the row
 * revokes the link.
 */
export const shares = pgTable(
  'shares',
  {
    id: uuid('id').primaryKey(),
    token: text('token').notNull(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    snapshot: jsonb('snapshot').$type<MessageNode[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('shares_token_idx').on(t.token), uniqueIndex('shares_chat_idx').on(t.chatId)]
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
  (t) => [index('usage_events_user_created_idx').on(t.userId, t.createdAt), index('usage_events_created_idx').on(t.createdAt)]
);
