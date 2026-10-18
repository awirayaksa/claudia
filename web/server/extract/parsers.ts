/**
 * Document parsers for the web server. They run inside the extraction
 * worker (extract/worker.ts), never on the main thread.
 *
 * - PDF: pdf.js through unpdf (not pdf-parse, which is unmaintained and
 *   bundles a 2018 pdf.js). This pdf.js has no eval / new Function path at
 *   all, so the old isEvalSupported switch no longer exists.
 * - XLSX: SheetJS from its official CDN build (0.20.3+; the npm 0.18.5 build
 *   has CVE-2023-30533 and CVE-2024-22363).
 * - DOCX: mammoth; PPTX: JSZip. Zip formats are inspected first (limits.ts).
 * - HTML: jsdom (scripts never run) + readability + turndown.
 */
import { slideEntries, slideText } from '../../../electron/services/builtin-mcp/document-extractor';
import { inspectZip } from './limits';

export async function parsePdf(buffer: Buffer): Promise<{ pages: string[] }> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer), { disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    return { pages: text };
  } finally {
    await pdf.cleanup().catch(() => {});
  }
}

export async function parseDocx(buffer: Buffer): Promise<{ text: string; warnings: string[] }> {
  inspectZip(buffer);
  const mammoth = await import('mammoth');
  const result = await (mammoth.default ?? mammoth).extractRawText({ buffer });
  return {
    text: result.value,
    warnings: result.messages.filter((m: { type: string }) => m.type === 'warning').map((m: { message: string }) => m.message),
  };
}

export async function parseXlsx(buffer: Buffer): Promise<{ sheets: Array<{ name: string; tsv: string }> }> {
  inspectZip(buffer);
  const XLSX = await import('xlsx');
  const lib = (XLSX as any).default ?? XLSX;
  // No formula evaluation, no external links; values only
  const workbook = lib.read(buffer, { type: 'buffer', cellFormula: false, cellHTML: false, bookVBA: false });
  return {
    sheets: (workbook.SheetNames as string[]).map((name) => ({
      name,
      tsv: lib.utils.sheet_to_csv(workbook.Sheets[name], { FS: '\t' }),
    })),
  };
}

export async function parsePptx(buffer: Buffer): Promise<{ slides: Array<{ num: number; text: string }> }> {
  inspectZip(buffer);
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const names: string[] = [];
  zip.forEach((p) => names.push(p));
  const slides: Array<{ num: number; text: string }> = [];
  for (const s of slideEntries(names)) {
    slides.push({ num: s.num, text: slideText(await zip.file(s.name)!.async('string')) });
  }
  return { slides };
}

/** HTML → markdown of the main content. */
export async function parseHtml(html: string, url?: string): Promise<{ title: string | null; markdown: string }> {
  const { JSDOM } = await import('jsdom');
  const { Readability } = await import('@mozilla/readability');
  const { default: TurndownService } = await import('turndown');
  // @ts-expect-error: no types for the GFM plugin
  const { gfm } = await import('turndown-plugin-gfm');
  const dom = new JSDOM(html, { url: url ?? 'https://example.invalid/' });
  try {
    const article = new Readability(dom.window.document).parse();
    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    turndown.use(gfm);
    const body = article?.content ?? dom.window.document.body?.innerHTML ?? '';
    return { title: article?.title ?? dom.window.document.title ?? null, markdown: turndown.turndown(body) };
  } finally {
    dom.window.close();
  }
}

/** SVG → PNG with sharp; the output size is capped. */
export async function svgToPng(svg: string, scale: number): Promise<Uint8Array> {
  const { default: sharp } = await import('sharp');
  const density = Math.round(72 * Math.min(Math.max(scale, 0.5), 8));
  // limitInputPixels guards against an SVG declaring an enormous canvas
  return new Uint8Array(await sharp(Buffer.from(svg), { density, limitInputPixels: 50_000_000 }).png().toBuffer());
}

/** DOT → SVG with Graphviz (WASM). */
export async function renderDot(source: string, engine: string): Promise<string> {
  const { instance } = await import('@viz-js/viz');
  const viz = await instance();
  return viz.renderString(source, { format: 'svg', engine });
}
