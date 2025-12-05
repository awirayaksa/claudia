import { ipcMain, BrowserWindow } from 'electron';
import { getMCPServerManager } from '../services/mcp.service';
import { store } from '../services/store.service';
import { MCPServerConfig } from '../../src/types/mcp.types';

let mainWindow: BrowserWindow | null = null;

export function setMainWindow(window: BrowserWindow) {
  mainWindow = window;
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
      const config = servers[serverId];

      if (!config) {
        throw new Error(`Server configuration not found: ${serverId}`);
      }

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
      const config = servers[serverId];

      if (!config) {
        throw new Error(`Server configuration not found: ${serverId}`);
      }

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
      return { success: true, servers };
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
      const config = servers[serverId];

      if (!config) {
        throw new Error(`Server configuration not found: ${serverId}`);
      }

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
      // Validate config
      if (!config.id || !config.name || !config.command) {
        throw new Error('Invalid server configuration: missing required fields');
      }

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
    async (_event, serverId: string, toolName: string, args: any) => {
      try {
        const result = await manager.callTool(serverId, toolName, args);
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
  manager.on('serverStatusChanged', (event: any) => {
    if (mainWindow) {
      mainWindow.webContents.send('mcp:server:statusChanged', event);
    }
  });

  // Forward tool updates to renderer
  manager.on('serverToolsUpdated', (event: any) => {
    if (mainWindow) {
      mainWindow.webContents.send('mcp:server:toolsUpdated', event);
    }
  });

  // Forward errors to renderer
  manager.on('serverError', (event: any) => {
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
