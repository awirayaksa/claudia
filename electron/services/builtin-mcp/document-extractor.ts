/**
 * Text extraction from office documents and PDFs.
 *
 * The desktop parses in-process with the parsers below (loaded on first use).
 * The web server injects its own extractor that parses in a worker pool with
 * time, memory and zip-size limits, so this module's parsers never load there.
 */

export interface DocumentExtractor {
  /** Text of every page, in order. */
  pdf(buffer: Buffer): Promise<{ pages: string[] }>;
  docx(buffer: Buffer): Promise<{ text: string; warnings: string[] }>;
  /** Every sheet as tab-separated rows. */
  xlsx(buffer: Buffer): Promise<{ sheets: Array<{ name: string; tsv: string }> }>;
  /** Text of every slide, ordered by slide number. */
  pptx(buffer: Buffer): Promise<{ slides: Array<{ num: number; text: string }> }>;
}

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Slide XML entries (ppt/slides/slideN.xml) sorted by N. */
export function slideEntries(names: string[]): Array<{ num: number; name: string }> {
  return names
    .map((name) => {
      const m = name.match(/^ppt\/slides\/slide(\d+)\.xml$/);
      return m ? { num: parseInt(m[1], 10), name } : null;
    })
    .filter((s): s is { num: number; name: string } => s !== null)
    .sort((a, b) => a.num - b.num);
}

/** Text runs (<a:t>) of one slide's XML. */
export function slideText(xml: string): string {
  const texts: string[] = [];
  const regex = /<a:t>([\s\S]*?)<\/a:t>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) texts.push(decodeXmlEntities(match[1]));
  return texts.join(' ');
}

/** The desktop's extractor: pdf-parse, mammoth, SheetJS and JSZip in this process. */
export function inProcessExtractor(): DocumentExtractor {
  return {
    async pdf(buffer) {
      const pdfParse = require('pdf-parse');
      const pages: string[] = [];
      // pdf-parse's pdf.js reads the whole underlying ArrayBuffer and ignores
      // byteOffset, so hand it a copy that owns its memory
      await pdfParse(new Uint8Array(buffer), {
        // Same layout as pdf-parse's own renderer: a new line when the baseline moves
        pagerender: (pageData: any) =>
          pageData.getTextContent().then((tc: any) => {
            let text = '';
            let lastY: number | undefined;
            for (const item of tc.items) {
              const y = item.transform[5];
              text += lastY === undefined || lastY === y ? item.str : `\n${item.str}`;
              lastY = y;
            }
            pages.push(text);
            return text;
          }),
      });
      return { pages };
    },
    async docx(buffer) {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return {
        text: result.value,
        warnings: result.messages.filter((m: any) => m.type === 'warning').map((m: any) => m.message),
      };
    },
    async xlsx(buffer) {
      const XLSX = require('xlsx');
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      return {
        sheets: (workbook.SheetNames as string[]).map((name) => ({
          name,
          tsv: XLSX.utils.sheet_to_csv(workbook.Sheets[name], { FS: '\t' }),
        })),
      };
    },
    async pptx(buffer) {
      const JSZip = require('jszip');
      const zip = await JSZip.loadAsync(buffer);
      const names: string[] = [];
      zip.forEach((p: string) => names.push(p));
      const slides: Array<{ num: number; text: string }> = [];
      for (const s of slideEntries(names)) {
        slides.push({ num: s.num, text: slideText(await zip.file(s.name)!.async('string')) });
      }
      return { slides };
    },
  };
}

// ─── Whole documents as plain text (attachments) ─────────────────────────────

export type DocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml',
  '.html', '.htm', '.log', '.ini', '.toml', '.cfg', '.conf', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.kt', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.sh', '.bash', '.ps1', '.bat', '.sql', '.css', '.scss',
  '.vue', '.svelte', '.r', '.lua', '.pl', '.tex',
]);

function extname(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** Which parser a file needs, from its name and MIME type; null when unsupported. */
export function detectDocumentFormat(name: string, mimeType = ''): DocumentFormat | null {
  const ext = extname(name);
  if (ext === '.pdf' || mimeType === 'application/pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx' || ext === '.xls') return 'xlsx';
  if (ext === '.pptx') return 'pptx';
  if (TEXT_EXTENSIONS.has(ext) || mimeType.startsWith('text/') || mimeType === 'application/json') return 'text';
  return null;
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The whole document as one text, with sheet and slide headings. */
export async function documentToText(
  extractor: DocumentExtractor,
  buffer: Buffer,
  format: DocumentFormat
): Promise<string> {
  switch (format) {
    case 'pdf':
      return (await extractor.pdf(buffer)).pages.join('\n\n');
    case 'docx':
      return (await extractor.docx(buffer)).text;
    case 'xlsx':
      return (await extractor.xlsx(buffer)).sheets.map((s) => `--- Sheet: ${s.name} ---\n${s.tsv}`).join('\n\n');
    case 'pptx':
      return (await extractor.pptx(buffer)).slides.map((s) => `--- Slide ${s.num} ---\n${s.text}`).join('\n\n');
    case 'text':
      return stripBom(buffer.toString('utf-8'));
  }
}
