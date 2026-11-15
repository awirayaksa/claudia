import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';

/**
 * Who did what: sign-ins, sign-outs, API keys and every change made through
 * the admin API. Kept for `audit.retentionDays`. The actor's email is copied
 * in, so entries stay readable after the account is deleted.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorEmail: text('actor_email'),
    /** e.g. "auth.login", "auth.login_failed", "admin.request". */
    action: text('action').notNull(),
    /** For admin requests: "PATCH /api/admin/users/:id". */
    route: text('route'),
    targetType: text('target_type'),
    targetId: text('target_id'),
    /** Request details with secrets removed. */
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
    status: integer('status'),
    requestId: text('request_id'),
  },
  (t) => [
    index('audit_log_created_idx').on(t.createdAt),
    index('audit_log_actor_created_idx').on(t.actorId, t.createdAt),
    index('audit_log_action_created_idx').on(t.action, t.createdAt),
  ]
);

/**
 * What users sent to models and what the models answered, kept for audit
 * when "audit.conversations" is on. A copy, independent of the chat: it
 * stays when the user edits or deletes the chat, and only admins read it.
 * Kept for `audit.conversations.retentionDays`.
 */
export const conversationLog = pgTable(
  'conversation_log',
  {
    id: uuid('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    userEmail: text('user_email'),
    /** "chat", "api" or "channel". */
    source: text('source').notNull(),
    /** The chat or channel (not a foreign key: the record outlives it). */
    chatId: uuid('chat_id'),
    chatTitle: text('chat_title'),
    /** The assistant message (chats) or channel message. */
    messageId: uuid('message_id'),
    modelId: text('model_id').notNull(),
    prompt: text('prompt').notNull(),
    reply: text('reply').notNull(),
    status: text('status').notNull(),
    error: text('error'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    /** Attachment names, tool calls and the like (never file contents). */
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
  },
  (t) => [
    index('conversation_log_created_idx').on(t.createdAt),
    index('conversation_log_user_created_idx').on(t.userId, t.createdAt),
    index('conversation_log_chat_idx').on(t.chatId),
  ]
);

/**
 * Admin webhooks: events are POSTed as JSON, signed with HMAC-SHA256 of
 * "<timestamp>.<body>" under the webhook's secret (kept encrypted; shown once).
 */
export const webhooks = pgTable('webhooks', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  /** Event names, or ["*"] for all. */
  events: jsonb('events').$type<string[]>().notNull().default([]),
  secretCipher: text('secret_cipher').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  lastStatus: integer('last_status'),
  lastError: text('last_error'),
  lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
