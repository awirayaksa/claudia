import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createAzureDevOpsServer } from './azure-devops.server';
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
  /** Where the server is offered (default: everywhere). */
  platforms?: Array<'desktop' | 'web'>;
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
  {
    id: 'builtin-azdo-001',
    name: 'Azure DevOps',
    description: 'Find, read, create and update work items on Azure DevOps Server / TFS: tasks, bugs, user stories, comments and links.',
    createServer: (config) => createAzureDevOpsServer(config),
    // Needs the web server's per-user connections
    platforms: ['web'],
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

/** The definitions offered on a platform (all of them without one). */
export function getAllBuiltinServerDefinitions(platform?: 'desktop' | 'web'): BuiltinServerDefinition[] {
  return BUILTIN_SERVERS.filter((s) => !platform || !s.platforms || s.platforms.includes(platform));
}
