import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import {
  PluginConfig,
  PluginStatus,
  PluginRuntimeState,
  DiscoveredPlugin,
} from '../../types/plugin.types';
import { getPlatform } from '../../platform';

// ============================================================================
// State Interface
// ============================================================================

interface PluginState {
  // Plugin configurations (persisted via Electron store)
  plugins: Record<string, PluginConfig>;

  // Runtime states (ephemeral)
  runtimeStates: Record<string, PluginRuntimeState>;

  // Discovered plugins (from scanning)
  discoveredPlugins: DiscoveredPlugin[];

  // Ordered list of active extension plugin IDs (by priority)
  activeExtensions: string[];

  // Currently active replacement renderer (only one allowed)
  activeReplacement: string | null;

  // UI state
  isDiscovering: boolean;
  isLoading: boolean;
  error: string | null;
  selectedPluginId: string | null;
}

const initialState: PluginState = {
  plugins: {},
  runtimeStates: {},
  discoveredPlugins: [],
  activeExtensions: [],
  activeReplacement: null,
  isDiscovering: false,
  isLoading: false,
  error: null,
  selectedPluginId: null,
};

// ============================================================================
// Async Thunks
// ============================================================================

// Discover all plugins
export const discoverPlugins = createAsyncThunk(
  'plugins/discover',
  async (_, { rejectWithValue }) => {
    try {
      const response = await getPlatform().plugins.discover();
      if (!response.success) {
        throw new Error(response.error || 'Failed to discover plugins');
      }
      return response.plugins as DiscoveredPlugin[];
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to discover plugins'
      );
    }
  }
);

// Load plugin configurations
export const loadPluginConfigs = createAsyncThunk(
  'plugins/loadConfigs',
  async (_, { rejectWithValue }) => {
    try {
      const response = await getPlatform().plugins.list();
      if (!response.success) {
        throw new Error(response.error || 'Failed to load plugin configs');
      }
      return response.configs as Record<string, PluginConfig>;
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to load plugin configs'
      );
    }
  }
);

// Enable a plugin
export const enablePlugin = createAsyncThunk(
  'plugins/enable',
  async (pluginId: string, { dispatch, rejectWithValue }) => {
    try {
      dispatch(setPluginRuntimeState({
        id: pluginId,
        state: { status: 'loading' },
      }));

      const response = await getPlatform().plugins.enable(pluginId);
      if (!response.success) {
        throw new Error(response.error || 'Failed to enable plugin');
      }

      dispatch(setPluginRuntimeState({
        id: pluginId,
        state: { status: 'active', lastActivated: new Date().toISOString() },
      }));

      // Refresh active plugins
      dispatch(refreshActivePlugins());

      return { pluginId };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to enable plugin';
      dispatch(setPluginRuntimeState({
        id: pluginId,
        state: { status: 'error', error: errorMessage },
      }));
      return rejectWithValue(errorMessage);
    }
  }
);

// Disable a plugin
export const disablePlugin = createAsyncThunk(
  'plugins/disable',
  async (pluginId: string, { dispatch, rejectWithValue }) => {
    try {
      const response = await getPlatform().plugins.disable(pluginId);
      if (!response.success) {
        throw new Error(response.error || 'Failed to disable plugin');
      }

      dispatch(setPluginRuntimeState({
        id: pluginId,
        state: { status: 'inactive', lastDeactivated: new Date().toISOString() },
      }));

      // Refresh active plugins
      dispatch(refreshActivePlugins());

      return { pluginId };
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to disable plugin'
      );
    }
  }
);

// Reload a plugin (for development)
export const reloadPlugin = createAsyncThunk(
  'plugins/reload',
  async (pluginId: string, { dispatch, rejectWithValue }) => {
    try {
      dispatch(setPluginRuntimeState({
        id: pluginId,
        state: { status: 'loading' },
      }));

      const response = await getPlatform().plugins.reload(pluginId);
      if (!response.success) {
        throw new Error(response.error || 'Failed to reload plugin');
      }

      dispatch(setPluginRuntimeState({
        id: pluginId,
        state: { status: 'active', lastActivated: new Date().toISOString() },
      }));

      return { pluginId };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to reload plugin';
      dispatch(setPluginRuntimeState({
        id: pluginId,
        state: { status: 'error', error: errorMessage },
      }));
      return rejectWithValue(errorMessage);
    }
  }
);

// Update plugin settings
export const updatePluginSettings = createAsyncThunk(
  'plugins/updateSettings',
  async (
    { pluginId, settings }: { pluginId: string; settings: Record<string, unknown> },
    { rejectWithValue }
  ) => {
    try {
      const response = await getPlatform().plugins.setSettings(pluginId, settings);
      if (!response.success) {
        throw new Error(response.error || 'Failed to update plugin settings');
      }
      return { pluginId, settings };
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to update plugin settings'
      );
    }
  }
);

// Refresh list of active plugins
export const refreshActivePlugins = createAsyncThunk(
  'plugins/refreshActive',
  async (_, { rejectWithValue }) => {
    try {
      const [extensionsResponse, replacementResponse] = await Promise.all([
        getPlatform().plugins.getActiveExtensions(),
        getPlatform().plugins.getActiveReplacement(),
      ]);

      if (!extensionsResponse.success) {
        throw new Error(extensionsResponse.error || 'Failed to get active extensions');
      }

      return {
        activeExtensions: extensionsResponse.extensionIds as string[],
        activeReplacement: replacementResponse.success
          ? (replacementResponse.replacementId as string | null)
          : null,
      };
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to refresh active plugins'
      );
    }
  }
);

// ============================================================================
// Slice Definition
// ============================================================================

const pluginSlice = createSlice({
  name: 'plugins',
  initialState,
  reducers: {
    // Set all plugins
    setPlugins: (state, action: PayloadAction<Record<string, PluginConfig>>) => {
      state.plugins = action.payload;
    },

    // Update a single plugin config
    updatePluginConfig: (
      state,
      action: PayloadAction<{ id: string; updates: Partial<PluginConfig> }>
    ) => {
      if (state.plugins[action.payload.id]) {
        state.plugins[action.payload.id] = {
          ...state.plugins[action.payload.id],
          ...action.payload.updates,
        };
      }
    },

    // Set plugin runtime state
    setPluginRuntimeState: (
      state,
      action: PayloadAction<{ id: string; state: PluginRuntimeState }>
    ) => {
      state.runtimeStates[action.payload.id] = action.payload.state;
    },

    // Update plugin runtime status
    updatePluginStatus: (
      state,
      action: PayloadAction<{ id: string; status: PluginStatus; error?: string }>
    ) => {
      if (!state.runtimeStates[action.payload.id]) {
        state.runtimeStates[action.payload.id] = { status: action.payload.status };
      } else {
        state.runtimeStates[action.payload.id].status = action.payload.status;
      }

      if (action.payload.error) {
        state.runtimeStates[action.payload.id].error = action.payload.error;
      }
    },

    // Set active extensions
    setActiveExtensions: (state, action: PayloadAction<string[]>) => {
      state.activeExtensions = action.payload;
    },

    // Set active replacement
    setActiveReplacement: (state, action: PayloadAction<string | null>) => {
      state.activeReplacement = action.payload;
    },

    // Set selected plugin for detail view
    setSelectedPlugin: (state, action: PayloadAction<string | null>) => {
      state.selectedPluginId = action.payload;
    },

    // Set error
    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
    },

    // Clear error
    clearError: (state) => {
      state.error = null;
    },
  },

  extraReducers: (builder) => {
    // Discover plugins
    builder
      .addCase(discoverPlugins.pending, (state) => {
        state.isDiscovering = true;
        state.error = null;
      })
      .addCase(discoverPlugins.fulfilled, (state, action) => {
        state.isDiscovering = false;
        state.discoveredPlugins = action.payload;

        // Update plugins from discovered
        for (const discovered of action.payload) {
          if (!state.plugins[discovered.id]) {
            state.plugins[discovered.id] = {
              id: discovered.id,
              name: discovered.manifest.name,
              version: discovered.manifest.version,
              source: discovered.source,
              type: discovered.manifest.type,
              enabled: false,
              priority: discovered.manifest.renderer?.priority ?? 100,
              path: discovered.path,
              capabilities: discovered.manifest.capabilities || {},
              settings: {},
              installedAt: new Date().toISOString(),
            };
          }

          // Set runtime state based on validity
          if (!state.runtimeStates[discovered.id]) {
            state.runtimeStates[discovered.id] = {
              status: discovered.isValid ? 'discovered' : 'error',
              error: discovered.isValid ? undefined : discovered.validationErrors?.join(', '),
            };
          }
        }
      })
      .addCase(discoverPlugins.rejected, (state, action) => {
        state.isDiscovering = false;
        state.error = action.payload as string;
      });

    // Load plugin configs
    builder
      .addCase(loadPluginConfigs.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(loadPluginConfigs.fulfilled, (state, action) => {
        state.isLoading = false;
        state.plugins = action.payload;
      })
      .addCase(loadPluginConfigs.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      });

    // Enable plugin
    builder
      .addCase(enablePlugin.pending, (state, action) => {
        const pluginId = action.meta.arg;
        if (state.plugins[pluginId]) {
          state.plugins[pluginId].enabled = true;
        }
      })
      .addCase(enablePlugin.rejected, (state, action) => {
        const pluginId = action.meta.arg;
        if (state.plugins[pluginId]) {
          state.plugins[pluginId].enabled = false;
        }
        state.error = action.payload as string;
      });

    // Disable plugin
    builder
      .addCase(disablePlugin.fulfilled, (state, action) => {
        const pluginId = action.payload.pluginId;
        if (state.plugins[pluginId]) {
          state.plugins[pluginId].enabled = false;
        }
      })
      .addCase(disablePlugin.rejected, (state, action) => {
        state.error = action.payload as string;
      });

    // Update plugin settings
    builder
      .addCase(updatePluginSettings.fulfilled, (state, action) => {
        const { pluginId, settings } = action.payload;
        if (state.plugins[pluginId]) {
          state.plugins[pluginId].settings = settings;
        }
      })
      .addCase(updatePluginSettings.rejected, (state, action) => {
        state.error = action.payload as string;
      });

    // Refresh active plugins
    builder
      .addCase(refreshActivePlugins.fulfilled, (state, action) => {
        state.activeExtensions = action.payload.activeExtensions;
        state.activeReplacement = action.payload.activeReplacement;
      });
  },
});

// ============================================================================
// Exports
// ============================================================================

export const {
  setPlugins,
  updatePluginConfig,
  setPluginRuntimeState,
  updatePluginStatus,
  setActiveExtensions,
  setActiveReplacement,
  setSelectedPlugin,
  setError,
  clearError,
} = pluginSlice.actions;

export default pluginSlice.reducer;
