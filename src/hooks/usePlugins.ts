import { useCallback, useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import {
  discoverPlugins,
  loadPluginConfigs,
  enablePlugin,
  disablePlugin,
  reloadPlugin,
  updatePluginSettings,
  refreshActivePlugins,
  updatePluginStatus,
  setError,
  clearError,
} from '../store/slices/pluginSlice';
import { PluginConfig, PluginStatus } from '../types/plugin.types';
import { getPlatform } from '../platform';

/**
 * Hook for managing plugins in the application.
 */
export function usePlugins() {
  const dispatch = useAppDispatch();

  // Select state
  const plugins = useAppSelector((state) => state.plugins.plugins);
  const runtimeStates = useAppSelector((state) => state.plugins.runtimeStates);
  const discoveredPlugins = useAppSelector((state) => state.plugins.discoveredPlugins);
  const activeExtensions = useAppSelector((state) => state.plugins.activeExtensions);
  const activeReplacement = useAppSelector((state) => state.plugins.activeReplacement);
  const isDiscovering = useAppSelector((state) => state.plugins.isDiscovering);
  const isLoading = useAppSelector((state) => state.plugins.isLoading);
  const error = useAppSelector((state) => state.plugins.error);
  const selectedPluginId = useAppSelector((state) => state.plugins.selectedPluginId);

  // Setup event listeners on mount
  useEffect(() => {
    interface StatusChangedEvent {
      pluginId?: string;
      status?: PluginStatus;
    }

    interface ErrorEvent {
      pluginId?: string;
      error?: string;
    }

    interface ChangedEvent {
      event: string;
      pluginId: string;
    }

    const cleanupStatusChanged = getPlatform().events.on('plugin.statusChanged', (event: StatusChangedEvent) => {
      console.log('[usePlugins] Status changed:', event);
      if (event.pluginId) {
        dispatch(updatePluginStatus({
          id: event.pluginId,
          status: event.status || 'active',
        }));
      }
      // Refresh active plugins list
      dispatch(refreshActivePlugins());
    });

    const cleanupError = getPlatform().events.on('plugin.error', (event: ErrorEvent) => {
      console.error('[usePlugins] Plugin error:', event);
      if (event.pluginId) {
        dispatch(updatePluginStatus({
          id: event.pluginId,
          status: 'error',
          error: event.error,
        }));
      }
      dispatch(setError(event.error || 'Unknown error'));
    });

    // Note: We don't dispatch discoverPlugins on discovered/changed events
    // as that would create an infinite loop. The discovery is already complete
    // when these events fire. Just log for debugging.
    const cleanupDiscovered = getPlatform().events.on('plugin.discovered', () => {
      console.log('[usePlugins] Plugins discovered event received');
    });

    const cleanupChanged = getPlatform().events.on('plugin.changed', (event: ChangedEvent) => {
      console.log('[usePlugins] Plugin changed:', event);
      // Only rediscover on file system changes, not on our own actions
      // This is triggered by the file watcher in plugin-discovery.service.ts
    });

    return () => {
      cleanupStatusChanged();
      cleanupError();
      cleanupDiscovered();
      cleanupChanged();
    };
  }, [dispatch]);

  // Actions
  const discover = useCallback(() => {
    return dispatch(discoverPlugins());
  }, [dispatch]);

  const loadConfigs = useCallback(() => {
    return dispatch(loadPluginConfigs());
  }, [dispatch]);

  const enable = useCallback(
    (pluginId: string) => {
      return dispatch(enablePlugin(pluginId));
    },
    [dispatch]
  );

  const disable = useCallback(
    (pluginId: string) => {
      return dispatch(disablePlugin(pluginId));
    },
    [dispatch]
  );

  const reload = useCallback(
    (pluginId: string) => {
      return dispatch(reloadPlugin(pluginId));
    },
    [dispatch]
  );

  const updateSettings = useCallback(
    (pluginId: string, settings: Record<string, unknown>) => {
      return dispatch(updatePluginSettings({ pluginId, settings }));
    },
    [dispatch]
  );

  const refreshActive = useCallback(() => {
    return dispatch(refreshActivePlugins());
  }, [dispatch]);

  const clearPluginError = useCallback(() => {
    dispatch(clearError());
  }, [dispatch]);

  // Derived data
  const getPluginStatus = useCallback(
    (pluginId: string): PluginStatus => {
      return runtimeStates[pluginId]?.status || 'discovered';
    },
    [runtimeStates]
  );

  const getPluginConfig = useCallback(
    (pluginId: string): PluginConfig | undefined => {
      return plugins[pluginId];
    },
    [plugins]
  );

  const getEnabledPlugins = useCallback((): PluginConfig[] => {
    return Object.values(plugins).filter((p) => p.enabled);
  }, [plugins]);

  const getExtensionPlugins = useCallback((): PluginConfig[] => {
    return Object.values(plugins).filter((p) => p.type === 'renderer-extension');
  }, [plugins]);

  const getReplacementPlugins = useCallback((): PluginConfig[] => {
    return Object.values(plugins).filter((p) => p.type === 'renderer-replacement');
  }, [plugins]);

  return {
    // State
    plugins,
    runtimeStates,
    discoveredPlugins,
    activeExtensions,
    activeReplacement,
    isDiscovering,
    isLoading,
    error,
    selectedPluginId,

    // Actions
    discover,
    loadConfigs,
    enable,
    disable,
    reload,
    updateSettings,
    refreshActive,
    clearPluginError,

    // Getters
    getPluginStatus,
    getPluginConfig,
    getEnabledPlugins,
    getExtensionPlugins,
    getReplacementPlugins,
  };
}
