import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createFilesystemServer } from './filesystem.server';
import { createOfficeServer } from './office.server';

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
    id: 'builtin-office-001',
    name: 'Office Automation',
    description: 'Control Microsoft Office apps (Word, Excel, PowerPoint) via PowerShell COM automation (Windows only)',
    createServer: (config) => createOfficeServer(config),
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
