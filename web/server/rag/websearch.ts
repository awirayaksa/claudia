/**
 * Web search providers. The provider endpoints are the admin's choice (a
 * SearXNG instance may be internal), so they aren't put through the SSRF
 * guard; the result pages are, when they are read.
 */
export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchConfig {
  engine: 'searxng' | 'brave' | 'tavily' | 'google_pse' | 'duckduckgo';
  baseUrl: string;
  apiKey?: string;
  cx: string;
  count: number;
}

const TIMEOUT_MS = 15_000;

async function getJson(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Web search failed (${res.status}).`);
  return res.json();
}

const decodeEntities = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** Results of DuckDuckGo's HTML page (it has no API). */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const blocks = html.split(/class="result results_links/).slice(1);
  for (const block of blocks) {
    const link = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    let url = link[1].replace(/&amp;/g, '&');
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:\/\//.test(url)) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    out.push({ url, title: decodeEntities(link[2]), snippet: snippet ? decodeEntities(snippet[1]) : '' });
  }
  return out;
}

export async function webSearch(config: SearchConfig, query: string): Promise<SearchResult[]> {
  const q = encodeURIComponent(query);
  const n = config.count;
  let results: SearchResult[];
  switch (config.engine) {
    case 'searxng': {
      if (!config.baseUrl) throw new Error('Set the SearXNG URL in Admin → Knowledge.');
      const json = await getJson(`${config.baseUrl.replace(/\/+$/, '')}/search?q=${q}&format=json`);
      results = (json.results ?? []).map((r: any) => ({ url: r.url, title: r.title ?? r.url, snippet: r.content ?? '' }));
      break;
    }
    case 'brave': {
      const json = await getJson(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=${n}`, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': config.apiKey ?? '' },
      });
      results = (json.web?.results ?? []).map((r: any) => ({ url: r.url, title: r.title, snippet: decodeEntities(r.description ?? '') }));
      break;
    }
    case 'tavily': {
      const json = await getJson('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey ?? ''}` },
        body: JSON.stringify({ query, max_results: n }),
      });
      results = (json.results ?? []).map((r: any) => ({ url: r.url, title: r.title, snippet: r.content ?? '' }));
      break;
    }
    case 'google_pse': {
      const json = await getJson(
        `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(config.apiKey ?? '')}&cx=${encodeURIComponent(config.cx)}&q=${q}&num=${Math.min(n, 10)}`
      );
      results = (json.items ?? []).map((r: any) => ({ url: r.link, title: r.title, snippet: r.snippet ?? '' }));
      break;
    }
    case 'duckduckgo': {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClaudiaWeb/1.0)' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Web search failed (${res.status}).`);
      results = parseDuckDuckGo(await res.text());
      break;
    }
  }
  // Only http(s), each URL once
  const seen = new Set<string>();
  return results
    .filter((r) => typeof r.url === 'string' && /^https?:\/\//i.test(r.url) && !seen.has(r.url) && seen.add(r.url))
    .slice(0, n);
}
