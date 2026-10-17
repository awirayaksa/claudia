/**
 * The one migration set must run on both engines. PGlite always runs; real
 * PostgreSQL runs when TEST_DATABASE_URL is set (CI's pgvector service).
 */
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { openDatabase } from './client';
import { appConfig } from './schema';
import { MIGRATIONS_DIR } from '../test/helpers';

const engines: Array<{ name: string; url?: string }> = [{ name: 'pglite' }];
if (process.env.TEST_DATABASE_URL) engines.push({ name: 'postgres', url: process.env.TEST_DATABASE_URL });

describe.each(engines)('migrations on $name', ({ url }) => {
  it('apply cleanly, are idempotent, and give a working schema with pgvector', async () => {
    const db = await openDatabase({ url });
    try {
      const first = await db.migrate(MIGRATIONS_DIR);
      expect(first.pending).toBe(0);
      expect(first.applied).toBeGreaterThan(0);

      // Running again changes nothing
      expect(await db.migrate(MIGRATIONS_DIR)).toEqual(first);

      await db.db
        .insert(appConfig)
        .values({ key: 'test.key', value: { enabled: true } })
        .onConflictDoUpdate({ target: appConfig.key, set: { value: { enabled: true } } });
      const rows = await db.db.select().from(appConfig);
      expect(rows.find((r) => r.key === 'test.key')?.value).toEqual({ enabled: true });

      // pgvector is installed: distance between two vectors
      const res = await db.db.execute<{ d: number }>(sql`select '[1,2,3]'::vector <-> '[1,2,4]'::vector as d`);
      const list = Array.isArray(res) ? res : (res as unknown as { rows: Array<{ d: number }> }).rows;
      expect(Number(list[0].d)).toBeCloseTo(1);

      await db.db.delete(appConfig).where(sql`${appConfig.key} = 'test.key'`);
    } finally {
      await db.close();
    }
  });
});
