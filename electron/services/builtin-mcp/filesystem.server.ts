import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require('pdf-parse');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mammoth = require('mammoth');

// Maximum text content size (in bytes) to return in a single tool response.
// Stays well below the ~8 MB API input limit to leave room for conversation context.
const MAX_READ_SIZE = 5 * 1024 * 1024; // 5 MB

// ============================================================================
// Security: Path Validation
// ============================================================================

function normalizePath(p: string): string {
  return path.resolve(p).toLowerCase();
}

function isPathAllowed(targetPath: string, allowedDirs: string[]): boolean {
  const resolved = normalizePath(targetPath);
  return allowedDirs.some((dir) => {
    const normalizedDir = normalizePath(dir);
    return resolved === normalizedDir || resolved.startsWith(normalizedDir + path.sep);
  });
}

function assertPathAllowed(targetPath: string, allowedDirs: string[]): void {
  if (!isPathAllowed(targetPath, allowedDirs)) {
    throw new Error(
      `Access denied: "${targetPath}" is outside allowed directories.\n` +
      `Allowed: ${allowedDirs.join(', ')}`
    );
  }
}

/**
 * Resolve a requested path against the allowed directories.
 *
 * The model often sends root-relative paths like "/hello.txt" or bare names
 * like "hello.txt" when a working directory is configured. This function
 * first tries the path as an absolute path; if it falls outside every allowed
 * directory it retries by stripping leading separators and joining with the
 * first allowed directory (i.e. the configured working directory).
 */
function resolveRequestedPath(requestedPath: string, allowedDirs: string[]): string {
  const absoluteResolved = path.resolve(requestedPath);

  if (allowedDirs.length === 0 || isPathAllowed(absoluteResolved, allowedDirs)) {
    return absoluteResolved;
  }

  // Fall back: treat as relative to the working directory (first allowed dir)
  const stripped = requestedPath.replace(/^[/\\]+/, '');
  if (stripped) {
    const relativeResolved = path.resolve(allowedDirs[0], stripped);
    if (isPathAllowed(relativeResolved, allowedDirs)) {
      return relativeResolved;
    }
  }

  return absoluteResolved; // Will fail assertPathAllowed with a clear error
}

function getDefaultAllowedDirectories(): string[] {
  return [];
}

// ============================================================================
// Helper: Recursive file search
// ============================================================================

async function searchFilesRecursive(
  dir: string,
  pattern: string,
  allowedDirs: string[],
  results: string[] = [],
  maxResults: number = 500
): Promise<string[]> {
  if (results.length >= maxResults) return results;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  const lowerPattern = pattern.toLowerCase();

  for (const entry of entries) {
    if (results.length >= maxResults) break;

    const fullPath = path.join(dir, entry.name);

    if (!isPathAllowed(fullPath, allowedDirs)) continue;

    if (entry.name.toLowerCase().includes(lowerPattern)) {
      results.push(fullPath);
    }

    if (entry.isDirectory()) {
      await searchFilesRecursive(fullPath, pattern, allowedDirs, results, maxResults);
    }
  }

  return results;
}

// ============================================================================
// Helper: Line-based file reading for large files
// ============================================================================

async function countFileLines(filePath: string): Promise<number> {
  const content = await fs.promises.readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  return lines.length;
}

async function readFileLines(
  filePath: string,
  startLine: number,
  maxLines: number,
  encoding: BufferEncoding = 'utf-8'
): Promise<string> {
  const content = await fs.promises.readFile(filePath, { encoding });
  const lines = content.split('\n');
  const totalLines = lines.length;
  const endLine = Math.min(startLine + maxLines - 1, totalLines);
  const selected = lines.slice(startLine - 1, endLine);

  const header = `Lines ${startLine}-${endLine} of ${totalLines} total\n` +
    `${'='.repeat(40)}\n`;
  return header + selected.join('\n');
}

// ============================================================================
// Server Factory
// ============================================================================

export function createFilesystemServer(config?: Record<string, unknown>): McpServer {
  const allowedDirs: string[] =
    (config?.allowedDirectories as string[]) || getDefaultAllowedDirectories();

  const server = new McpServer(
    { name: 'Claudia Filesystem', version: '1.0.0' },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ---- read_file ----
  server.tool(
    'read_file',
    'Read the contents of a text file. For PDF files, use the dedicated read_pdf tool instead. ' +
    'If the file is larger than 5 MB, you must provide start_line and max_lines to read a portion. ' +
    'Paths are resolved relative to the configured working directory.',
    {
      path: z.string().describe('Path to the file. Can be an absolute path or a filename/relative path resolved against the working directory.'),
      encoding: z.string().optional().describe('File encoding (default: utf-8)'),
      start_line: z.number().optional().describe('Line number to start reading from (1-based). Use this for large files.'),
      max_lines: z.number().optional().describe('Maximum number of lines to read. Use this for large files.'),
    },
    async ({ path: filePath, encoding, start_line, max_lines }) => {
      const resolvedPath = resolveRequestedPath(filePath, allowedDirs);
      assertPathAllowed(resolvedPath, allowedDirs);

      // Suggest dedicated tools for binary document formats
      const ext = path.extname(resolvedPath).toLowerCase();
      if (ext === '.pdf') {
        return {
          content: [{
            type: 'text' as const,
            text: `This is a PDF file. Please use the "read_pdf" tool instead of "read_file" to extract text from PDF files. ` +
              `The read_pdf tool supports page ranges for large PDFs.`,
          }],
        };
      }
      if (ext === '.docx' || ext === '.doc') {
        return {
          content: [{
            type: 'text' as const,
            text: `This is a Word document. Please use the "read_docx" tool instead of "read_file" to extract text from Word files.`,
          }],
        };
      }

      const stat = await fs.promises.stat(resolvedPath);
      const hasRange = start_line !== undefined || max_lines !== undefined;

      // If file is too large and no range was provided, return a warning
      if (stat.size > MAX_READ_SIZE && !hasRange) {
        const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
        const lineCount = await countFileLines(resolvedPath);
        return {
          content: [{
            type: 'text' as const,
            text: `⚠ File is too large to read at once (${sizeMB} MB, ~${lineCount} lines). ` +
              `The API has an ~8 MB total input limit.\n\n` +
              `To read this file, use the start_line and max_lines parameters to read it in chunks. ` +
              `For example:\n` +
              `  - start_line: 1, max_lines: 500  (read first 500 lines)\n` +
              `  - start_line: 501, max_lines: 500 (read next 500 lines)\n\n` +
              `File: ${resolvedPath}\nSize: ${sizeMB} MB\nEstimated lines: ${lineCount}`,
          }],
        };
      }

      // Read with optional line range
      if (hasRange) {
        const startLine = Math.max(1, start_line || 1);
        const maxLines = max_lines || 500;
        const text = await readFileLines(resolvedPath, startLine, maxLines, (encoding as BufferEncoding) || 'utf-8');
        return { content: [{ type: 'text' as const, text }] };
      }

      const content = await fs.promises.readFile(
        resolvedPath,
        { encoding: (encoding as BufferEncoding) || 'utf-8' }
      );
      return { content: [{ type: 'text' as const, text: content }] };
    }
  );

  // ---- read_pdf ----
  server.tool(
    'read_pdf',
    'Extract text content from a PDF file. Supports page ranges for large PDFs. ' +
    'If the PDF has many pages or is large, specify start_page and end_page to read a portion at a time. ' +
    'Paths are resolved relative to the configured working directory.',
    {
      path: z.string().describe('Path to the PDF file.'),
      start_page: z.number().optional().describe('First page to extract (1-based). Defaults to 1.'),
      end_page: z.number().optional().describe('Last page to extract (inclusive). Defaults to the last page.'),
    },
    async ({ path: filePath, start_page, end_page }) => {
      const resolvedPath = resolveRequestedPath(filePath, allowedDirs);
      assertPathAllowed(resolvedPath, allowedDirs);

      const ext = path.extname(resolvedPath).toLowerCase();
      if (ext !== '.pdf') {
        return {
          content: [{
            type: 'text' as const,
            text: `This file is not a PDF (extension: ${ext}). Use "read_file" for text files.`,
          }],
        };
      }

      const stat = await fs.promises.stat(resolvedPath);
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      const hasRange = start_page !== undefined || end_page !== undefined;

      // For large PDFs without a page range, do a metadata-only parse first to warn
      if (stat.size > MAX_READ_SIZE && !hasRange) {
        const buffer = await fs.promises.readFile(resolvedPath);
        const metaResult = await pdfParse(buffer, { max: 0 });
        const totalPages = metaResult.numpages;
        return {
          content: [{
            type: 'text' as const,
            text: `⚠ This PDF is large (${sizeMB} MB, ${totalPages} pages). ` +
              `Reading all pages at once may exceed the API's ~8 MB input limit.\n\n` +
              `Use start_page and end_page to read in chunks. For example:\n` +
              `  - start_page: 1, end_page: 20\n` +
              `  - start_page: 21, end_page: 40\n\n` +
              `PDF info:\n` +
              `  File: ${resolvedPath}\n` +
              `  File size: ${sizeMB} MB\n` +
              `  Total pages: ${totalPages}`,
          }],
        };
      }

      const buffer = await fs.promises.readFile(resolvedPath);

      // Parse PDF, collecting text per page so we can support page ranges
      const pages: string[] = [];
      let currentPage = 0;

      const pageRender = (pageData: any) => {
        currentPage++;
        return pageData.getTextContent().then((textContent: any) => {
          const pageText = textContent.items
            .map((item: any) => item.str)
            .join('');
          pages.push(pageText);
          return pageText;
        });
      };

      const result = await pdfParse(buffer, { pagerender: pageRender });
      const totalPages = result.numpages;

      // Determine page range
      const firstPage = Math.max(1, start_page || 1);
      const lastPage = Math.min(totalPages, end_page || totalPages);

      if (firstPage > totalPages) {
        return {
          content: [{
            type: 'text' as const,
            text: `PDF has ${totalPages} page(s). Requested start_page ${firstPage} is out of range.`,
          }],
        };
      }

      let text: string;
      if (!hasRange) {
        // Full document — use the combined text from pdf-parse
        text = result.text;
      } else {
        // Extract only the requested page range
        const selectedPages = pages
          .slice(firstPage - 1, lastPage)
          .map((pageText, i) => `--- Page ${firstPage + i} ---\n${pageText}`);
        text = selectedPages.join('\n\n');
      }

      // Check if extracted text exceeds the limit
      const textBytes = Buffer.byteLength(text, 'utf-8');
      if (textBytes > MAX_READ_SIZE) {
        const suggestedChunkSize = Math.max(1, Math.floor((lastPage - firstPage + 1) * MAX_READ_SIZE / textBytes));
        return {
          content: [{
            type: 'text' as const,
            text: `⚠ Extracted text from pages ${firstPage}-${lastPage} is too large (${(textBytes / (1024 * 1024)).toFixed(1)} MB). ` +
              `The API has an ~8 MB total input limit.\n\n` +
              `Try reading fewer pages at a time (suggest ~${suggestedChunkSize} pages per request).\n\n` +
              `PDF info:\n` +
              `  File: ${resolvedPath}\n` +
              `  File size: ${sizeMB} MB\n` +
              `  Total pages: ${totalPages}`,
          }],
        };
      }

      const header = `PDF: ${path.basename(resolvedPath)} | ${sizeMB} MB | ` +
        `Pages: ${firstPage}-${lastPage} of ${totalPages}\n` +
        `${'='.repeat(60)}\n\n`;

      return { content: [{ type: 'text' as const, text: header + text }] };
    }
  );

  // ---- read_docx ----
  server.tool(
    'read_docx',
    'Extract text content from a Microsoft Word document (.docx). ' +
    'Note: legacy .doc format is not supported — only .docx files can be read. ' +
    'Paths are resolved relative to the configured working directory.',
    {
      path: z.string().describe('Path to the .docx file.'),
    },
    async ({ path: filePath }) => {
      const resolvedPath = resolveRequestedPath(filePath, allowedDirs);
      assertPathAllowed(resolvedPath, allowedDirs);

      const ext = path.extname(resolvedPath).toLowerCase();
      if (ext === '.doc') {
        return {
          content: [{
            type: 'text' as const,
            text: `Legacy .doc format is not supported. Only .docx files can be read. ` +
              `If possible, convert the file to .docx first.`,
          }],
        };
      }
      if (ext !== '.docx') {
        return {
          content: [{
            type: 'text' as const,
            text: `This file is not a Word document (extension: ${ext}). Use "read_file" for text files or "read_pdf" for PDFs.`,
          }],
        };
      }

      const stat = await fs.promises.stat(resolvedPath);
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);

      const result = await mammoth.extractRawText({ path: resolvedPath });
      const text = result.value;

      // Check if extracted text exceeds the limit
      const textBytes = Buffer.byteLength(text, 'utf-8');
      if (textBytes > MAX_READ_SIZE) {
        return {
          content: [{
            type: 'text' as const,
            text: `⚠ Extracted text is too large (${(textBytes / (1024 * 1024)).toFixed(1)} MB). ` +
              `The API has an ~8 MB total input limit.\n\n` +
              `File: ${resolvedPath}\n` +
              `File size: ${sizeMB} MB`,
          }],
        };
      }

      const warnings = result.messages
        .filter((m: any) => m.type === 'warning')
        .map((m: any) => m.message);

      let header = `Word Document: ${path.basename(resolvedPath)} | ${sizeMB} MB\n` +
        `${'='.repeat(60)}\n`;
      if (warnings.length > 0) {
        header += `Warnings: ${warnings.join('; ')}\n`;
      }
      header += '\n';

      return { content: [{ type: 'text' as const, text: header + text }] };
    }
  );

  // ---- write_file ----
  server.tool(
    'write_file',
    'Write content to a file. Creates the file if it does not exist, overwrites if it does. Paths are resolved relative to the configured working directory.',
    {
      path: z.string().describe('Path to the file. Can be an absolute path or a filename/relative path resolved against the working directory.'),
      content: z.string().describe('Content to write to the file'),
      encoding: z.string().optional().describe('File encoding (default: utf-8)'),
    },
    async ({ path: filePath, content, encoding }) => {
      const resolvedPath = resolveRequestedPath(filePath, allowedDirs);
      assertPathAllowed(resolvedPath, allowedDirs);

      // Ensure parent directory exists
      await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });

      await fs.promises.writeFile(
        resolvedPath,
        content,
        { encoding: (encoding as BufferEncoding) || 'utf-8' }
      );
      return {
        content: [{ type: 'text' as const, text: `Successfully wrote to ${resolvedPath}` }],
      };
    }
  );

  // ---- edit_file ----
  server.tool(
    'edit_file',
    'Apply text replacements to a file. Each replacement specifies old text to find and new text to replace it with. Paths are resolved relative to the configured working directory.',
    {
      path: z.string().describe('Path to the file. Can be an absolute path or a filename/relative path resolved against the working directory.'),
      replacements: z.array(z.object({
        old_text: z.string().describe('Text to search for'),
        new_text: z.string().describe('Text to replace with'),
      })).describe('List of replacements to apply'),
    },
    async ({ path: filePath, replacements }) => {
      const resolvedPath = resolveRequestedPath(filePath, allowedDirs);
      assertPathAllowed(resolvedPath, allowedDirs);

      let content = await fs.promises.readFile(resolvedPath, 'utf-8');
      const applied: string[] = [];
      const notFound: string[] = [];

      for (const { old_text, new_text } of replacements) {
        if (content.includes(old_text)) {
          content = content.replace(old_text, new_text);
          applied.push(old_text.substring(0, 50));
        } else {
          notFound.push(old_text.substring(0, 50));
        }
      }

      await fs.promises.writeFile(resolvedPath, content, 'utf-8');

      let summary = `Applied ${applied.length} replacement(s) to ${resolvedPath}`;
      if (notFound.length > 0) {
        summary += `\nNot found (${notFound.length}): ${notFound.map((s) => `"${s}..."`).join(', ')}`;
      }
      return { content: [{ type: 'text' as const, text: summary }] };
    }
  );

  // ---- create_directory ----
  server.tool(
    'create_directory',
    'Create a directory (and any necessary parent directories). Paths are resolved relative to the configured working directory.',
    {
      path: z.string().describe('Path of the directory to create. Can be an absolute path or a name/relative path resolved against the working directory.'),
    },
    async ({ path: dirPath }) => {
      const resolvedPath = resolveRequestedPath(dirPath, allowedDirs);
      assertPathAllowed(resolvedPath, allowedDirs);

      await fs.promises.mkdir(resolvedPath, { recursive: true });
      return {
        content: [{ type: 'text' as const, text: `Created directory: ${resolvedPath}` }],
      };
    }
  );

  // ---- list_directory ----
  server.tool(
    'list_directory',
    'List the contents of a directory with file metadata (type, size, modified date). Paths are resolved relative to the configured working directory.',
    {
      path: z.string().describe('Path of the directory to list. Can be an absolute path or a name/relative path resolved against the working directory.'),
    },
    async ({ path: dirPath }) => {
      const resolvedPath = resolveRequestedPath(dirPath, allowedDirs);
      assertPathAllowed(resolvedPath, allowedDirs);

      const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
      const lines: string[] = [];

      for (const entry of entries) {
        const fullPath = path.join(resolvedPath, entry.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          const type = entry.isDirectory() ? '[DIR]' : '[FILE]';
          const size = entry.isFile() ? `${stat.size} bytes` : '';
          const modified = stat.mtime.toISOString();
          lines.push(`${type} ${entry.name}  ${size}  ${modified}`);
        } catch {
          lines.push(`[?] ${entry.name}  (unable to stat)`);
        }
      }

      const result = lines.length > 0
        ? lines.join('\n')
        : '(empty directory)';
      return { content: [{ type: 'text' as const, text: result }] };
    }
  );

  // ---- move_file ----
  server.tool(
    'move_file',
    'Move or rename a file or directory. Paths are resolved relative to the configured working directory.',
    {
      source: z.string().describe('Path of the source file/directory. Can be absolute or relative to the working directory.'),
      destination: z.string().describe('Path of the destination. Can be absolute or relative to the working directory.'),
    },
    async ({ source, destination }) => {
      const resolvedSource = resolveRequestedPath(source, allowedDirs);
      const resolvedDest = resolveRequestedPath(destination, allowedDirs);
      assertPathAllowed(resolvedSource, allowedDirs);
      assertPathAllowed(resolvedDest, allowedDirs);

      await fs.promises.rename(resolvedSource, resolvedDest);
      return {
        content: [{ type: 'text' as const, text: `Moved ${resolvedSource} -> ${resolvedDest}` }],
      };
    }
  );

  // ---- search_files ----
  server.tool(
    'search_files',
    'Recursively search for files by name pattern within allowed directories. Paths are resolved relative to the configured working directory.',
    {
      path: z.string().describe('Path of the directory to search in. Can be absolute or relative to the working directory.'),
      pattern: z.string().describe('File name pattern to search for (case-insensitive substring match)'),
    },
    async ({ path: searchPath, pattern }) => {
      const resolvedPath = resolveRequestedPath(searchPath, allowedDirs);
      assertPathAllowed(resolvedPath, allowedDirs);

      const results = await searchFilesRecursive(resolvedPath, pattern, allowedDirs);
      const text = results.length > 0
        ? `Found ${results.length} file(s):\n${results.join('\n')}`
        : 'No files found matching the pattern.';
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  // ---- get_file_info ----
  server.tool(
    'get_file_info',
    'Get detailed information about a file or directory (size, timestamps, permissions). Paths are resolved relative to the configured working directory.',
    {
      path: z.string().describe('Path of the file or directory. Can be absolute or relative to the working directory.'),
    },
    async ({ path: filePath }) => {
      const resolvedPath = resolveRequestedPath(filePath, allowedDirs);
      assertPathAllowed(resolvedPath, allowedDirs);

      const stat = await fs.promises.stat(resolvedPath);
      const info = {
        path: resolvedPath,
        type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
        size: stat.size,
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        accessed: stat.atime.toISOString(),
        permissions: stat.mode.toString(8),
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }] };
    }
  );

  // ---- list_allowed_directories ----
  server.tool(
    'list_allowed_directories',
    'Returns the working directory and the list of directories this server is allowed to access. Call this first if you are unsure what directory to use.',
    {},
    async () => {
      const text = allowedDirs.length > 0
        ? `Working directory (first entry is used to resolve relative paths):\n${allowedDirs[0]}\n\nAll allowed directories:\n${allowedDirs.join('\n')}`
        : 'No working directory is configured. Ask the user to set one using the directory bar above the chat input.';
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  return server;
}
