import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

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

function getDefaultAllowedDirectories(): string[] {
  const home = os.homedir();
  return [
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
  ];
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
    'Read the contents of a file. Returns the file text with UTF-8 encoding by default.',
    {
      path: z.string().describe('Absolute path to the file to read'),
      encoding: z.string().optional().describe('File encoding (default: utf-8)'),
    },
    async ({ path: filePath, encoding }) => {
      const resolvedPath = path.resolve(filePath);
      assertPathAllowed(resolvedPath, allowedDirs);

      const content = await fs.promises.readFile(
        resolvedPath,
        { encoding: (encoding as BufferEncoding) || 'utf-8' }
      );
      return { content: [{ type: 'text' as const, text: content }] };
    }
  );

  // ---- write_file ----
  server.tool(
    'write_file',
    'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
    {
      path: z.string().describe('Absolute path to the file to write'),
      content: z.string().describe('Content to write to the file'),
      encoding: z.string().optional().describe('File encoding (default: utf-8)'),
    },
    async ({ path: filePath, content, encoding }) => {
      const resolvedPath = path.resolve(filePath);
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
    'Apply text replacements to a file. Each replacement specifies old text to find and new text to replace it with.',
    {
      path: z.string().describe('Absolute path to the file to edit'),
      replacements: z.array(z.object({
        old_text: z.string().describe('Text to search for'),
        new_text: z.string().describe('Text to replace with'),
      })).describe('List of replacements to apply'),
    },
    async ({ path: filePath, replacements }) => {
      const resolvedPath = path.resolve(filePath);
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
    'Create a directory (and any necessary parent directories).',
    {
      path: z.string().describe('Absolute path of the directory to create'),
    },
    async ({ path: dirPath }) => {
      const resolvedPath = path.resolve(dirPath);
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
    'List the contents of a directory with file metadata (type, size, modified date).',
    {
      path: z.string().describe('Absolute path of the directory to list'),
    },
    async ({ path: dirPath }) => {
      const resolvedPath = path.resolve(dirPath);
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
    'Move or rename a file or directory.',
    {
      source: z.string().describe('Absolute path of the source file/directory'),
      destination: z.string().describe('Absolute path of the destination'),
    },
    async ({ source, destination }) => {
      const resolvedSource = path.resolve(source);
      const resolvedDest = path.resolve(destination);
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
    'Recursively search for files by name pattern within allowed directories.',
    {
      path: z.string().describe('Absolute path of the directory to search in'),
      pattern: z.string().describe('File name pattern to search for (case-insensitive substring match)'),
    },
    async ({ path: searchPath, pattern }) => {
      const resolvedPath = path.resolve(searchPath);
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
    'Get detailed information about a file or directory (size, timestamps, permissions).',
    {
      path: z.string().describe('Absolute path of the file or directory'),
    },
    async ({ path: filePath }) => {
      const resolvedPath = path.resolve(filePath);
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
    'Returns the list of directories this server is allowed to access.',
    {},
    async () => {
      const text = allowedDirs.length > 0
        ? `Allowed directories:\n${allowedDirs.join('\n')}`
        : 'No directories are configured. Ask the user to configure allowed directories in Settings > MCP.';
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  return server;
}
