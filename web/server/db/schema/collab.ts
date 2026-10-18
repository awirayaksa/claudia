import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { chats, messages } from './chats';

/** Markdown notes; private until shared (access_grants, resource type "note"). */
export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    content: text('content').notNull().default(''),
    pinned: boolean('pinned').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notes_owner_updated_idx').on(t.ownerId, t.updatedAt)]
);

/**
 * Rooms where people talk to each other and, with @model, to a model.
 * Admins create them; members come from access_grants (resource type
 * "channel": read = read and post, write = manage) or everyone when public.
 */
export const channels = pgTable('channels', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  archived: boolean('archived').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const channelMessages = pgTable(
  'channel_messages',
  {
    id: uuid('id').primaryKey(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /** The author; null for a model's reply. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** The model that wrote it (replies to @model). */
    modelId: text('model_id'),
    /** The message a model reply answers. */
    replyToId: uuid('reply_to_id'),
    content: text('content').notNull(),
    /** 'done' | 'streaming' | 'error' */
    status: text('status').$type<'done' | 'streaming' | 'error'>().notNull().default('done'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('channel_messages_channel_created_idx').on(t.channelId, t.createdAt)]
);

/** A prompt run on a schedule (cron in the user's time zone); replies land in a chat. */
export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prompt: text('prompt').notNull(),
    modelId: text('model_id').notNull(),
    /** Five-field cron, e.g. "0 8 * * 1-5". */
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    /** 'new': a new chat each run; 'same': the next turn of one chat. */
    chatMode: text('chat_mode').$type<'new' | 'same'>().notNull().default('new'),
    chatId: uuid('chat_id').references(() => chats.id, { onDelete: 'set null' }),
    toolIds: jsonb('tool_ids').$type<string[]>().notNull().default([]),
    webSearch: boolean('web_search').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastStatus: text('last_status'),
    lastError: text('last_error'),
    lastChatId: uuid('last_chat_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('schedules_due_idx').on(t.enabled, t.nextRunAt), index('schedules_owner_idx').on(t.ownerId)]
);

/** One blind comparison: two models answered a turn; the user picked one (or a tie). */
export const arenaVotes = pgTable(
  'arena_votes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id').references(() => chats.id, { onDelete: 'set null' }),
    /** The user turn both replies answer. */
    userMessageId: uuid('user_message_id').references(() => messages.id, { onDelete: 'set null' }),
    modelA: text('model_a').notNull(),
    modelB: text('model_b').notNull(),
    winner: text('winner').$type<'a' | 'b' | 'tie'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('arena_votes_turn_unique').on(t.userMessageId), index('arena_votes_created_idx').on(t.createdAt)]
);
