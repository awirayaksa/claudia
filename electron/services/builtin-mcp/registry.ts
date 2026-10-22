import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createDiagramServer } from './diagram.server';
import { createFetchServer } from './fetch.server';
import { createFilesystemServer } from './filesystem.server';
import { createMsOfficeServer } from './msoffice.server';
import { createPdfServer } from './pdf.server';
import { createPresentationServer } from './presentation.server';
import { createSpreadsheetServer } from './spreadsheet.server';

// ============================================================================
// Built-in Server Definitions
// ============================================================================

export interface BuiltinServerDefinition {
  id: string;
  name: string;
  description: string;
  createServer: (config?: Record<string, unknown>) => McpServer;
}

const BUILTIN_SERVERS: BuiltinServerDefinition[] = [
  {
    id: 'builtin-filesystem-001',
    name: 'Filesystem',
    description: 'Read, write, and manage files and directories on your computer',
    createServer: (config) => createFilesystemServer(config),
  },
  {
    id: 'builtin-msoffice-001',
    name: 'Ms Office Files',
    description: 'Comprehensive Word document creation, formatting, and manipulation, including .dotx/.dotm template support (60 tools). No Microsoft Office required for most operations.',
    createServer: (config) => createMsOfficeServer(config),
  },
  {
    id: 'builtin-spreadsheet-001',
    name: 'Spreadsheets',
    description: 'Create and edit Excel workbooks (.xlsx): values, formulas, number formats, styles, sheets and native charts. No Microsoft Office required.',
    createServer: (config) => createSpreadsheetServer(config),
  },
  {
    id: 'builtin-presentation-001',
    name: 'Presentations',
    description: 'Create PowerPoint decks (.pptx): title, bullet, two-column, image, table, chart and quote slides, themes and speaker notes. No Microsoft Office required.',
    createServer: (config) => createPresentationServer(config),
  },
  {
    id: 'builtin-pdf-001',
    name: 'PDF',
    description: 'Create PDFs from Markdown or HTML, and convert Word, Excel, PowerPoint, Markdown and HTML files to PDF.',
    createServer: (config) => createPdfServer(config),
  },
  {
    id: 'builtin-diagram-001',
    name: 'Diagram Generator',
    description: 'Generate diagram images (ER, network, architecture, flowchart, etc.) from DOT/Graphviz syntax to SVG or PNG',
    createServer: (config) => createDiagramServer(config),
  },
  {
    id: 'builtin-fetch-001',
    name: 'Web Fetch',
    description: 'Fetch a URL and return its content as markdown (or raw). Useful for reading documentation, articles, and APIs.',
    createServer: (config) => createFetchServer(config),
  },
];

// ============================================================================
// Public API
// ============================================================================

export function getBuiltinServerIds(): string[] {
  return BUILTIN_SERVERS.map((s) => s.id);
}

export function getBuiltinServerDefinition(builtinId: string): BuiltinServerDefinition | undefined {
  return BUILTIN_SERVERS.find((s) => s.id === builtinId);
}

export function getAllBuiltinServerDefinitions(): BuiltinServerDefinition[] {
  return [...BUILTIN_SERVERS];
}
