/**
 * Reading web pages for #url references and web search results, always
 * through the SSRF guard. HTML becomes markdown (readability), PDFs and
 * other documents go through the extraction pool, and YouTube links become
 * their transcript.
 */
import type { ExtractPool } from '../extract/pool';
import { readBodyLimited, safeFetch, type SafeFetchPolicy } from '../net/safe-fetch';
import { documentSegments } from './segments';

const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const UA = 'Mozilla/5.0 (compatible; ClaudiaWeb/1.0; +https://github.com/)';

export interface WebPage {
  url: string;
  title: string;
  text: string;
}

export interface WebDeps {
  extract: ExtractPool;
  policy: () => SafeFetchPolicy;
  /** Test hook: where YouTube pages are fetched from. */
  youtubeOrigin?: string;
}

// ─── YouTube ─────────────────────────────────────────────────────────────────

export function youtubeId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v') ?? /^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(url.pathname)?.[1] ?? null;
  }
  return id && /^[\w-]{6,20}$/.test(id) ? id : null;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
}

/** The caption tracks listed in a watch page's player response. */
export function captionTracks(html: string): CaptionTrack[] {
  const at = html.indexOf('"captionTracks":');
  if (at < 0) return [];
  const start = html.indexOf('[', at);
  // Find the matching bracket (the JSON may contain nested arrays)
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1)) as CaptionTrack[];
      } catch {
        return [];
      }
    }
  }
  return [];
}

/** Text of a json3 timed-text document. */
export function json3Text(json: { events?: Array<{ segs?: Array<{ utf8?: string }> }> }): string {
  return (json.events ?? [])
    .map((e) => (e.segs ?? []).map((s) => s.utf8 ?? '').join(''))
    .filter((line) => line.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m ? m[1].replace(/\s*-\s*YouTube\s*$/, '').trim() : null;
}

async function youtubeTranscript(id: string, deps: WebDeps, lang = 'en'): Promise<WebPage> {
  const origin = deps.youtubeOrigin ?? 'https://www.youtube.com';
  const pageUrl = `${origin}/watch?v=${id}`;
  const res = await safeFetch(pageUrl, {
    policy: deps.policy(),
    timeoutMs: TIMEOUT_MS,
    headers: { 'User-Agent': UA, 'Accept-Language': `${lang},en;q=0.8` },
  });
  const html = (await readBodyLimited(res, MAX_PAGE_BYTES)).toString('utf-8');
  const tracks = captionTracks(html);
  const track =
    tracks.find((t) => t.languageCode === lang && t.kind !== 'asr') ??
    tracks.find((t) => t.languageCode === lang) ??
    tracks.find((t) => t.kind !== 'asr') ??
    tracks[0];
  if (!track) throw new Error('This video has no captions to read.');
  const captionUrl = new URL(track.baseUrl, origin);
  captionUrl.searchParams.set('fmt', 'json3');
  const caps = await safeFetch(captionUrl, { policy: deps.policy(), timeoutMs: TIMEOUT_MS, headers: { 'User-Agent': UA } });
  const body = (await readBodyLimited(caps, MAX_PAGE_BYTES)).toString('utf-8');
  const text = json3Text(JSON.parse(body || '{}'));
  if (!text) throw new Error("The video's captions are empty.");
  return { url: `https://www.youtube.com/watch?v=${id}`, title: htmlTitle(html) ?? `YouTube video ${id}`, text };
}

// ─── Pages ───────────────────────────────────────────────────────────────────

/** A web page (or document, or YouTube video) as text. */
export async function readUrl(url: string, deps: WebDeps): Promise<WebPage> {
  const video = youtubeId(url);
  if (video) return youtubeTranscript(video, deps);

  const res = await safeFetch(url, {
    policy: deps.policy(),
    timeoutMs: TIMEOUT_MS,
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5' },
  });
  if (!res.ok) throw new Error(`The page answered ${res.status}.`);
  const finalUrl = res.url || url;
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const body = await readBodyLimited(res, MAX_PAGE_BYTES);
  const name = new URL(finalUrl).pathname.split('/').pop() || 'page';

  if (type === 'text/html' || type === 'application/xhtml+xml' || (!type && /<html/i.test(body.subarray(0, 512).toString()))) {
    const page = await deps.extract.htmlToMarkdown(body.toString('utf-8'), finalUrl);
    return { url: finalUrl, title: page.title || new URL(finalUrl).hostname, text: page.markdown };
  }
  const { segments } = await documentSegments(deps.extract, body, name, type);
  return { url: finalUrl, title: decodeURIComponent(name), text: segments.map((s) => s.text).join('\n\n') };
}
