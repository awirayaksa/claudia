/**
 * Optional reranking of retrieved passages by a cross-encoder service:
 * - cohere: POST /rerank {model, query, documents, top_n} → {results: [{index, relevance_score}]}
 *   (Cohere, Jina and most hosted rerankers);
 * - tei: Hugging Face Text Embeddings Inference, POST /rerank {query, texts} → [{index, score}].
 * Failures fall back to the order we already have.
 */
import type { FastifyBaseLogger } from 'fastify';

export interface RerankConfig {
  engine: 'cohere' | 'tei';
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export async function rerank(
  config: RerankConfig,
  query: string,
  documents: string[],
  log?: FastifyBaseLogger
): Promise<number[] | null> {
  if (documents.length <= 1) return documents.map((_, i) => i);
  const url = `${config.baseUrl.replace(/\/+$/, '')}/rerank`;
  const body =
    config.engine === 'tei'
      ? { query, texts: documents, truncate: true }
      : { model: config.model, query, documents, top_n: documents.length };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`rerank failed (${res.status})`);
    const json = await res.json();
    const results = (config.engine === 'tei' ? json : json.results) as Array<{ index: number; score?: number; relevance_score?: number }>;
    return [...results]
      .sort((a, b) => (b.relevance_score ?? b.score ?? 0) - (a.relevance_score ?? a.score ?? 0))
      .map((r) => r.index)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < documents.length);
  } catch (err) {
    log?.warn({ err: err instanceof Error ? err.message : String(err) }, 'reranking failed; keeping the retrieval order');
    return null;
  }
}
