/**
 * The sources a turn is answered from: knowledge base passages (or whole
 * documents in full-context mode), referenced chats, #url pages and web
 * search results. Each becomes a numbered source the model cites as [n];
 * the same numbers are stored as `citation` parts on the reply.
 */
import type { FastifyBaseLogger } from 'fastify';
import { inArray } from 'drizzle-orm';
import type { Database } from '../db/client';
import { knowledgeBases } from '../db/schema';
import type { CitationSource } from '../../../src/types/turn.types';
import { ChatRepo, pathTo, toNode } from '../modules/chats/repo';
import { chunkSegments, countTokens } from './chunk';
import type { RagConfig } from './config';
import type { KnowledgeService } from './knowledge';
import { rankPassages } from './rank';
import { readUrl, type WebDeps } from './web';
import { webSearch, type SearchResult } from './websearch';

export interface TurnSource {
  index: number;
  source: CitationSource;
  text: string;
}

export interface SourceRequest {
  userId: string;
  query: string;
  /** Knowledge bases the user may read (checked by the caller). */
  kbIds: string[];
  urls: string[];
  /** Chats of this user. */
  chatIds: string[];
  /** #note references the caller may read. */
  notes?: Array<{ id: string; title: string; content: string }>;
  webSearch: boolean;
}

export interface TurnSources {
  sources: TurnSource[];
  notices: string[];
}

const SNIPPET_CHARS = 300;
/** One page or chat gets at most this share of the budget. */
const PER_DOCUMENT_SHARE = 0.4;

/** Cut text to about `max` tokens (keeping the start, or the end for chats). */
function fit(text: string, max: number, keep: 'start' | 'end' = 'start'): string {
  if (countTokens(text) <= max) return text;
  // ~4 characters per token, then trim until it fits
  let chars = max * 4;
  let out = keep === 'start' ? text.slice(0, chars) : text.slice(-chars);
  while (chars > 100 && countTokens(out) > max) {
    chars = Math.floor(chars * 0.85);
    out = keep === 'start' ? text.slice(0, chars) : text.slice(-chars);
  }
  return keep === 'start' ? `${out}\n…` : `…\n${out}`;
}

/** Plain text for display: no markdown heading marks, one line. */
const snippet = (text: string) =>
  text
    .replace(/^#{1,6}\s+.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SNIPPET_CHARS);

export class SourceBuilder {
  private readonly repo: ChatRepo;

  constructor(
    private readonly deps: {
      db: Database;
      config: RagConfig;
      knowledge: KnowledgeService;
      web: WebDeps;
      log: FastifyBaseLogger;
    }
  ) {
    this.repo = new ChatRepo(deps.db);
  }

  async build(req: SourceRequest): Promise<TurnSources> {
    const settings = await this.deps.config.settings();
    const budget = settings.maxContextTokens;
    const perDoc = Math.max(500, Math.floor(budget * PER_DOCUMENT_SHARE));
    const out: TurnSources = { sources: [], notices: [] };
    let used = 0;
    const add = (source: CitationSource, text: string) => {
      const tokens = countTokens(text);
      if (used + tokens > budget) return false;
      used += tokens;
      out.sources.push({ index: out.sources.length + 1, source: { ...source, snippet: source.snippet ?? snippet(text) }, text });
      return true;
    };

    // Knowledge: whole documents where asked for and they fit, else the best passages
    if (req.kbIds.length > 0) {
      const kbs = await this.deps.db
        .select({ id: knowledgeBases.id, name: knowledgeBases.name, fullContext: knowledgeBases.fullContext })
        .from(knowledgeBases)
        .where(inArray(knowledgeBases.id, req.kbIds));
      const retrieve: string[] = [];
      for (const kb of kbs) {
        if (!kb.fullContext) {
          retrieve.push(kb.id);
          continue;
        }
        const docs = await this.deps.knowledge.fullText(kb.id, budget - used);
        if (!docs) {
          out.notices.push(`"${kb.name}" is too large to send whole, so its most relevant passages were used.`);
          retrieve.push(kb.id);
          continue;
        }
        for (const d of docs) add({ kind: 'file', id: d.fileId, title: d.title }, d.text);
      }
      const hits = await this.deps.knowledge.search(retrieve, req.query);
      for (const h of hits) {
        add(
          {
            kind: 'file',
            ...(h.fileId ? { id: h.fileId } : {}),
            title: h.title,
            ...(h.page ? { page: h.page } : {}),
            ...(h.heading ? { section: h.heading } : {}),
            snippet: snippet(h.text),
          },
          h.heading ? `${h.heading}\n${h.text}` : h.text
        );
      }
      if (retrieve.length > 0 && hits.length === 0) out.notices.push('Nothing in the knowledge bases matched this message.');
    }

    // Referenced chats (the end of a long chat matters most)
    for (const chatId of req.chatIds) {
      try {
        const chat = await this.repo.getOwned(req.userId, chatId);
        const nodes = (await this.repo.messages(chat.id)).map(toNode);
        const path = pathTo(nodes, chat.currentLeafId);
        const transcript = path
          .map((n) => {
            const text = n.parts.map((p) => (p.type === 'text' ? p.text : '')).join('').trim();
            return text ? `${n.role === 'user' ? 'User' : 'Assistant'}: ${text}` : '';
          })
          .filter(Boolean)
          .join('\n\n');
        if (transcript) add({ kind: 'chat', id: chat.id, title: chat.title }, fit(transcript, perDoc, 'end'));
      } catch {
        out.notices.push('A referenced chat was not found.');
      }
    }

    // Notes: the whole note if it's short, else its most relevant passages
    for (const note of req.notes ?? []) {
      if (note.content.trim()) add({ kind: 'note', id: note.id, title: note.title }, await this.relevant(note.content, req.query, perDoc));
    }

    // #url pages: the whole page if it's short, else its most relevant passages
    const pages = await Promise.all(
      req.urls.map(async (url) => {
        try {
          return { url, page: await readUrl(url, this.deps.web) };
        } catch (err) {
          out.notices.push(`Couldn't read ${url}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      })
    );
    for (const p of pages) {
      if (!p) continue;
      add({ kind: 'url', url: p.page.url, title: p.page.title }, await this.relevant(p.page.text, req.query, perDoc));
    }

    // Web search
    if (req.webSearch) {
      try {
        for (const r of await this.searchWeb(req.query)) add({ kind: 'url', url: r.url, title: r.title }, r.text);
      } catch (err) {
        out.notices.push(`Web search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  }

  /** A long text's passages most relevant to the query, in document order, within `max` tokens. */
  private async relevant(text: string, query: string, max: number): Promise<string> {
    if (countTokens(text) <= max) return text;
    const passages = chunkSegments([{ text }], { size: 300, overlap: 0 }).map((c) => c.text);
    const order = await rankPassages(query, passages, await this.deps.config.embedder().catch(() => null));
    const picked: number[] = [];
    let tokens = 0;
    for (const i of order) {
      const t = countTokens(passages[i]);
      if (tokens + t > max) break;
      picked.push(i);
      tokens += t;
    }
    return picked
      .sort((a, b) => a - b)
      .map((i) => passages[i])
      .join('\n…\n');
  }

  private async searchWeb(query: string): Promise<Array<SearchResult & { text: string }>> {
    const settings = await this.deps.config.settings();
    const ws = settings.webSearch;
    if (ws.engine === 'none') throw new Error('No search engine is set up (Admin → Knowledge).');
    const results = await webSearch(
      { engine: ws.engine, baseUrl: ws.baseUrl, cx: ws.cx, count: ws.resultCount, apiKey: await this.deps.config.secret('searchKey') },
      query.slice(0, 400)
    );
    const perPage = Math.max(300, Math.floor(settings.maxContextTokens / Math.max(results.length, 1) / 1.5));
    return Promise.all(
      results.map(async (r) => {
        if (!ws.fetchPages) return { ...r, text: r.snippet };
        try {
          const page = await readUrl(r.url, this.deps.web);
          return { ...r, text: await this.relevant(page.text, query, perPage) };
        } catch {
          return { ...r, text: r.snippet };
        }
      })
    );
  }
}

/** The system message that carries the sources. */
export function sourcesPrompt(sources: TurnSource[]): string {
  const attr = (v: string) => v.replace(/[<>"\n]/g, ' ');
  const body = sources
    .map((s) => {
      const where = s.source.url ? ` url="${attr(s.source.url)}"` : s.source.page ? ` page="${s.source.page}"` : '';
      return `<source id="${s.index}" title="${attr(s.source.title)}"${where}>\n${s.text}\n</source>`;
    })
    .join('\n');
  return [
    'Answer using the sources below where they are relevant. Cite them inline with their number in square brackets, like [1] or [2][3], right after the statement they support. Only cite sources you used. If they don\'t contain the answer, say so and answer from what you know.',
    '<sources>',
    body,
    '</sources>',
  ].join('\n');
}

/** Knowledge bases bound to a custom model or folders, plus #kb references, that `can` lets through. */
export async function readableKbIds(
  db: Database,
  ids: string[],
  can: (kb: { id: string; ownerId: string }) => Promise<boolean>
): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await db
    .select({ id: knowledgeBases.id, ownerId: knowledgeBases.ownerId })
    .from(knowledgeBases)
    .where(inArray(knowledgeBases.id, unique));
  const out: string[] = [];
  for (const r of rows) if (await can(r)) out.push(r.id);
  return out;
}

