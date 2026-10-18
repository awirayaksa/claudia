/**
 * One schema, one migration set, two engines:
 * - PostgreSQL (postgres.js) in production;
 * - PGlite (embedded Postgres) for development, tests and single-container trials.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

export type Schema = typeof schema;
/** The query API both engines share. */
export type Database = PgDatabase<PgQueryResultHKT, Schema>;
export type DatabaseKind = 'postgres' | 'pglite';

export interface MigrationStatus {
  applied: number;
  pending: number;
}

export interface DbHandle {
  db: Database;
  kind: DatabaseKind;
  /** Apply pending migrations from `migrationsDir`. */
  migrate(migrationsDir: string): Promise<MigrationStatus>;
  /** Applied vs. available migrations, without changing anything. */
  migrationStatus(migrationsDir: string): Promise<MigrationStatus>;
  /** Throws when the database can't be reached. */
  ping(): Promise<void>;
  /**
   * LISTEN/NOTIFY between the processes sharing this database (PostgreSQL
   * only; PGlite has one process). `listen` resolves to the unlisten.
   */
  listen?(channel: string, onMessage: (payload: string) => void): Promise<() => Promise<void>>;
  notify?(channel: string, payload?: string): Promise<void>;
  close(): Promise<void>;
}

export interface OpenDatabaseOptions {
  /** postgres:// URL. When absent, PGlite is used. */
  url?: string;
  /** PGlite data directory; omit for an in-memory database (tests). */
  dataDir?: string;
}

/** Migrations listed in drizzle-kit's journal. */
function journalEntryCount(migrationsDir: string): number {
  const journal = path.join(migrationsDir, 'meta', '_journal.json');
  if (!fs.existsSync(journal)) return 0;
  return (JSON.parse(fs.readFileSync(journal, 'utf8')).entries ?? []).length;
}

async function appliedCount(db: Database): Promise<number> {
  try {
    const rows = await db.execute<{ count: number }>(sql`select count(*)::int as count from drizzle.__drizzle_migrations`);
    // postgres.js returns an array; PGlite returns { rows }
    const list = Array.isArray(rows) ? rows : (rows as unknown as { rows: Array<{ count: number }> }).rows;
    return Number(list[0]?.count ?? 0);
  } catch {
    return 0; // table doesn't exist yet
  }
}

async function openPostgres(url: string): Promise<DbHandle> {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');

  const client = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(client, { schema }) as unknown as Database;

  const status = async (dir: string) => {
    const applied = await appliedCount(db);
    return { applied, pending: Math.max(0, journalEntryCount(dir) - applied) };
  };

  return {
    db,
    kind: 'postgres',
    async migrate(dir) {
      // Instances starting together take turns; the later ones find nothing left to do
      const lock = await client.reserve();
      try {
        await lock`select pg_advisory_lock(hashtext('claudia:migrations'))`;
        await migrate(drizzle(client, { schema }), { migrationsFolder: dir });
      } finally {
        await lock`select pg_advisory_unlock(hashtext('claudia:migrations'))`.catch(() => {});
        lock.release();
      }
      return status(dir);
    },
    migrationStatus: status,
    async ping() {
      await client`select 1`;
    },
    async listen(channel, onMessage) {
      const { unlisten } = await client.listen(channel, onMessage);
      return unlisten;
    },
    async notify(channel, payload = '') {
      await client.notify(channel, payload);
    },
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}

async function openPglite(dataDir?: string): Promise<DbHandle> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite/vector');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');

  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  // Options must go in one object: new PGlite(undefined, opts) ignores opts
  const client = await PGlite.create({ ...(dataDir ? { dataDir } : {}), extensions: { vector } });
  const db = drizzle(client, { schema }) as unknown as Database;

  const status = async (dir: string) => {
    const applied = await appliedCount(db);
    return { applied, pending: Math.max(0, journalEntryCount(dir) - applied) };
  };

  return {
    db,
    kind: 'pglite',
    async migrate(dir) {
      await migrate(drizzle(client, { schema }), { migrationsFolder: dir });
      return status(dir);
    },
    migrationStatus: status,
    async ping() {
      await client.query('select 1');
    },
    async close() {
      await client.close();
    },
  };
}

export async function openDatabase(opts: OpenDatabaseOptions): Promise<DbHandle> {
  return opts.url ? openPostgres(opts.url) : openPglite(opts.dataDir);
}
