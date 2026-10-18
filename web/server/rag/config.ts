/**
 * Admin RAG settings: embeddings, chunking, retrieval, reranking and web
 * search. Stored in app_config ("rag"); API keys encrypted in "rag.secrets"
 * and never returned.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { appConfig } from '../db/schema';
import type { SecretBox } from '../crypto/secrets';
import type { Cluster } from '../cluster/cluster';
import { RagSettings, type RagSettingsResponse, type RagSettingsUpdate } from '../../shared/knowledge';
import { createEmbedder, localEngineAvailable, type Embedder } from './embed';

export const RAG_DEFAULTS: RagSettings = {
  embedding: { engine: 'none', baseUrl: '', model: '', batchSize: 32 },
  chunkSize: 800,
  chunkOverlap: 100,
  topK: 5,
  maxContextTokens: 8000,
  rerank: { engine: 'none', baseUrl: '', model: '' },
  webSearch: { engine: 'none', baseUrl: '', cx: '', resultCount: 5, fetchPages: true },
};

interface Secrets {
  embeddingKey?: string;
  rerankKey?: string;
  searchKey?: string;
}

export class RagConfig {
  private cached: { settings: RagSettings; secrets: Secrets } | null = null;
  private embedderCache: { stamp: string; embedder: Embedder | null } | null = null;

  constructor(private readonly deps: { db: Database; secrets: SecretBox; cluster?: Cluster }) {
    deps.cluster?.on('rag', () => this.reset());
  }

  private async load(): Promise<{ settings: RagSettings; secrets: Secrets }> {
    if (this.cached) return this.cached;
    const rows = await this.deps.db.select().from(appConfig).where(eq(appConfig.key, 'rag'));
    const [sec] = await this.deps.db.select().from(appConfig).where(eq(appConfig.key, 'rag.secrets'));
    const stored = (rows[0]?.value ?? {}) as Partial<RagSettings>;
    const merged = {
      ...RAG_DEFAULTS,
      ...stored,
      embedding: { ...RAG_DEFAULTS.embedding, ...stored.embedding },
      rerank: { ...RAG_DEFAULTS.rerank, ...stored.rerank },
      webSearch: { ...RAG_DEFAULTS.webSearch, ...stored.webSearch },
    };
    const parsed = RagSettings.safeParse(merged);
    const cipher = (sec?.value ?? {}) as Record<string, string>;
    const secrets: Secrets = {};
    for (const k of ['embeddingKey', 'rerankKey', 'searchKey'] as const) {
      if (cipher[k]) secrets[k] = this.deps.secrets.decrypt(cipher[k]);
    }
    this.cached = { settings: parsed.success ? parsed.data : RAG_DEFAULTS, secrets };
    return this.cached;
  }

  async settings(): Promise<RagSettings> {
    return (await this.load()).settings;
  }

  async secret(name: keyof Secrets): Promise<string | undefined> {
    return (await this.load()).secrets[name];
  }

  async view(): Promise<RagSettingsResponse> {
    const { settings, secrets } = await this.load();
    return {
      settings,
      hasEmbeddingKey: !!secrets.embeddingKey,
      hasRerankKey: !!secrets.rerankKey,
      hasSearchKey: !!secrets.searchKey,
      localAvailable: await localEngineAvailable(),
    };
  }

  /** Save; reports whether the embedding model changed (everything must be re-embedded). */
  async update(patch: RagSettingsUpdate): Promise<{ view: RagSettingsResponse; embeddingChanged: boolean }> {
    const before = await this.embedderKey();
    const { settings, secrets } = await this.load();
    const { embeddingKey, rerankKey, searchKey, ...fields } = patch;
    const next = RagSettings.parse({
      ...settings,
      ...fields,
      embedding: { ...settings.embedding, ...fields.embedding },
      rerank: { ...settings.rerank, ...fields.rerank },
      webSearch: { ...settings.webSearch, ...fields.webSearch },
    });
    const nextSecrets: Secrets = { ...secrets };
    for (const [k, v] of Object.entries({ embeddingKey, rerankKey, searchKey }) as Array<[keyof Secrets, string | undefined]>) {
      if (v === undefined) continue;
      if (v === '') delete nextSecrets[k];
      else nextSecrets[k] = v;
    }
    const cipher = Object.fromEntries(Object.entries(nextSecrets).map(([k, v]) => [k, this.deps.secrets.encrypt(v!)]));
    for (const [key, value] of [
      ['rag', next],
      ['rag.secrets', cipher],
    ] as const) {
      await this.deps.db
        .insert(appConfig)
        .values({ key, value })
        .onConflictDoUpdate({ target: appConfig.key, set: { value, updatedAt: new Date() } });
    }
    this.cached = null;
    this.embedderCache = null;
    this.deps.cluster?.signal('rag');
    return { view: await this.view(), embeddingChanged: before !== (await this.embedderKey()) };
  }

  /** "<engine>:<model>" of the configured embedder, or null (keyword search only). */
  async embedderKey(): Promise<string | null> {
    const { embedding } = await this.settings();
    return embedding.engine === 'none' || !embedding.model ? null : `${embedding.engine}:${embedding.model}`;
  }

  async embedder(): Promise<Embedder | null> {
    const { settings, secrets } = await this.load();
    const e = settings.embedding;
    const stamp = JSON.stringify([e, secrets.embeddingKey ?? '']);
    if (this.embedderCache?.stamp === stamp) return this.embedderCache.embedder;
    const embedder =
      e.engine === 'none' || !e.model
        ? null
        : createEmbedder({ engine: e.engine, baseUrl: e.baseUrl, model: e.model, apiKey: secrets.embeddingKey, batchSize: e.batchSize });
    this.embedderCache = { stamp, embedder };
    return embedder;
  }

  /** Forget the cached settings (another instance changed them, or a test wrote app_config). */
  reset(): void {
    this.cached = null;
    this.embedderCache = null;
  }
}
