import { useState, useEffect } from 'react';
import { useAppSelector, useAppDispatch } from '../../store';
import { setApiConfig, setAvailableModels, setPreferences } from '../../store/slices/settingsSlice';
import { ProviderFactory } from '../../services/api/provider.factory';
import { ProviderType, OpenWebUIConfig, OpenRouterConfig, CustomProviderConfig } from '../../types/api.types';
import { OpenWebUIConfigForm } from './OpenWebUIConfigForm';
import { OpenRouterConfigForm } from './OpenRouterConfigForm';
import { CustomConfigForm } from './CustomConfigForm';

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
  const [customConfig, setCustomConfig] = useState<Partial<CustomProviderConfig>>(
    api.custom || { baseUrl: '', apiKey: '', selectedModel: '' }
  );
  const [streamingEnabled, setStreamingEnabled] = useState(preferences.streamingEnabled);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Sync local state with Redux store only on initial mount
  // Don't sync on every Redux change to avoid overwriting unsaved form changes
  useEffect(() => {
    console.log('[ApiSettings] Initial sync - api.openwebui.baseUrl:', api.openwebui?.baseUrl);
    setProvider(api.provider || 'openwebui');
    if (api.openwebui) {
      setOpenwebuiConfig(api.openwebui);
    }
    if (api.openrouter) {
      setOpenrouterConfig(api.openrouter);
    }
    if (api.custom) {
      setCustomConfig(api.custom);
    }
    setStreamingEnabled(preferences.streamingEnabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount

  // Sync streaming preference separately when it changes
  useEffect(() => {
    setStreamingEnabled(preferences.streamingEnabled);
  }, [preferences.streamingEnabled]);

  const handleProviderChange = (newProvider: ProviderType) => {
    setProvider(newProvider);
    setTestResult(null);
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);

    console.log('[ApiSettings] Test connection - baseUrl BEFORE:', openwebuiConfig?.baseUrl);

    try {
      // Create a temporary provider instance with current form values
      const tempProvider = ProviderFactory.getProvider(
        provider,
        provider === 'openwebui'
          ? openwebuiConfig as OpenWebUIConfig
          : provider === 'openrouter'
            ? openrouterConfig as OpenRouterConfig
            : customConfig as CustomProviderConfig
      );

      console.log('[ApiSettings] Test connection - baseUrl AFTER getProvider:', openwebuiConfig?.baseUrl);

      const models = await tempProvider.getModels();

      console.log('[ApiSettings] Test connection - baseUrl AFTER getModels:', openwebuiConfig?.baseUrl);

      setTestResult({
        success: true,
        message: `Connected successfully! Found ${models.length} model(s).`,
      });

      // Update available models in store
      dispatch(setAvailableModels(models.map((m) => m.id)));

      // If no model selected, select the first one (only for providers that support model listing)
      if (provider === 'openwebui' && !openwebuiConfig.selectedModel && models.length > 0) {
        console.log('[ApiSettings] Setting selected model, baseUrl before:', openwebuiConfig?.baseUrl);
        setOpenwebuiConfig({ ...openwebuiConfig, selectedModel: models[0].id });
      } else if (provider === 'openrouter' && !openrouterConfig.selectedModel && models.length > 0) {
        setOpenrouterConfig({ ...openrouterConfig, selectedModel: models[0].id });
      }

      console.log('[ApiSettings] Test connection complete - baseUrl FINAL:', openwebuiConfig?.baseUrl);
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

      // Add provider-specific config and extract selectedModel
      let selectedModel = '';
      if (provider === 'openwebui') {
        // Normalize baseUrl - remove trailing slashes and /api suffix
        const normalizedConfig = { ...openwebuiConfig };
        if (normalizedConfig.baseUrl) {
          normalizedConfig.baseUrl = normalizedConfig.baseUrl
            .replace(/\/+$/, '') // Remove trailing slashes
            .replace(/\/api$/i, ''); // Remove /api suffix to prevent duplication
        }
        newApiConfig.openwebui = normalizedConfig;
        selectedModel = normalizedConfig.selectedModel || '';
      } else if (provider === 'openrouter') {
        newApiConfig.openrouter = openrouterConfig;
        selectedModel = openrouterConfig.selectedModel || '';
      } else if (provider === 'custom') {
        // Normalize baseUrl - remove trailing slashes and /api suffix
        const normalizedConfig = { ...customConfig };
        if (normalizedConfig.baseUrl) {
          normalizedConfig.baseUrl = normalizedConfig.baseUrl
            .replace(/\/+$/, '') // Remove trailing slashes
            .replace(/\/api$/i, ''); // Remove /api suffix to prevent duplication
        }
        newApiConfig.custom = normalizedConfig;
        selectedModel = normalizedConfig.selectedModel || '';
      }

      // Set selectedModel at the top level for backward compatibility
      newApiConfig.selectedModel = selectedModel;

      // Save to Electron store
      await window.electron.config.set({
        api: newApiConfig,
        preferences: { streamingEnabled },
      });

      // Update Redux store
      dispatch(setApiConfig(newApiConfig));
      dispatch(setPreferences({ streamingEnabled }));

      // Update local form state to match what was saved (with normalized URLs)
      if (provider === 'openwebui' && newApiConfig.openwebui) {
        setOpenwebuiConfig(newApiConfig.openwebui);
      } else if (provider === 'openrouter' && newApiConfig.openrouter) {
        setOpenrouterConfig(newApiConfig.openrouter);
      } else if (provider === 'custom' && newApiConfig.custom) {
        setCustomConfig(newApiConfig.custom);
      }

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

  const connectionStatus = testResult?.success === true
    ? { dot: '#2f8f4a', text: 'Connected', sub: '· tested just now' }
    : testResult?.success === false
      ? { dot: '#b14a3b', text: 'Error', sub: `· ${testResult.message}` }
      : null;

  return (
    <div>
      {/* Section header */}
      <div style={{ padding: '22px 28px 18px', borderBottom: '1px solid #ebe7e1' }}>
        <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: -0.2, marginBottom: 4, color: '#1a1a19' }}>
          API Configuration
        </div>
        <div style={{ fontSize: 13, color: '#6f6b66', lineHeight: 1.55 }}>
          Connect to your preferred provider to start chatting.
        </div>
      </div>

      <div style={{ padding: '22px 28px' }}>
        {/* Provider + connection status card */}
        <div style={{ border: '1px solid #ebe7e1', borderRadius: 10, padding: 18, background: '#fff', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: '#2e2b27' }}>Provider</div>
            {connectionStatus && (
              <div style={{ fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 5, color: connectionStatus.dot }}>
                <span>●</span>
                <span>{connectionStatus.text}</span>
                <span style={{ color: '#6f6b66' }}>{connectionStatus.sub}</span>
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <select
                value={provider}
                onChange={(e) => handleProviderChange(e.target.value as ProviderType)}
                style={{
                  width: '100%',
                  border: '1px solid #ebe7e1',
                  borderRadius: 7,
                  padding: '7px 10px',
                  fontSize: 13,
                  background: '#fff',
                  color: '#2e2b27',
                  outline: 'none',
                }}
              >
                <option value="openwebui">Open WebUI</option>
                <option value="openrouter">OpenRouter</option>
                <option value="custom">Custom (OpenAI-compatible)</option>
              </select>
            </div>
            <div>
              {provider === 'custom' ? (
                <input
                  type="text"
                  value={customConfig.selectedModel || ''}
                  onChange={(e) => setCustomConfig({ ...customConfig, selectedModel: e.target.value })}
                  placeholder="Enter model name..."
                  style={{
                    width: '100%',
                    border: '1px solid #ebe7e1',
                    borderRadius: 7,
                    padding: '7px 10px',
                    fontSize: 13,
                    background: '#fff',
                    color: '#2e2b27',
                    outline: 'none',
                  }}
                />
              ) : (
                <select
                  value={
                    provider === 'openwebui'
                      ? openwebuiConfig.selectedModel || ''
                      : openrouterConfig.selectedModel || ''
                  }
                  onChange={(e) => {
                    if (provider === 'openwebui') {
                      setOpenwebuiConfig({ ...openwebuiConfig, selectedModel: e.target.value });
                    } else {
                      setOpenrouterConfig({ ...openrouterConfig, selectedModel: e.target.value });
                    }
                  }}
                  style={{
                    width: '100%',
                    border: '1px solid #ebe7e1',
                    borderRadius: 7,
                    padding: '7px 10px',
                    fontSize: 13,
                    background: '#fff',
                    color: '#2e2b27',
                    outline: 'none',
                  }}
                >
                  {api.availableModels.length === 0 ? (
                    <option value="">No models — test connection</option>
                  ) : (
                    api.availableModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))
                  )}
                </select>
              )}
            </div>
          </div>
        </div>

        {/* Credentials form */}
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

        {provider === 'custom' && (
          <CustomConfigForm
            config={customConfig as CustomProviderConfig}
            streamingEnabled={streamingEnabled}
            onConfigChange={(updates) => setCustomConfig({ ...customConfig, ...updates })}
            onStreamingChange={setStreamingEnabled}
            onTestConnection={handleTestConnection}
            onSave={handleSave}
            testResult={testResult}
            testing={testing}
            saving={saving}
          />
        )}
      </div>
    </div>
  );
}
