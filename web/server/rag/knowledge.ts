/**
 * Knowledge bases: ingestion (a job per file: extract → chunk → embed →
 * store, with progress over the WebSocket), hybrid search (pgvector +
 * tsvector, fused with RRF, optionally reranked), full-context text, and
 * memory vectors. Without an embedding engine everything still works on
 * keyword search alone.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client';
import { chunks, files, kbFiles, knowledgeBases, memories } from '../db/schema';
import type { Storage } from '../storage/local';
import type { ExtractPool } from '../extract/pool';
import { ExtractLimitError } from '../extract/limits';
import { uuidv7 } from '../lib/ids';
import type { JobQueue } from '../jobs/queue';
import type { EventHub } from '../ws/gateway';
import type { KbFileEvent, KbFileStatus, SearchHit } from '../../shared/knowledge';
import { chunkSegments } from './chunk';
import type { RagConfig } from './config';
import { documentSegments, UnsupportedDocumentError } from './segments';
import { orTsQuery, queryTerms, rrf } from './rank';
import { rerank } from './rerank';
import type { VectorStore } from './vector-store';

export interface KnowledgeDeps {
  db: Database;
  storage: Storage;
  extract: ExtractPool;
  config: RagConfig;
  vectors: VectorStore;
  jobs: JobQueue;
  events: EventHub;
  log: FastifyBaseLogger;
}

type ChunkRow = typeof chunks.$inferSelect;

const permanent = (message: string) => Object.assign(new Error(message), { permanent: true });

/** What a chunk's vector is made from: its place in the document, then its text. */
const embedInput = (c: { title: string; heading: string | null; text: string }) =>
  `${c.title}${c.heading ? ` — ${c.heading}` : ''}\n${c.text}`;

const uuidList = (ids: string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);

export class KnowledgeService {
  constructor(private readonly deps: KnowledgeDeps) {
    deps.jobs.register('kb.ingest', (p) => this.ingest(String(p.kbId), String(p.fileId)));
    deps.jobs.register('kb.reindex', (p) => this.reindex(String(p.kbId)));
    deps.jobs.register('memory.embed', (p) => this.embedMemory(String(p.memoryId)));
    deps.jobs.register('rag.reindex-all', () => this.reindexAll());
  }

  // ─── Ingestion ─────────────────────────────────────────────────────────────

  private publish(kbId: string, fileId: string, status: KbFileStatus, extra: Partial<KbFileEvent> = {}): void {
    const event: KbFileEvent = { type: 'kb.file', kbId, fileId, status, chunks: 0, progress: 0, error: null, ...extra };
    this.deps.events.publish(`kb:${kbId}`, event);
  }

  private async setStatus(kbId: string, fileId: string, status: KbFileStatus, patch: { error?: string | null; chunkCount?: number } = {}) {
    await this.deps.db
      .update(kbFiles)
      .set({ status, ...patch })
      .where(and(eq(kbFiles.kbId, kbId), eq(kbFiles.fileId, fileId)));
    this.publish(kbId, fileId, status, { chunks: patch.chunkCount ?? 0, error: patch.error ?? null, progress: status === 'ready' ? 1 : 0 });
  }

  /** Queue a file for a knowledge base (called after the kb_files row exists). */
  async queue(kbId: string, fileId: string): Promise<void> {
    this.publish(kbId, fileId, 'queued');
    await this.deps.jobs.enqueue('kb.ingest', { kbId, fileId });
  }

  async ingest(kbId: string, fileId: string): Promise<void> {
    const { db, storage, extract, config, vectors, log } = this.deps;
    const [kb] = await db.select().from(knowledgeBases).where(eq(knowledgeBases.id, kbId));
    const [link] = await db.select().from(kbFiles).where(and(eq(kbFiles.kbId, kbId), eq(kbFiles.fileId, fileId)));
    const [file] = await db.select().from(files).where(eq(files.id, fileId));
    if (!kb || !link || !file) return; // removed meanwhile

    await this.setStatus(kbId, fileId, 'processing');
    try {
      if (file.mime.startsWith('image/')) throw permanent("Images can't be searched. Add documents or text.");
      const { segments } = await documentSegments(extract, await storage.get(file.storageKey), file.name, file.mime).catch((err) => {
        if (err instanceof UnsupportedDocumentError || err instanceof ExtractLimitError) throw permanent(err.message);
        throw err;
      });
      const settings = await config.settings();
      const pieces = chunkSegments(segments, {
        size: kb.chunkSize ?? settings.chunkSize,
        overlap: kb.chunkOverlap ?? settings.chunkOverlap,
      });
      if (pieces.length === 0) throw permanent('No text found in this file.');

      const rows = pieces.map((p, ord) => ({
        id: uuidv7(),
        kbId,
        fileId,
        source: 'file' as const,
        title: file.name,
        heading: p.heading,
        page: p.page,
        ord,
        text: p.text,
        tokens: p.tokens,
        model: null as string | null,
      }));

      // Vectors first (the slow part, with progress), then everything in one go
      const embedder = await config.embedder();
      let vecs: number[][] = [];
      if (embedder) {
        const batch = settings.embedding.batchSize;
        for (let i = 0; i < rows.length; i += batch) {
          vecs.push(...(await embedder.embed(rows.slice(i, i + batch).map(embedInput))));
          this.publish(kbId, fileId, 'processing', { progress: Math.min(1, (i + batch) / rows.length) });
        }
        for (const r of rows) r.model = embedder.key;
      }

      await db.transaction(async (tx) => {
        await tx.delete(chunks).where(and(eq(chunks.kbId, kbId), eq(chunks.fileId, fileId)));
        for (let i = 0; i < rows.length; i += 200) await tx.insert(chunks).values(rows.slice(i, i + 200));
      });
      if (embedder) {
        await vectors.insert(rows.map((r, i) => ({ chunkId: r.id, vector: vecs[i] })));
        await db
          .update(knowledgeBases)
          .set({ embedModel: embedder.key, dims: vecs[0]?.length ?? null, updatedAt: new Date() })
          .where(eq(knowledgeBases.id, kbId));
      }
      await this.setStatus(kbId, fileId, 'ready', { error: null, chunkCount: rows.length });
      log.info({ kbId, fileId, chunks: rows.length }, 'knowledge file ready');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.setStatus(kbId, fileId, 'failed', { error: message.slice(0, 1000) });
      throw err;
    }
  }

  /** Chunk and embed every file again (chunk settings or the embedding model changed). */
  async reindex(kbId: string): Promise<void> {
    const key = await this.deps.config.embedderKey();
    await this.deps.db
      .update(knowledgeBases)
      .set({ embedModel: key, dims: null, updatedAt: new Date() })
      .where(eq(knowledgeBases.id, kbId));
    const list = await this.deps.db.select({ fileId: kbFiles.fileId }).from(kbFiles).where(eq(kbFiles.kbId, kbId));
    for (const { fileId } of list) {
      await this.deps.db.update(kbFiles).set({ status: 'queued' }).where(and(eq(kbFiles.kbId, kbId), eq(kbFiles.fileId, fileId)));
      await this.queue(kbId, fileId);
    }
  }

  /** After the embedding model changes: every knowledge base and memory. */
  async reindexAll(): Promise<void> {
    for (const kb of await this.deps.db.select({ id: knowledgeBases.id }).from(knowledgeBases)) {
      await this.deps.jobs.enqueue('kb.reindex', { kbId: kb.id });
    }
    for (const m of await this.deps.db.select({ id: memories.id }).from(memories)) {
      await this.deps.jobs.enqueue('memory.embed', { memoryId: m.id });
    }
  }

  // ─── Search ────────────────────────────────────────────────────────────────

  /**
   * The best passages of these knowledge bases for a query: keyword ranking
   * and (for chunks embedded with the current model) vector similarity,
   * fused with RRF, then reranked when a reranker is configured.
   */
  async search(kbIds: string[], query: string, k?: number): Promise<SearchHit[]> {
    if (kbIds.length === 0 || !query.trim()) return [];
    const { config, vectors, db } = this.deps;
    const settings = await config.settings();
    const topK = k ?? settings.topK;
    const pool = Math.max(topK * 4, 20);

    const lists: string[][] = [];
    const tsq = orTsQuery(queryTerms(query));
    if (tsq) {
      const rows = await db
        .select({ id: chunks.id })
        .from(chunks)
        .where(and(inArray(chunks.kbId, kbIds), sql`${chunks.search} @@ ${tsq}`))
        .orderBy(desc(sql`ts_rank_cd(${chunks.search}, ${tsq})`), asc(chunks.ord))
        .limit(pool);
      lists.push(rows.map((r) => r.id));
    }
    const embedder = await config.embedder();
    if (embedder) {
      const [qv] = await embedder.embed([query]);
      const near = await vectors.nearest(qv, sql`c.kb_id in (${uuidList(kbIds)}) and c.model = ${embedder.key}`, pool);
      lists.push(near.map((n) => n.id));
    }
    const fused = rrf(lists);
    let ids = [...fused.keys()].sort((a, b) => fused.get(b)! - fused.get(a)!);
    if (ids.length === 0) return [];

    const rerankCfg = settings.rerank;
    const candidates = ids.slice(0, rerankCfg.engine === 'none' ? topK : Math.min(pool, topK * 3));
    const rows = await this.chunksByIds(candidates);
    if (rerankCfg.engine !== 'none' && rerankCfg.baseUrl) {
      const order = await rerank(
        { ...rerankCfg, engine: rerankCfg.engine, apiKey: await config.secret('rerankKey') },
        query,
        candidates.map((id) => rows.get(id)?.text ?? ''),
        this.deps.log
      );
      if (order) ids = order.map((i) => candidates[i]);
    }
    return ids
      .filter((id) => rows.has(id))
      .slice(0, topK)
      .map((id) => {
        const c = rows.get(id)!;
        return {
          chunkId: c.id,
          fileId: c.fileId,
          title: c.title,
          text: c.text,
          page: c.page,
          heading: c.heading,
          score: fused.get(id) ?? 0,
        };
      });
  }

  private async chunksByIds(ids: string[]): Promise<Map<string, Omit<ChunkRow, 'search'>>> {
    if (ids.length === 0) return new Map();
    const rows = await this.deps.db
      .select({
        id: chunks.id,
        kbId: chunks.kbId,
        fileId: chunks.fileId,
        memoryId: chunks.memoryId,
        userId: chunks.userId,
        source: chunks.source,
        title: chunks.title,
        heading: chunks.heading,
        page: chunks.page,
        ord: chunks.ord,
        text: chunks.text,
        tokens: chunks.tokens,
        model: chunks.model,
        createdAt: chunks.createdAt,
      })
      .from(chunks)
      .where(inArray(chunks.id, ids));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Whole documents of a knowledge base, in order, up to `maxTokens` (null when they don't fit). */
  async fullText(kbId: string, maxTokens: number): Promise<Array<{ fileId: string; title: string; text: string }> | null> {
    const rows = await this.deps.db
      .select({ fileId: kbFiles.fileId, name: files.name, key: files.extractedTextKey, tokens: sql<number>`coalesce((select sum(${chunks.tokens}) from ${chunks} where ${chunks.kbId} = ${kbId} and ${chunks.fileId} = ${kbFiles.fileId}), 0)::int` })
      .from(kbFiles)
      .innerJoin(files, eq(files.id, kbFiles.fileId))
      .where(and(eq(kbFiles.kbId, kbId), eq(kbFiles.status, 'ready')))
      .orderBy(asc(kbFiles.createdAt));
    // Chunks overlap, so their sum is an upper bound of the text's size
    if (rows.reduce((n, r) => n + Number(r.tokens), 0) > maxTokens * 1.3) return null;
    const out: Array<{ fileId: string; title: string; text: string }> = [];
    for (const r of rows) {
      if (r.key) {
        out.push({ fileId: r.fileId, title: r.name, text: (await this.deps.storage.get(r.key)).toString('utf-8') });
      } else {
        const parts = await this.deps.db
          .select({ text: chunks.text })
          .from(chunks)
          .where(and(eq(chunks.kbId, kbId), eq(chunks.fileId, r.fileId)))
          .orderBy(asc(chunks.ord));
        out.push({ fileId: r.fileId, title: r.name, text: parts.map((p) => p.text).join('\n\n') });
      }
    }
    return out;
  }

  // ─── Memories ──────────────────────────────────────────────────────────────

  async embedMemory(memoryId: string): Promise<void> {
    const embedder = await this.deps.config.embedder();
    const [m] = await this.deps.db.select().from(memories).where(eq(memories.id, memoryId));
    await this.deps.db.delete(chunks).where(eq(chunks.memoryId, memoryId));
    if (!m || !embedder) return;
    const id = uuidv7();
    const [vector] = await embedder.embed([m.content]);
    await this.deps.db.insert(chunks).values({
      id,
      memoryId,
      userId: m.userId,
      source: 'memory',
      text: m.content,
      tokens: 0,
      model: embedder.key,
    });
    await this.deps.vectors.insert([{ chunkId: id, vector }]);
  }

  /** The user's memories closest to the query (empty without embeddings). */
  async searchMemories(userId: string, query: string, k: number): Promise<string[]> {
    const embedder = await this.deps.config.embedder();
    if (!embedder || !query.trim()) return [];
    const [qv] = await embedder.embed([query]);
    const near = await this.deps.vectors.nearest(
      qv,
      sql`c.user_id = ${userId}::uuid and c.source = 'memory' and c.model = ${embedder.key}`,
      k
    );
    const rows = await this.chunksByIds(near.map((n) => n.id));
    return near.map((n) => rows.get(n.id)?.text).filter((t): t is string => !!t);
  }
}
