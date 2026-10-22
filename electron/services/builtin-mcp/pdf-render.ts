/**
 * Markdown and HTML to PDF, on every platform.
 *
 * - Desktop: the main process registers a Chromium renderer (printToPDF), so
 *   HTML and Markdown come out as a browser would print them.
 * - Elsewhere (the web server, tests): Markdown is laid out with pdfmake,
 *   pure JavaScript with no system dependency; HTML is turned into Markdown
 *   first. The web server runs this in its worker pool.
 */
import * as path from 'path';

// ============================================================================
// Options and renderers
// ============================================================================

export const PAGE_SIZES = ['A4', 'Letter', 'Legal'] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export interface PdfOptions {
  pageSize: PageSize;
  landscape: boolean;
  title?: string;
  /** Page numbers at the bottom (default true). */
  pageNumbers?: boolean;
}

/** HTML document → PDF bytes. `baseDir` is where relative image paths point. */
export type HtmlPdfRenderer = (html: string, opts: PdfOptions & { baseDir?: string }) => Promise<Buffer>;

/** Markdown → PDF bytes. `images` maps each image reference in the text to a data: URL. */
export type MarkdownPdfRenderer = (markdown: string, opts: PdfOptions, images: Record<string, string>) => Promise<Buffer>;

let htmlRenderer: HtmlPdfRenderer | null = null;

/** The desktop registers Chromium's printToPDF here at startup. */
export function setHtmlPdfRenderer(fn: HtmlPdfRenderer | null): void {
  htmlRenderer = fn;
}

export function getHtmlPdfRenderer(): HtmlPdfRenderer | null {
  return htmlRenderer;
}

// ============================================================================
// Markdown and HTML
// ============================================================================

let markedModule: typeof import('marked') | null = null;

function getMarked(): typeof import('marked') {
  if (!markedModule) markedModule = require('marked');
  return markedModule!;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PRINT_CSS = `
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: "Segoe UI", -apple-system, "Helvetica Neue", Arial, "Noto Sans", sans-serif; font-size: 11pt; line-height: 1.5; color: #1f2328; margin: 0; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.2em 0 0.5em; page-break-after: avoid; }
h1 { font-size: 22pt; border-bottom: 1px solid #d0d7de; padding-bottom: 0.2em; }
h2 { font-size: 17pt; border-bottom: 1px solid #eaeef2; padding-bottom: 0.15em; }
h3 { font-size: 14pt; } h4 { font-size: 12pt; } h5, h6 { font-size: 11pt; }
p, ul, ol, table, pre, blockquote { margin: 0 0 0.8em; }
a { color: #0969da; text-decoration: none; }
code { font-family: Consolas, "SF Mono", Menlo, "DejaVu Sans Mono", monospace; font-size: 0.9em; background: #f3f4f6; padding: 0.1em 0.3em; border-radius: 3px; }
pre { background: #f6f8fa; padding: 10px 12px; border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; page-break-inside: avoid; }
pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid #d0d7de; color: #57606a; padding: 0 1em; margin-left: 0; }
table { border-collapse: collapse; width: 100%; page-break-inside: auto; }
tr { page-break-inside: avoid; }
th, td { border: 1px solid #d0d7de; padding: 5px 9px; text-align: left; vertical-align: top; }
th { background: #f6f8fa; font-weight: 600; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid #d0d7de; margin: 1.5em 0; }
`;

/** A Markdown document as a printable HTML page. */
export function markdownToHtml(markdown: string, title?: string): string {
  const body = getMarked().marked.parse(markdown, { async: false, gfm: true }) as string;
  return wrapHtml(body, title);
}

/** Make a fragment (or a full page) printable: charset, title and a default stylesheet. */
export function wrapHtml(html: string, title?: string): string {
  if (/<html[\s>]/i.test(html)) {
    // A full page keeps its own styles; only add the charset when missing
    return /<meta[^>]+charset/i.test(html) ? html : html.replace(/<head[^>]*>/i, (m) => `${m}<meta charset="utf-8">`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title ?? '')}</title><style>${PRINT_CSS}</style></head><body>${html}</body></html>`;
}

/** HTML → Markdown (for the pdfmake route, which lays out Markdown). Scripts never run. */
export function htmlToMarkdown(html: string): string {
  const TurndownService = require('turndown');
  const { gfm } = require('turndown-plugin-gfm');
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.use(gfm);
  td.remove(['script', 'style', 'noscript', 'iframe', 'object', 'embed']);
  return td.turndown(html);
}

/** Every image reference in a Markdown text (to resolve before rendering). */
export function markdownImageRefs(markdown: string): string[] {
  const refs = new Set<string>();
  const { marked } = getMarked();
  marked.walkTokens(marked.lexer(markdown), (t) => {
    if (t.type === 'image') refs.add((t as { href: string }).href);
  });
  return [...refs];
}

// ============================================================================
// pdfmake route
// ============================================================================

type Content = Record<string, unknown> | string | Content[];

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', '#39': "'" };

function decode(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e.startsWith('#x') || e.startsWith('#X')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#') && e !== '#39') return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const STANDARD_FONTS = new Set(['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique']);

let pdfmakeReady: any = null;

function getPdfmake(): any {
  if (pdfmakeReady) return pdfmakeReady;
  const pdfmake = require('pdfmake');
  const fontsDir = path.dirname(require.resolve('pdfmake/fonts/Roboto.js'));
  pdfmake.setFonts({
    Roboto: {
      normal: path.join(fontsDir, 'Roboto', 'Roboto-Regular.ttf'),
      bold: path.join(fontsDir, 'Roboto', 'Roboto-Medium.ttf'),
      italics: path.join(fontsDir, 'Roboto', 'Roboto-Italic.ttf'),
      bolditalics: path.join(fontsDir, 'Roboto', 'Roboto-MediumItalic.ttf'),
    },
    Courier: { normal: 'Courier', bold: 'Courier-Bold', italics: 'Courier-Oblique', bolditalics: 'Courier-BoldOblique' },
  });
  // Fonts only; images arrive as data: URLs and nothing is downloaded
  pdfmake.setLocalAccessPolicy((p: string) => STANDARD_FONTS.has(p) || path.resolve(p).startsWith(fontsDir));
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmakeReady = pdfmake;
  return pdfmake;
}

/** Characters Roboto has (Latin, Greek, Cyrillic, common punctuation and symbols). */
const COVERED = /^[\u0000-\u052f\u1e00-\u1fff\u2000-\u206f\u20a0-\u20cf\u2100-\u218f\u2190-\u21ff\u2200-\u22ff\u2500-\u257f\u25a0-\u25ff\ufb00-\ufb06\ufeff]*$/; // eslint-disable-line no-control-regex

/** True when the text has characters the built-in PDF font can't show (e.g. Arabic, CJK, emoji). */
export function hasUncoveredCharacters(text: string): boolean {
  return !COVERED.test(text);
}

interface Ctx {
  images: Record<string, string>;
}

function inline(tokens: any[] | undefined, ctx: Ctx, style: Record<string, unknown> = {}): Content[] {
  const out: Content[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'text':
        if (t.tokens?.length) out.push(...inline(t.tokens, ctx, style));
        else out.push({ text: decode(t.text), ...style });
        break;
      case 'escape':
        out.push({ text: decode(t.text), ...style });
        break;
      case 'strong':
        out.push(...inline(t.tokens, ctx, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...inline(t.tokens, ctx, { ...style, italics: true }));
        break;
      case 'del':
        out.push(...inline(t.tokens, ctx, { ...style, decoration: 'lineThrough' }));
        break;
      case 'codespan':
        out.push({ text: decode(t.text), font: 'Courier', background: '#F3F4F6', ...style });
        break;
      case 'link':
        out.push(...inline(t.tokens, ctx, { ...style, link: t.href, color: '#0969DA' }));
        break;
      case 'br':
        out.push({ text: '\n', ...style });
        break;
      case 'image':
        // Inline images can't sit in a line of text with pdfmake: show the alt text
        out.push({ text: t.text || '', italics: true, color: '#57606A', ...style });
        break;
      case 'html':
        out.push({ text: decode(String(t.text).replace(/<[^>]+>/g, '')), ...style });
        break;
      default:
        if (t.text) out.push({ text: decode(String(t.text)), ...style });
    }
  }
  return out;
}

/** A paragraph that is only an image becomes an image block. */
function imageBlock(t: any, ctx: Ctx, maxWidth: number): Content | null {
  const only = t.tokens?.length === 1 && t.tokens[0].type === 'image' ? t.tokens[0] : null;
  if (!only) return null;
  const src = ctx.images[only.href];
  if (!src) return { text: `[${only.text || only.href}]`, italics: true, color: '#57606A', margin: [0, 0, 0, 8] };
  if (src.startsWith('data:image/svg+xml')) {
    const svg = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64').toString('utf-8');
    return { svg, fit: [maxWidth, 420], alignment: 'center', margin: [0, 4, 0, 10] };
  }
  return { image: src, fit: [maxWidth, 420], alignment: 'center', margin: [0, 4, 0, 10] };
}

function blocks(tokens: any[], ctx: Ctx, maxWidth: number): Content[] {
  const out: Content[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
        break;
      case 'heading':
        out.push({ text: inline(t.tokens, ctx), style: `h${t.depth}` });
        break;
      case 'paragraph':
        out.push(imageBlock(t, ctx, maxWidth) ?? { text: inline(t.tokens, ctx), margin: [0, 0, 0, 8] });
        break;
      case 'text':
        out.push({ text: t.tokens ? inline(t.tokens, ctx) : decode(t.text) });
        break;
      case 'list': {
        const items = t.items.map((item: any) => {
          const body = blocks(item.tokens, ctx, maxWidth - 20);
          if (item.task) {
            // The font has no ballot boxes: a checkbox in text, on the item's first line
            const box = { text: item.checked ? '[x] ' : '[ ] ', font: 'Courier' };
            const first = body[0] as { text?: unknown } | undefined;
            if (first && Array.isArray(first.text)) first.text.unshift(box);
            else body.unshift({ text: [box] });
          }
          return body.length === 1 ? body[0] : { stack: body };
        });
        out.push(t.ordered ? { ol: items, start: Number(t.start) || 1, margin: [0, 0, 0, 8] } : { ul: items, margin: [0, 0, 0, 8] });
        break;
      }
      case 'code':
        out.push({
          table: { widths: ['*'], body: [[{ text: t.text, font: 'Courier', fontSize: 9, preserveLeadingSpaces: true, lineHeight: 1.15 }]] },
          layout: {
            fillColor: () => '#F6F8FA',
            hLineWidth: () => 0,
            vLineWidth: () => 0,
            paddingLeft: () => 8,
            paddingRight: () => 8,
            paddingTop: () => 6,
            paddingBottom: () => 6,
          },
          margin: [0, 2, 0, 10],
        });
        break;
      case 'blockquote':
        out.push({
          table: { widths: ['*'], body: [[{ stack: blocks(t.tokens, ctx, maxWidth - 20), color: '#57606A' }]] },
          layout: {
            hLineWidth: () => 0,
            vLineWidth: (i: number) => (i === 0 ? 3 : 0),
            vLineColor: () => '#D0D7DE',
            paddingLeft: () => 10,
          },
          margin: [0, 0, 0, 8],
        });
        break;
      case 'table': {
        const header = t.header.map((c: any) => ({ text: inline(c.tokens, ctx), bold: true, fillColor: '#F6F8FA', alignment: c.align ?? 'left' }));
        const rows = t.rows.map((r: any[]) => r.map((c: any) => ({ text: inline(c.tokens, ctx), alignment: c.align ?? 'left' })));
        out.push({
          table: { headerRows: 1, widths: header.map(() => '*'), body: [header, ...rows], dontBreakRows: true },
          layout: {
            hLineWidth: () => 0.5,
            vLineWidth: () => 0.5,
            hLineColor: () => '#D0D7DE',
            vLineColor: () => '#D0D7DE',
            paddingLeft: () => 5,
            paddingRight: () => 5,
            paddingTop: () => 3,
            paddingBottom: () => 3,
          },
          fontSize: 9.5,
          margin: [0, 2, 0, 10],
        });
        break;
      }
      case 'hr':
        out.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: maxWidth, y2: 0, lineWidth: 0.5, lineColor: '#D0D7DE' }], margin: [0, 8, 0, 12] });
        break;
      case 'html':
        if (String(t.text).trim()) out.push({ text: decode(String(t.text).replace(/<[^>]+>/g, '')), margin: [0, 0, 0, 8] });
        break;
      default:
        if (t.tokens) out.push(...blocks(t.tokens, ctx, maxWidth));
        else if (t.text) out.push({ text: decode(String(t.text)) });
    }
  }
  return out;
}

const PAGE_WIDTH_PT: Record<PageSize, [number, number]> = { A4: [595.28, 841.89], Letter: [612, 792], Legal: [612, 1008] };

/** Lay out Markdown as a PDF with pdfmake (no browser needed). */
export const markdownToPdfInProcess: MarkdownPdfRenderer = async (markdown, opts, images) => {
  const pdfmake = getPdfmake();
  const margin = 56;
  const [w, h] = PAGE_WIDTH_PT[opts.pageSize];
  const pageWidth = opts.landscape ? h : w;
  const tokens = getMarked().marked.lexer(markdown, { gfm: true });
  const doc = {
    pageSize: opts.pageSize,
    pageOrientation: opts.landscape ? 'landscape' : 'portrait',
    pageMargins: [margin, margin, margin, margin],
    info: { title: opts.title ?? '', creator: 'Claudia', producer: 'Claudia' },
    content: blocks(tokens, { images }, pageWidth - 2 * margin),
    footer:
      opts.pageNumbers === false
        ? undefined
        : (page: number, pages: number) => ({ text: `${page} / ${pages}`, alignment: 'center', fontSize: 8, color: '#8C959F', margin: [0, 20, 0, 0] }),
    defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.25, color: '#1F2328' },
    styles: {
      h1: { fontSize: 22, bold: true, margin: [0, 10, 0, 8] },
      h2: { fontSize: 17, bold: true, margin: [0, 10, 0, 6] },
      h3: { fontSize: 14, bold: true, margin: [0, 8, 0, 4] },
      h4: { fontSize: 12, bold: true, margin: [0, 6, 0, 4] },
      h5: { fontSize: 11, bold: true, margin: [0, 6, 0, 4] },
      h6: { fontSize: 10.5, bold: true, color: '#57606A', margin: [0, 6, 0, 4] },
    },
  };
  return Buffer.from(await pdfmake.createPdf(doc).getBuffer());
};

// ============================================================================
// Choosing the route
// ============================================================================

export interface PdfRenderers {
  /** Chromium (desktop); null where there is no browser. */
  html: HtmlPdfRenderer | null;
  markdown: MarkdownPdfRenderer;
}

/** Renderers for a built-in server: the web server injects a worker-pool Markdown renderer. */
export function pdfRenderers(config?: Record<string, unknown>): PdfRenderers {
  return {
    html: (config?.renderHtmlPdf as HtmlPdfRenderer | undefined) ?? getHtmlPdfRenderer(),
    markdown: (config?.renderMarkdownPdf as MarkdownPdfRenderer | undefined) ?? markdownToPdfInProcess,
  };
}

export interface RenderedPdf {
  data: Buffer;
  /** Something the user should know about the result. */
  warning?: string;
}

/**
 * Render Markdown or HTML. `resolveImage` turns an image reference into a
 * data: URL (undefined when it can't be used); `baseDir` is where relative
 * references point on the Chromium route.
 */
export async function renderPdf(
  input: { markdown: string } | { html: string },
  opts: PdfOptions,
  renderers: PdfRenderers,
  resolveImage: (ref: string) => string | undefined,
  baseDir?: string
): Promise<RenderedPdf> {
  if (renderers.html) {
    const html = 'html' in input ? wrapHtml(input.html, opts.title) : markdownToHtml(input.markdown, opts.title);
    return { data: await renderers.html(html, { ...opts, baseDir }) };
  }
  const markdown = 'markdown' in input ? input.markdown : htmlToMarkdown(input.html);
  const images: Record<string, string> = {};
  const skipped: string[] = [];
  for (const ref of markdownImageRefs(markdown)) {
    const url = resolveImage(ref);
    if (url) images[ref] = url;
    else skipped.push(ref);
  }
  const data = await renderers.markdown(markdown, opts, images);
  const notes: string[] = [];
  if ('html' in input) notes.push('The HTML was converted to plain document formatting (headings, lists, tables); its CSS was not applied.');
  if (hasUncoveredCharacters(markdown)) notes.push('Some characters (for example Arabic, Chinese or emoji) cannot be shown by the PDF font here.');
  if (skipped.length) notes.push(`Images left out (only local PNG, JPEG and SVG files are used): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}`);
  return { data, ...(notes.length ? { warning: notes.join(' ') } : {}) };
}
