/**
 * The built-in MCP servers, configured for one user on the server:
 * - filesystem and diagram are confined to DATA_DIR/workspaces/<userId>;
 * - msoffice, spreadsheet, presentation and pdf are confined to the same workspace;
 *   LibreOffice converts to PDF only when the admin set LIBREOFFICE_PATH;
 * - fetch goes through the SSRF guard;
 * - documents are parsed, and diagrams and PDFs rendered, in the worker pool.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getAllBuiltinServerDefinitions } from '../../../electron/services/builtin-mcp/registry';
import type { HttpGet } from '../../../electron/services/builtin-mcp/fetch.server';
import type { PdfOptions } from '../../../electron/services/builtin-mcp/pdf-render';
import type { MCPServerConfig } from '../../../src/types/mcp.types';
import type { ExtractPool } from '../extract/pool';
import { readBodyLimited, safeFetch, type SafeFetchPolicy } from '../net/safe-fetch';

export interface BuiltinInfo {
  id: string;
  name: string;
  description: string;
}

/** What the built-ins do here (the desktop descriptions talk about "your computer"). */
const WEB_DESCRIPTIONS: Record<string, string> = {
  'builtin-filesystem-001': 'Read, write and organise files in your private workspace on the server.',
  'builtin-msoffice-001': 'Create and edit Word documents in your private workspace.',
  'builtin-spreadsheet-001': 'Create and edit Excel workbooks (formulas, formats, charts) in your private workspace.',
  'builtin-presentation-001': 'Create PowerPoint decks (layouts, themes, charts, speaker notes) in your private workspace.',
  'builtin-pdf-001': 'Create PDFs from Markdown or HTML, and convert Office files to PDF, in your private workspace.',
};

export function builtinServers(): BuiltinInfo[] {
  return getAllBuiltinServerDefinitions().map((d) => ({
    id: d.id,
    name: d.name,
    description: WEB_DESCRIPTIONS[d.id] ?? d.description,
  }));
}

/**
 * Tool results mention absolute paths ("Successfully wrote to /data/workspaces/<id>/a.txt").
 * Show them relative to the workspace instead: the server's layout is none of
 * the model's (or user's) business, and relative paths work as tool input.
 */
export function redactWorkspacePath<T>(result: T, workspace: string): T {
  const res = result as { content?: Array<{ type: string; text?: string }> };
  if (!Array.isArray(res?.content)) return result;
  const variants = [
    ...new Set([
      workspace,
      workspace.replace(/\\/g, '/'),
      workspace.replace(/\//g, '\\'),
      // Inside JSON text, backslashes are doubled
      JSON.stringify(workspace).slice(1, -1),
    ]),
  ].sort((a, b) => b.length - a.length);
  const scrub = (text: string) => {
    let out = text;
    for (const v of variants) {
      for (const sep of ['\\\\', '\\', '/']) out = out.split(v + sep).join('');
      out = out.split(v).join('.');
    }
    return out;
  };
  return {
    ...res,
    content: res.content.map((c) => (c.type === 'text' && typeof c.text === 'string' ? { ...c, text: scrub(c.text) } : c)),
  } as T;
}

export function isBuiltinId(id: string): boolean {
  return builtinServers().some((b) => b.id === id);
}

/** The user's workspace folder (created on first use). Files here belong to that user only. */
export function userWorkspace(dataDir: string, userId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('Invalid user id');
  const dir = path.join(dataDir, 'workspaces', userId);
  fs.mkdirSync(dir, { recursive: true });
  // Compare real paths later; resolve the workspace itself once (DATA_DIR may be a link)
  return fs.realpathSync.native(dir);
}

/** GET through the SSRF guard, for the fetch built-in. */
export function safeHttpGet(policy: () => SafeFetchPolicy): HttpGet {
  return async (url, { headers, timeoutMs, maxBytes }) => {
    const res = await safeFetch(url, { headers, timeoutMs, policy: policy() });
    const body = await readBodyLimited(res, maxBytes);
    return {
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get('content-type') ?? undefined,
      body,
      finalUrl: res.url || url,
    };
  };
}

export interface BuiltinDeps {
  dataDir: string;
  extract: ExtractPool;
  netPolicy: () => SafeFetchPolicy;
}

/** Config for one built-in server instance belonging to one user. */
export function builtinConfigFor(userId: string, builtinId: string, deps: BuiltinDeps): MCPServerConfig & { builtinContext: Record<string, unknown> } {
  const info = builtinServers().find((b) => b.id === builtinId);
  if (!info) throw new Error(`Unknown built-in server: ${builtinId}`);
  const workspace = userWorkspace(deps.dataDir, userId);
  const office = { workingDirectory: workspace, confineToWorkingDirectory: true };
  const pdf = {
    renderMarkdownPdf: (md: string, opts: PdfOptions, images: Record<string, string>) => deps.extract.renderMarkdownPdf(md, opts, images),
    // LibreOffice opens linked resources while converting: only when the admin chose to install it
    useLibreOffice: !!process.env.LIBREOFFICE_PATH,
  };

  const contextById: Record<string, Record<string, unknown>> = {
    'builtin-filesystem-001': { allowedDirectories: [workspace], extractor: deps.extract.extractor() },
    'builtin-msoffice-001': { ...office, ...pdf },
    'builtin-spreadsheet-001': office,
    'builtin-presentation-001': office,
    'builtin-pdf-001': { ...office, ...pdf },
    'builtin-diagram-001': {
      allowedDirectories: [workspace],
      renderSvg: (s: string, e: string) => deps.extract.renderSvg(s, e),
      svgToPng: (svg: string, scale: number) => deps.extract.svgToPng(svg, scale),
    },
    'builtin-fetch-001': {
      httpGet: safeHttpGet(deps.netPolicy),
      htmlToMarkdown: (html: string, url: string) => deps.extract.htmlToMarkdown(html, url),
    },
  };

  return {
    id: builtinId,
    name: info.name,
    transport: 'builtin',
    builtin: true,
    builtinId,
    enabled: true,
    metadata: { description: info.description },
    builtinContext: contextById[builtinId] ?? { allowedDirectories: [workspace] },
  };
}
