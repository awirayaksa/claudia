/**
 * Worker-thread pool for parsing untrusted documents (piscina). Each job has
 * a timeout (the thread is terminated), the threads have a heap limit, and
 * inputs are size-checked before they are sent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Piscina } from 'piscina';
import type { DocumentExtractor } from '../../../electron/services/builtin-mcp/document-extractor';
import { detectDocumentFormat, documentToText, type DocumentFormat } from '../../../electron/services/builtin-mcp/document-extractor';
import { EXTRACT_LIMITS, ExtractLimitError } from './limits';
import type { ExtractTask } from './worker';
import type { PdfOptions } from '../../../electron/services/builtin-mcp/pdf-render';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The bundled worker next to the server bundle, or the TypeScript source (loaded with tsx). */
function workerLocation(): { filename: string; execArgv: string[] } {
  const bundled = path.join(here, 'extract-worker.cjs');
  if (fs.existsSync(bundled)) return { filename: bundled, execArgv: [] };
  return { filename: path.join(here, 'worker.ts'), execArgv: ['--import', 'tsx'] };
}

export interface ExtractPoolOptions {
  maxThreads?: number;
  timeoutMs?: number;
  maxHeapMb?: number;
  maxInputBytes?: number;
}

export interface ExtractedDocument {
  text: string;
  truncated: boolean;
  format: DocumentFormat | 'html';
}

export class ExtractPool {
  private readonly pool: Piscina;
  private readonly timeoutMs: number;
  private readonly maxInputBytes: number;

  constructor(opts: ExtractPoolOptions = {}) {
    const { filename, execArgv } = workerLocation();
    this.timeoutMs = opts.timeoutMs ?? EXTRACT_LIMITS.timeoutMs;
    this.maxInputBytes = opts.maxInputBytes ?? EXTRACT_LIMITS.maxInputBytes;
    this.pool = new Piscina({
      filename,
      execArgv,
      minThreads: 0,
      maxThreads: opts.maxThreads ?? 2,
      idleTimeout: 60_000,
      resourceLimits: { maxOldGenerationSizeMb: opts.maxHeapMb ?? EXTRACT_LIMITS.maxHeapMb },
    });
  }

  /** Run one task; a timeout or a worker crash becomes an ExtractLimitError. */
  async run<T>(task: ExtractTask, timeoutMs = this.timeoutMs): Promise<T> {
    if ('data' in task && task.data.byteLength > this.maxInputBytes) {
      throw new ExtractLimitError(`The file is larger than ${Math.round(this.maxInputBytes / (1024 * 1024))} MB.`);
    }
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return (await this.pool.run(task, { signal })) as T;
    } catch (err) {
      if (signal.aborted) throw new ExtractLimitError(`Reading the file took longer than ${Math.round(timeoutMs / 1000)} seconds.`);
      const e = err as Error & { code?: string };
      if (e?.code === 'ERR_WORKER_OUT_OF_MEMORY' || /out of memory/i.test(e?.message ?? '')) {
        throw new ExtractLimitError('The file needs too much memory to read.');
      }
      if (e?.name === 'ExtractLimitError' || e?.message?.startsWith('The document')) throw new ExtractLimitError(e.message);
      throw err;
    }
  }

  /** For the filesystem built-in server. */
  extractor(): DocumentExtractor {
    const data = (b: Buffer) => new Uint8Array(b);
    return {
      pdf: (b) => this.run({ op: 'pdf', data: data(b) }),
      docx: (b) => this.run({ op: 'docx', data: data(b) }),
      xlsx: (b) => this.run({ op: 'xlsx', data: data(b) }),
      pptx: (b) => this.run({ op: 'pptx', data: data(b) }),
    };
  }

  /** Plain text of an uploaded file; null format = unsupported. */
  async documentText(buffer: Buffer, name: string, mime = ''): Promise<ExtractedDocument | null> {
    if (buffer.byteLength > this.maxInputBytes) {
      throw new ExtractLimitError(`The file is larger than ${Math.round(this.maxInputBytes / (1024 * 1024))} MB.`);
    }
    let text: string;
    let format: ExtractedDocument['format'];
    if (mime === 'text/html' || /\.html?$/i.test(name)) {
      const res = await this.run<{ title: string | null; markdown: string }>({ op: 'html', html: buffer.toString('utf-8') });
      text = res.title ? `# ${res.title}\n\n${res.markdown}` : res.markdown;
      format = 'html';
    } else {
      const detected = detectDocumentFormat(name, mime);
      if (!detected) return null;
      text = await documentToText(this.extractor(), buffer, detected);
      format = detected;
    }
    text = text.trim();
    const truncated = text.length > EXTRACT_LIMITS.maxTextChars;
    return { text: truncated ? text.slice(0, EXTRACT_LIMITS.maxTextChars) : text, truncated, format };
  }

  renderSvg(source: string, engine: string): Promise<string> {
    return this.run({ op: 'dot', source, engine }, 20_000);
  }

  async svgToPng(svg: string, scale: number): Promise<Buffer> {
    return Buffer.from(await this.run<Uint8Array>({ op: 'png', svg, scale }, 20_000));
  }

  /** Markdown laid out as a PDF (PDF and Word built-ins; there is no browser on the server). */
  async renderMarkdownPdf(markdown: string, options: PdfOptions, images: Record<string, string>): Promise<Buffer> {
    const size = markdown.length + Object.values(images).reduce((n, u) => n + u.length, 0);
    if (size > this.maxInputBytes * 2) {
      throw new ExtractLimitError(`The document and its images are larger than ${Math.round((this.maxInputBytes * 2) / (1024 * 1024))} MB.`);
    }
    return Buffer.from(await this.run<Uint8Array>({ op: 'mdpdf', markdown, options, images }, 60_000));
  }

  /** A fetched page's main content as markdown (fetch built-in). */
  htmlToMarkdown(html: string, url: string): Promise<{ title: string | null; markdown: string }> {
    return this.run({ op: 'html', html, url });
  }

  async close(): Promise<void> {
    await this.pool.destroy();
  }
}
