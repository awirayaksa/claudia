/**
 * Ranking helpers: query terms for keyword search, Reciprocal Rank Fusion,
 * and in-memory ranking of passages that never reach the database (web
 * pages, search results).
 */
import { sql, type SQL } from 'drizzle-orm';
import { cosine, type Embedder } from './embed';

/** RRF constant (Cormack et al.): 60. */
export const RRF_K = 60;

const STOPWORDS = new Set(
  (
    'a an and are as at be but by do does for from had has have how i if in into is it its me my no not of on or our so ' +
    'than that the their them then there these they this to was we were what when where which who why will with you your ' +
    'about can could would should please tell show give explain'
  ).split(' ')
);

/** Lower-cased words worth searching for (letters and digits only, so safe in tsquery). */
export function queryTerms(query: string, max = 32): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const w of words) {
    if (w.length < 2 || STOPWORDS.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= max) break;
  }
  // A query of only stopwords still searches for something
  return out.length > 0 ? out : [...new Set(words.filter((w) => w.length > 1))].slice(0, max);
}

/** "w1:* | w2:* | …" as a tsquery ('simple' config): any word, as a prefix. */
export function orTsQuery(terms: string[]): SQL | null {
  if (terms.length === 0) return null;
  return sql`to_tsquery('simple', ${terms.map((t) => `${t}:*`).join(' | ')})`;
}

/** Fuse ranked lists of ids: score = Σ 1 / (k + rank). */
export function rrf(lists: string[][], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return scores;
}

/** BM25-ish keyword scores of passages for the query terms. */
export function keywordScores(terms: string[], passages: string[]): number[] {
  const docs = passages.map((p) => p.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(docs.length, 1) || 1;
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, docs.filter((d) => d.some((w) => w.startsWith(t))).length);
  return docs.map((d) => {
    let score = 0;
    for (const t of terms) {
      const tf = d.filter((w) => w.startsWith(t)).length;
      if (!tf) continue;
      const idf = Math.log(1 + (docs.length - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
      score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.length / avg)));
    }
    return score;
  });
}

/** Order passages by keyword and (with an embedder) vector similarity, fused with RRF. */
export async function rankPassages(query: string, passages: string[], embedder: Embedder | null): Promise<number[]> {
  if (passages.length <= 1) return passages.map((_, i) => i);
  const ids = passages.map((_, i) => String(i));
  const kw = keywordScores(queryTerms(query), passages);
  const lists = [ids.filter((_, i) => kw[i] > 0).sort((a, b) => kw[+b] - kw[+a])];
  if (embedder) {
    const [q, ...vs] = await embedder.embed([query, ...passages]);
    const sim = vs.map((v) => cosine(q, v));
    lists.push([...ids].sort((a, b) => sim[+b] - sim[+a]));
  }
  const fused = rrf(lists);
  return [...ids].sort((a, b) => (fused.get(b) ?? 0) - (fused.get(a) ?? 0) || +a - +b).map(Number);
}
