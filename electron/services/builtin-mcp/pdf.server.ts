import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { atomicWrite, errorResult, fileScope, resolveFile, withFileLock, wroteFiles, type FileScope } from './office-files';
import { PAGE_SIZES, pdfRenderers, renderPdf, type PdfOptions, type PdfRenderers } from './pdf-render';
import { officeAsHtml, officeKind, officeToPdf } from './office-convert';

const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;

/** Image references → data: URLs. Local files only (in the scope); nothing is downloaded. */
export function imageResolver(scope: FileScope, baseDir: string) {
  return (ref: string): string | undefined => {
    if (/^data:image\/(png|jpe?g|svg\+xml);/i.test(ref)) return ref;
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^file:/i.test(ref) && !/^[a-z]:[\\/]/i.test(ref)) return undefined;
    try {
      let p = ref.startsWith('file:') ? fileURLToPath(ref) : ref;
      try {
        p = decodeURIComponent(p);
      } catch {
        /* keep as written */
      }
      const resolved = resolveFile(scope, path.isAbsolute(p) ? p : path.join(baseDir, p));
      const mime = IMAGE_MIME[path.extname(resolved).toLowerCase()];
      if (!mime || fs.statSync(resolved).size > MAX_IMAGE_BYTES) return undefined;
      return `data:${mime};base64,${fs.readFileSync(resolved).toString('base64')}`;
    } catch {
      return undefined;
    }
  };
}

/** Office documents → PDF: Microsoft Office or LibreOffice, else an approximate route through HTML. */
export async function convertOfficeToPdf(
  src: string,
  out: string,
  opts: { useLibreOffice: boolean; renderers: PdfRenderers; scope: FileScope; pdf: PdfOptions }
): Promise<string> {
  const via = await officeToPdf(src, out, { useLibreOffice: opts.useLibreOffice });
  if (via) return `Converted ${src} to ${out} with ${via}.`;
  const { html, note } = await officeAsHtml(src);
  const { data, warning } = await renderPdf({ html }, opts.pdf, opts.renderers, imageResolver(opts.scope, path.dirname(src)), path.dirname(src));
  await atomicWrite(out, data);
  return (
    `Converted ${src} to ${out} without Microsoft Office or LibreOffice (approximate: ${note}). ` +
    `For an exact copy, install LibreOffice.${warning ? `\n${warning}` : ''}`
  );
}

export function createPdfServer(config?: Record<string, unknown>): McpServer {
  const server = new McpServer({ name: 'Claudia PDF', version: '1.0.0' }, { capabilities: { tools: {} } });
  const scope = fileScope(config);
  const renderers = pdfRenderers(config);
  const useLibreOffice = config?.useLibreOffice !== false;

  const pageParams = {
    title: z.string().optional().describe('Document title (PDF properties).'),
    page_size: z.enum(PAGE_SIZES).optional().describe('Default A4.'),
    landscape: z.boolean().optional(),
    page_numbers: z.boolean().optional().describe('Page numbers in the footer (default true).'),
  };

  // ---- create_pdf ----
  server.tool(
    'create_pdf',
    'Create a PDF from Markdown (headings, lists, tables, code, quotes, links, local images) or HTML. Write the whole ' +
      'document in one call. Use it for reports, letters, handouts and anything the user wants to print or share as PDF.',
    {
      filename: z.string().describe('Output path, e.g. "report.pdf" (relative to the working directory).'),
      content: z.string().describe('The document, in Markdown (default) or HTML.'),
      format: z.enum(['markdown', 'html']).optional(),
      ...pageParams,
      overwrite: z.boolean().optional().describe('Replace the file if it exists (default: false).'),
    },
    async ({ filename, content, format, title, page_size, landscape, page_numbers, overwrite }) => {
      if (content.length > MAX_TEXT_CHARS) return errorResult('The content is too long for one PDF (2 million characters at most).');
      const out = resolveFile(scope, filename, '.pdf');
      if (!overwrite && fs.existsSync(out)) return errorResult(`${out} already exists. Pass overwrite: true to replace it.`);
      const opts: PdfOptions = { pageSize: page_size ?? 'A4', landscape: !!landscape, title, pageNumbers: page_numbers };
      return withFileLock(out, async () => {
        const input = format === 'html' ? { html: content } : { markdown: content };
        const { data, warning } = await renderPdf(input, opts, renderers, imageResolver(scope, scope.workingDir), scope.workingDir);
        await atomicWrite(out, data);
        return wroteFiles(`Created ${out} (${Math.max(1, Math.round(data.length / 1024))} KB).${warning ? `\n${warning}` : ''}`, out);
      });
    }
  );

  // ---- convert_file_to_pdf ----
  server.tool(
    'convert_file_to_pdf',
    'Convert a file to PDF: Word, Excel, PowerPoint and OpenDocument files (with Microsoft Office on Windows or ' +
      'LibreOffice when installed; otherwise an approximate conversion), and Markdown, HTML or text files.',
    {
      filename: z.string().describe('Source file, e.g. "report.docx", "budget.xlsx", "deck.pptx", "notes.md".'),
      output_filename: z.string().optional().describe('Output path (default: the source name with .pdf).'),
      ...pageParams,
    },
    async ({ filename, output_filename, title, page_size, landscape, page_numbers }) => {
      const src = resolveFile(scope, filename);
      if (!fs.existsSync(src)) return errorResult(`File not found: ${src}`);
      const out = output_filename ? resolveFile(scope, output_filename, '.pdf') : src.replace(/\.[^./\\]+$/, '') + '.pdf';
      if (path.resolve(out) === path.resolve(src)) return errorResult('The output must differ from the source.');
      const opts: PdfOptions = { pageSize: page_size ?? 'A4', landscape: !!landscape, title: title ?? path.parse(src).name, pageNumbers: page_numbers };
      const ext = path.extname(src).toLowerCase();

      return withFileLock(out, async () => {
        if (officeKind(src)) {
          const text = await convertOfficeToPdf(src, out, { useLibreOffice, renderers, scope, pdf: opts });
          return wroteFiles(text, out);
        }
        if (!['.md', '.markdown', '.txt', '.html', '.htm'].includes(ext)) {
          return errorResult(`Can't convert ${ext || 'this'} files. Supported: Office documents, Markdown, HTML and text.`);
        }
        const text = await fs.promises.readFile(src, 'utf-8');
        if (text.length > MAX_TEXT_CHARS) return errorResult('The file is too long for one PDF (2 million characters at most).');
        const input =
          ext === '.html' || ext === '.htm' ? { html: text } : ext === '.txt' ? { markdown: '```text\n' + text.replace(/```/g, '`\u200b``') + '\n```' } : { markdown: text };
        const { data, warning } = await renderPdf(input, opts, renderers, imageResolver(scope, path.dirname(src)), path.dirname(src));
        await atomicWrite(out, data);
        return wroteFiles(`Converted ${src} to ${out}.${warning ? `\n${warning}` : ''}`, out);
      });
    }
  );

  return server;
}
