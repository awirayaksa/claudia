import { useState, useEffect } from 'react';
import { useAppSelector, useAppDispatch } from '../../store';
import { setApiConfig, setAvailableModels, setPreferences } from '../../store/slices/settingsSlice';
import { ProviderFactory } from '../../services/api/provider.factory';
import { ProviderType, OpenWebUIConfig, OpenRouterConfig } from '../../types/api.types';
import { OpenWebUIConfigForm } from './OpenWebUIConfigForm';
import { OpenRouterConfigForm } from './OpenRouterConfigForm';

export function ApiSettings() {
  const dispatch = useAppDispatch();
  const { api, preferences } = useAppSelector((state) => state.settings);

  // Local state for form inputs
  const [provider, setProvider] = useState<ProviderType>(api.provider || 'openwebui');
  const [openwebuiConfig, setOpenwebuiConfig] = useState<Partial<OpenWebUIConfig>>(
    api.openwebui || { baseUrl: '', apiKey: '', selectedModel: '' }
  );
  const [openrouterConfig, setOpenrouterConfig] = useState<Partial<OpenRouterConfig>>(
    api.openrouter || { apiKey: '', selectedModel: '', siteUrl: '', siteName: '' }
  );
  const [streamingEnabled, setStreamingEnabled] = useState(preferences.streamingEnabled);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Sync local state with Redux store when it changes
  useEffect(() => {
    setProvider(api.provider || 'openwebui');
    if (api.openwebui) {
      setOpenwebuiConfig(api.openwebui);
    }
    if (api.openrouter) {
      setOpenrouterConfig(api.openrouter);
    }
    setStreamingEnabled(preferences.streamingEnabled);
  }, [api, preferences]);

  const handleProviderChange = (newProvider: ProviderType) => {
    setProvider(newProvider);
    setTestResult(null);
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);

    try {
      // Create a temporary provider instance with current form values
      const tempProvider = ProviderFactory.getProvider(
        provider,
        provider === 'openwebui'
          ? openwebuiConfig as OpenWebUIConfig
          : openrouterConfig as OpenRouterConfig
      );

      const models = await tempProvider.getModels();

      setTestResult({
        success: true,
        message: `Connected successfully! Found ${models.length} model(s).`,
      });

      // Update available models in store
      dispatch(setAvailableModels(models.map((m) => m.id)));

      // If no model selected, select the first one
      if (provider === 'openwebui' && !openwebuiConfig.selectedModel && models.length > 0) {
        setOpenwebuiConfig({ ...openwebuiConfig, selectedModel: models[0].id });
      } else if (provider === 'openrouter' && !openrouterConfig.selectedModel && models.length > 0) {
        setOpenrouterConfig({ ...openrouterConfig, selectedModel: models[0].id });
      }
    } catch (error) {
      setTestResult({
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);

    try {
      const newApiConfig: any = {
        provider,
        availableModels: api.availableModels,
      };

      // Add provider-specific config
      if (provider === 'openwebui') {
        newApiConfig.openwebui = openwebuiConfig;
      } else if (provider === 'openrouter') {
        newApiConfig.openrouter = openrouterConfig;
      }

      // Save to Electron store
      await window.electron.config.set({
        api: newApiConfig,
        preferences: { streamingEnabled },
      });

      // Update Redux store
      dispatch(setApiConfig(newApiConfig));
      dispatch(setPreferences({ streamingEnabled }));

      setTestResult({
        success: true,
        message: 'Settings saved successfully!',
      });
    } catch (error) {
      setTestResult({
        success: false,
        message: 'Failed to save settings',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Provider Selection */}
      <div>
        <label className="block text-sm font-medium text-text-primary mb-2">
          API Provider
        </label>
        <select
          value={provider}
          onChange={(e) => handleProviderChange(e.target.value as ProviderType)}
          className="w-full rounded border border-border bg-bg-secondary px-3 py-2 text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
        >
          <option value="openwebui">Open WebUI</option>
          <option value="openrouter">OpenRouter</option>
        </select>
        <p className="mt-1 text-xs text-text-secondary">
          Select your preferred API provider
        </p>
      </div>

      {/* Conditional Form Rendering */}
      {provider === 'openwebui' && (
        <OpenWebUIConfigForm
          config={openwebuiConfig as OpenWebUIConfig}
          availableModels={api.availableModels}
          streamingEnabled={streamingEnabled}
          onConfigChange={(updates) => setOpenwebuiConfig({ ...openwebuiConfig, ...updates })}
          onStreamingChange={setStreamingEnabled}
          onTestConnection={handleTestConnection}
          onSave={handleSave}
          testResult={testResult}
          testing={testing}
          saving={saving}
        />
      )}

      {provider === 'openrouter' && (
        <OpenRouterConfigForm
          config={openrouterConfig as OpenRouterConfig}
          availableModels={api.availableModels}
          streamingEnabled={streamingEnabled}
          onConfigChange={(updates) => setOpenrouterConfig({ ...openrouterConfig, ...updates })}
          onStreamingChange={setStreamingEnabled}
          onTestConnection={handleTestConnection}
          onSave={handleSave}
          testResult={testResult}
          testing={testing}
          saving={saving}
        />
      )}
    </div>
  );
}
