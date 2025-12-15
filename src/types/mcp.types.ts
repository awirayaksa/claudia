// MCP (Model Context Protocol) Type Definitions
// Using @modelcontextprotocol/sdk for protocol implementation

// ============================================================================
// MCP Server Configuration
// ============================================================================

export type MCPTransportType = 'stdio' | 'streamable-http';

export interface MCPServerConfig {
  id: string; // UUID
  name: string; // Display name
  command?: string; // Executable path or command (required for stdio)
  args?: string[]; // Command arguments (for stdio)
  url?: string; // Server URL (required for streamable-http)
  env?: Record<string, string>; // Environment variables
  transport: MCPTransportType; // Transport protocol
  autoStart?: boolean; // Auto-start on app launch (default: false)
  enabled: boolean; // Whether server is enabled
  metadata?: {
    description?: string;
    author?: string;
    version?: string;
    homepage?: string;
  };
}

// ============================================================================
// MCP Tool Definition
// ============================================================================

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown; // Additional JSON Schema fields
  };
}

// ============================================================================
// MCP Resource Definition
// ============================================================================

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string; // Base64 encoded binary data
}

// ============================================================================
// MCP Prompt Definition
// ============================================================================

export interface MCPPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: MCPPromptArgument[];
}

export interface MCPPromptMessage {
  role: 'user' | 'assistant';
  content: {
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  };
}

// ============================================================================
// Server Capabilities
// ============================================================================

export interface MCPServerCapabilities {
  tools?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  prompts?: {
    listChanged?: boolean;
  };
  logging?: Record<string, unknown>;
}

// ============================================================================
// Server Runtime State
// ============================================================================

export type MCPServerStatus =
  | 'stopped' // Not running
  | 'starting' // Transport initializing
  | 'initializing' // Handshake in progress
  | 'ready' // Connected and ready
  | 'error' // Failed to start/crashed
  | 'stopping'; // Shutting down

export interface MCPServerState {
  config: MCPServerConfig;
  status: MCPServerStatus;
  capabilities?: MCPServerCapabilities;
  tools: MCPTool[];
  resources: MCPResource[];
  prompts: MCPPrompt[];
  error?: string;
  pid?: number; // Process ID (for stdio only)
  lastStarted?: string; // ISO timestamp
  lastError?: string; // ISO timestamp
  restartCount: number;
}

// ============================================================================
// Tool Execution Tracking
// ============================================================================

export interface MCPToolCall {
  id: string; // UUID for tracking
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'executing' | 'success' | 'error';
  result?: MCPToolResult;
  error?: string;
  startTime: string; // ISO timestamp
  endTime?: string; // ISO timestamp
}

export interface MCPToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
    resource?: {
      uri: string;
      mimeType?: string;
      text?: string;
      blob?: string;
    };
  }>;
  isError?: boolean;
}

// ============================================================================
// MCP-UI Types
// ============================================================================

export type UIResourceMimeType =
  | 'text/html'                         // Inline HTML
  | 'text/uri-list'                     // External URLs
  | 'application/vnd.mcp-ui.remote-dom'; // Remote-dom JavaScript

export interface UIResourceContent {
  uri: string;        // ui://component/id
  mimeType: UIResourceMimeType;
  text?: string;      // Inline content (for text/html or remote-dom)
  blob?: string;      // Base64 content
}

export interface UIResource {
  type: 'resource';
  resource: UIResourceContent;
}

export interface UIAction {
  uri: string;
  action: string;
  data?: Record<string, unknown>;
}

// ============================================================================
// IPC Event Types
// ============================================================================

export interface MCPServerStatusChangedEvent {
  serverId: string;
  status: MCPServerStatus;
  error?: string;
}

export interface MCPServerToolsUpdatedEvent {
  serverId: string;
  tools: MCPTool[];
}

export interface MCPServerResourcesUpdatedEvent {
  serverId: string;
  resources: MCPResource[];
}

export interface MCPServerPromptsUpdatedEvent {
  serverId: string;
  prompts: MCPPrompt[];
}

export interface MCPServerErrorEvent {
  serverId: string;
  error: string;
}
