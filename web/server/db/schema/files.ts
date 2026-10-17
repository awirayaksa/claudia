import { bigint, boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';

export type FileStatus = 'processing' | 'ready' | 'failed';

/** Uploaded files. Bytes and extracted text live in storage, not in the database. */
export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    status: text('status').$type<FileStatus>().notNull().default('processing'),
    /** Storage key of the extracted text (documents only). */
    extractedTextKey: text('extracted_text_key'),
    /** Set when the text was cut off at the size limit. */
    textTruncated: boolean('text_truncated').notNull().default(false),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('files_user_created_idx').on(t.userId, t.createdAt)]
);
