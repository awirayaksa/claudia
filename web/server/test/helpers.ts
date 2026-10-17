import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, type AppDeps } from '../app';
import { loadConfig } from '../config';
import { openDatabase, type DbHandle } from '../db/client';

export const TEST_SECRET = 'test-secret-key-test-secret-key-0123456789';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

export function testConfig(env: Record<string, string> = {}) {
  // Apps built without a DATA_DIR of their own write here (never into the repo)
  return loadConfig({ NODE_ENV: 'test', DATA_DIR: path.join(os.tmpdir(), 'claudia-test-data'), ...env });
}

/**
 * A fresh database per test: in-memory PGlite, or — when TEST_DATABASE_URL is
 * set (CI) — a new throwaway database on that PostgreSQL server, dropped on close.
 */
export async function openTestDatabase(url = process.env.TEST_DATABASE_URL): Promise<DbHandle> {
  if (!url) return openDatabase({});
  const { default: postgres } = await import('postgres');
  const name = `claudia_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const u = new URL(url);
  u.pathname = `/${name}`;
  const db = await openDatabase({ url: u.toString() });
  const close = db.close.bind(db);
  return {
    ...db,
    async close() {
      await close();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end({ timeout: 5 });
    },
  };
}

export async function buildTestApp(
  opts: { db?: DbHandle; migrate?: boolean; env?: Record<string, string>; orchestrator?: AppDeps['orchestrator'] } = {}
) {
  const db = opts.db ?? (await openTestDatabase());
  if (opts.migrate !== false) await db.migrate(MIGRATIONS_DIR);
  // Each app gets its own data directory (uploads, workspaces)
  const dataDir = opts.env?.DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'claudia-test-'));
  const app = await buildApp({
    config: testConfig({ ...opts.env, DATA_DIR: dataDir }),
    db,
    migrationsDir: MIGRATIONS_DIR,
    rootSecret: TEST_SECRET,
    logger: false,
    bootstrap: opts.migrate !== false,
    orchestrator: opts.orchestrator,
  });
  return {
    app,
    db,
    dataDir,
    async close() {
      await app.close();
      await db.close();
      if (!opts.env?.DATA_DIR) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
