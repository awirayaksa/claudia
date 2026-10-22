import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

/**
 * Register an IPC listener that forwards only the payload to `callback`, and
 * return a cleanup that removes exactly the wrapper that was registered.
 * Removing `callback` itself would be a no-op and leak the listener.
 */
function subscribe<T>(channel: string, callback: (data: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, data: T) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  // Configuration
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (config: any) => ipcRenderer.invoke('config:set', config),
  },

  // Profile operations
  profile: {
    list: () => ipcRenderer.invoke('profile:list'),
    switch: (id: string) => ipcRenderer.invoke('profile:switch', id),
    create: (payload: { name: string; cloneCurrent: boolean }) => ipcRenderer.invoke('profile:create', payload),
    rename: (id: string, name: string) => ipcRenderer.invoke('profile:rename', id, name),
    duplicate: (id: string, newName: string) => ipcRenderer.invoke('profile:duplicate', id, newName),
    delete: (id: string) => ipcRenderer.invoke('profile:delete', id),
  },

  // File operations
  file: {
    select: () => ipcRenderer.invoke('file:select'),
    selectDirectories: () => ipcRenderer.invoke('file:selectDirectories'),
    read: (path: string) => ipcRenderer.invoke('file:read', path),
    save: (path: string, data: any) => ipcRenderer.invoke('file:save', path, data),
    listDirectory: (dirPath: string) => ipcRenderer.invoke('file:listDirectory', dirPath),
    extractText: (payload: { name: string; mimeType?: string; data: Uint8Array }) =>
      ipcRenderer.invoke('file:extractText', payload),
    openPath: (filePath: string) => ipcRenderer.invoke('file:openPath', filePath),
    showInFolder: (filePath: string) => ipcRenderer.invoke('file:showInFolder', filePath),
  },

  // Conversation operations
  conversation: {
    save: (conversation: any) => ipcRenderer.invoke('conversation:save', conversation),
    updateMeta: (
      id: string,
      projectId: string | null,
      patch: { title?: string; model?: string; starred?: boolean }
    ) => ipcRenderer.invoke('conversation:updateMeta', id, projectId, patch),
    load: (id: string, projectId: string | null) => ipcRenderer.invoke('conversation:load', id, projectId),
    list: (projectId?: string | null) => ipcRenderer.invoke('conversation:list', projectId),
    delete: (id: string, projectId: string | null) => ipcRenderer.invoke('conversation:delete', id, projectId),
    deleteMultiple: (conversations: Array<{ id: string; projectId: string | null }>) =>
      ipcRenderer.invoke('conversation:deleteMultiple', conversations),
    deleteAll: (projectId: string | null) => ipcRenderer.invoke('conversation:deleteAll', projectId),
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

  // Window operations
  window: {
    setTitle: (title: string) => ipcRenderer.invoke('window:setTitle', title),
    setBackgroundColor: (color: string) => ipcRenderer.invoke('window:setBackgroundColor', color),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    showMenu: (x: number, y: number) => ipcRenderer.invoke('window:showMenu', x, y),
  },

  // System prompt operations
  systemPrompt: {
    selectFile: () => ipcRenderer.invoke('systemPrompt:selectFile'),
  },

  // Icon operations
  icon: {
    select: () => ipcRenderer.invoke('icon:select'),
    upload: (sourcePath: string) => ipcRenderer.invoke('icon:upload', sourcePath),
    apply: (iconPath: string) => ipcRenderer.invoke('icon:apply', iconPath),
    reset: () => ipcRenderer.invoke('icon:reset'),
    getPreview: (iconPath: string) => ipcRenderer.invoke('icon:getPreview', iconPath),
  },

  // Menu event listeners
  onMenuEvent: (channel: string, callback: () => void) => {
    const validChannels = [
      'menu:open-settings',
      'menu:toggle-sidebar',
      'menu:new-conversation',
      'menu:about',
    ];
    if (validChannels.includes(channel)) {
      const handler = () => callback();
      ipcRenderer.on(channel, handler);
      // Return cleanup function (removes the same wrapper that was registered)
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    }
  },

  // Menu state control
  setNewConversationEnabled: (enabled: boolean) =>
    ipcRenderer.send('menu:set-new-conversation-enabled', enabled),

  // MCP (Model Context Protocol) operations
  mcp: {
    // Server management
    startServer: (serverId: string) => ipcRenderer.invoke('mcp:server:start', serverId),
    stopServer: (serverId: string) => ipcRenderer.invoke('mcp:server:stop', serverId),
    restartServer: (serverId: string) => ipcRenderer.invoke('mcp:server:restart', serverId),
    restartWithBuiltinConfig: (serverId: string, builtinConfig: Record<string, unknown>) =>
      ipcRenderer.invoke('mcp:server:restartWithBuiltinConfig', serverId, builtinConfig),
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
      return subscribe('mcp:server:statusChanged', callback);
    },
    onServerToolsUpdated: (callback: (event: any) => void) => {
      return subscribe('mcp:server:toolsUpdated', callback);
    },
    onServerResourcesUpdated: (callback: (event: any) => void) => {
      return subscribe('mcp:server:resourcesUpdated', callback);
    },
    onServerPromptsUpdated: (callback: (event: any) => void) => {
      return subscribe('mcp:server:promptsUpdated', callback);
    },
    onServerError: (callback: (event: any) => void) => {
      return subscribe('mcp:server:error', callback);
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
      return subscribe('plugin:statusChanged', callback);
    },
    onError: (callback: (event: any) => void) => {
      return subscribe('plugin:error', callback);
    },
    onDiscovered: (callback: (event: any) => void) => {
      return subscribe('plugin:discovered', callback);
    },
    onChanged: (callback: (event: any) => void) => {
      return subscribe('plugin:changed', callback);
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
      return subscribe('logger:entry', callback);
    },
  },

  // Skills
  skills: {
    list: () => ipcRenderer.invoke('skill:list'),
    get: (id: string) => ipcRenderer.invoke('skill:get', id),
    create: (payload: any) => ipcRenderer.invoke('skill:create', payload),
    update: (payload: any) => ipcRenderer.invoke('skill:update', payload),
    delete: (id: string) => ipcRenderer.invoke('skill:delete', id),
    getDir: () => ipcRenderer.invoke('skill:getDir'),
    openDir: () => ipcRenderer.invoke('skill:openDir'),
    onChanged: (callback: (skills: any[]) => void) => {
      return subscribe('skill:changed', callback);
    },
  },

  // Auto-updater (portable builds)
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    getStatus: () => ipcRenderer.invoke('updater:getStatus'),
    relaunch: () => ipcRenderer.invoke('updater:relaunch'),
    restartCheck: () => ipcRenderer.invoke('updater:restartCheck'),
    onStatusChanged: (callback: (status: any) => void) => {
      return subscribe('updater:status-changed', callback);
    },
    onDownloadProgress: (callback: (percent: number) => void) => {
      return subscribe('updater:download-progress', callback);
    },
    onLastAttemptFailed: (callback: (payload: any) => void) => {
      return subscribe('updater:last-attempt-failed', callback);
    },
  },
});

// Type definitions for TypeScript (will create separate types file later)
export interface ElectronAPI {
  config: {
    get: () => Promise<any>;
    set: (config: any) => Promise<void>;
  };
  profile: {
    list: () => Promise<{ profiles: any[]; currentProfileId: string }>;
    switch: (id: string) => Promise<any>;
    create: (payload: { name: string; cloneCurrent: boolean }) => Promise<any>;
    rename: (id: string, name: string) => Promise<void>;
    duplicate: (id: string, newName: string) => Promise<any>;
    delete: (id: string) => Promise<void>;
  };
  file: {
    select: () => Promise<string[]>;
    read: (path: string) => Promise<string>;
    save: (path: string, data: any) => Promise<void>;
    listDirectory: (dirPath: string) => Promise<{
      success: boolean;
      entries: Array<{ name: string; isDirectory: boolean }>;
      error?: string;
    }>;
    extractText: (payload: { name: string; mimeType?: string; data: Uint8Array }) => Promise<{
      success: boolean;
      text?: string;
      truncated?: boolean;
      error?: string;
    }>;
    /** Open a file a built-in tool wrote, in its default app. */
    openPath: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    /** Show a file in the system file manager. */
    showInFolder: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  };
  conversation: {
    save: (conversation: any) => Promise<any>;
    updateMeta: (
      id: string,
      projectId: string | null,
      patch: { title?: string; model?: string; starred?: boolean }
    ) => Promise<any>;
    load: (id: string, projectId: string | null) => Promise<any>;
    list: (projectId?: string | null) => Promise<any>;
    delete: (id: string, projectId: string | null) => Promise<any>;
    deleteMultiple: (conversations: Array<{ id: string; projectId: string | null }>) => Promise<any>;
    deleteAll: (projectId: string | null) => Promise<any>;
  };
  project: {
    create: (project: any) => Promise<any>;
    update: (id: string, updates: any) => Promise<any>;
    delete: (id: string) => Promise<any>;
    get: (id: string) => Promise<any>;
    list: () => Promise<any>;
  };
  platform: string;
  window: {
    setTitle: (title: string) => Promise<void>;
    setBackgroundColor: (color: string) => Promise<void>;
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    showMenu: (x: number, y: number) => Promise<void>;
  };
  icon: {
    select: () => Promise<string | null>;
    upload: (sourcePath: string) => Promise<string>;
    apply: (iconPath: string) => Promise<{ success: boolean; requiresRestart: boolean }>;
    reset: () => Promise<void>;
    getPreview: (iconPath: string) => Promise<string | null>;
  };
  onMenuEvent: (channel: string, callback: () => void) => (() => void) | undefined;
  mcp: {
    // Server management
    startServer: (serverId: string) => Promise<any>;
    stopServer: (serverId: string) => Promise<any>;
    restartServer: (serverId: string) => Promise<any>;
    restartWithBuiltinConfig: (serverId: string, builtinConfig: Record<string, unknown>) => Promise<any>;
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
  skills: {
    list: () => Promise<any>;
    get: (id: string) => Promise<any>;
    create: (payload: any) => Promise<any>;
    update: (payload: any) => Promise<any>;
    delete: (id: string) => Promise<any>;
    getDir: () => Promise<any>;
    openDir: () => Promise<any>;
    onChanged: (callback: (skills: any[]) => void) => () => void;
  };
  updater: {
    check: () => Promise<any>;
    getStatus: () => Promise<any>;
    relaunch: () => Promise<void>;
    restartCheck: () => Promise<void>;
    onStatusChanged: (callback: (status: any) => void) => () => void;
    onDownloadProgress: (callback: (percent: number) => void) => () => void;
    onLastAttemptFailed: (callback: (payload: any) => void) => () => void;
  };
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
