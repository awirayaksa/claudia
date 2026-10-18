/**
 * A small web for RAG tests on 127.0.0.1: HTML pages, a SearXNG JSON search,
 * a YouTube watch page with captions, and a Cohere-style /rerank that puts
 * the documents containing `preferred` first.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockWeb {
  url: string;
  pages: Map<string, { title: string; body: string }>;
  searches: string[];
  reranks: Array<{ query: string; documents: string[] }>;
  /** Text the reranker ranks first. */
  preferred: string;
  close(): Promise<void>;
}

export async function startMockWeb(): Promise<MockWeb> {
  const pages = new Map<string, { title: string; body: string }>();
  const searches: string[] = [];
  const reranks: MockWeb['reranks'] = [];
  const state = { preferred: '' };
  let base = '';

  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const url = new URL(req.url ?? '/', base);

    if (url.pathname === '/search') {
      const q = url.searchParams.get('q') ?? '';
      searches.push(q);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          results: [...pages.keys()].map((p) => ({ url: `${base}${p}`, title: pages.get(p)!.title, content: `Snippet of ${pages.get(p)!.title}` })),
        })
      );
    }
    if (url.pathname === '/rerank' && req.method === 'POST') {
      const json = JSON.parse(body);
      reranks.push({ query: json.query, documents: json.documents });
      const docs: string[] = json.documents;
      const order = docs.map((_, i) => i).sort((a, b) => Number(docs[b].includes(state.preferred)) - Number(docs[a].includes(state.preferred)));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ results: order.map((index, rank) => ({ index, relevance_score: 1 - rank / docs.length })) }));
    }
    if (url.pathname === '/watch') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const tracks = [{ baseUrl: `/api/timedtext?v=${url.searchParams.get('v')}&lang=en`, languageCode: 'en' }];
      return res.end(`<html><head><title>Sailing basics - YouTube</title></head><body><script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":${JSON.stringify(tracks)}}}};</script></body></html>`);
    }
    if (url.pathname === '/api/timedtext') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ events: [{ segs: [{ utf8: 'Always reef the mainsail' }] }, { segs: [{ utf8: ' before the squall arrives.' }] }] }));
    }
    const page = pages.get(url.pathname);
    if (page) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html><head><title>${page.title}</title></head><body><article><h1>${page.title}</h1>${page.body}</article></body></html>`);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    pages,
    searches,
    reranks,
    get preferred() {
      return state.preferred;
    },
    set preferred(v: string) {
      state.preferred = v;
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
