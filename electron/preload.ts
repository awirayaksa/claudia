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
    callTool: (serverId: string, toolName: string, args: any, traceId?: string) =>
      ipcRenderer.invoke('mcp:tools:call', serverId, toolName, args, traceId),

    // Resources
    listResources: (serverId: string) => ipcRenderer.invoke('mcp:resources:list', serverId),
    readResource: (serverId: string, uri: string) =>
      ipcRenderer.invoke('mcp:resources:read', serverId, uri),

    // Prompts
    listPrompts: (serverId: string) => ipcRenderer.invoke('mcp:prompts:list', serverId),
    getPrompt: (serverId: string, promptName: string, args?: Record<string, string>) =>
      ipcRenderer.invoke('mcp:prompts:get', serverId, promptName, args),

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
    onServerResourcesUpdated: (callback: (event: any) => void) => {
      ipcRenderer.on('mcp:server:resourcesUpdated', (_event, data) => callback(data));
      return () => ipcRenderer.removeListener('mcp:server:resourcesUpdated', callback);
    },
    onServerPromptsUpdated: (callback: (event: any) => void) => {
      ipcRenderer.on('mcp:server:promptsUpdated', (_event, data) => callback(data));
      return () => ipcRenderer.removeListener('mcp:server:promptsUpdated', callback);
    },
    onServerError: (callback: (event: any) => void) => {
      ipcRenderer.on('mcp:server:error', (_event, data) => callback(data));
      return () => ipcRenderer.removeListener('mcp:server:error', callback);
    },
  },

  // Plugin operations
  plugins: {
    // Discovery
    discover: () => ipcRenderer.invoke('plugin:discover'),

    // Loading
    load: (pluginId: string) => ipcRenderer.invoke('plugin:load', pluginId),
    unload: (pluginId: string) => ipcRenderer.invoke('plugin:unload', pluginId),
    reload: (pluginId: string) => ipcRenderer.invoke('plugin:reload', pluginId),

    // Enable/Disable
    enable: (pluginId: string) => ipcRenderer.invoke('plugin:enable', pluginId),
    disable: (pluginId: string) => ipcRenderer.invoke('plugin:disable', pluginId),

    // Configuration
    list: () => ipcRenderer.invoke('plugin:list'),
    getConfig: (pluginId: string) => ipcRenderer.invoke('plugin:getConfig', pluginId),
    updateConfig: (pluginId: string, updates: any) =>
      ipcRenderer.invoke('plugin:updateConfig', pluginId, updates),

    // Settings
    getSettings: (pluginId: string) => ipcRenderer.invoke('plugin:getSettings', pluginId),
    setSettings: (pluginId: string, settings: any) =>
      ipcRenderer.invoke('plugin:setSettings', pluginId, settings),

    // Status
    getStatus: (pluginId: string) => ipcRenderer.invoke('plugin:getStatus', pluginId),
    getActiveExtensions: () => ipcRenderer.invoke('plugin:getActiveExtensions'),
    getActiveReplacement: () => ipcRenderer.invoke('plugin:getActiveReplacement'),

    // Utility
    getLocalPluginsDir: () => ipcRenderer.invoke('plugin:getLocalPluginsDir'),

    // Event listeners
    onStatusChanged: (callback: (event: any) => void) => {
      ipcRenderer.on('plugin:statusChanged', (_event, data) => callback(data));
      return () => ipcRenderer.removeListener('plugin:statusChanged', callback);
    },
    onError: (callback: (event: any) => void) => {
      ipcRenderer.on('plugin:error', (_event, data) => callback(data));
      return () => ipcRenderer.removeListener('plugin:error', callback);
    },
    onDiscovered: (callback: (event: any) => void) => {
      ipcRenderer.on('plugin:discovered', (_event, data) => callback(data));
      return () => ipcRenderer.removeListener('plugin:discovered', callback);
    },
    onChanged: (callback: (event: any) => void) => {
      ipcRenderer.on('plugin:changed', (_event, data) => callback(data));
      return () => ipcRenderer.removeListener('plugin:changed', callback);
    },
  },

  // Logger operations
  logger: {
    // Write log entry from renderer to main for file logging
    write: (entry: any) => ipcRenderer.invoke('logger:write', entry),

    // Open logs folder in file explorer
    openLogsFolder: () => ipcRenderer.invoke('logger:openLogsFolder'),

    // Get log directory path
    getLogDirectory: () => ipcRenderer.invoke('logger:getLogDirectory'),

    // Event listener for logs from main process
    onLogEntry: (callback: (entry: any) => void) => {
      ipcRenderer.on('logger:entry', (_event, data) => callback(data));
      return () => ipcRenderer.removeListener('logger:entry', callback);
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
    // Resources
    listResources: (serverId: string) => Promise<any>;
    readResource: (serverId: string, uri: string) => Promise<any>;
    // Prompts
    listPrompts: (serverId: string) => Promise<any>;
    getPrompt: (serverId: string, promptName: string, args?: Record<string, string>) => Promise<any>;
    // Import
    importClaudeDesktop: () => Promise<any>;
    // Event listeners
    onServerStatusChanged: (callback: (event: any) => void) => () => void;
    onServerToolsUpdated: (callback: (event: any) => void) => () => void;
    onServerResourcesUpdated: (callback: (event: any) => void) => () => void;
    onServerPromptsUpdated: (callback: (event: any) => void) => () => void;
    onServerError: (callback: (event: any) => void) => () => void;
  };
  plugins: {
    // Discovery
    discover: () => Promise<any>;
    // Loading
    load: (pluginId: string) => Promise<any>;
    unload: (pluginId: string) => Promise<any>;
    reload: (pluginId: string) => Promise<any>;
    // Enable/Disable
    enable: (pluginId: string) => Promise<any>;
    disable: (pluginId: string) => Promise<any>;
    // Configuration
    list: () => Promise<any>;
    getConfig: (pluginId: string) => Promise<any>;
    updateConfig: (pluginId: string, updates: any) => Promise<any>;
    // Settings
    getSettings: (pluginId: string) => Promise<any>;
    setSettings: (pluginId: string, settings: any) => Promise<any>;
    // Status
    getStatus: (pluginId: string) => Promise<any>;
    getActiveExtensions: () => Promise<any>;
    getActiveReplacement: () => Promise<any>;
    // Utility
    getLocalPluginsDir: () => Promise<any>;
    // Event listeners
    onStatusChanged: (callback: (event: any) => void) => () => void;
    onError: (callback: (event: any) => void) => () => void;
    onDiscovered: (callback: (event: any) => void) => () => void;
    onChanged: (callback: (event: any) => void) => () => void;
  };
  logger: {
    write: (entry: any) => Promise<void>;
    openLogsFolder: () => Promise<void>;
    getLogDirectory: () => Promise<string | null>;
    onLogEntry: (callback: (entry: any) => void) => () => void;
  };
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
