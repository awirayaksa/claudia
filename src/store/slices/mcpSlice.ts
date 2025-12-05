import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import {
  MCPServerConfig,
  MCPServerState,
  MCPServerStatus,
  MCPTool,
} from '../../types/mcp.types';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// State Interface
// ============================================================================

interface MCPState {
  // Server configurations (persisted)
  servers: Record<string, MCPServerConfig>;

  // Runtime state (ephemeral)
  serverStates: Record<string, MCPServerState>;

  // All available tools (aggregated from all ready servers)
  availableTools: MCPTool[];

  // UI state
  isLoadingServers: boolean;
  error: string | null;
  selectedServerId: string | null; // For detail view
}

const initialState: MCPState = {
  servers: {},
  serverStates: {},
  availableTools: [],
  isLoadingServers: false,
  error: null,
  selectedServerId: null,
};

// ============================================================================
// Async Thunks
// ============================================================================

// Load all server configurations from Electron store
export const loadMCPServers = createAsyncThunk(
  'mcp/loadServers',
  async (_, { rejectWithValue }) => {
    try {
      const response = await window.electron.mcp.listConfigs();
      if (!response.success) {
        throw new Error(response.error || 'Failed to load servers');
      }
      return response.servers;
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to load servers'
      );
    }
  }
);

// Start an MCP server
export const startMCPServer = createAsyncThunk(
  'mcp/startServer',
  async (serverId: string, { getState, dispatch, rejectWithValue }) => {
    try {
      const response = await window.electron.mcp.startServer(serverId);
      if (!response.success) {
        throw new Error(response.error || 'Failed to start server');
      }
      return { serverId };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to start server';
      dispatch(
        setServerError({
          id: serverId,
          error: errorMessage,
        })
      );
      return rejectWithValue(errorMessage);
    }
  }
);

// Stop an MCP server
export const stopMCPServer = createAsyncThunk(
  'mcp/stopServer',
  async (serverId: string, { rejectWithValue }) => {
    try {
      const response = await window.electron.mcp.stopServer(serverId);
      if (!response.success) {
        throw new Error(response.error || 'Failed to stop server');
      }
      return { serverId };
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to stop server'
      );
    }
  }
);

// Restart an MCP server
export const restartMCPServer = createAsyncThunk(
  'mcp/restartServer',
  async (serverId: string, { rejectWithValue }) => {
    try {
      const response = await window.electron.mcp.restartServer(serverId);
      if (!response.success) {
        throw new Error(response.error || 'Failed to restart server');
      }
      return { serverId };
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to restart server'
      );
    }
  }
);

// Save server configuration
export const saveMCPServer = createAsyncThunk(
  'mcp/saveServer',
  async (config: MCPServerConfig, { dispatch, rejectWithValue }) => {
    try {
      const response = await window.electron.mcp.saveConfig(config);
      if (!response.success) {
        throw new Error(response.error || 'Failed to save server');
      }
      dispatch(addServer(config));
      return config;
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to save server'
      );
    }
  }
);

// Delete server configuration
export const deleteMCPServer = createAsyncThunk(
  'mcp/deleteServer',
  async (serverId: string, { getState, dispatch, rejectWithValue }) => {
    try {
      const state = getState() as { mcp: MCPState };
      const serverState = state.mcp.serverStates[serverId];

      // Stop if running
      if (
        serverState?.status === 'ready' ||
        serverState?.status === 'starting' ||
        serverState?.status === 'initializing'
      ) {
        await window.electron.mcp.stopServer(serverId);
      }

      const response = await window.electron.mcp.deleteConfig(serverId);
      if (!response.success) {
        throw new Error(response.error || 'Failed to delete server');
      }

      dispatch(removeServer(serverId));
      return { serverId };
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to delete server'
      );
    }
  }
);

// Import servers from Claude Desktop config
export const importFromClaudeDesktop = createAsyncThunk(
  'mcp/importClaudeDesktop',
  async (_, { dispatch, rejectWithValue }) => {
    try {
      const response = await window.electron.mcp.importClaudeDesktop();
      if (!response.success) {
        throw new Error(response.error || 'Failed to import from Claude Desktop');
      }

      const configs = response.configs;
      for (const config of configs) {
        dispatch(addServer(config));
      }

      return configs;
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to import from Claude Desktop'
      );
    }
  }
);

// Call an MCP tool
export const callMCPTool = createAsyncThunk(
  'mcp/callTool',
  async (
    {
      serverId,
      toolName,
      args,
    }: {
      serverId: string;
      toolName: string;
      args: Record<string, any>;
    },
    { rejectWithValue }
  ) => {
    try {
      const response = await window.electron.mcp.callTool(serverId, toolName, args);
      if (!response.success) {
        throw new Error(response.error || 'Failed to call tool');
      }
      return { toolName, result: response.result };
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to call tool'
      );
    }
  }
);

// Sync all server tools (fetch tools from all running servers)
export const syncAllServerTools = createAsyncThunk(
  'mcp/syncAllServerTools',
  async (_, { getState, dispatch }) => {
    const state = getState() as { mcp: MCPState };
    const serverIds = Object.keys(state.mcp.servers);

    console.log('[MCP] Syncing tools for', serverIds.length, 'servers');

    for (const serverId of serverIds) {
      try {
        // Get server status
        const statusResponse = await window.electron.mcp.getServerStatus(serverId);
        if (statusResponse.success && statusResponse.status === 'ready') {
          // Get server tools
          const toolsResponse = await window.electron.mcp.listTools(serverId);
          if (toolsResponse.success) {
            console.log(`[MCP] Synced ${toolsResponse.tools.length} tools for server ${serverId}`);
            dispatch(
              setServerTools({
                id: serverId,
                tools: toolsResponse.tools,
              })
            );
          }
        }
      } catch (error) {
        console.error(`[MCP] Failed to sync tools for server ${serverId}:`, error);
      }
    }
  }
);

// ============================================================================
// Slice Definition
// ============================================================================

const mcpSlice = createSlice({
  name: 'mcp',
  initialState,
  reducers: {
    // Server configuration
    setServers: (state, action: PayloadAction<Record<string, MCPServerConfig>>) => {
      state.servers = action.payload;
    },

    addServer: (state, action: PayloadAction<MCPServerConfig>) => {
      state.servers[action.payload.id] = action.payload;
    },

    updateServer: (
      state,
      action: PayloadAction<{ id: string; updates: Partial<MCPServerConfig> }>
    ) => {
      if (state.servers[action.payload.id]) {
        state.servers[action.payload.id] = {
          ...state.servers[action.payload.id],
          ...action.payload.updates,
        };
      }
    },

    removeServer: (state, action: PayloadAction<string>) => {
      delete state.servers[action.payload];
      delete state.serverStates[action.payload];
      // Rebuild available tools after removal
      rebuildAvailableToolsHelper(state);
    },

    // Server state updates (from IPC events)
    setServerState: (
      state,
      action: PayloadAction<{ id: string; state: MCPServerState }>
    ) => {
      state.serverStates[action.payload.id] = action.payload.state;
    },

    updateServerStatus: (
      state,
      action: PayloadAction<{ id: string; status: MCPServerStatus; error?: string }>
    ) => {
      if (!state.serverStates[action.payload.id]) {
        // Initialize server state if it doesn't exist
        const config = state.servers[action.payload.id];
        if (config) {
          state.serverStates[action.payload.id] = {
            config,
            status: action.payload.status,
            tools: [],
            resources: [],
            prompts: [],
            restartCount: 0,
          };
        }
      } else {
        state.serverStates[action.payload.id].status = action.payload.status;
        if (action.payload.error) {
          state.serverStates[action.payload.id].error = action.payload.error;
        }
      }

      // If server stopped or errored, clear tools
      if (
        action.payload.status === 'stopped' ||
        action.payload.status === 'error'
      ) {
        if (state.serverStates[action.payload.id]) {
          state.serverStates[action.payload.id].tools = [];
        }
        rebuildAvailableToolsHelper(state);
      }
    },

    setServerTools: (
      state,
      action: PayloadAction<{ id: string; tools: MCPTool[] }>
    ) => {
      if (state.serverStates[action.payload.id]) {
        state.serverStates[action.payload.id].tools = action.payload.tools;
        rebuildAvailableToolsHelper(state);
      }
    },

    setServerError: (state, action: PayloadAction<{ id: string; error: string }>) => {
      if (state.serverStates[action.payload.id]) {
        state.serverStates[action.payload.id].error = action.payload.error;
        state.serverStates[action.payload.id].status = 'error';
      }
    },

    // Aggregated tools
    rebuildAvailableTools: (state) => {
      rebuildAvailableToolsHelper(state);
    },

    // UI state
    setSelectedServer: (state, action: PayloadAction<string | null>) => {
      state.selectedServerId = action.payload;
    },

    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
    },

    clearError: (state) => {
      state.error = null;
    },
  },

  extraReducers: (builder) => {
    // Load servers
    builder
      .addCase(loadMCPServers.pending, (state) => {
        state.isLoadingServers = true;
        state.error = null;
      })
      .addCase(loadMCPServers.fulfilled, (state, action) => {
        state.isLoadingServers = false;
        state.servers = action.payload;
      })
      .addCase(loadMCPServers.rejected, (state, action) => {
        state.isLoadingServers = false;
        state.error = action.payload as string;
      });

    // Start server
    builder
      .addCase(startMCPServer.pending, (state, action) => {
        const serverId = action.meta.arg;
        if (!state.serverStates[serverId]) {
          const config = state.servers[serverId];
          if (config) {
            state.serverStates[serverId] = {
              config,
              status: 'starting',
              tools: [],
              resources: [],
              prompts: [],
              restartCount: 0,
            };
          }
        } else {
          state.serverStates[serverId].status = 'starting';
        }
      })
      .addCase(startMCPServer.rejected, (state, action) => {
        const serverId = action.meta.arg;
        if (state.serverStates[serverId]) {
          state.serverStates[serverId].status = 'error';
          state.serverStates[serverId].error = action.payload as string;
        }
      });

    // Stop server
    builder.addCase(stopMCPServer.fulfilled, (state, action) => {
      const serverId = action.payload.serverId;
      if (state.serverStates[serverId]) {
        state.serverStates[serverId].status = 'stopped';
        state.serverStates[serverId].tools = [];
        rebuildAvailableToolsHelper(state);
      }
    });

    // Delete server
    builder.addCase(deleteMCPServer.fulfilled, (state, action) => {
      const serverId = action.payload.serverId;
      delete state.servers[serverId];
      delete state.serverStates[serverId];
      rebuildAvailableToolsHelper(state);
    });

    // Import from Claude Desktop
    builder
      .addCase(importFromClaudeDesktop.pending, (state) => {
        state.isLoadingServers = true;
        state.error = null;
      })
      .addCase(importFromClaudeDesktop.fulfilled, (state) => {
        state.isLoadingServers = false;
      })
      .addCase(importFromClaudeDesktop.rejected, (state, action) => {
        state.isLoadingServers = false;
        state.error = action.payload as string;
      });
  },
});

// ============================================================================
// Helper Functions
// ============================================================================

function rebuildAvailableToolsHelper(state: MCPState) {
  const tools: MCPTool[] = [];
  const seenToolNames = new Set<string>();

  for (const [serverId, serverState] of Object.entries(state.serverStates)) {
    if (serverState.status === 'ready' && serverState.tools.length > 0) {
      for (const tool of serverState.tools) {
        // Avoid duplicate tool names (first server wins)
        if (!seenToolNames.has(tool.name)) {
          tools.push(tool);
          seenToolNames.add(tool.name);
        } else {
          console.warn(
            `[MCP] Duplicate tool name "${tool.name}" from server ${serverId}, skipping`
          );
        }
      }
    }
  }

  state.availableTools = tools;
}

// ============================================================================
// Exports
// ============================================================================

export const {
  setServers,
  addServer,
  updateServer,
  removeServer,
  setServerState,
  updateServerStatus,
  setServerTools,
  setServerError,
  rebuildAvailableTools,
  setSelectedServer,
  setError,
  clearError,
} = mcpSlice.actions;

export default mcpSlice.reducer;
