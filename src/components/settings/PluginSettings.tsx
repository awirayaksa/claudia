import { useEffect, useState } from 'react';
import { usePlugins } from '../../hooks/usePlugins';
import { PluginCard } from '../plugins/PluginCard';
import { Button } from '../common/Button';

export function PluginSettings() {
  const {
    plugins,
    runtimeStates,
    isDiscovering,
    error,
    discover,
    enable,
    disable,
    reload,
    clearPluginError,
  } = usePlugins();

  const [localPluginsDir, setLocalPluginsDir] = useState<string>('');

  // Load local plugins directory path
  useEffect(() => {
    window.electron.plugins.getLocalPluginsDir().then((response: { success: boolean; dir?: string }) => {
      if (response.success && response.dir) {
        setLocalPluginsDir(response.dir);
      }
    });
  }, []);

  // Discover plugins on mount
  useEffect(() => {
    discover();
  }, [discover]);

  const pluginList = Object.values(plugins);
  const extensionPlugins = pluginList.filter((p) => p.type === 'renderer-extension');
  const replacementPlugins = pluginList.filter((p) => p.type === 'renderer-replacement');

  const handleEnable = async (pluginId: string) => {
    try {
      await enable(pluginId);
    } catch (err) {
      console.error('Failed to enable plugin:', err);
    }
  };

  const handleDisable = async (pluginId: string) => {
    try {
      await disable(pluginId);
    } catch (err) {
      console.error('Failed to disable plugin:', err);
    }
  };

  const handleReload = async (pluginId: string) => {
    try {
      await reload(pluginId);
    } catch (err) {
      console.error('Failed to reload plugin:', err);
    }
  };

  return (
    <div className="space-y-6" style={{ padding: '22px 28px' }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Plugins</h2>
          <p className="text-sm text-text-secondary">
            Manage renderer plugins for custom message display
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => discover()}
          disabled={isDiscovering}
        >
          {isDiscovering ? 'Scanning...' : 'Refresh'}
        </Button>
      </div>

      {/* Error display */}
      {error && (
        <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-3">
          <div className="flex items-start justify-between">
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={clearPluginError}
              className="text-red-400 hover:text-red-300"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Local plugins directory info */}
      <div className="rounded-lg border border-border bg-surface p-4">
        <h3 className="text-sm font-medium text-text-primary">Local Plugins Directory</h3>
        <p className="mt-1 text-xs text-text-secondary">
          Place your custom plugins in this folder:
        </p>
        <code className="mt-2 block rounded bg-surface-hover px-2 py-1 text-xs text-text-primary">
          {localPluginsDir || 'Loading...'}
        </code>
        <p className="mt-2 text-xs text-text-secondary">
          Each plugin should have a <code className="text-accent">plugin.json</code> manifest file.
        </p>
      </div>

      {/* No plugins message */}
      {pluginList.length === 0 && !isDiscovering && (
        <div className="rounded-lg border border-border bg-surface p-8 text-center">
          <p className="text-text-secondary">No plugins found</p>
          <p className="mt-1 text-sm text-text-secondary">
            Add plugins to the local plugins directory or install npm packages with the{' '}
            <code className="text-accent">claudia-plugin-</code> prefix.
          </p>
        </div>
      )}

      {/* Extension Plugins */}
      {extensionPlugins.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-medium text-text-primary">
            Extension Plugins ({extensionPlugins.length})
          </h3>
          <p className="mb-3 text-xs text-text-secondary">
            These plugins extend the default markdown renderer with additional features.
          </p>
          <div className="space-y-3">
            {extensionPlugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                status={runtimeStates[plugin.id]?.status || 'discovered'}
                onEnable={() => handleEnable(plugin.id)}
                onDisable={() => handleDisable(plugin.id)}
                onReload={() => handleReload(plugin.id)}
                isLoading={runtimeStates[plugin.id]?.status === 'loading'}
              />
            ))}
          </div>
        </div>
      )}

      {/* Replacement Plugins */}
      {replacementPlugins.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-medium text-text-primary">
            Replacement Plugins ({replacementPlugins.length})
          </h3>
          <p className="mb-3 text-xs text-text-secondary">
            These plugins can completely replace the default renderer. Only one can be active at a time.
          </p>
          <div className="space-y-3">
            {replacementPlugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                status={runtimeStates[plugin.id]?.status || 'discovered'}
                onEnable={() => handleEnable(plugin.id)}
                onDisable={() => handleDisable(plugin.id)}
                onReload={() => handleReload(plugin.id)}
                isLoading={runtimeStates[plugin.id]?.status === 'loading'}
              />
            ))}
          </div>
        </div>
      )}

      {/* Plugin development info */}
      <div className="rounded-lg border border-border bg-surface p-4">
        <h3 className="text-sm font-medium text-text-primary">Creating Plugins</h3>
        <p className="mt-1 text-xs text-text-secondary">
          Plugins can add custom markdown components, pre/post processing, or completely replace the renderer.
        </p>
        <div className="mt-3 space-y-2 text-xs text-text-secondary">
          <p>
            <strong className="text-text-primary">Extension plugins</strong> can provide:
          </p>
          <ul className="ml-4 list-disc space-y-1">
            <li>Custom remark/rehype plugins</li>
            <li>Custom React components for markdown elements</li>
            <li>Pre-processing of markdown content</li>
            <li>Post-processing of rendered output</li>
          </ul>
          <p className="mt-2">
            <strong className="text-text-primary">Replacement plugins</strong> provide a complete custom renderer component.
          </p>
        </div>
      </div>
    </div>
  );
}
