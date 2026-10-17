/**
 * Text extraction for chat attachments (desktop, main process).
 *
 * The renderer sends the file bytes; this returns plain text that is inlined
 * into the user message, so non-image attachments actually reach the model.
 */
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require('pdf-parse');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mammoth = require('mammoth');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const XLSX = require('xlsx');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const JSZip = require('jszip');

/** Largest input accepted, matching the chat input's drop limit. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Extracted text beyond this is cut off (roughly 50k tokens). */
export const MAX_EXTRACTED_CHARS = 200_000;

export interface ExtractTextRequest {
  name: string;
  mimeType?: string;
  data: Uint8Array;
}

export interface ExtractTextResult {
  text: string;
  truncated: boolean;
  format: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text';
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml',
  '.html', '.htm', '.log', '.ini', '.toml', '.cfg', '.conf', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.kt', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.sh', '.bash', '.ps1', '.bat', '.sql', '.css', '.scss',
  '.vue', '.svelte', '.r', '.lua', '.pl', '.tex',
]);

export class UnsupportedAttachmentError extends Error {
  constructor(name: string) {
    super(`Can't read text from "${name}". Supported: PDF, DOCX, XLSX, PPTX and text files.`);
    this.name = 'UnsupportedAttachmentError';
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function detectFormat(name: string, mimeType = ''): ExtractTextResult['format'] | null {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf' || mimeType === 'application/pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx' || ext === '.xls') return 'xlsx';
  if (ext === '.pptx') return 'pptx';
  if (TEXT_EXTENSIONS.has(ext) || mimeType.startsWith('text/') || mimeType === 'application/json') return 'text';
  return null;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Text of every slide, in order, from a .pptx buffer. */
export async function extractPptxSlides(buffer: Buffer): Promise<Array<{ num: number; text: string }>> {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles: Array<{ num: number; name: string }> = [];
  zip.forEach((relativePath: string) => {
    const match = relativePath.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (match) slideFiles.push({ num: parseInt(match[1], 10), name: relativePath });
  });
  slideFiles.sort((a, b) => a.num - b.num);

  const slides: Array<{ num: number; text: string }> = [];
  for (const slide of slideFiles) {
    const xml: string = await zip.file(slide.name)!.async('string');
    const texts: string[] = [];
    const regex = /<a:t>([\s\S]*?)<\/a:t>/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      texts.push(decodeXmlEntities(match[1]));
    }
    slides.push({ num: slide.num, text: texts.join(' ') });
  }
  return slides;
}

async function extractRaw(buffer: Buffer, format: ExtractTextResult['format']): Promise<string> {
  switch (format) {
    case 'pdf': {
      // pdf-parse's pdf.js reads the whole underlying ArrayBuffer and ignores
      // byteOffset, so a pooled or sliced Buffer shifts every offset. Hand it
      // a copy that owns its memory.
      const result = await pdfParse(new Uint8Array(buffer));
      return result.text;
    }
    case 'docx': {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    case 'xlsx': {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      return (workbook.SheetNames as string[])
        .map((sheet) => `--- Sheet: ${sheet} ---\n${XLSX.utils.sheet_to_csv(workbook.Sheets[sheet], { FS: '\t' })}`)
        .join('\n\n');
    }
    case 'pptx': {
      const slides = await extractPptxSlides(buffer);
      return slides.map((s) => `--- Slide ${s.num} ---\n${s.text}`).join('\n\n');
    }
    case 'text':
      // Strip a UTF-8 BOM if present
      return stripBom(buffer.toString('utf-8'));
  }
}

export async function extractText(
  req: ExtractTextRequest,
  maxChars = MAX_EXTRACTED_CHARS
): Promise<ExtractTextResult> {
  if (req.data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`"${req.name}" is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`);
  }
  const format = detectFormat(req.name, req.mimeType);
  if (!format) {
    throw new UnsupportedAttachmentError(req.name);
  }

  const buffer = Buffer.from(req.data.buffer, req.data.byteOffset, req.data.byteLength);
  const raw = (await extractRaw(buffer, format)).trim();
  const truncated = raw.length > maxChars;
  return { text: truncated ? raw.slice(0, maxChars) : raw, truncated, format };
}
