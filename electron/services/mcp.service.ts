import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import {
  MCPServerConfig,
  MCPServerStatus,
  MCPServerCapabilities,
  MCPTool,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCMessage,
  InitializeRequest,
  InitializeResponse,
  ToolsListRequest,
  ToolsListResponse,
  ToolCallRequest,
  ToolCallResponse,
} from '../../src/types/mcp.types';

// ============================================================================
// Pending Request Tracking
// ============================================================================

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

// ============================================================================
// MCP Server Instance
// ============================================================================

export class MCPServerInstance extends EventEmitter {
  private process: ChildProcess | null = null;
  private pendingRequests: Map<number | string, PendingRequest> = new Map();
  private messageBuffer: string = '';
  private requestId: number = 1;
  private _status: MCPServerStatus = 'stopped';
  private _capabilities?: MCPServerCapabilities;
  private _tools: MCPTool[] = [];
  private _error?: string;
  private _pid?: number;
  private _logs: string[] = []; // Store recent logs (stderr)
  private readonly MAX_LOGS = 200; // Keep last 200 log lines

  constructor(private config: MCPServerConfig) {
    super();
  }

  // Getters
  get status(): MCPServerStatus {
    return this._status;
  }

  get capabilities(): MCPServerCapabilities | undefined {
    return this._capabilities;
  }

  get tools(): MCPTool[] {
    return this._tools;
  }

  get error(): string | undefined {
    return this._error;
  }

  get pid(): number | undefined {
    return this._pid;
  }

  get logs(): string[] {
    return [...this._logs]; // Return a copy
  }

  clearLogs(): void {
    this._logs = [];
  }

  // ============================================================================
  // Lifecycle Management
  // ============================================================================

  async start(): Promise<void> {
    if (this.process) {
      throw new Error('Server is already running');
    }

    this._status = 'starting';
    this._error = undefined;
    this.emit('statusChanged', this._status);

    try {
      // Spawn process
      this.process = spawn(this.config.command, this.config.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.config.env },
        shell: false,
      });

      this._pid = this.process.pid;

      // Set up event handlers
      this.process.stdout?.on('data', (data) => this.handleStdout(data));
      this.process.stderr?.on('data', (data) => this.handleStderr(data));
      this.process.on('exit', (code, signal) => this.handleExit(code, signal));
      this.process.on('error', (error) => this.handleProcessError(error));

      // Initialize the server
      await this.initialize();
    } catch (error) {
      this._status = 'error';
      this._error = error instanceof Error ? error.message : 'Failed to start server';
      this.emit('statusChanged', this._status);
      this.emit('error', this._error);
      this.cleanup();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    this._status = 'stopping';
    this.emit('statusChanged', this._status);

    try {
      // Send shutdown notification
      this.sendNotification('notifications/shutdown');

      // Wait 2 seconds for graceful exit
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          // Force kill if not exited
          if (this.process && !this.process.killed) {
            this.process.kill('SIGTERM');
            setTimeout(() => {
              if (this.process && !this.process.killed) {
                this.process.kill('SIGKILL');
              }
            }, 1000);
          }
          resolve();
        }, 2000);

        this.process?.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } finally {
      this.cleanup();
    }
  }

  private cleanup(): void {
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Server stopped'));
    }
    this.pendingRequests.clear();

    // Clean up process
    if (this.process) {
      this.process.removeAllListeners();
      this.process.stdout?.removeAllListeners();
      this.process.stderr?.removeAllListeners();
      this.process = null;
    }

    this._status = 'stopped';
    this._pid = undefined;
    this._capabilities = undefined;
    this._tools = [];
    this.messageBuffer = '';
    this.emit('statusChanged', this._status);
  }

  // ============================================================================
  // Initialization Handshake
  // ============================================================================

  private async initialize(): Promise<void> {
    this._status = 'initializing';
    this.emit('statusChanged', this._status);

    try {
      // Step 1: Send initialize request
      const initRequest: InitializeRequest = {
        jsonrpc: '2.0',
        id: this.getNextRequestId(),
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'Claudia',
            version: '0.1.0',
          },
        },
      };

      const initResponse = (await this.sendRequest(
        initRequest.method,
        initRequest.params
      )) as InitializeResponse['result'];

      this._capabilities = initResponse.capabilities;

      // Step 2: Send initialized notification
      this.sendNotification('notifications/initialized');

      // Step 3: List tools if supported
      if (this._capabilities.tools) {
        const toolsRequest: ToolsListRequest = {
          jsonrpc: '2.0',
          id: this.getNextRequestId(),
          method: 'tools/list',
        };

        const toolsResponse = (await this.sendRequest(
          toolsRequest.method
        )) as ToolsListResponse['result'];

        this._tools = toolsResponse.tools;
        this.emit('toolsUpdated', this._tools);
      }

      // Successfully initialized
      this._status = 'ready';
      this.emit('statusChanged', this._status);
    } catch (error) {
      this._status = 'error';
      this._error = error instanceof Error ? error.message : 'Initialization failed';
      this.emit('statusChanged', this._status);
      this.emit('error', this._error);
      this.cleanup();
      throw error;
    }
  }

  // ============================================================================
  // Tool Calling
  // ============================================================================

  async callTool(name: string, args: Record<string, any>): Promise<any> {
    if (this._status !== 'ready') {
      throw new Error(`Server is not ready (status: ${this._status})`);
    }

    const request: ToolCallRequest = {
      jsonrpc: '2.0',
      id: this.getNextRequestId(),
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    };

    const response = (await this.sendRequest(
      request.method,
      request.params
    )) as ToolCallResponse['result'];

    return response;
  }

  // ============================================================================
  // JSON-RPC Communication
  // ============================================================================

  private sendRequest(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.getNextRequestId();
      const request: JSONRPCRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      // Set up timeout (30 seconds)
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, 30000);

      // Store pending request
      this.pendingRequests.set(id, { resolve, reject, timeout });

      // Send request
      this.sendMessage(request);
    });
  }

  private sendNotification(method: string, params?: any): void {
    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.sendMessage(notification);
  }

  private sendMessage(message: any): void {
    if (!this.process || !this.process.stdin) {
      throw new Error('Process not running');
    }

    const json = JSON.stringify(message);
    this.process.stdin.write(json + '\n');
  }

  // ============================================================================
  // Stream Handling
  // ============================================================================

  private handleStdout(data: Buffer): void {
    this.messageBuffer += data.toString();

    // Process complete messages (newline-delimited)
    const lines = this.messageBuffer.split('\n');
    this.messageBuffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line) as JSONRPCMessage;
          this.handleMessage(message);
        } catch (error) {
          console.error('[MCP] Failed to parse message:', line, error);
        }
      }
    }
  }

  private handleStderr(data: Buffer): void {
    const message = data.toString().trim();
    if (message) {
      console.warn(`[MCP] ${this.config.name} stderr:`, message);

      // Store log with timestamp
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] ${message}`;
      this._logs.push(logEntry);

      // Keep only last MAX_LOGS entries
      if (this._logs.length > this.MAX_LOGS) {
        this._logs = this._logs.slice(-this.MAX_LOGS);
      }
    }
  }

  private handleMessage(message: JSONRPCMessage): void {
    // Check if it's a response (has id field)
    if ('id' in message && message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);

        const response = message as JSONRPCResponse;
        if (response.error) {
          pending.reject(
            new Error(
              `JSON-RPC Error ${response.error.code}: ${response.error.message}`
            )
          );
        } else {
          pending.resolve(response.result);
        }
      }
    } else {
      // It's a notification
      this.handleNotification(message);
    }
  }

  private handleNotification(message: JSONRPCMessage): void {
    // Handle server-initiated notifications
    console.log(`[MCP] ${this.config.name} notification:`, message);
  }

  // ============================================================================
  // Process Event Handlers
  // ============================================================================

  private handleExit(code: number | null, signal: string | null): void {
    console.error(`[MCP] ${this.config.name} exited:`, { code, signal });

    this._status = 'error';
    this._error = `Server exited with code ${code}`;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Server crashed'));
    }
    this.pendingRequests.clear();

    this.emit('statusChanged', this._status);
    this.emit('error', this._error);
    this.cleanup();
  }

  private handleProcessError(error: Error): void {
    console.error(`[MCP] ${this.config.name} process error:`, error);

    this._status = 'error';
    this._error = error.message;

    this.emit('statusChanged', this._status);
    this.emit('error', this._error);
    this.cleanup();
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private getNextRequestId(): number {
    return this.requestId++;
  }
}

// ============================================================================
// MCP Server Manager
// ============================================================================

export class MCPServerManager extends EventEmitter {
  private servers: Map<string, MCPServerInstance> = new Map();

  async startServer(config: MCPServerConfig): Promise<void> {
    // Stop existing server if running
    const existing = this.servers.get(config.id);
    if (existing) {
      await existing.stop();
    }

    // Create new instance
    const instance = new MCPServerInstance(config);

    // Forward events
    instance.on('statusChanged', (status: MCPServerStatus) => {
      this.emit('serverStatusChanged', { serverId: config.id, status });
    });

    instance.on('toolsUpdated', (tools: MCPTool[]) => {
      this.emit('serverToolsUpdated', { serverId: config.id, tools });
    });

    instance.on('error', (error: string) => {
      this.emit('serverError', { serverId: config.id, error });
    });

    // Store and start
    this.servers.set(config.id, instance);
    await instance.start();
  }

  async stopServer(serverId: string): Promise<void> {
    const instance = this.servers.get(serverId);
    if (instance) {
      await instance.stop();
      this.servers.delete(serverId);
    }
  }

  async restartServer(serverId: string, config: MCPServerConfig): Promise<void> {
    await this.stopServer(serverId);
    await this.startServer(config);
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, any>
  ): Promise<any> {
    const instance = this.servers.get(serverId);
    if (!instance) {
      throw new Error(`Server not found: ${serverId}`);
    }

    return await instance.callTool(toolName, args);
  }

  getServerStatus(serverId: string): MCPServerStatus {
    const instance = this.servers.get(serverId);
    return instance ? instance.status : 'stopped';
  }

  getServerTools(serverId: string): MCPTool[] {
    const instance = this.servers.get(serverId);
    return instance ? instance.tools : [];
  }

  getServerLogs(serverId: string): string[] {
    const instance = this.servers.get(serverId);
    return instance ? instance.logs : [];
  }

  clearServerLogs(serverId: string): void {
    const instance = this.servers.get(serverId);
    if (instance) {
      instance.clearLogs();
    }
  }

  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.servers.values()).map((instance) =>
      instance.stop()
    );
    await Promise.all(stopPromises);
    this.servers.clear();
  }
}

// Singleton instance
let managerInstance: MCPServerManager | null = null;

export function getMCPServerManager(): MCPServerManager {
  if (!managerInstance) {
    managerInstance = new MCPServerManager();
  }
  return managerInstance;
}
