/**
 * Embedding engines, configured by the admin (rag/config.ts):
 * - openai: any OpenAI-compatible POST /embeddings;
 * - ollama: POST /api/embed;
 * - local: transformers.js in-process (the optional @huggingface/transformers
 *   package; the model is downloaded on first use).
 * Requests are batched and retried. Endpoints are the admin's, so they are
 * not put through the SSRF guard (like admin LLM connections).
 */
export interface Embedder {
  /** "<engine>:<model>", stored with every vector. */
  key: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbedderConfig {
  engine: 'openai' | 'ollama' | 'local';
  baseUrl: string;
  model: string;
  apiKey?: string;
  batchSize: number;
}

const RETRIES = 3;
const TIMEOUT_MS = 60_000;

async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if ((err as { permanent?: boolean }).permanent) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function postJson(url: string, body: unknown, apiKey?: string): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    const err = new Error(`Embedding request failed (${res.status}): ${text || res.statusText}`) as Error & { permanent?: boolean };
    // Client errors (bad model, bad key) won't get better by retrying
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw err;
  }
  return res.json();
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

function openaiEmbedder(c: EmbedderConfig): Embedder['embed'] {
  return async (texts) => {
    const json = await postJson(`${trimSlash(c.baseUrl)}/embeddings`, { model: c.model, input: texts }, c.apiKey);
    const data = (json.data ?? []) as Array<{ index: number; embedding: number[] }>;
    if (data.length !== texts.length) throw new Error('The embedding endpoint returned the wrong number of vectors.');
    return [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  };
}

function ollamaEmbedder(c: EmbedderConfig): Embedder['embed'] {
  return async (texts) => {
    const json = await postJson(`${trimSlash(c.baseUrl)}/api/embed`, { model: c.model, input: texts }, c.apiKey);
    const vectors = json.embeddings as number[][] | undefined;
    if (!vectors || vectors.length !== texts.length) throw new Error('Ollama returned the wrong number of vectors.');
    return vectors;
  };
}

/** Whether the optional local engine is installed. */
export async function localEngineAvailable(): Promise<boolean> {
  try {
    await import(/* @vite-ignore */ '@huggingface/transformers' as string);
    return true;
  } catch {
    return false;
  }
}

function localEmbedder(c: EmbedderConfig): Embedder['embed'] {
  let pipe: Promise<(input: string[], opts: object) => Promise<{ tolist(): number[][] }>> | null = null;
  return async (texts) => {
    pipe ??= import(/* @vite-ignore */ '@huggingface/transformers' as string)
      .then((m: any) => m.pipeline('feature-extraction', c.model))
      .catch((err) => {
        pipe = null;
        throw new Error(`Local embeddings need the @huggingface/transformers package: ${err instanceof Error ? err.message : err}`);
      });
    const run = await pipe;
    return (await run(texts, { pooling: 'mean', normalize: true })).tolist();
  };
}

export function createEmbedder(c: EmbedderConfig): Embedder {
  const one =
    c.engine === 'openai' ? openaiEmbedder(c) : c.engine === 'ollama' ? ollamaEmbedder(c) : localEmbedder(c);
  return {
    key: `${c.engine}:${c.model}`,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += c.batchSize) {
        // Empty strings are refused by some endpoints
        const batch = texts.slice(i, i + c.batchSize).map((t) => t || ' ');
        out.push(...(await withRetries(() => one(batch))));
      }
      return out;
    },
  };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
