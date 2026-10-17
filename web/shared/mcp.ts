import { z } from 'zod';
import type { MCPTool, MCPServerStatus, UIResourceContent } from '../../src/types/mcp.types';

export interface McpServerView {
  id: string;
  name: string;
  description: string | null;
  /** user: the user's own remote server. */
  scope: 'global' | 'builtin' | 'user';
  transport: 'stdio' | 'streamable-http' | 'sse' | 'builtin';
  status: MCPServerStatus;
  enabled: boolean;
  error: string | null;
  tools: MCPTool[];
}

export const McpServerInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(500).nullable().default(null),
    transport: z.enum(['stdio', 'streamable-http', 'sse']),
    url: z.url().optional(),
    /** Omitted on update = keep the stored headers. */
    headers: z.record(z.string(), z.string()).optional(),
    command: z.string().min(1).max(500).optional(),
    args: z.array(z.string().max(2000)).max(100).optional(),
    env: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().default(true),
  })
  .refine((v) => (v.transport === 'stdio' ? !!v.command : !!v.url), {
    message: 'stdio servers need a command; HTTP and SSE servers need a URL.',
  });
export type McpServerInput = z.infer<typeof McpServerInput>;

/** A global server as admins see it: secrets reduced to their names. */
export interface AdminMcpServerView {
  id: string;
  name: string;
  description: string | null;
  transport: 'stdio' | 'streamable-http' | 'sse';
  url: string | null;
  command: string | null;
  args: string[];
  /** Names only; values never leave the server. */
  headerNames: string[];
  envNames: string[];
  enabled: boolean;
  status: MCPServerStatus;
  error: string | null;
  toolCount: number;
}

export const UIActionRequest = z.object({
  uri: z.string().max(2000),
  toolName: z.string().min(1).max(200),
  params: z.record(z.string(), z.unknown()).default({}),
  originalToolCallId: z.string().min(1).max(200),
  /** The user confirmed a tool marked destructive. */
  confirmed: z.boolean().default(false),
});

export interface UIActionResponse {
  result: {
    tool_call_id: string;
    role: 'tool';
    name: string;
    content: string;
    isError?: boolean;
    hasUI?: boolean;
    uiResource?: UIResourceContent;
    serverId: string;
  };
}
