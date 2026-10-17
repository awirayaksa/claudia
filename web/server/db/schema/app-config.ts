import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Settings edited in the admin UI. Environment variables win over rows here.
 */
export const appConfig = pgTable('app_config', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
