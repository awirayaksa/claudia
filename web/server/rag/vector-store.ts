/**
 * Chunk vectors in pgvector: one table per dimension (embeddings_<dims>),
 * created on first use with an HNSW cosine index. Above 2,000 dimensions
 * (the HNSW limit for `vector`) the column is `halfvec`.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client';

const HALFVEC_ABOVE = 2000;
const MAX_DIMS = 16_000;

/** Rows of db.execute on either engine (postgres.js: array; PGlite: { rows }). */
export function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}

const literal = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;

export class VectorStore {
  private ready = new Set<number>();

  constructor(private readonly db: Database) {}

  private table(dims: number): { name: SQL; type: string } {
    if (!Number.isInteger(dims) || dims < 1 || dims > MAX_DIMS) throw new Error(`Unsupported embedding size: ${dims}`);
    return { name: sql.raw(`embeddings_${dims}`), type: dims > HALFVEC_ABOVE ? 'halfvec' : 'vector' };
  }

  private creating = new Map<number, Promise<void>>();

  /**
   * Create the table for this size once. "if not exists" alone races on
   * PostgreSQL when two jobs (or instances) get there together, so creation
   * is serialized with an advisory lock, and here by one shared promise.
   */
  async ensure(dims: number): Promise<void> {
    if (this.ready.has(dims)) return;
    let pending = this.creating.get(dims);
    if (!pending) {
      const { name, type } = this.table(dims);
      pending = this.db
        .transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`claudia:embeddings_${dims}`}))`);
          await tx.execute(sql`create table if not exists ${name} (
            chunk_id uuid primary key references chunks(id) on delete cascade,
            embedding ${sql.raw(`${type}(${dims})`)} not null
          )`);
          await tx.execute(
            sql`create index if not exists ${sql.raw(`embeddings_${dims}_hnsw`)} on ${name} using hnsw (embedding ${sql.raw(`${type}_cosine_ops`)})`
          );
        })
        .then(() => {
          this.ready.add(dims);
        })
        .finally(() => this.creating.delete(dims));
      this.creating.set(dims, pending);
    }
    await pending;
  }

  async insert(rows: Array<{ chunkId: string; vector: number[] }>): Promise<void> {
    if (rows.length === 0) return;
    const dims = rows[0].vector.length;
    await this.ensure(dims);
    const { name, type } = this.table(dims);
    for (let i = 0; i < rows.length; i += 200) {
      const values = rows
        .slice(i, i + 200)
        .map((r) => sql`(${r.chunkId}::uuid, ${literal(r.vector)}::${sql.raw(type)})`);
      await this.db.execute(
        sql`insert into ${name} (chunk_id, embedding) values ${sql.join(values, sql`, `)}
            on conflict (chunk_id) do update set embedding = excluded.embedding`
      );
    }
  }

  /**
   * Nearest chunks to `vector` among those matching `where` (a condition on
   * the `c` alias of chunks), with their cosine similarity.
   */
  async nearest(vector: number[], where: SQL, limit: number): Promise<Array<{ id: string; similarity: number }>> {
    const dims = vector.length;
    const { name, type } = this.table(dims);
    if (!this.ready.has(dims)) {
      const exists = rowsOf<{ t: string | null }>(await this.db.execute(sql`select to_regclass(${`embeddings_${dims}`}) as t`));
      if (!exists[0]?.t) return [];
      this.ready.add(dims);
    }
    const q = sql`${literal(vector)}::${sql.raw(type)}`;
    const rows = rowsOf<{ id: string; distance: number }>(
      await this.db.execute(sql`
        select c.id, e.embedding <=> ${q} as distance
        from ${name} e join chunks c on c.id = e.chunk_id
        where ${where}
        order by e.embedding <=> ${q}
        limit ${limit}`)
    );
    return rows.map((r) => ({ id: r.id, similarity: 1 - Number(r.distance) }));
  }
}
