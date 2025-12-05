import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  // Configuration
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (config: any) => ipcRenderer.invoke('config:set', config),
  },

  // File operations
  file: {
    select: () => ipcRenderer.invoke('file:select'),
    read: (path: string) => ipcRenderer.invoke('file:read', path),
    save: (path: string, data: any) => ipcRenderer.invoke('file:save', path, data),
  },

  // Conversation operations
  conversation: {
    save: (conversation: any) => ipcRenderer.invoke('conversation:save', conversation),
    load: (id: string, projectId: string | null) => ipcRenderer.invoke('conversation:load', id, projectId),
    list: (projectId?: string | null) => ipcRenderer.invoke('conversation:list', projectId),
    delete: (id: string, projectId: string | null) => ipcRenderer.invoke('conversation:delete', id, projectId),
  },

  // Project operations
  project: {
    create: (project: any) => ipcRenderer.invoke('project:create', project),
    update: (id: string, updates: any) => ipcRenderer.invoke('project:update', id, updates),
    delete: (id: string) => ipcRenderer.invoke('project:delete', id),
    get: (id: string) => ipcRenderer.invoke('project:get', id),
    list: () => ipcRenderer.invoke('project:list'),
  },

  // Platform information
  platform: process.platform,

  // Menu event listeners
  onMenuEvent: (channel: string, callback: () => void) => {
    const validChannels = [
      'menu:open-settings',
      'menu:toggle-sidebar',
      'menu:new-conversation',
      'menu:about',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, callback);
      // Return cleanup function
      return () => ipcRenderer.removeListener(channel, callback);
    }
  },

  // MCP (Model Context Protocol) operations
  mcp: {
    // Server management
    startServer: (serverId: string) => ipcRenderer.invoke('mcp:server:start', serverId),
    stopServer: (serverId: string) => ipcRenderer.invoke('mcp:server:stop', serverId),
    restartServer: (serverId: string) => ipcRenderer.invoke('mcp:server:restart', serverId),
    getServerStatus: (serverId: string) => ipcRenderer.invoke('mcp:server:getStatus', serverId),
    getLogs: (serverId: string) => ipcRenderer.invoke('mcp:server:getLogs', serverId),
    clearLogs: (serverId: string) => ipcRenderer.invoke('mcp:server:clearLogs', serverId),

    // Configuration
    listConfigs: () => ipcRenderer.invoke('mcp:config:list'),
    getConfig: (serverId: string) => ipcRenderer.invoke('mcp:config:get', serverId),
    saveConfig: (config: any) => ipcRenderer.invoke('mcp:config:save', config),
    deleteConfig: (serverId: string) => ipcRenderer.invoke('mcp:config:delete', serverId),

    // Tools
    listTools: (serverId: string) => ipcRenderer.invoke('mcp:tools:list', serverId),
    callTool: (serverId: string, toolName: string, args: any) =>
      ipcRenderer.invoke('mcp:tools:call', serverId, toolName, args),

    // Import
    importClaudeDesktop: () => ipcRenderer.invoke('mcp:import:claudeDesktop'),

    // Event listeners
    onServerStatusChanged: (callback: (event: any) => void) => {
      ipcRenderer.on('mcp:server:statusChanged', (_event, data) => callback(data));
      return () => ipcRenderer.removeListener('mcp:server:statusChanged', callback);
    },
    onServerToolsUpdated: (callback: (event: any) => void) => {
      ipcRenderer.on('mcp:server:toolsUpdated', (_event, data) => callback(data));
      return () => ipcRenderer.removeListener('mcp:server:toolsUpdated', callback);
    },
    onServerError: (callback: (event: any) => void) => {
      ipcRenderer.on('mcp:server:error', (_event, data) => callback(data));
      return () => ipcRenderer.removeListener('mcp:server:error', callback);
    },
  },
});

// Type definitions for TypeScript (will create separate types file later)
export interface ElectronAPI {
  config: {
    get: () => Promise<any>;
    set: (config: any) => Promise<void>;
  };
  file: {
    select: () => Promise<string[]>;
    read: (path: string) => Promise<Buffer>;
    save: (path: string, data: any) => Promise<void>;
  };
  conversation: {
    save: (conversation: any) => Promise<any>;
    load: (id: string, projectId: string | null) => Promise<any>;
    list: (projectId?: string | null) => Promise<any>;
    delete: (id: string, projectId: string | null) => Promise<any>;
  };
  project: {
    create: (project: any) => Promise<any>;
    update: (id: string, updates: any) => Promise<any>;
    delete: (id: string) => Promise<any>;
    get: (id: string) => Promise<any>;
    list: () => Promise<any>;
  };
  platform: string;
  onMenuEvent: (channel: string, callback: () => void) => (() => void) | undefined;
  mcp: {
    // Server management
    startServer: (serverId: string) => Promise<any>;
    stopServer: (serverId: string) => Promise<any>;
    restartServer: (serverId: string) => Promise<any>;
    getServerStatus: (serverId: string) => Promise<any>;
    getLogs: (serverId: string) => Promise<any>;
    clearLogs: (serverId: string) => Promise<any>;
    // Configuration
    listConfigs: () => Promise<any>;
    getConfig: (serverId: string) => Promise<any>;
    saveConfig: (config: any) => Promise<any>;
    deleteConfig: (serverId: string) => Promise<any>;
    // Tools
    listTools: (serverId: string) => Promise<any>;
    callTool: (serverId: string, toolName: string, args: any) => Promise<any>;
    // Import
    importClaudeDesktop: () => Promise<any>;
    // Event listeners
    onServerStatusChanged: (callback: (event: any) => void) => () => void;
    onServerToolsUpdated: (callback: (event: any) => void) => () => void;
    onServerError: (callback: (event: any) => void) => () => void;
  };
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
