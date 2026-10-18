/**
 * Exit check for Phase 4: the golden retrieval set reaches its recall@k
 * through the real ingestion and search path (chunking, tsvector, pgvector,
 * RRF). Embeddings here are the deterministic hash embedder (no model, no
 * network), so this measures the pipeline, not a language model's quality.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { chatFixture, type ChatFixture } from '../test/chat-fixture';
import { GOLDEN_DOCS, GOLDEN_QUERIES, MIN_RECALL_HYBRID, MIN_RECALL_KEYWORD, RECALL_AT } from '../test/golden-set';

let f: ChatFixture;
let kb: string;

beforeAll(async () => {
  f = await chatFixture();
  // Small chunks, so documents are split and the search works on passages
  kb = (await f.admin.post('/api/knowledge', { name: 'Company wiki', chunkSize: 100, chunkOverlap: 20 })).json().knowledge.id;
  for (const [name, text] of Object.entries(GOLDEN_DOCS)) {
    const file = (await f.admin.upload(name, text, 'text/markdown')).json().file.id;
    expect((await f.admin.post(`/api/knowledge/${kb}/files`, { fileId: file })).statusCode).toBe(202);
  }
  await f.app.ctx.jobs.idle(60_000);
}, 120_000);

afterAll(async () => {
  await f?.close();
});

async function recall(label: string): Promise<number> {
  let found = 0;
  const misses: string[] = [];
  for (const { q, doc } of GOLDEN_QUERIES) {
    const hits = (await f.admin.post(`/api/knowledge/${kb}/search`, { query: q, k: RECALL_AT })).json().hits as Array<{ title: string }>;
    if (hits.some((h) => h.title === doc)) found++;
    else misses.push(`${q} → ${hits.map((h) => h.title).join(', ') || 'nothing'}`);
  }
  const r = found / GOLDEN_QUERIES.length;
  console.info(`[golden] ${label}: recall@${RECALL_AT} = ${r.toFixed(3)} (${found}/${GOLDEN_QUERIES.length})${misses.length ? `\n  missed: ${misses.join('\n  missed: ')}` : ''}`);
  return r;
}

describe('golden retrieval set', () => {
  it('splits longer documents into several passages', async () => {
    const files = (await f.admin.get(`/api/knowledge/${kb}`)).json().knowledge.files as Array<{ status: string; chunks: number }>;
    expect(files).toHaveLength(Object.keys(GOLDEN_DOCS).length);
    expect(files.every((x) => x.status === 'ready')).toBe(true);
    expect(files.reduce((n, x) => n + x.chunks, 0)).toBeGreaterThan(files.length);
  });

  it(`keyword search alone reaches recall@${RECALL_AT} ≥ ${MIN_RECALL_KEYWORD}`, async () => {
    expect(await recall('keyword')).toBeGreaterThanOrEqual(MIN_RECALL_KEYWORD);
  });

  it(`hybrid search reaches recall@${RECALL_AT} ≥ ${MIN_RECALL_HYBRID}`, async () => {
    const res = await f.admin.put('/api/admin/rag', { embedding: { engine: 'openai', baseUrl: f.mock.url, model: 'hash-512', batchSize: 32 } });
    expect(res.statusCode).toBe(200);
    await f.app.ctx.jobs.idle(60_000);
    expect((await f.admin.get(`/api/knowledge/${kb}`)).json().knowledge.embedModel).toBe('openai:hash-512');
    expect(await recall('hybrid')).toBeGreaterThanOrEqual(MIN_RECALL_HYBRID);
  });
});
