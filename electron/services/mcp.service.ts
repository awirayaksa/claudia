import { EventEmitter } from 'events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  MCPServerConfig,
  MCPServerStatus,
  MCPServerCapabilities,
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPToolResult,
  MCPResourceContent,
  MCPPromptMessage,
} from '../../src/types/mcp.types';

// ============================================================================
// MCP Client Wrapper - Uses official SDK
// ============================================================================

export class MCPClientWrapper extends EventEmitter {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private _status: MCPServerStatus = 'stopped';
  private _capabilities?: MCPServerCapabilities;
  private _tools: MCPTool[] = [];
  private _resources: MCPResource[] = [];
  private _prompts: MCPPrompt[] = [];
  private _error?: string;
  private _pid?: number;
  private _logs: string[] = [];
  private readonly MAX_LOGS = 200;

  constructor(private config: MCPServerConfig) {
    super();
  }

  // Getters
  get id(): string {
    return this.config.id;
  }

  get status(): MCPServerStatus {
    return this._status;
  }

  get capabilities(): MCPServerCapabilities | undefined {
    return this._capabilities;
  }

  get tools(): MCPTool[] {
    return this._tools;
  }

  get resources(): MCPResource[] {
    return this._resources;
  }

  get prompts(): MCPPrompt[] {
    return this._prompts;
  }

  get error(): string | undefined {
    return this._error;
  }

  get pid(): number | undefined {
    return this._pid;
  }

  get logs(): string[] {
    return [...this._logs];
  }

  clearLogs(): void {
    this._logs = [];
  }

  private addLog(message: string): void {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}`;
    this._logs.push(logEntry);
    if (this._logs.length > this.MAX_LOGS) {
      this._logs = this._logs.slice(-this.MAX_LOGS);
    }
  }

  // ============================================================================
  // Lifecycle Management
  // ============================================================================

  async start(): Promise<void> {
    if (this.client) {
      throw new Error('Client is already running');
    }

    this._status = 'starting';
    this._error = undefined;
    this.emit('statusChanged', this._status);

    try {
      // Create transport based on config
      if (this.config.transport === 'stdio') {
        await this.createStdioTransport();
      } else if (this.config.transport === 'streamable-http') {
        await this.createHttpTransport();
      } else {
        throw new Error(`Unknown transport: ${this.config.transport}`);
      }

      this._status = 'initializing';
      this.emit('statusChanged', this._status);

      // Create and connect client
      this.client = new Client(
        {
          name: 'Claudia',
          version: '0.1.0',
        },
        {
          capabilities: {
            // Request capabilities from server
          },
        }
      );

      // Connect to transport
      await this.client.connect(this.transport!);

      // Get server capabilities
      const serverCapabilities = this.client.getServerCapabilities();
      this._capabilities = this.mapCapabilities(serverCapabilities);
      console.log(`[MCP ${this.config.name}] Capabilities:`, JSON.stringify(this._capabilities, null, 2));

      // Fetch tools if supported
      if (this._capabilities?.tools) {
        await this.fetchTools();
      }

      // Fetch resources if supported
      if (this._capabilities?.resources) {
        await this.fetchResources();
      }

      // Fetch prompts if supported
      if (this._capabilities?.prompts) {
        await this.fetchPrompts();
      }

      // Set up notification handlers for list changes
      this.setupNotificationHandlers();

      this._status = 'ready';
      this.emit('statusChanged', this._status);
      this.addLog('Connected and ready');
    } catch (error) {
      this._status = 'error';
      this._error = error instanceof Error ? error.message : 'Failed to start client';
      this.addLog(`Error: ${this._error}`);
      this.emit('statusChanged', this._status);
      this.emit('error', this._error);
      await this.cleanup();
      throw error;
    }
  }

  private async createStdioTransport(): Promise<void> {
    if (!this.config.command) {
      throw new Error('Command is required for stdio transport');
    }

    console.log(`[MCP ${this.config.name}] Creating stdio transport:`, {
      command: this.config.command,
      args: this.config.args,
      envKeys: Object.keys(this.config.env || {}),
    });

    // Merge environment variables
    const mergedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        mergedEnv[key] = value;
      }
    }
    if (this.config.env) {
      Object.assign(mergedEnv, this.config.env);
    }

    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args || [],
      env: mergedEnv,
      stderr: 'pipe',
    });

    // Handle stderr for logging
    const stdioTransport = this.transport as StdioClientTransport;
    if (stdioTransport.stderr) {
      stdioTransport.stderr.on('data', (data: Buffer) => {
        const message = data.toString().trim();
        if (message) {
          console.warn(`[MCP ${this.config.name}] stderr:`, message);
          this.addLog(message);
        }
      });
    }

    // Get PID if available
    // Note: The SDK transport may expose the process
    const transportAny = this.transport as any;
    if (transportAny._process?.pid) {
      this._pid = transportAny._process.pid;
    }
  }

  private async createHttpTransport(): Promise<void> {
    if (!this.config.url) {
      throw new Error('URL is required for streamable-http transport');
    }

    console.log(`[MCP ${this.config.name}] Creating HTTP transport:`, {
      url: this.config.url,
    });

    this.transport = new StreamableHTTPClientTransport(
      new URL(this.config.url)
    );
  }

  private mapCapabilities(serverCaps: any): MCPServerCapabilities {
    return {
      tools: serverCaps?.tools ? { listChanged: !!serverCaps.tools.listChanged } : undefined,
      resources: serverCaps?.resources
        ? {
            subscribe: !!serverCaps.resources.subscribe,
            listChanged: !!serverCaps.resources.listChanged,
          }
        : undefined,
      prompts: serverCaps?.prompts ? { listChanged: !!serverCaps.prompts.listChanged } : undefined,
      logging: serverCaps?.logging,
    };
  }

  private setupNotificationHandlers(): void {
    if (!this.client) return;

    // Handle tool list changes
    this.client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        console.log(`[MCP ${this.config.name}] Tools list changed, refetching...`);
        await this.fetchTools();
      }
    );

    // Handle resource list changes
    this.client.setNotificationHandler(
      ResourceListChangedNotificationSchema,
      async () => {
        console.log(`[MCP ${this.config.name}] Resources list changed, refetching...`);
        await this.fetchResources();
      }
    );

    // Handle prompt list changes
    this.client.setNotificationHandler(
      PromptListChangedNotificationSchema,
      async () => {
        console.log(`[MCP ${this.config.name}] Prompts list changed, refetching...`);
        await this.fetchPrompts();
      }
    );
  }

  async stop(): Promise<void> {
    if (!this.client && !this.transport) {
      return;
    }

    this._status = 'stopping';
    this.emit('statusChanged', this._status);
    this.addLog('Stopping...');

    try {
      await this.cleanup();
    } finally {
      this._status = 'stopped';
      this.emit('statusChanged', this._status);
      this.addLog('Stopped');
    }
  }

  private async cleanup(): Promise<void> {
    // Close client
    if (this.client) {
      try {
        await this.client.close();
      } catch (error) {
        console.error(`[MCP ${this.config.name}] Error closing client:`, error);
      }
      this.client = null;
    }

    // Close transport
    if (this.transport) {
      try {
        await this.transport.close();
      } catch (error) {
        console.error(`[MCP ${this.config.name}] Error closing transport:`, error);
      }
      this.transport = null;
    }

    this._capabilities = undefined;
    this._tools = [];
    this._resources = [];
    this._prompts = [];
    this._pid = undefined;
  }

  // ============================================================================
  // Tools
  // ============================================================================

  private async fetchTools(): Promise<void> {
    if (!this.client) return;

    try {
      const result = await this.client.listTools();
      this._tools = (result.tools || []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as MCPTool['inputSchema'],
      }));
      console.log(`[MCP ${this.config.name}] Received ${this._tools.length} tools:`, this._tools.map((t) => t.name));
      this.emit('toolsUpdated', this._tools);
    } catch (error) {
      console.error(`[MCP ${this.config.name}] Failed to list tools:`, error);
    }
  }

  async listTools(): Promise<MCPTool[]> {
    return this._tools;
  }

  async callTool(name: string, args: Record<string, unknown>, traceId?: string): Promise<MCPToolResult> {
    if (this._status !== 'ready' || !this.client) {
      throw new Error(`Client is not ready (status: ${this._status})`);
    }

    this.addLog(`Calling tool: ${name}`);

    try {
      const result = await this.client.callTool({
        name,
        arguments: args,
      });

      return {
        content: (result.content || []).map((item) => ({
          type: item.type as 'text' | 'image' | 'resource',
          text: item.type === 'text' ? (item as any).text : undefined,
          data: item.type === 'image' ? (item as any).data : undefined,
          mimeType: (item as any).mimeType,
          resource: item.type === 'resource' ? (item as any).resource : undefined,
        })),
        isError: result.isError,
      };
    } catch (error) {
      this.addLog(`Tool call failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  // ============================================================================
  // Resources
  // ============================================================================

  private async fetchResources(): Promise<void> {
    if (!this.client) return;

    try {
      const result = await this.client.listResources();
      this._resources = (result.resources || []).map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      }));
      console.log(`[MCP ${this.config.name}] Received ${this._resources.length} resources`);
      this.emit('resourcesUpdated', this._resources);
    } catch (error) {
      console.error(`[MCP ${this.config.name}] Failed to list resources:`, error);
    }
  }

  async listResources(): Promise<MCPResource[]> {
    return this._resources;
  }

  async readResource(uri: string): Promise<MCPResourceContent[]> {
    if (this._status !== 'ready' || !this.client) {
      throw new Error(`Client is not ready (status: ${this._status})`);
    }

    this.addLog(`Reading resource: ${uri}`);

    try {
      const result = await this.client.readResource({ uri });
      return (result.contents || []).map((content) => ({
        uri: content.uri,
        mimeType: content.mimeType,
        text: (content as any).text,
        blob: (content as any).blob,
      }));
    } catch (error) {
      this.addLog(`Resource read failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  // ============================================================================
  // Prompts
  // ============================================================================

  private async fetchPrompts(): Promise<void> {
    if (!this.client) return;

    try {
      const result = await this.client.listPrompts();
      this._prompts = (result.prompts || []).map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments?.map((arg) => ({
          name: arg.name,
          description: arg.description,
          required: arg.required,
        })),
      }));
      console.log(`[MCP ${this.config.name}] Received ${this._prompts.length} prompts`);
      this.emit('promptsUpdated', this._prompts);
    } catch (error) {
      console.error(`[MCP ${this.config.name}] Failed to list prompts:`, error);
    }
  }

  async listPrompts(): Promise<MCPPrompt[]> {
    return this._prompts;
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<MCPPromptMessage[]> {
    if (this._status !== 'ready' || !this.client) {
      throw new Error(`Client is not ready (status: ${this._status})`);
    }

    this.addLog(`Getting prompt: ${name}`);

    try {
      const result = await this.client.getPrompt({
        name,
        arguments: args,
      });
      return (result.messages || []).map((message) => ({
        role: message.role as 'user' | 'assistant',
        content: {
          type: (message.content as any).type || 'text',
          text: (message.content as any).text,
          data: (message.content as any).data,
          mimeType: (message.content as any).mimeType,
        },
      }));
    } catch (error) {
      this.addLog(`Get prompt failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }
}

// ============================================================================
// MCP Client Manager
// ============================================================================

export class MCPClientManager extends EventEmitter {
  private clients: Map<string, MCPClientWrapper> = new Map();

  async startServer(config: MCPServerConfig): Promise<void> {
    // Stop existing client if running
    const existing = this.clients.get(config.id);
    if (existing) {
      await existing.stop();
    }

    // Create new instance
    const client = new MCPClientWrapper(config);

    // Forward events
    client.on('statusChanged', (status: MCPServerStatus) => {
      this.emit('serverStatusChanged', { serverId: config.id, status });
    });

    client.on('toolsUpdated', (tools: MCPTool[]) => {
      this.emit('serverToolsUpdated', { serverId: config.id, tools });
    });

    client.on('resourcesUpdated', (resources: MCPResource[]) => {
      this.emit('serverResourcesUpdated', { serverId: config.id, resources });
    });

    client.on('promptsUpdated', (prompts: MCPPrompt[]) => {
      this.emit('serverPromptsUpdated', { serverId: config.id, prompts });
    });

    client.on('error', (error: string) => {
      this.emit('serverError', { serverId: config.id, error });
    });

    // Store and start
    this.clients.set(config.id, client);
    await client.start();
  }

  async stopServer(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    if (client) {
      await client.stop();
      this.clients.delete(serverId);
    }
  }

  async restartServer(serverId: string, config: MCPServerConfig): Promise<void> {
    await this.stopServer(serverId);
    await this.startServer(config);
  }

  // Tools
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    traceId?: string
  ): Promise<MCPToolResult> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`Server not found: ${serverId}`);
    }
    return await client.callTool(toolName, args, traceId);
  }

  getServerTools(serverId: string): MCPTool[] {
    const client = this.clients.get(serverId);
    return client ? client.tools : [];
  }

  // Resources
  async listResources(serverId: string): Promise<MCPResource[]> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`Server not found: ${serverId}`);
    }
    return await client.listResources();
  }

  async readResource(serverId: string, uri: string): Promise<MCPResourceContent[]> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`Server not found: ${serverId}`);
    }
    return await client.readResource(uri);
  }

  getServerResources(serverId: string): MCPResource[] {
    const client = this.clients.get(serverId);
    return client ? client.resources : [];
  }

  // Prompts
  async listPrompts(serverId: string): Promise<MCPPrompt[]> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`Server not found: ${serverId}`);
    }
    return await client.listPrompts();
  }

  async getPrompt(
    serverId: string,
    promptName: string,
    args?: Record<string, string>
  ): Promise<MCPPromptMessage[]> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`Server not found: ${serverId}`);
    }
    return await client.getPrompt(promptName, args);
  }

  getServerPrompts(serverId: string): MCPPrompt[] {
    const client = this.clients.get(serverId);
    return client ? client.prompts : [];
  }

  // Status
  getServerStatus(serverId: string): MCPServerStatus {
    const client = this.clients.get(serverId);
    return client ? client.status : 'stopped';
  }

  // Logs
  getServerLogs(serverId: string): string[] {
    const client = this.clients.get(serverId);
    return client ? client.logs : [];
  }

  clearServerLogs(serverId: string): void {
    const client = this.clients.get(serverId);
    if (client) {
      client.clearLogs();
    }
  }

  // Cleanup
  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.clients.values()).map((client) =>
      client.stop()
    );
    await Promise.all(stopPromises);
    this.clients.clear();
  }
}

// Singleton instance
let managerInstance: MCPClientManager | null = null;

export function getMCPServerManager(): MCPClientManager {
  if (!managerInstance) {
    managerInstance = new MCPClientManager();
  }
  return managerInstance;
}
