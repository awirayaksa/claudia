// MCP (Model Context Protocol) Type Definitions

// ============================================================================
// JSON-RPC 2.0 Base Types
// ============================================================================

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: any;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: any;
  error?: JSONRPCError;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: any;
}

export interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

export type JSONRPCMessage = JSONRPCRequest | JSONRPCResponse | JSONRPCNotification;

// ============================================================================
// MCP Server Configuration
// ============================================================================

export interface MCPServerConfig {
  id: string; // UUID
  name: string; // Display name
  command: string; // Executable path or command
  args: string[]; // Command arguments
  env?: Record<string, string>; // Environment variables
  transport: 'stdio' | 'sse'; // Transport protocol
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
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
    [key: string]: any; // Additional JSON Schema fields
  };
}

// ============================================================================
// MCP Resource Definition (Future Phase)
// ============================================================================

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

// ============================================================================
// MCP Prompt Definition (Future Phase)
// ============================================================================

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

// ============================================================================
// Server Capabilities
// ============================================================================

export interface MCPServerCapabilities {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
  logging?: boolean;
}

// ============================================================================
// Server Runtime State
// ============================================================================

export type MCPServerStatus =
  | 'stopped' // Not running
  | 'starting' // Child process spawning
  | 'initializing' // Handshake in progress
  | 'ready' // Connected and ready
  | 'error' // Failed to start/crashed
  | 'stopping'; // Shutting down

export interface MCPServerState {
  config: MCPServerConfig;
  status: MCPServerStatus;
  capabilities?: MCPServerCapabilities;
  tools: MCPTool[];
  resources: MCPResource[]; // Future
  prompts: MCPPrompt[]; // Future
  error?: string;
  pid?: number;
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
  arguments: Record<string, any>;
  status: 'pending' | 'executing' | 'success' | 'error';
  result?: any;
  error?: string;
  startTime: string; // ISO timestamp
  endTime?: string; // ISO timestamp
}

// ============================================================================
// MCP Protocol Messages
// ============================================================================

// Initialize Request
export interface InitializeRequest extends JSONRPCRequest {
  method: 'initialize';
  params: {
    protocolVersion: string;
    capabilities: Record<string, any>;
    clientInfo: {
      name: string;
      version: string;
    };
  };
}

// Initialize Response
export interface InitializeResponse extends JSONRPCResponse {
  result: {
    protocolVersion: string;
    capabilities: MCPServerCapabilities;
    serverInfo: {
      name: string;
      version: string;
    };
  };
}

// Tools List Request
export interface ToolsListRequest extends JSONRPCRequest {
  method: 'tools/list';
  params?: Record<string, never>;
}

// Tools List Response
export interface ToolsListResponse extends JSONRPCResponse {
  result: {
    tools: MCPTool[];
  };
}

// Tool Call Request
export interface ToolCallRequest extends JSONRPCRequest {
  method: 'tools/call';
  params: {
    name: string;
    arguments?: Record<string, any>;
  };
}

// Tool Call Response
export interface ToolCallResponse extends JSONRPCResponse {
  result: {
    content: Array<{
      type: 'text' | 'image' | 'resource';
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    isError?: boolean;
  };
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

export interface MCPServerErrorEvent {
  serverId: string;
  error: string;
}
