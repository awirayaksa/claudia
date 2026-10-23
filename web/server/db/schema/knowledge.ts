import { sql } from 'drizzle-orm';
import { boolean, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { KbFileStatus } from '../../../shared/knowledge';
import { users } from './identity';
import { files } from './files';
import { memories } from './access';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const knowledgeBases = pgTable(
  'knowledge_bases',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** "<engine>:<model>" of its chunks' vectors; null = keyword search only. */
    embedModel: text('embed_model'),
    dims: integer('dims'),
    chunkSize: integer('chunk_size'),
    chunkOverlap: integer('chunk_overlap'),
    fullContext: boolean('full_context').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('knowledge_bases_owner_idx').on(t.ownerId)]
);

export const kbFiles = pgTable(
  'kb_files',
  {
    kbId: uuid('kb_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    status: text('status').$type<KbFileStatus>().notNull().default('queued'),
    error: text('error'),
    chunkCount: integer('chunk_count').notNull().default(0),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.kbId, t.fileId] }), index('kb_files_file_idx').on(t.fileId)]
);

/** What a GitHub source pulls: a repository, a branch or tag, and paths in it. */
export interface GitHubSourceConfig {
  /** "owner/name". */
  repo: string;
  /** Branch, tag or commit; null = the default branch. */
  ref: string | null;
  /** Folders ("docs/") and files to include; empty = the whole repository. */
  paths: string[];
  /** GitHub Enterprise: its API address; null = api.github.com. */
  apiUrl: string | null;
}

/** What the last sync brought in: the commit, and each path's blob and the file made from it. */
export interface GitHubSourceState {
  commit?: string;
  files?: Record<string, { sha: string; fileId: string }>;
}

/**
 * Places a knowledge base pulls files from and can sync again (a GitHub
 * repository). Its files are kept as the knowledge base owner's files.
 */
export const kbSources = pgTable(
  'kb_sources',
  {
    id: uuid('id').primaryKey(),
    kbId: uuid('kb_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'github'>().notNull(),
    config: jsonb('config').$type<GitHubSourceConfig>().notNull(),
    /** An access token for private repositories, encrypted. */
    tokenCipher: text('token_cipher'),
    state: jsonb('state').$type<GitHubSourceState>().notNull().default({}),
    status: text('status').$type<'queued' | 'syncing' | 'ready' | 'failed'>().notNull().default('queued'),
    error: text('error'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('kb_sources_kb_idx').on(t.kbId)]
);

export type ChunkSource = 'file' | 'memory';

/**
 * Searchable passages: of a knowledge base's files, or of a user's memories.
 * Their vectors live in embeddings_<dims> tables (rag/vector-store.ts), one
 * per dimension, created when first needed.
 */
export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey(),
    kbId: uuid('kb_id').references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'cascade' }),
    memoryId: uuid('memory_id').references(() => memories.id, { onDelete: 'cascade' }),
    /** Memories: whose. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    source: text('source').$type<ChunkSource>().notNull(),
    title: text('title').notNull().default(''),
    heading: text('heading'),
    page: integer('page'),
    ord: integer('ord').notNull().default(0),
    text: text('text').notNull(),
    tokens: integer('tokens').notNull().default(0),
    /** "<engine>:<model>" its vector was made with; null = none (keyword search only). */
    model: text('model'),
    search: tsvector('search').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(heading, '') || ' ' || text)`
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('chunks_kb_idx').on(t.kbId, t.fileId, t.ord),
    index('chunks_memory_idx').on(t.memoryId),
    index('chunks_user_idx').on(t.userId),
    index('chunks_search_idx').using('gin', t.search),
  ]
);

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

/** Background work, claimed with FOR UPDATE SKIP LOCKED. */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').$type<JobStatus>().notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('jobs_queue_idx').on(t.status, t.runAfter)]
);
