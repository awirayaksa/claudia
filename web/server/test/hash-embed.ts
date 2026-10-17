/**
 * A deterministic embedding for tests (no model, no network): word stems and
 * word pairs hashed into a fixed number of dimensions (signed feature
 * hashing), L2-normalized. Texts that share words land close together, which
 * is enough to test the retrieval pipeline end to end.
 */

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function stem(w: string): string {
  if (w.length > 5) {
    for (const suffix of ['ations', 'ation', 'ments', 'ment', 'ings', 'ing', 'ies', 'ed', 'es', 'ly', 's']) {
      if (w.endsWith(suffix) && w.length - suffix.length >= 4) return w.slice(0, -suffix.length);
    }
  } else if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

const STOP = new Set('a an and are as at be by for from has have how in is it of on or that the this to was what when where which who why with'.split(' '));

export function hashEmbed(text: string, dims = 256): number[] {
  const v = new Array<number>(dims).fill(0);
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w)).map(stem);
  const add = (feature: string, weight: number) => {
    const h = fnv1a(feature);
    v[h % dims] += (h & 0x80000000 ? -1 : 1) * weight;
  };
  words.forEach((w, i) => {
    add(w, 1);
    if (i > 0) add(`${words[i - 1]} ${w}`, 0.5);
  });
  const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/** Dimensions from a model name like "hash-384" (default 256). */
export function hashDims(model: string): number {
  const n = Number(/(\d+)$/.exec(model)?.[1]);
  return Number.isInteger(n) && n > 0 && n <= 4096 ? n : 256;
}
