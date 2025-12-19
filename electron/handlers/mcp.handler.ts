import { ipcMain, BrowserWindow } from 'electron';
import { getMCPServerManager } from '../services/mcp.service';
import { store } from '../services/store.service';
import { MCPServerConfig } from '../../src/types/mcp.types';

let mainWindow: BrowserWindow | null = null;

export function setMainWindow(window: BrowserWindow) {
  mainWindow = window;
}

// Helper to validate server config based on transport type
function validateConfig(config: MCPServerConfig): void {
  if (!config.id || !config.name) {
    throw new Error('Invalid server configuration: missing id or name');
  }

  if (config.transport === 'stdio') {
    if (!config.command) {
      throw new Error('Invalid server configuration: command is required for stdio transport');
    }
  } else if (config.transport === 'streamable-http') {
    if (!config.url) {
      throw new Error('Invalid server configuration: url is required for streamable-http transport');
    }
  } else {
    throw new Error(`Invalid server configuration: unknown transport type "${config.transport}"`);
  }
}

// Helper to migrate old config format
function migrateConfig(config: MCPServerConfig): MCPServerConfig {
  // Migrate 'sse' transport to 'streamable-http'
  if ((config.transport as string) === 'sse') {
    console.log(`[MCP] Migrating server "${config.name}" from 'sse' to 'streamable-http' transport`);
    return {
      ...config,
      transport: 'streamable-http',
    };
  }
  return config;
}

export function registerMCPHandlers() {
  const manager = getMCPServerManager();

  // ============================================================================
  // Server Management
  // ============================================================================

  ipcMain.handle('mcp:server:start', async (_event, serverId: string) => {
    try {
      // Load config from store
      const servers = store.get('mcp.servers', {}) as Record<string, MCPServerConfig>;
      let config = servers[serverId];

      if (!config) {
        throw new Error(`Server configuration not found: ${serverId}`);
      }

      // Migrate old config format if needed
      config = migrateConfig(config);

      // Debug logging
      console.log('[MCP] Starting server:', config.name, {
        transport: config.transport,
        command: config.command,
        url: config.url,
        envKeys: Object.keys(config.env || {}),
      });

      await manager.startServer(config);
      return { success: true };
    } catch (error) {
      console.error('[MCP] Failed to start server:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start server',
      };
    }
  });

  ipcMain.handle('mcp:server:stop', async (_event, serverId: string) => {
    try {
      await manager.stopServer(serverId);
      return { success: true };
    } catch (error) {
      console.error('[MCP] Failed to stop server:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop server',
      };
    }
  });

  ipcMain.handle('mcp:server:restart', async (_event, serverId: string) => {
    try {
      // Load config from store
      const servers = store.get('mcp.servers', {}) as Record<string, MCPServerConfig>;
      let config = servers[serverId];

      if (!config) {
        throw new Error(`Server configuration not found: ${serverId}`);
      }

      // Migrate old config format if needed
      config = migrateConfig(config);

      await manager.restartServer(serverId, config);
      return { success: true };
    } catch (error) {
      console.error('[MCP] Failed to restart server:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to restart server',
      };
    }
  });

  ipcMain.handle('mcp:server:getStatus', async (_event, serverId: string) => {
    try {
      const status = manager.getServerStatus(serverId);
      return { success: true, status };
    } catch (error) {
      console.error('[MCP] Failed to get server status:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get status',
      };
    }
  });

  ipcMain.handle('mcp:server:getLogs', async (_event, serverId: string) => {
    try {
      const logs = manager.getServerLogs(serverId);
      return { success: true, logs };
    } catch (error) {
      console.error('[MCP] Failed to get logs:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get logs',
      };
    }
  });

  ipcMain.handle('mcp:server:clearLogs', async (_event, serverId: string) => {
    try {
      manager.clearServerLogs(serverId);
      return { success: true };
    } catch (error) {
      console.error('[MCP] Failed to clear logs:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to clear logs',
      };
    }
  });

  // ============================================================================
  // Configuration Management
  // ============================================================================

  ipcMain.handle('mcp:config:list', async () => {
    try {
      const servers = store.get('mcp.servers', {}) as Record<string, MCPServerConfig>;

      // Migrate old configs
      const migratedServers: Record<string, MCPServerConfig> = {};
      let needsSave = false;

      for (const [id, config] of Object.entries(servers)) {
        const migrated = migrateConfig(config);
        migratedServers[id] = migrated;
        if (migrated !== config) {
          needsSave = true;
        }
      }

      // Save migrated configs if needed
      if (needsSave) {
        store.set('mcp.servers', migratedServers);
      }

      return { success: true, servers: migratedServers };
    } catch (error) {
      console.error('[MCP] Failed to list configs:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list configs',
      };
    }
  });

  ipcMain.handle('mcp:config:get', async (_event, serverId: string) => {
    try {
      const servers = store.get('mcp.servers', {}) as Record<string, MCPServerConfig>;
      let config = servers[serverId];

      if (!config) {
        throw new Error(`Server configuration not found: ${serverId}`);
      }

      // Migrate old config format if needed
      config = migrateConfig(config);

      return { success: true, config };
    } catch (error) {
      console.error('[MCP] Failed to get config:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get config',
      };
    }
  });

  ipcMain.handle('mcp:config:save', async (_event, config: MCPServerConfig) => {
    try {
      // Validate config based on transport type
      validateConfig(config);

      // Normalize env vars - ensure all values are strings
      if (config.env && typeof config.env === 'object') {
        const normalizedEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(config.env)) {
          if (key && key.trim()) {
            normalizedEnv[key.trim()] = String(value ?? '');
          }
        }
        config.env = Object.keys(normalizedEnv).length > 0 ? normalizedEnv : undefined;
      }

      // Debug logging
      console.log('[MCP] Saving config:', config.name, {
        transport: config.transport,
        command: config.command,
        url: config.url,
        envKeys: Object.keys(config.env || {}),
      });

      // Get existing servers
      const servers = store.get('mcp.servers', {}) as Record<string, MCPServerConfig>;

      // Save config
      servers[config.id] = config;
      store.set('mcp.servers', servers);

      return { success: true };
    } catch (error) {
      console.error('[MCP] Failed to save config:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save config',
      };
    }
  });

  ipcMain.handle('mcp:config:delete', async (_event, serverId: string) => {
    try {
      // Stop server if running
      await manager.stopServer(serverId);

      // Delete config from store
      const servers = store.get('mcp.servers', {}) as Record<string, MCPServerConfig>;
      delete servers[serverId];
      store.set('mcp.servers', servers);

      return { success: true };
    } catch (error) {
      console.error('[MCP] Failed to delete config:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete config',
      };
    }
  });

  // ============================================================================
  // Tool Operations
  // ============================================================================

  ipcMain.handle('mcp:tools:list', async (_event, serverId: string) => {
    try {
      const tools = manager.getServerTools(serverId);
      return { success: true, tools };
    } catch (error) {
      console.error('[MCP] Failed to list tools:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list tools',
      };
    }
  });

  ipcMain.handle(
    'mcp:tools:call',
    async (_event, serverId: string, toolName: string, args: Record<string, unknown>, traceId?: string) => {
      try {
        const result = await manager.callTool(serverId, toolName, args, traceId);
        return { success: true, result };
      } catch (error) {
        console.error('[MCP] Failed to call tool:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to call tool',
        };
      }
    }
  );

  // ============================================================================
  // Resource Operations
  // ============================================================================

  ipcMain.handle('mcp:resources:list', async (_event, serverId: string) => {
    try {
      const resources = await manager.listResources(serverId);
      return { success: true, resources };
    } catch (error) {
      console.error('[MCP] Failed to list resources:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list resources',
      };
    }
  });

  ipcMain.handle(
    'mcp:resources:read',
    async (_event, serverId: string, uri: string) => {
      try {
        const contents = await manager.readResource(serverId, uri);
        return { success: true, contents };
      } catch (error) {
        console.error('[MCP] Failed to read resource:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to read resource',
        };
      }
    }
  );

  // ============================================================================
  // Prompt Operations
  // ============================================================================

  ipcMain.handle('mcp:prompts:list', async (_event, serverId: string) => {
    try {
      const prompts = await manager.listPrompts(serverId);
      return { success: true, prompts };
    } catch (error) {
      console.error('[MCP] Failed to list prompts:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list prompts',
      };
    }
  });

  ipcMain.handle(
    'mcp:prompts:get',
    async (_event, serverId: string, promptName: string, args?: Record<string, string>) => {
      try {
        const messages = await manager.getPrompt(serverId, promptName, args);
        return { success: true, messages };
      } catch (error) {
        console.error('[MCP] Failed to get prompt:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get prompt',
        };
      }
    }
  );

  // ============================================================================
  // Import/Discovery
  // ============================================================================

  ipcMain.handle('mcp:import:claudeDesktop', async () => {
    try {
      const { importClaudeDesktopConfig } = await import(
        '../services/claude-importer.service'
      );
      const configs = await importClaudeDesktopConfig();

      // Save imported configs
      const servers = store.get('mcp.servers', {}) as Record<string, MCPServerConfig>;
      for (const config of configs) {
        servers[config.id] = config;
      }
      store.set('mcp.servers', servers);

      return { success: true, configs };
    } catch (error) {
      console.error('[MCP] Failed to import from Claude Desktop:', error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to import from Claude Desktop',
      };
    }
  });

  // ============================================================================
  // Event Forwarding
  // ============================================================================

  // Forward server status changes to renderer
  manager.on('serverStatusChanged', (event: { serverId: string; status: string }) => {
    if (mainWindow) {
      mainWindow.webContents.send('mcp:server:statusChanged', event);
    }
  });

  // Forward tool updates to renderer
  manager.on('serverToolsUpdated', (event: { serverId: string; tools: unknown[] }) => {
    console.log('[MCP Handler] Forwarding toolsUpdated event to renderer:', {
      serverId: event.serverId,
      toolCount: event.tools?.length || 0,
    });
    if (mainWindow) {
      mainWindow.webContents.send('mcp:server:toolsUpdated', event);
    }
  });

  // Forward resource updates to renderer
  manager.on('serverResourcesUpdated', (event: { serverId: string; resources: unknown[] }) => {
    console.log('[MCP Handler] Forwarding resourcesUpdated event to renderer:', {
      serverId: event.serverId,
      resourceCount: event.resources?.length || 0,
    });
    if (mainWindow) {
      mainWindow.webContents.send('mcp:server:resourcesUpdated', event);
    }
  });

  // Forward prompt updates to renderer
  manager.on('serverPromptsUpdated', (event: { serverId: string; prompts: unknown[] }) => {
    console.log('[MCP Handler] Forwarding promptsUpdated event to renderer:', {
      serverId: event.serverId,
      promptCount: event.prompts?.length || 0,
    });
    if (mainWindow) {
      mainWindow.webContents.send('mcp:server:promptsUpdated', event);
    }
  });

  // Forward errors to renderer
  manager.on('serverError', (event: { serverId: string; error: string }) => {
    if (mainWindow) {
      mainWindow.webContents.send('mcp:server:error', event);
    }
  });

  console.log('[MCP] Handlers registered');
}

// ============================================================================
// Cleanup on App Quit
// ============================================================================

export async function cleanupMCPServers() {
  const manager = getMCPServerManager();
  await manager.stopAll();
  console.log('[MCP] All servers stopped');
}
