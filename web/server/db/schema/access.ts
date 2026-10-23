import { boolean, index, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { GroupCaps, Permissions } from '../../../shared/access';
import type { CustomModelParams, MemorySource, MemoryTopic } from '../../../shared/workspace';
import { users } from './identity';
import { chats, folders, messages } from './chats';

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Only the keys the group grants (true); permissions are additive. */
    permissions: jsonb('permissions').$type<Partial<Permissions>>().notNull().default({}),
    /** Models members may use on top of their role's allowlist. */
    modelIds: jsonb('model_ids').$type<string[]>().notNull().default([]),
    caps: jsonb('caps').$type<GroupCaps>().notNull().default({}),
    /** Directory group synced into this one at sign-in (stored lower-cased). */
    ldapDn: text('ldap_dn'),
    /** The identity provider's id for this group (SCIM externalId). */
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('groups_name_unique').on(t.name), uniqueIndex('groups_ldap_dn_unique').on(t.ldapDn)]
);

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'ldap', 'sso' and 'scim' rows are added and removed by that sync; 'manual' ones never are. */
    source: text('source').$type<'manual' | 'ldap' | 'sso' | 'scim'>().notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index('group_members_user_idx').on(t.userId)]
);

export type ResourceType = 'model' | 'prompt' | 'knowledge' | 'note' | 'channel' | 'folder';
export type PrincipalType = 'user' | 'group' | 'public';

/**
 * The only way anyone but the owner reaches a workspace item. Grants of a
 * deleted item, user or group are removed with it (in code: the reference
 * is polymorphic).
 */
export const accessGrants = pgTable(
  'access_grants',
  {
    id: uuid('id').primaryKey(),
    resourceType: text('resource_type').$type<ResourceType>().notNull(),
    resourceId: uuid('resource_id').notNull(),
    principalType: text('principal_type').$type<PrincipalType>().notNull(),
    /** null for 'public'. */
    principalId: uuid('principal_id'),
    perm: text('perm').$type<'read' | 'write'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('access_grants_unique')
      .on(t.resourceType, t.resourceId, t.principalType, t.principalId)
      .nullsNotDistinct(),
    index('access_grants_principal_idx').on(t.principalType, t.principalId),
  ]
);

/** Custom models: a base model with a system prompt, parameters and tools. */
export const customModels = pgTable(
  'models',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    baseModelId: text('base_model_id').notNull(),
    systemPrompt: text('system_prompt').notNull().default(''),
    params: jsonb('params').$type<CustomModelParams>().notNull().default({}),
    toolIds: jsonb('tool_ids').$type<string[]>().notNull().default([]),
    /** Knowledge bases searched whenever it answers (with its owner's access). */
    knowledgeIds: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
    suggestions: jsonb('suggestions').$type<string[]>().notNull().default([]),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('models_owner_idx').on(t.ownerId)]
);

/**
 * What the assistant remembers about a user, injected as a system message:
 * entered by the user, saved by the model during a chat, learned from chats
 * in the background, or imported from another assistant.
 */
export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    topic: text('topic').$type<MemoryTopic>().notNull().default('other'),
    source: text('source').$type<MemorySource>().notNull().default('user'),
    /** Set: only for chats in this folder (and its subfolders). */
    folderId: uuid('folder_id').references(() => folders.id, { onDelete: 'cascade' }),
    /** The chat it was learned in, if any. */
    chatId: uuid('chat_id').references(() => chats.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('memories_user_idx').on(t.userId, t.createdAt), index('memories_folder_idx').on(t.folderId)]
);

/** A memory as it was before or after a change. */
export interface MemorySnapshot {
  content: string;
  topic: MemoryTopic;
  source: MemorySource;
  folderId: string | null;
  chatId: string | null;
}

/** Changes the model made to memories (in a chat or learning from one), so the user can undo them. */
export const memoryChanges = pgTable(
  'memory_changes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Not a foreign key: a deleted memory keeps its change, so it can be restored. */
    memoryId: uuid('memory_id').notNull(),
    action: text('action').$type<'add' | 'update' | 'delete'>().notNull(),
    before: jsonb('before').$type<MemorySnapshot>(),
    after: jsonb('after').$type<MemorySnapshot>(),
    /** The reply whose chip shows the change. */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('memory_changes_user_idx').on(t.userId, t.createdAt)]
);

/** Bearer keys for the OpenAI-compatible API (/api/v1). Only a hash is stored. */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    /** sha256 of the whole key (keys are random, so a slow hash adds nothing). */
    keyHash: text('key_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_keys_hash_unique').on(t.keyHash), index('api_keys_user_idx').on(t.userId)]
);
