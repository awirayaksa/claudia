import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';

/** A user's personal access token for one of the admin's Azure DevOps Server collections (encrypted). */
export const azdoConnections = pgTable(
  'azdo_connections',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The collection's id in the `azdo.servers` setting. */
    serverId: uuid('server_id').notNull(),
    patCipher: text('pat_cipher').notNull(),
    /** Who the token signs in as (from connectionData). */
    displayName: text('display_name'),
    defaultProject: text('default_project'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.serverId] })]
);
