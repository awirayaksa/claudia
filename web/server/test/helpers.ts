import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { openDatabase, type DbHandle } from '../db/client';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

export function testConfig(env: Record<string, string> = {}) {
  return loadConfig({ NODE_ENV: 'test', DATA_DIR: './data-test', ...env });
}

/** In-memory PGlite, or real Postgres when TEST_DATABASE_URL is set. */
export async function openTestDatabase(url = process.env.TEST_DATABASE_URL): Promise<DbHandle> {
  return openDatabase({ url });
}

export async function buildTestApp(opts: { db?: DbHandle; migrate?: boolean } = {}) {
  const db = opts.db ?? (await openTestDatabase());
  if (opts.migrate !== false) await db.migrate(MIGRATIONS_DIR);
  const app = await buildApp({ config: testConfig(), db, migrationsDir: MIGRATIONS_DIR, logger: false });
  return {
    app,
    db,
    async close() {
      await app.close();
      await db.close();
    },
  };
}
